"""Adapt the Node app's checklist and transcript to this module, and back.

The Node server owns storage, scoring, and the UI. This process only runs
evaluate_conversation and returns answers in the shape shared/scoring.js expects:
"yes" | "no" | "na" | number, plus evidence indices the player already uses.

confidence here is the UI's existing marker (1 = judges agreed, 0.5 = resolved
by the adjudicator or still unresolved). It is not a calibrated probability.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from ai_eval.config import load_env_file
from ai_eval.errors import ConfigurationError
from ai_eval.models import (
    Applicability,
    Checklist,
    Conversation,
    CriterionJudgment,
    EvaluationResult,
    JudgeRun,
    parse_checklist,
    parse_conversation,
)
from ai_eval.pipeline import evaluate_conversation
from ai_eval.prompt import PROMPT_VERSION, SYSTEM_PROMPT

_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def checklist_from_team(data: dict[str, Any], *, extra_note: str = "") -> Checklist:
    rules = [str(rule) for rule in data.get("general_rules") or [] if str(rule).strip()]
    if extra_note.strip():
        rules.append(extra_note.strip())
    criteria = [_criterion(item) for item in data.get("criteria") or []]
    if not criteria:
        raise ConfigurationError("team checklist has no criteria")
    return parse_checklist(
        {
            "checklist_version_id": f"{data.get('id') or 'checklist'}-v{data.get('version', '')}",
            "shared_instructions": "\n".join(rules),
            "explanation_language": "Russian",
            "criteria": criteria,
        }
    )


def conversation_from_team(data: dict[str, Any]) -> Conversation:
    source = data.get("transcript") if isinstance(data.get("transcript"), list) else data.get("messages")
    if not isinstance(source, list):
        raise ConfigurationError("team conversation has no transcript")
    messages = []
    for index, item in enumerate(source):
        if not isinstance(item, dict):
            raise ConfigurationError(f"transcript[{index}] is not an object")
        message_id = item.get("message_id")
        if message_id is None or str(message_id).strip() == "":
            message_id = item.get("msg_index", index)
        messages.append(
            {
                "message_id": str(message_id),
                "timestamp": str(item.get("timestamp") or "0"),
                "speaker": item.get("speaker"),
                "text": str(item.get("text") or ""),
            }
        )
    return parse_conversation(
        {
            "conversation_id": data.get("conversation_id"),
            "channel": data.get("channel") or "agent chat",
            "language": data.get("language") or "RU",
            "messages": messages,
        }
    )


def to_team_result(
    checklist_data: dict[str, Any],
    conversation_data: dict[str, Any],
    result: EvaluationResult,
) -> dict[str, Any]:
    if result.status.value == "failed":
        raise ConfigurationError("evaluation failed: " + "; ".join(result.notes) or result.status.value)
    by_type = {item["id"]: item.get("type") for item in checklist_data.get("criteria") or []}
    texts = _texts_by_index(conversation_data)
    judges = {
        run.role.value: {item.criterion_id: item for item in run.judgments}
        for run in result.judge_runs
        if run.validation_status.value == "valid"
    }
    criteria = []
    for judgment in result.criterion_results:
        kind = by_type.get(judgment.criterion_id)
        if kind is None:
            raise ConfigurationError(f"result criterion {judgment.criterion_id} is not in the team checklist")
        answer, agreement, confidence = _team_answer(kind, judgment, judges)
        indices, evidence = _evidence(judgment, texts)
        checked = _range(judgment)
        criteria.append(
            {
                "criterion_id": judgment.criterion_id,
                "answer": answer,
                "explanation": judgment.explanation,
                "evidence_msg_indices": indices,
                "evidence": evidence,
                "checked_range": checked,
                "na_reason": judgment.na_reason,
                "gross_error_type": None,
                "confidence": confidence,
                "agreement": agreement,
                "votes": _votes(judgment.criterion_id, judges, answer),
                "judge_answers": _judge_answers(judgment.criterion_id, judges),
                "needs_human_review": judgment.needs_human_review,
            }
        )
    usage = result.usage
    return {
        "criteria": criteria,
        "usage": {
            "input_tokens": usage.input_tokens or 0,
            "output_tokens": usage.output_tokens or 0,
            "calls": usage.provider_request_count,
            "cost_usd": usage.estimated_cost_usd,
            "usage_known": usage.usage_known,
        },
        "prompt": [{"role": "system", "content": f"{PROMPT_VERSION}\n\n{SYSTEM_PROMPT}"}],
        "status": result.status.value,
        "model": ", ".join(f"{run.role.value}={run.model}" for run in result.judge_runs),
        "mode": "ai_eval",
    }


def _criterion(item: dict[str, Any]) -> dict[str, Any]:
    kind = item.get("type")
    criterion: dict[str, Any] = {
        "criterion_id": item.get("id"),
        "name": item.get("name") or item.get("id"),
        "description": (item.get("yes_rule") or item.get("name") or "").strip() or str(item.get("id")),
        "allow_na": bool(item.get("na_allowed")),
    }
    notes = []
    steps = item.get("decision_steps") or []
    if steps:
        notes.append("Порядок решения:\n" + "\n".join(f"{i}. {step}" for i, step in enumerate(steps, start=1)))
    examples = item.get("examples") or []
    if examples:
        lines = []
        for example in examples:
            if not isinstance(example, dict):
                continue
            lines.append(f"- {example.get('text', '')} → {example.get('answer')}: {example.get('why', '')}")
        if lines:
            notes.append("Примеры:\n" + "\n".join(lines))
    if kind == "flag":
        notes.append("Да означает, что нарушение выявлено. Нет означает, что ни одно нарушение не выявлено.")
    if notes:
        criterion["additional_instructions"] = "\n".join(notes)
    if criterion["allow_na"]:
        rule = str(item.get("na_rule") or "").strip()
        if not rule:
            raise ConfigurationError(f"{item.get('id')}: na_allowed requires na_rule")
        criterion["na_rule"] = rule
    if kind in ("binary", "flag"):
        criterion["answer_type"] = "boolean"
    elif kind == "scale":
        anchors = item.get("scale") or []
        if not anchors:
            raise ConfigurationError(f"{item.get('id')}: scale criterion has no scale")
        criterion["answer_type"] = "numeric"
        criterion["scale"] = {
            "anchors": [
                {"value": step["value"], "description": step.get("description") or str(step["value"])}
                for step in anchors
            ]
        }
    else:
        raise ConfigurationError(f"{item.get('id')}: unsupported type {kind}")
    return criterion


def _team_answer(
    kind: str,
    judgment: CriterionJudgment,
    judges: dict[str, dict[str, CriterionJudgment]],
) -> tuple[Any, str, float]:
    adjudicated = _was_adjudicated(judgment, judges)
    if judgment.applicability is Applicability.not_applicable:
        return "na", ("arbitrated" if adjudicated else "agreed"), (0.5 if adjudicated else 1)
    if judgment.applicability is Applicability.undetermined:
        fallback = _judge_answer(kind, judges.get("judge_a", {}).get(judgment.criterion_id))
        if fallback is None:
            fallback = _judge_answer(kind, judges.get("judge_b", {}).get(judgment.criterion_id))
        if fallback is None:
            raise ConfigurationError(f"{judgment.criterion_id}: unresolved and neither judge has an answer")
        return fallback, "arbiter_failed", 0.5
    agreement = "arbitrated" if adjudicated else "agreed"
    confidence = 0.5 if adjudicated else 1
    if kind in ("binary", "flag"):
        if not isinstance(judgment.answer, bool):
            raise ConfigurationError(f"{judgment.criterion_id}: expected a boolean answer")
        return ("yes" if judgment.answer else "no"), agreement, confidence
    return judgment.answer, agreement, confidence


def _was_adjudicated(judgment: CriterionJudgment, judges: dict[str, dict[str, CriterionJudgment]]) -> bool:
    left = judges.get("judge_a", {}).get(judgment.criterion_id)
    right = judges.get("judge_b", {}).get(judgment.criterion_id)
    if left is None or right is None:
        return False
    return (left.applicability, left.answer) != (right.applicability, right.answer)


def _judge_answer(kind: str | None, judgment: CriterionJudgment | None) -> Any:
    if judgment is None or judgment.applicability is not Applicability.applicable:
        return "na" if judgment is not None and judgment.applicability is Applicability.not_applicable else None
    if kind in ("binary", "flag"):
        return "yes" if judgment.answer is True else "no" if judgment.answer is False else None
    return judgment.answer


def _judge_answers(criterion_id: str, judges: dict[str, dict[str, CriterionJudgment]]) -> dict[str, Any]:
    """Each role's own answer, keyed by role, so per-judge accuracy can be measured later."""
    out: dict[str, Any] = {}
    for role in ("judge_a", "judge_b", "adjudicator"):
        judgment = judges.get(role, {}).get(criterion_id)
        if judgment is None:
            continue
        if judgment.applicability is Applicability.not_applicable:
            out[role] = "na"
        elif judgment.applicability is Applicability.applicable:
            out[role] = "yes" if judgment.answer is True else "no" if judgment.answer is False else judgment.answer
    return out


