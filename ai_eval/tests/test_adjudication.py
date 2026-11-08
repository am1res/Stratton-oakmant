import asyncio
import json

from ai_eval.models import Applicability, EvaluationStatus, JudgeRole, ValidationStatus
from ai_eval.pipeline import assemble_result, evaluate_single_judge
from ai_eval.prompt import build_adjudication_prompt
from ai_eval.provider import MockProvider

from helpers import FIXTURES, StubProvider, load_demo
from test_compare import _edit, _payload, _run


def _resolved(raw_text: str, criterion_id: str, answer: object) -> str:
    return _edit(raw_text, criterion_id, answer=answer)


def test_adjudication_prompt_contains_only_disputed_criteria() -> None:
    conversation, checklist = load_demo()
    request = build_adjudication_prompt(
        conversation,
        checklist,
        ["demo_operator_replied"],
        [
            {
                "role": "judge_a",
                "criteria": [
                    {
                        "criterion_id": "demo_operator_replied",
                        "applicability": "applicable",
                        "answer": True,
                        "explanation": "Judge A says the operator replied.",
                        "evidence_message_ids": ["ru-4"],
                        "checked_range": None,
                        "na_reason": None,
                    }
                ],
            }
        ],
    )
    user = request.messages[1].content
    system = request.messages[0].content
    assert "demo_operator_replied" in user
    assert "Judge A says the operator replied." in user
    assert "demo_product_followup" not in user
    assert "demo_clarity_anchor" not in user
    assert "demo_handoff_label" not in user
    assert "<untrusted_transcript>" in user
    assert "ru-4" in user
    assert "do not count votes" in system.lower() or "Do not average" in system
    assert request.prompt_version.startswith("cqa-adjudicate")
    encoded = json.dumps(request.json_schema)
    assert "demo_operator_replied" in encoded
    assert "demo_product_followup" not in encoded


def test_official_adjudication_omits_agreed_clarifications() -> None:
    from ai_eval.models import parse_checklist

    from helpers import conversation as make_conversation

    checklist = parse_checklist(
        json.loads((FIXTURES / "checklists" / "official_chat_v1.json").read_text(encoding="utf-8"))
    )
    request = build_adjudication_prompt(
        make_conversation(),
        checklist,
        ["c07"],
        [{"role": "judge_a", "criteria": []}, {"role": "judge_b", "criteria": []}],
    )
    user = request.messages[1].content
    assert "Сау болыңыз" in user
    assert "зря переспросил" not in user
    assert "Один сбой = 7" not in user


def _subset_run(role: JudgeRole, raw_text: str, criterion_id: str):
    conversation, checklist = load_demo()
    subset = checklist.model_copy(
        update={
            "criteria": [
                criterion
                for criterion in checklist.criteria
                if criterion.criterion_id == criterion_id
            ]
        }
    )
    return asyncio.run(
        evaluate_single_judge(
            conversation,
            subset,
            provider=StubProvider(raw_text=raw_text),
            role=role,
        )
    )


def test_valid_adjudicator_replaces_only_the_dispute() -> None:
    conversation, checklist = load_demo()
    raw_a = _payload("a")
    raw_b = _resolved(raw_a, "demo_operator_replied", False)
    judge_a = _run(JudgeRole.judge_a, raw_a)
    judge_b = _run(JudgeRole.judge_b, raw_b)
    only = json.loads(raw_a)
    only["criteria"] = [
        item for item in only["criteria"] if item["criterion_id"] == "demo_operator_replied"
    ]
    adjudicator = _subset_run(JudgeRole.adjudicator, json.dumps(only), "demo_operator_replied")
    result = assemble_result(conversation, checklist, [judge_a, judge_b, adjudicator])
    by_id = {item.criterion_id: item for item in result.criterion_results}
    assert result.disputed_criterion_ids == ["demo_operator_replied"]
    assert result.unresolved_criterion_ids == []
    assert result.status is EvaluationStatus.completed
    assert by_id["demo_operator_replied"].answer is True
    assert by_id["demo_clarity_anchor"].applicability is Applicability.applicable
    assert any(note.startswith("adjudicator resolved:") for note in result.notes)


def test_undecided_adjudicator_stays_unresolved_for_a_human() -> None:
    conversation, checklist = load_demo()
    raw_a = _payload("a")
    raw_b = _resolved(raw_a, "demo_handoff_label", "unclear")
    judge_a = _run(JudgeRole.judge_a, raw_a)
    judge_b = _run(JudgeRole.judge_b, raw_b)
    subset = checklist.model_copy(
        update={
            "criteria": [
                criterion
                for criterion in checklist.criteria
                if criterion.criterion_id == "demo_handoff_label"
            ]
        }
    )
    response = asyncio.run(
        MockProvider(undecided=True).complete(
            build_adjudication_prompt(conversation, subset, ["demo_handoff_label"], []),
            conversation=conversation,
            checklist=subset,
        )
    )
    adjudicator = _subset_run(JudgeRole.adjudicator, response.raw_text, "demo_handoff_label")
    assert adjudicator.validation_status is ValidationStatus.valid
    result = assemble_result(conversation, checklist, [judge_a, judge_b, adjudicator])
    assert result.status is EvaluationStatus.partial
    assert result.disputed_criterion_ids == ["demo_handoff_label"]
    assert result.unresolved_criterion_ids == ["demo_handoff_label"]
    decision = next(item for item in result.criterion_results if item.criterion_id == "demo_handoff_label")
    assert decision.applicability is Applicability.undetermined
    assert decision.needs_human_review is True


def test_failed_adjudicator_does_not_invent_a_winner() -> None:
    conversation, checklist = load_demo()
    raw_a = _payload("a")
    raw_b = _resolved(raw_a, "demo_operator_replied", False)
    result = assemble_result(
        conversation,
        checklist,
        [
            _run(JudgeRole.judge_a, raw_a),
            _run(JudgeRole.judge_b, raw_b),
            _run(JudgeRole.adjudicator, "not json"),
        ],
    )
    assert result.disputed_criterion_ids == ["demo_operator_replied"]
    assert result.unresolved_criterion_ids == ["demo_operator_replied"]
    decision = next(item for item in result.criterion_results if item.criterion_id == "demo_operator_replied")
    assert decision.applicability is Applicability.undetermined
    assert any("adjudicator produced no valid result" in note for note in result.notes)


def test_a_failed_primary_judge_is_not_sent_to_adjudication() -> None:
    conversation, checklist = load_demo()
    result = assemble_result(
        conversation,
        checklist,
        [
            _run(JudgeRole.judge_a, _payload("a")),
            _run(JudgeRole.judge_b, "not json"),
            _run(JudgeRole.adjudicator, _payload("a")),
        ],
    )
    assert result.status is EvaluationStatus.partial
    assert result.disputed_criterion_ids == []
    assert any("not a two-judge comparison" in note for note in result.notes)
    assert result.criterion_results[0].answer is True
