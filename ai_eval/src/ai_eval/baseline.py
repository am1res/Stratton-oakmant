"""Compare an evaluation with an external reference file.

The reference uses its own criterion ids. The mapping from those ids to the
checklist ids is data, loaded from a JSON file, so the evaluator does not
contain a fixed rubric. A match is the same applicability and the same typed
answer. Evidence and wording are not compared. An undetermined result does
not match a reference answer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from ai_eval.errors import ConfigurationError
from ai_eval.models import Applicability, CriterionJudgment, EvaluationResult

MAP_PATH = (
    Path(__file__).resolve().parents[2] / "fixtures" / "baselines" / "reference_criterion_map.json"
)

UNDETERMINED = object()


@dataclass(frozen=True)
class AnswerDiff:
    checklist_id: str
    reference_id: str
    reference_value: Any
    actual_value: Any
    matched: bool


def load_id_map(path: Path | None = None) -> dict[str, str]:
    source = path or MAP_PATH
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigurationError(f"cannot read criterion map: {exc.strerror}") from exc
    if not isinstance(payload, dict) or not payload:
        raise ConfigurationError("criterion map must be a non-empty object")
    mapping: dict[str, str] = {}
    for reference_id, checklist_id in payload.items():
        if not isinstance(reference_id, str) or not isinstance(checklist_id, str):
            raise ConfigurationError("criterion map keys and values must be strings")
        mapping[reference_id] = checklist_id
    return mapping


def load_reference(path: Path) -> dict[str, dict[str, Any]]:
    """conversation_id -> {reference criterion id: value}."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigurationError(f"cannot read baseline: {exc.strerror}") from exc
    rows = payload.get("results") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ConfigurationError("baseline must contain a results list")
    by_conversation: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("conversation_id"), str):
            raise ConfigurationError("baseline row has no conversation_id")
        answers: dict[str, Any] = {}
        for item in row.get("criteria") or []:
            if isinstance(item, dict) and isinstance(item.get("criterion_id"), str):
                answers[item["criterion_id"]] = item.get("value")
        by_conversation[row["conversation_id"]] = answers
    return by_conversation


def compare_judgments(
    judgments: list[CriterionJudgment],
    reference_answers: dict[str, Any],
    id_map: dict[str, str],
) -> list[AnswerDiff]:
    by_id = {judgment.criterion_id: judgment for judgment in judgments}
    diffs: list[AnswerDiff] = []
    for reference_id, checklist_id in id_map.items():
        if reference_id not in reference_answers:
            continue
        judgment = by_id.get(checklist_id)
        actual = UNDETERMINED if judgment is None else _comparable(judgment)
        reference = reference_answers[reference_id]
        diffs.append(
            AnswerDiff(
                checklist_id=checklist_id,
                reference_id=reference_id,
                reference_value=reference,
                actual_value="undetermined" if actual is UNDETERMINED else actual,
                matched=_same(actual, reference),
            )
        )
    return diffs


def compare_result(
    result: EvaluationResult,
    reference_answers: dict[str, Any],
    id_map: dict[str, str],
) -> dict[str, list[AnswerDiff]]:
    """Merged result plus each judge run, keyed by 'merged' and the judge role."""
    compared = {
        "merged": compare_judgments(result.criterion_results, reference_answers, id_map)
    }
    for run in result.judge_runs:
        if run.validation_status.value != "valid":
            continue
        compared[run.role.value] = compare_judgments(run.judgments, reference_answers, id_map)
    return compared


def format_comparison(
    conversation_id: str,
    compared: dict[str, list[AnswerDiff]],
) -> str:
    lines = [f"baseline {conversation_id}"]
    for label, diffs in compared.items():
        matched = sum(1 for diff in diffs if diff.matched)
        lines.append(f"  {label}: {matched}/{len(diffs)}")
    merged = compared.get("merged", [])
    for diff in merged:
        if diff.matched:
            continue
        lines.append(
            f"  {diff.checklist_id} ({diff.reference_id}): "
            f"baseline={_show(diff.reference_value)} actual={_show(diff.actual_value)}"
        )
    return "\n".join(lines)


def _comparable(judgment: CriterionJudgment) -> Any:
    if judgment.applicability is Applicability.not_applicable:
        return None
    if judgment.applicability is Applicability.undetermined:
        return UNDETERMINED
    answer = judgment.answer
    if isinstance(answer, float) and answer == int(answer):
        return int(answer)
    return answer


def _same(actual: Any, reference: Any) -> bool:
    if actual is UNDETERMINED:
        return False
    if isinstance(reference, bool) or isinstance(actual, bool):
        return actual is reference
    if reference is None or actual is None:
        return actual is None and reference is None
    if isinstance(reference, (int, float)) and isinstance(actual, (int, float)):
        return Decimal(str(actual)) == Decimal(str(reference))
    return actual == reference


def _show(value: Any) -> str:
    if value == "undetermined":
        return "undetermined"
    if value is None:
        return "N/A"
    if value is True:
        return "yes"
    if value is False:
        return "no"
    return str(value)


def reference_for(
    path: Path,
    conversation_id: str,
    id_map: dict[str, str] | None = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    mapping = id_map if id_map is not None else load_id_map()
    answers = load_reference(path).get(conversation_id)
    if answers is None:
        raise ConfigurationError(f"baseline has no conversation {conversation_id}")
    return answers, mapping