def _votes(criterion_id: str, judges: dict[str, dict[str, CriterionJudgment]], final: Any) -> list[Any]:
    values = []
    for role in ("judge_a", "judge_b", "adjudicator"):
        judgment = judges.get(role, {}).get(criterion_id)
        if judgment is None:
            continue
        if judgment.applicability is Applicability.not_applicable:
            values.append("na")
        elif judgment.applicability is Applicability.applicable:
            values.append("yes" if judgment.answer is True else "no" if judgment.answer is False else judgment.answer)
    return values or [final]


def _evidence(judgment: CriterionJudgment, texts: dict[int, str]) -> tuple[list[int], list[dict[str, Any]]]:
    indices: list[int] = []
    evidence: list[dict[str, Any]] = []
    for message_id in judgment.evidence_message_ids:
        index = _index(message_id)
        if index is None or index in indices:
            continue
        indices.append(index)
        evidence.append({"msg_index": index, "quote": texts.get(index, "")[:300], "proves": ""})
    return indices, evidence


def _range(judgment: CriterionJudgment) -> list[int] | None:
    checked = judgment.checked_range
    if checked is None:
        return None
    start, end = _index(checked.start_message_id), _index(checked.end_message_id)
    if start is None or end is None:
        return None
    return [start, end]


def _index(message_id: str) -> int | None:
    tail = message_id.rsplit("#", 1)[-1]
    return int(tail) if tail.isdigit() else None


