"""Evaluate one conversation: agents A and B in parallel, arbiter on disagreements, then score."""
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from evaluations.models import AgentVerdict, CriterionResult, Evaluation, EvaluationRun, Status

from . import scoring
from .llm import LLMError, get_client
from .prompts import NO_RANGE, PromptBuilder, prompt_hash

logger = logging.getLogger("cqa.pipeline")

ATTEMPTS = 2


class PipelineError(Exception):
    pass


@dataclass
class AgentOutcome:
    role: str
    model: str
    prompt_hash: str
    verdicts: dict | None = None  # code -> normalized verdict
    raw: dict = field(default_factory=dict)
    usage: dict = field(default_factory=dict)
    latency_ms: int = 0
    error: str = ""


def normalize(data, criteria, valid_idx):
    """Check an agent's JSON against the checklist and clean evidence references.

    Raises ValueError if the output is unusable (missing criterion, value not allowed).
    """
    items = (data or {}).get("criteria") or {}
    verdicts = {}
    for c in criteria:
        item = items.get(c.code)
        if not isinstance(item, dict):
            raise ValueError(f"missing criterion {c.code}")
        value = str(item.get("value", "")).strip().upper()
        if value not in c.allowed_values():
            raise ValueError(f"{c.code}: value {value!r} not in {c.allowed_values()}")
        evidence = [
            {"msg_idx": e["msg_idx"], "quote": e.get("quote", ""), "proves": e.get("proves", "")}
            for e in item.get("evidence") or []
            if isinstance(e, dict) and e.get("msg_idx") in valid_idx
        ]
        lo, hi = item.get("checked_from", NO_RANGE), item.get("checked_to", NO_RANGE)
        checked = [min(lo, hi), max(lo, hi)] if lo in valid_idx and hi in valid_idx else None
        verdicts[c.code] = {
            "value": value,
            "explanation": item.get("explanation", ""),
            "evidence": evidence,
            "checked_range": checked,
            "na_reason": item.get("na_reason", "") if value == "N/A" else "",
            "decision_reason": item.get("decision_reason", ""),
        }
    return verdicts


def public(verdict):
    """The part of a verdict the arbiter needs to see."""
    return {k: v for k, v in verdict.items() if k != "decision_reason"}


def call_agent(role, model, effort, system_blocks, user, schema, criteria, valid_idx):
    """Run one agent with a retry on API/format errors. Never raises; errors go in the outcome."""
    outcome = AgentOutcome(role=role, model=model, prompt_hash=prompt_hash(system_blocks, user, schema))
    client = get_client()
    for attempt in range(1, ATTEMPTS + 1):
        try:
            result = client.complete_json(
                role=role, model=model, effort=effort, system_blocks=system_blocks, user=user, schema=schema
            )
            outcome.raw, outcome.usage, outcome.latency_ms = result.data, result.usage, result.latency_ms
            outcome.model = result.model
            outcome.verdicts = normalize(result.data, criteria, valid_idx)
            outcome.error = ""
            return outcome
        except (LLMError, ValueError) as exc:
            outcome.error = f"attempt {attempt}: {exc}"
            logger.warning("Agent %s failed (%s)", role, outcome.error)
    return outcome


def save_verdict(evaluation, outcome):
    AgentVerdict.objects.create(
        evaluation=evaluation,
        role=outcome.role,
        model_name=outcome.model,
        prompt_hash=outcome.prompt_hash,
        raw_output=outcome.raw,
        error=outcome.error,
        latency_ms=outcome.latency_ms,
        usage=outcome.usage,
    )


def merge_evidence(*lists):
    seen, merged = set(), []
    for items in lists:
        for e in items:
            if e["msg_idx"] not in seen:
                seen.add(e["msg_idx"])
                merged.append(e)
    return sorted(merged, key=lambda e: e["msg_idx"])


