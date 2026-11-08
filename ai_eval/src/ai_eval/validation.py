"""Structural checks for one judge's output.

Passing these checks means the output matches the conversation and the
checklist configuration. It does not mean the explanation is true.
A message id that exists in the transcript only shows the id was not invented.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from pydantic import ValidationError

from ai_eval.models import (
    Applicability,
    BooleanCriterion,
    CategoricalCriterion,
    Checklist,
    Conversation,
    Criterion,
    CriterionJudgment,
    NumericCriterion,
)

EXPLANATION_MAX_CHARS = 1000


def parse_judge_payload(
    raw_text: str,
    conversation: Conversation,
    checklist: Checklist,
) -> tuple[list[CriterionJudgment], list[str]]:
    """Return judgments only when the payload passes every structural check."""
    try:
        payload = json.loads(raw_text, object_pairs_hook=_reject_duplicate_keys)
    except json.JSONDecodeError:
        return [], ["response is not valid JSON"]
    except ValueError as exc:
        return [], [str(exc)]

    if not isinstance(payload, dict):
        return [], ["response JSON must be an object"]
    if set(payload) != {"criteria"}:
        return [], ["response object must contain only 'criteria'"]
    items = payload["criteria"]
    if not isinstance(items, list):
        return [], ["criteria must be a list"]

    errors: list[str] = []
    parsed: list[CriterionJudgment] = []
    for index, item in enumerate(items):
        try:
            parsed.append(CriterionJudgment.model_validate(item))
        except ValidationError as exc:
            errors.append(f"criteria[{index}]: {_compact_validation_error(exc)}")

    errors.extend(validate_judgments(parsed, conversation, checklist))
    if errors:
        return [], errors
    return _in_checklist_order(parsed, checklist), []


def validate_judgments(
    judgments: list[CriterionJudgment],
    conversation: Conversation,
    checklist: Checklist,
) -> list[str]:
    expected = [criterion.criterion_id for criterion in checklist.criteria]
    by_id = {criterion.criterion_id: criterion for criterion in checklist.criteria}
    positions = {
        message.message_id: index for index, message in enumerate(conversation.messages)
    }
    errors: list[str] = []
    seen: dict[str, int] = {}
    for judgment in judgments:
        seen[judgment.criterion_id] = seen.get(judgment.criterion_id, 0) + 1

    for criterion_id, count in seen.items():
        if criterion_id not in by_id:
            errors.append(f"unknown criterion_id: {criterion_id}")
        elif count > 1:
            errors.append(f"duplicate criterion_id: {criterion_id}")
    for criterion_id in expected:
        if criterion_id not in seen:
            errors.append(f"missing criterion_id: {criterion_id}")

    for judgment in judgments:
        criterion = by_id.get(judgment.criterion_id)
        if criterion is None or seen.get(judgment.criterion_id, 0) != 1:
            continue
        errors.extend(_validate_one(judgment, criterion, positions))
    return errors


def answer_is_permitted(criterion: Criterion, answer: object) -> bool:
    if isinstance(criterion, NumericCriterion):
        return _numeric_error(criterion, answer) is None
    if isinstance(criterion, CategoricalCriterion):
        return isinstance(answer, str) and answer in criterion.allowed_values
    return isinstance(answer, bool)


def _validate_one(
    judgment: CriterionJudgment,
    criterion: Criterion,
    positions: dict[str, int],
) -> list[str]:
    errors: list[str] = []
    label = criterion.criterion_id
    if not judgment.explanation.strip():
        errors.append(f"{label}: explanation is empty")
    elif len(judgment.explanation) > EXPLANATION_MAX_CHARS:
        errors.append(f"{label}: explanation exceeds {EXPLANATION_MAX_CHARS} characters")

    if judgment.needs_human_review:
        if judgment.review_reason is None or not judgment.review_reason.strip():
            errors.append(f"{label}: needs_human_review requires review_reason")
        elif len(judgment.review_reason) > EXPLANATION_MAX_CHARS:
            errors.append(f"{label}: review_reason exceeds {EXPLANATION_MAX_CHARS} characters")
    elif judgment.review_reason is not None:
        errors.append(f"{label}: review_reason must be null when needs_human_review is false")

    errors.extend(_validate_ids(label, judgment, positions))

    if judgment.applicability is Applicability.not_applicable:
        if not criterion.allow_na:
            errors.append(f"{label}: N/A is not allowed")
        if judgment.answer is not None:
            errors.append(f"{label}: not_applicable requires a null answer")
        if judgment.na_reason is None or not judgment.na_reason.strip():
            errors.append(f"{label}: not_applicable requires na_reason")
        elif len(judgment.na_reason) > EXPLANATION_MAX_CHARS:
            errors.append(f"{label}: na_reason exceeds {EXPLANATION_MAX_CHARS} characters")
        return errors

    if judgment.na_reason is not None:
        errors.append(f"{label}: na_reason must be null unless applicability is not_applicable")

    if judgment.applicability is Applicability.undetermined:
        if judgment.answer is not None:
            errors.append(f"{label}: undetermined requires a null answer")
        if not judgment.needs_human_review:
            errors.append(f"{label}: undetermined requires needs_human_review")
        return errors

    if judgment.answer is None:
        errors.append(f"{label}: answer does not match the criterion; applicable requires an answer")
    else:
        detail = _answer_detail(criterion, judgment.answer)
        if detail is not None:
            errors.append(f"{label}: answer does not match the criterion; {detail}")
    if not judgment.evidence_message_ids and judgment.checked_range is None:
        errors.append(f"{label}: applicable requires evidence_message_ids or checked_range")
    return errors


def _answer_detail(criterion: Criterion, answer: object) -> str | None:
    if isinstance(criterion, BooleanCriterion):
        if isinstance(answer, bool):
            return None
        return "boolean answer must be true or false"
    if isinstance(criterion, CategoricalCriterion):
        if isinstance(answer, str) and answer in criterion.allowed_values:
            return None
        shown = ", ".join(criterion.allowed_values)
        if len(shown) > 160:
            shown = shown[:160] + "…"
        return f"categorical answer is not one of: {shown}"
    if isinstance(criterion, NumericCriterion):
        reason = _numeric_error(criterion, answer)
        if reason is None:
            return None
        if reason == "not a number":
            return "numeric answer must be a JSON number"
        if reason == "not a listed value":
            return "numeric answer is not one of the permitted scale values"
        if reason in {"below minimum", "above maximum"}:
            return "numeric answer is outside the scale range"
        if reason == "off step":
            return "numeric answer is outside the scale step"
    return "answer does not match the criterion configuration"


def _validate_ids(
    label: str,
    judgment: CriterionJudgment,
    positions: dict[str, int],
) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for message_id in judgment.evidence_message_ids:
        if message_id in seen:
            errors.append(f"{label}: duplicate evidence message_id {message_id!r}")
        seen.add(message_id)
        if message_id not in positions:
            errors.append(f"{label}: evidence message_id {message_id!r} is not in the conversation")
    checked = judgment.checked_range
    if checked is None:
        return errors
    start = positions.get(checked.start_message_id)
    end = positions.get(checked.end_message_id)
    if start is None:
        errors.append(
            f"{label}: checked_range start {checked.start_message_id!r} is not in the conversation"
        )
    if end is None:
        errors.append(
            f"{label}: checked_range end {checked.end_message_id!r} is not in the conversation"
        )
    if start is not None and end is not None and start > end:
        errors.append(f"{label}: checked_range is out of order")
    return errors


def _numeric_error(criterion: NumericCriterion, answer: object) -> str | None:
    if isinstance(answer, bool) or not isinstance(answer, (int, float)):
        return "not a number"
    value = Decimal(str(answer))
    scale = criterion.scale
    discrete = scale.discrete_values()
    if discrete is not None and value not in discrete:
        return "not a listed value"
    if scale.minimum is not None and value < Decimal(str(scale.minimum)):
        return "below minimum"
    if scale.maximum is not None and value > Decimal(str(scale.maximum)):
        return "above maximum"
    if scale.step is not None and scale.minimum is not None:
        span = value - Decimal(str(scale.minimum))
        step = Decimal(str(scale.step))
        if span % step != 0:
            return "off step"
    return None


def _in_checklist_order(
    judgments: list[CriterionJudgment],
    checklist: Checklist,
) -> list[CriterionJudgment]:
    by_id = {judgment.criterion_id: judgment for judgment in judgments}
    return [by_id[criterion.criterion_id] for criterion in checklist.criteria]


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key, value in pairs:
        if key in payload:
            raise ValueError(f"duplicate JSON key: {key}")
        payload[key] = value
    return payload


def _compact_validation_error(exc: ValidationError) -> str:
    parts = []
    for error in exc.errors():
        location = ".".join(str(part) for part in error["loc"]) or "value"
        parts.append(f"{location}: {error['type']}")
    return "; ".join(parts)
