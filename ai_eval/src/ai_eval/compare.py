"""Compare two valid judge runs criterion by criterion.

Agreement means the same applicability and the same normalized typed answer.
Evidence ids and wording are not compared: two judges can cite different
messages for the same decision. Agreement is a fact about two model outputs;
it is not a calibrated confidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from ai_eval.models import (
    Applicability,
    Checklist,
    Conversation,
    CriterionJudgment,
    JudgeRun,
)

_SNIPPET = 400


@dataclass(frozen=True)
class CriterionComparison:
    criterion_id: str
    agreed: bool
    judge_a: CriterionJudgment
    judge_b: CriterionJudgment


def normalized_answer(judgment: CriterionJudgment) -> tuple[str, str, object]:
    """Comparable form: (applicability, value kind, value).

    The kind tag keeps True and 1 apart; Python would otherwise treat them as equal.
    """
    answer = judgment.answer
    if answer is None:
        return (judgment.applicability.value, "null", None)
    if isinstance(answer, bool):
        return (judgment.applicability.value, "bool", answer)
    if isinstance(answer, (int, float)):
        return (judgment.applicability.value, "number", Decimal(str(answer)))
    return (judgment.applicability.value, "text", answer)


def compare_runs(run_a: JudgeRun, run_b: JudgeRun, checklist: Checklist) -> list[CriterionComparison]:
    by_a = {judgment.criterion_id: judgment for judgment in run_a.judgments}
    by_b = {judgment.criterion_id: judgment for judgment in run_b.judgments}
    comparisons = []
    for criterion in checklist.criteria:
        a = by_a[criterion.criterion_id]
        b = by_b[criterion.criterion_id]
        comparisons.append(
            CriterionComparison(
                criterion_id=criterion.criterion_id,
                agreed=normalized_answer(a) == normalized_answer(b),
                judge_a=a,
                judge_b=b,
            )
        )
    return comparisons


def agreed_judgment(
    comparison: CriterionComparison,
    conversation: Conversation,
) -> CriterionJudgment:
    """Judge A's judgment with both judges' evidence ids, in transcript order."""
    a, b = comparison.judge_a, comparison.judge_b
    return a.model_copy(
        update={
            "evidence_message_ids": merge_evidence(
                a.evidence_message_ids, b.evidence_message_ids, conversation
            ),
            "checked_range": a.checked_range or b.checked_range,
            "needs_human_review": a.needs_human_review or b.needs_human_review,
            "review_reason": a.review_reason or b.review_reason,
        }
    )


def disputed_judgment(
    comparison: CriterionComparison,
    conversation: Conversation,
    *,
    reason: str,
) -> CriterionJudgment:
    """Placeholder for a criterion the judges did not agree on and no one resolved."""
    a, b = comparison.judge_a, comparison.judge_b
    return CriterionJudgment(
        criterion_id=comparison.criterion_id,
        applicability=Applicability.undetermined,
        answer=None,
        explanation=(
            f"judge_a: {_describe(a)} — {_clip(a.explanation)}\n"
            f"judge_b: {_describe(b)} — {_clip(b.explanation)}"
        ),
        evidence_message_ids=merge_evidence(
            a.evidence_message_ids, b.evidence_message_ids, conversation
        ),
        checked_range=a.checked_range or b.checked_range,
        na_reason=None,
        needs_human_review=True,
        review_reason=reason,
    )


def merge_evidence(
    first: list[str], second: list[str], conversation: Conversation
) -> list[str]:
    position = {message.message_id: index for index, message in enumerate(conversation.messages)}
    merged = {message_id for message_id in first + second if message_id in position}
    return sorted(merged, key=position.__getitem__)


def _describe(judgment: CriterionJudgment) -> str:
    if judgment.applicability is Applicability.not_applicable:
        return "not_applicable"
    if judgment.applicability is Applicability.undetermined:
        return "undetermined"
    return f"answer={judgment.answer!r}"


def _clip(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= _SNIPPET else text[: _SNIPPET - 1] + "…"