def build_result(evaluation, criterion, a, b, arbiter):
    """a/b/arbiter: normalized verdicts for this criterion (any may be None)."""
    if a and b and a["value"] != b["value"]:
        final, agreement = arbiter, CriterionResult.Agreement.ARBITRATED
        evidence = final["evidence"] or merge_evidence(a["evidence"], b["evidence"])
    elif a and b:
        final, agreement = a, CriterionResult.Agreement.AGREED
        evidence = merge_evidence(a["evidence"], b["evidence"])
    else:
        final, agreement = a or b, CriterionResult.Agreement.SINGLE
        evidence = final["evidence"]
    return CriterionResult(
        evaluation=evaluation,
        criterion=criterion,
        value_a=a["value"] if a else "",
        value_b=b["value"] if b else "",
        value_arbiter=arbiter["value"] if arbiter else "",
        ai_value=final["value"],
        final_value=final["value"],
        explanation=final["explanation"],
        arbiter_reason=arbiter["decision_reason"] if arbiter else "",
        na_reason=final["na_reason"] or ((a or {}).get("na_reason") or (b or {}).get("na_reason") or ""),
        evidence=evidence,
        checked_range=final["checked_range"] or (a or {}).get("checked_range") or (b or {}).get("checked_range"),
        agreement=agreement,
    )


def run_pipeline(evaluation):
    conversation, version = evaluation.conversation, evaluation.checklist_version
    criteria = list(version.criteria.select_related("section"))
    messages = list(conversation.messages.all())
    if not messages:
        raise PipelineError("Conversation has no messages")
    valid_idx = {m.idx for m in messages}
    builder = PromptBuilder(version, criteria)
    user, schema = builder.agent_user(conversation, messages), builder.agent_schema()

    agents = {"A": settings.CQA_MODEL_AGENT_A, "B": settings.CQA_MODEL_AGENT_B}
    with ThreadPoolExecutor(max_workers=len(agents)) as pool:
        futures = {
            role: pool.submit(
                call_agent, role, model, settings.CQA_EFFORT_AGENT,
                builder.system_blocks(role), user, schema, criteria, valid_idx,
            )
            for role, model in agents.items()
        }
        outcomes = {role: f.result() for role, f in futures.items()}
    for outcome in outcomes.values():
        save_verdict(evaluation, outcome)

    a, b = outcomes["A"].verdicts, outcomes["B"].verdicts
    if not a and not b:
        raise PipelineError(f"Both agents failed: A: {outcomes['A'].error}; B: {outcomes['B'].error}")

    arbiter = {}
    disputed = [c.code for c in criteria if a and b and a[c.code]["value"] != b[c.code]["value"]]
    if disputed:
        disputes = {
            code: {"evaluator_1": public(a[code]), "evaluator_2": public(b[code])} for code in disputed
        }
        outcome = call_agent(
            "ARBITER", settings.CQA_MODEL_ARBITER, settings.CQA_EFFORT_ARBITER,
            builder.system_blocks("ARBITER"), builder.arbiter_user(conversation, messages, disputes),
            builder.arbiter_schema(disputed), [c for c in criteria if c.code in disputed], valid_idx,
        )
        save_verdict(evaluation, outcome)
        if outcome.verdicts is None:
            raise PipelineError(f"Arbiter failed on {', '.join(disputed)}: {outcome.error}")
        arbiter = outcome.verdicts

    with transaction.atomic():
        CriterionResult.objects.bulk_create(
            build_result(
                evaluation, c,
                a and a[c.code], b and b[c.code], arbiter.get(c.code),
            )
            for c in criteria
        )
        evaluation.arbiter_used = bool(disputed)
        evaluation.save(update_fields=["arbiter_used"])
        scoring.recalculate(evaluation, ai=True)


def evaluate(evaluation_id):
    evaluation = Evaluation.objects.select_related("conversation", "checklist_version__checklist").get(
        pk=evaluation_id
    )
    if evaluation.status == Status.DONE:
        return evaluation
    # Clear partial output from an earlier attempt so a retry starts clean.
    evaluation.results.all().delete()
    evaluation.verdicts.all().delete()
    evaluation.status, evaluation.error, evaluation.started_at = Status.RUNNING, "", timezone.now()
    evaluation.save(update_fields=["status", "error", "started_at"])
    try:
        run_pipeline(evaluation)
        evaluation.status = Status.DONE
    except Exception as exc:  # one bad conversation must not stop the batch
        logger.exception("Evaluation %s failed", evaluation_id)
        evaluation.status, evaluation.error = Status.FAILED, str(exc)
    evaluation.finished_at = timezone.now()
    evaluation.save(update_fields=["status", "error", "finished_at"])
    mark_run_finished(evaluation.run_id)
    return evaluation


def mark_run_finished(run_id):
    if run_id is None:
        return
    unfinished = Evaluation.objects.filter(run_id=run_id, status__in=[Status.PENDING, Status.RUNNING])
    if not unfinished.exists():
        EvaluationRun.objects.filter(pk=run_id, finished_at__isnull=True).update(finished_at=timezone.now())