def _texts_by_index(conversation_data: dict[str, Any]) -> dict[int, str]:
    source = conversation_data.get("transcript") or conversation_data.get("messages") or []
    texts = {}
    for index, item in enumerate(source):
        if not isinstance(item, dict):
            continue
        key = item.get("msg_index", index)
        if isinstance(key, int) or (isinstance(key, str) and key.isdigit()):
            texts[int(key)] = str(item.get("text") or "")
    return texts


def main() -> int:
    if _ENV_FILE.is_file():
        load_env_file(str(_ENV_FILE), __import__("os").environ)
    try:
        payload = json.load(sys.stdin)
        checklist_data = payload["checklist"]
        conversation_data = payload["conversation"]
        ids = payload.get("criteria_ids") or None
        if ids:
            checklist_data = dict(checklist_data)
            checklist_data["criteria"] = [c for c in checklist_data.get("criteria") or [] if c.get("id") in set(ids)]
        checklist = checklist_from_team(checklist_data, extra_note=str(payload.get("extra_note") or ""))
        conversation = conversation_from_team(conversation_data)
        result = __import__("asyncio").run(
            evaluate_conversation(
                conversation,
                checklist,
                tone_labels=payload.get("tone_labels") or None,
            )
        )
        json.dump(to_team_result(checklist_data, conversation_data, result), sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    except (ConfigurationError, KeyError, json.JSONDecodeError) as exc:
        print(f"ai_eval: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
