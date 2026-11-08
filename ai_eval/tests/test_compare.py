import asyncio
import json

import pytest

from ai_eval.compare import compare_runs, normalized_answer
from ai_eval.errors import ConfigurationError
from ai_eval.models import (
    Applicability,
    CriterionJudgment,
    EvaluationStatus,
    JudgeRole,
    JudgeRun,
    UsageMetadata,
    ValidationStatus,
)
from ai_eval.pipeline import assemble_result, evaluate_single_judge
from ai_eval.prompt import build_prompt
from ai_eval.provider import MockProvider

from helpers import StubProvider, load_demo


def _payload(variant: str) -> str:
    conversation, checklist = load_demo()
    response = asyncio.run(
        MockProvider(variant).complete(
            build_prompt(conversation, checklist), conversation=conversation, checklist=checklist
        )
    )
    return response.raw_text


def _run(role: JudgeRole, raw_text: str, *, usage: UsageMetadata | None = None) -> JudgeRun:
    conversation, checklist = load_demo()
    return asyncio.run(
        evaluate_single_judge(
            conversation,
            checklist,
            provider=StubProvider(raw_text=raw_text, usage=usage),
            role=role,
        )
    )


def _edit(raw_text: str, criterion_id: str, **fields) -> str:
    payload = json.loads(raw_text)
    for item in payload["criteria"]:
        if item["criterion_id"] == criterion_id:
            item.update(fields)
    return json.dumps(payload)


def test_same_answers_with_different_evidence_agree() -> None:
    conversation, checklist = load_demo()
    raw_a = _payload("a")
    raw_b = _edit(raw_a, "demo_operator_replied", evidence_message_ids=["ru-6"])
    result = assemble_result(
        conversation, checklist, [_run(JudgeRole.judge_a, raw_a), _run(JudgeRole.judge_b, raw_b)]
    )
    assert result.status is EvaluationStatus.completed
    assert result.disputed_criterion_ids == []
    assert result.notes == []
    merged = {item.criterion_id: item for item in result.criterion_results}
    assert merged["demo_operator_replied"].evidence_message_ids == ["ru-4", "ru-6"]
    assert len(result.judge_runs) == 2
    assert [run.role for run in result.judge_runs] == [JudgeRole.judge_a, JudgeRole.judge_b]


def test_numeric_answers_compare_by_value_not_type() -> None:
    conversation, checklist = load_demo()
    raw_a = _edit(_payload("a"), "demo_clarity_anchor", answer=1)
    raw_b = _edit(_payload("a"), "demo_clarity_anchor", answer=1.0)
    result = assemble_result(
        conversation, checklist, [_run(JudgeRole.judge_a, raw_a), _run(JudgeRole.judge_b, raw_b)]
    )
    assert result.disputed_criterion_ids == []


def test_disagreement_on_answer_or_applicability_is_disputed() -> None:
    conversation, checklist = load_demo()
    raw_a = _payload("a")
    raw_b = _payload("b")
    result = assemble_result(
        conversation, checklist, [_run(JudgeRole.judge_a, raw_a), _run(JudgeRole.judge_b, raw_b)]
    )
    assert result.status is EvaluationStatus.partial
    assert result.disputed_criterion_ids == [c.criterion_id for c in checklist.criteria]
    assert result.unresolved_criterion_ids == result.disputed_criterion_ids
    for item in result.criterion_results:
        assert item.applicability is Applicability.undetermined
        assert item.answer is None
        assert item.needs_human_review is True
        assert "judge_a" in item.explanation and "judge_b" in item.explanation
    # Judge outputs are preserved untouched.
    assert result.judge_runs[0].judgments[0].answer is True
    assert result.judge_runs[1].judgments[0].answer is False

    na_b = _edit(
        raw_a,
        "demo_product_followup",
        applicability="not_applicable",
        answer=None,
        evidence_message_ids=[],
        na_reason="Not applicable when the client never names a product.",
    )
    result = assemble_result(
        conversation, checklist, [_run(JudgeRole.judge_a, raw_a), _run(JudgeRole.judge_b, na_b)]
    )
    assert result.disputed_criterion_ids == ["demo_product_followup"]


def test_one_failed_judge_is_partial_not_consensus() -> None:
    conversation, checklist = load_demo()
    good = _run(JudgeRole.judge_a, _payload("a"))
    bad = _run(JudgeRole.judge_b, "not json")
    result = assemble_result(conversation, checklist, [good, bad])
    assert result.status is EvaluationStatus.partial
    assert result.disputed_criterion_ids == []
    assert len(result.criterion_results) == len(checklist.criteria)
    assert any("judge_b" in note and "no valid result" in note for note in result.notes)
    assert any("not a two-judge comparison" in note for note in result.notes)

    result = assemble_result(conversation, checklist, [bad, _run(JudgeRole.judge_a, "{}")])
    assert result.status is EvaluationStatus.failed
    assert result.criterion_results == []
    assert result.unresolved_criterion_ids == [c.criterion_id for c in checklist.criteria]


def test_usage_is_summed_across_judges() -> None:
    conversation, checklist = load_demo()
    usage = UsageMetadata(usage_known=True, input_tokens=100, output_tokens=10, request_count=1)
    result = assemble_result(
        conversation,
        checklist,
        [
            _run(JudgeRole.judge_a, _payload("a"), usage=usage),
            _run(JudgeRole.judge_b, _payload("a"), usage=usage),
        ],
    )
    assert result.usage.provider_request_count == 2
    assert result.usage.input_tokens == 200
    assert result.usage.usage_known is True


def test_two_runs_with_the_same_role_are_rejected() -> None:
    conversation, checklist = load_demo()
    run = _run(JudgeRole.judge_a, _payload("a"))
    with pytest.raises(ConfigurationError, match="different roles"):
        assemble_result(conversation, checklist, [run, run])


def test_normalized_answer_keeps_bool_and_number_distinct() -> None:
    base = dict(
        criterion_id="x",
        explanation="e",
        evidence_message_ids=[],
        checked_range=None,
        na_reason=None,
        needs_human_review=False,
        review_reason=None,
    )
    as_bool = CriterionJudgment(applicability=Applicability.applicable, answer=True, **base)
    as_int = CriterionJudgment(applicability=Applicability.applicable, answer=1, **base)
    assert normalized_answer(as_bool) != normalized_answer(as_int)
    assert normalized_answer(as_bool) == ("applicable", "bool", True)
