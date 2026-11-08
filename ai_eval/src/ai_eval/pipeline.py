"""Run two independent judges and, only when they disagree, one adjudicator.

Each judge makes one request for the whole checklist. Judge A and judge B run
in parallel and never see each other's output. The adjudicator is called only
when both judges are valid and at least one criterion differs. That call
contains the full transcript and only the disputed criteria. Transient
failures are retried up to config.max_attempts with bounded backoff. A
structurally invalid answer gets at most one repair request.

If either primary judge fails, the adjudicator is not called and the result
is partial: it is not a two-judge consensus. A disputed criterion the
adjudicator leaves undetermined, or cannot return validly, stays unresolved
for a human reviewer.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping

from ai_eval.compare import agreed_judgment, compare_runs, disputed_judgment
from ai_eval.config import apply_price_estimate, load_config, read_api_key
from ai_eval.errors import ConfigurationError, ProviderError
from ai_eval.models import (
    AppConfig,
    Applicability,
    Checklist,
    Conversation,
    CriterionJudgment,
    EvaluationResult,
    EvaluationStatus,
    JudgeRole,
    JudgeRun,
    ProviderRequest,
    ProviderResponse,
    UsageMetadata,
    UsageSummary,
    ValidationStatus,
)
from ai_eval.prompt import build_adjudication_prompt, build_prompt, build_repair_request
from ai_eval.provider import JudgeProvider, MockProvider
from ai_eval.validation import parse_judge_payload

MAX_REPAIR_ATTEMPTS = 1
BACKOFF_BASE_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 8.0

SleepFn = Callable[[float], Awaitable[None]]


async def evaluate_conversation(
    conversation: Conversation,
    checklist: Checklist,
    *,
    tone_labels: list[dict] | None = None,
) -> EvaluationResult:
    """Evaluate one conversation with judge A and judge B in parallel."""
    config = load_config()
    # Build both providers first so a configuration error for judge B
    # is raised before judge A spends a request.
    provider_a = build_provider(config, JudgeRole.judge_a)
    provider_b = build_provider(config, JudgeRole.judge_b)
    run_a, run_b = await asyncio.gather(
        evaluate_single_judge(
            conversation, checklist, provider=provider_a, role=JudgeRole.judge_a, tone_labels=tone_labels
        ),
        evaluate_single_judge(
            conversation, checklist, provider=provider_b, role=JudgeRole.judge_b, tone_labels=tone_labels
        ),
    )
    runs = [run_a, run_b]
    if (
        run_a.validation_status is ValidationStatus.valid
        and run_b.validation_status is ValidationStatus.valid
    ):
        disputed = [
            item.criterion_id
            for item in compare_runs(run_a, run_b, checklist)
            if not item.agreed
        ]
        if disputed:
            # Config is checked here, after the judges, so an agreement does
            # not require an adjudicator key and does not spend a request.
            provider_c = build_provider(config, JudgeRole.adjudicator)
            subset = checklist.model_copy(
                update={
                    "criteria": [
                        criterion
                        for criterion in checklist.criteria
                        if criterion.criterion_id in set(disputed)
                    ]
                }
            )
            request = build_adjudication_prompt(
                conversation,
                checklist,
                disputed,
                [_position(run, disputed) for run in (run_a, run_b)],
                tone_labels=tone_labels,
            )
            runs.append(
                await evaluate_single_judge(
                    conversation,
                    subset,
                    provider=provider_c,
                    role=JudgeRole.adjudicator,
                    request=request,
                )
            )
    return assemble_result(conversation, checklist, runs)


async def evaluate_single_judge(
    conversation: Conversation,
    checklist: Checklist,
    *,
    provider: JudgeProvider | None = None,
    role: JudgeRole = JudgeRole.judge_a,
    environ: Mapping[str, str] | None = None,
    sleep: SleepFn = asyncio.sleep,
    request: ProviderRequest | None = None,
    tone_labels: list[dict] | None = None,
) -> JudgeRun:
    """Run one judge. Pass provider to test parsing without configuration.

    request replaces the standard checklist prompt. The adjudicator uses this
    so a dispute call does not repeat the agreed criteria.
    """
    config = load_config(environ)
    if provider is None:
        provider = build_provider(config, role, environ)
    if request is None:
        request = build_prompt(conversation, checklist, tone_labels=tone_labels)
    started = time.perf_counter()
    usages: list[UsageMetadata] = []
    notes: list[str] = []

    judgments: list[CriterionJudgment] = []
    response, errors = await _call_with_retries(
        provider, request, conversation, checklist, config, usages, sleep
    )
    if response is not None:
        judgments, errors = _accept(response, conversation, checklist)
        if errors and _repairable(response) and MAX_REPAIR_ATTEMPTS > 0:
            first_errors = errors
            repair = build_repair_request(request, response.raw_text, errors)
            repaired, call_errors = await _call_with_retries(
                provider, repair, conversation, checklist, config, usages, sleep
            )
            if repaired is None:
                errors = [f"first attempt: {e}" for e in first_errors] + [
                    f"repair attempt: {e}" for e in call_errors
                ]
            else:
                judgments, repair_errors = _accept(repaired, conversation, checklist)
                if repair_errors:
                    judgments = []
                    errors = [f"first attempt: {e}" for e in first_errors] + [
                        f"repair attempt: {e}" for e in repair_errors
                    ]
                else:
                    errors = []
                    notes = [f"repaired after first attempt: {e}" for e in first_errors]

    latency_ms = (time.perf_counter() - started) * 1000
    usage = apply_price_estimate(merge_usage(usages), config)
    return JudgeRun(
        role=role,
        provider=provider.provider_name,
        model=response.model if response is not None else provider.model_name,
        prompt_version=request.prompt_version,
        judgments=judgments if not errors else [],
        usage=usage,
        latency_ms=latency_ms,
        validation_status=ValidationStatus.valid if not errors else ValidationStatus.invalid,
        validation_errors=errors,
        notes=notes,
    )


def build_provider(
    config: AppConfig,
    role: JudgeRole,
    environ: Mapping[str, str] | None = None,
) -> JudgeProvider:
    if config.mode == "mock":
        if role is JudgeRole.adjudicator:
            return MockProvider(undecided=True)
        return MockProvider(variant="b" if role is JudgeRole.judge_b else "a")
    api_key = read_api_key(config, role, environ)
    from ai_eval.openai_provider import OpenAICompatibleProvider

    return OpenAICompatibleProvider(config.roles[role], api_key, role=role)


def assemble_result(
    conversation: Conversation,
    checklist: Checklist,
    runs: list[JudgeRun],
) -> EvaluationResult:
    """Combine judge runs. Runs are kept verbatim in judge_runs."""
    if not 1 <= len(runs) <= 3:
        raise ConfigurationError("assemble_result expects one, two, or three judge runs")
    roles = [run.role for run in runs]
    if len(roles) != len(set(roles)):
        raise ConfigurationError("judge runs must have different roles")
    adjudicator = next((run for run in runs if run.role is JudgeRole.adjudicator), None)
    primaries = [run for run in runs if run.role is not JudgeRole.adjudicator]
    expected = [criterion.criterion_id for criterion in checklist.criteria]
    valid = [run for run in primaries if run.validation_status is ValidationStatus.valid]
    failed = [run for run in primaries if run.validation_status is not ValidationStatus.valid]
    notes = [
        f"{run.role.value} ({run.provider}/{run.model}) produced no valid result: "
        + "; ".join(run.validation_errors[:3])
        for run in failed
    ]
    disputed: list[str] = []
    adjudicated = (
        {judgment.criterion_id: judgment for judgment in adjudicator.judgments}
        if adjudicator is not None and adjudicator.validation_status is ValidationStatus.valid
        else {}
    )
    if adjudicator is not None and adjudicator.validation_status is not ValidationStatus.valid:
        notes.append(
            "adjudicator produced no valid result; disputed criteria stay unresolved: "
            + "; ".join(adjudicator.validation_errors[:3])
        )

    if not valid:
        status = EvaluationStatus.failed
        results: list[CriterionJudgment] = []
        unresolved = list(expected)
    elif len(valid) == 1:
        results = list(valid[0].judgments)
        if len(primaries) == 2:
            notes.append(
                f"single-judge result from {valid[0].role.value}; "
                "this is not a two-judge comparison"
            )
        unresolved = [
            judgment.criterion_id
            for judgment in results
            if judgment.applicability is Applicability.undetermined
        ]
        status = (
            EvaluationStatus.partial
            if unresolved or len(primaries) == 2
            else EvaluationStatus.completed
        )
    else:
        run_a, run_b = sorted(valid, key=lambda run: run.role.value)
        results = []
        unresolved = []
        resolved_by_adjudicator: list[str] = []
        left_unresolved: list[str] = []
        for comparison in compare_runs(run_a, run_b, checklist):
            if comparison.agreed:
                judgment = agreed_judgment(comparison, conversation)
            else:
                disputed.append(comparison.criterion_id)
                judgment = adjudicated.get(comparison.criterion_id)
                if judgment is None:
                    judgment = disputed_judgment(
                        comparison,
                        conversation,
                        reason="judges disagreed and adjudication did not resolve it",
                    )
                    left_unresolved.append(comparison.criterion_id)
                elif judgment.applicability is Applicability.undetermined:
                    left_unresolved.append(comparison.criterion_id)
                else:
                    resolved_by_adjudicator.append(comparison.criterion_id)
            results.append(judgment)
            if judgment.applicability is Applicability.undetermined:
                unresolved.append(judgment.criterion_id)
        if resolved_by_adjudicator:
            notes.append("adjudicator resolved: " + ", ".join(resolved_by_adjudicator))
        if left_unresolved and adjudicator is not None:
            notes.append("adjudicator left unresolved: " + ", ".join(left_unresolved))
        status = EvaluationStatus.partial if unresolved else EvaluationStatus.completed

    return EvaluationResult(
        conversation_id=conversation.conversation_id,
        checklist_version_id=checklist.checklist_version_id,
        status=status,
        criterion_results=results,
        judge_runs=runs,
        disputed_criterion_ids=disputed,
        unresolved_criterion_ids=unresolved,
        usage=summarize_usage([run.usage for run in runs]),
        notes=notes,
    )


def _position(run: JudgeRun, disputed_ids: list[str]) -> dict[str, object]:
    by_id = {judgment.criterion_id: judgment for judgment in run.judgments}
    items = []
    for criterion_id in disputed_ids:
        judgment = by_id[criterion_id]
        checked = judgment.checked_range
        items.append(
            {
                "criterion_id": criterion_id,
                "applicability": judgment.applicability.value,
                "answer": judgment.answer,
                "explanation": judgment.explanation,
                "evidence_message_ids": judgment.evidence_message_ids,
                "checked_range": (
                    None
                    if checked is None
                    else {
                        "start_message_id": checked.start_message_id,
                        "end_message_id": checked.end_message_id,
                    }
                ),
                "na_reason": judgment.na_reason,
            }
        )
    return {"role": run.role.value, "criteria": items}


def merge_usage(usages: list[UsageMetadata]) -> UsageMetadata:
    """Sum usage across requests. Any unknown request makes the total unknown."""
    request_count = sum(item.request_count for item in usages)
    billed = _sum_optional([item.provider_billed_cost_usd for item in usages])
    if not usages or not all(item.usage_known for item in usages):
        return UsageMetadata(
            usage_known=False,
            request_count=request_count,
            provider_billed_cost_usd=billed,
        )
    input_tokens = sum(item.input_tokens or 0 for item in usages)
    output_tokens = sum(item.output_tokens or 0 for item in usages)
    return UsageMetadata(
        usage_known=True,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        request_count=request_count,
        provider_billed_cost_usd=billed,
    )


def summarize_usage(usages: list[UsageMetadata]) -> UsageSummary:
    merged = merge_usage(usages)
    return UsageSummary(
        provider_request_count=merged.request_count,
        input_tokens=merged.input_tokens,
        output_tokens=merged.output_tokens,
        usage_known=merged.usage_known,
        estimated_cost_usd=_sum_optional([item.estimated_cost_usd for item in usages]),
        provider_billed_cost_usd=merged.provider_billed_cost_usd,
    )


async def _call_with_retries(
    provider: JudgeProvider,
    request: ProviderRequest,
    conversation: Conversation,
    checklist: Checklist,
    config: AppConfig,
    usages: list[UsageMetadata],
    sleep: SleepFn,
) -> tuple[ProviderResponse | None, list[str]]:
    errors: list[str] = []
    for attempt in range(1, config.max_attempts + 1):
        try:
            response = await provider.complete(
                request, conversation=conversation, checklist=checklist
            )
        except ConfigurationError:
            raise
        except ProviderError as exc:
            usages.append(UsageMetadata(usage_known=False, request_count=1))
            errors.append(f"attempt {attempt}: provider {exc.kind}: {exc.detail}")
            if exc.transient and attempt < config.max_attempts:
                await sleep(min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** (attempt - 1)))
                continue
            return None, errors
        except Exception as exc:  # noqa: BLE001 - never leak provider internals
            usages.append(UsageMetadata(usage_known=False, request_count=1))
            errors.append(f"attempt {attempt}: provider error: {type(exc).__name__}")
            return None, errors
        usages.append(response.usage)
        return response, errors
    return None, errors


def _accept(
    response: ProviderResponse,
    conversation: Conversation,
    checklist: Checklist,
) -> tuple[list[CriterionJudgment], list[str]]:
    if response.refusal:
        return [], ["model refused the request"]
    if response.finish_reason == "length":
        return [], [
            "output truncated (finish_reason=length); raise max_output_tokens for this role"
        ]
    if response.finish_reason not in (None, "stop"):
        return [], [f"unexpected finish_reason: {response.finish_reason}"]
    return parse_judge_payload(response.raw_text, conversation, checklist)


def _repairable(response: ProviderResponse) -> bool:
    return not response.refusal and response.finish_reason in (None, "stop")


def _sum_optional(values: list[float | None]) -> float | None:
    if not values or any(value is None for value in values):
        return None
    return float(sum(value or 0 for value in values))
