import asyncio
import http.client
import json
import urllib.request

import pytest

from ai_eval.errors import ConfigurationError
from ai_eval.models import Applicability, EvaluationStatus, UsageMetadata, ValidationStatus
from ai_eval.pipeline import assemble_result, evaluate_conversation, evaluate_single_judge, summarize_usage
from ai_eval.prompt import build_prompt
from ai_eval.provider import MockProvider

from helpers import FIXTURES, StubProvider, load_demo


def test_mock_evaluation_completes_without_a_score_or_a_network_call(monkeypatch) -> None:
    def blocked(*args, **kwargs):
        raise AssertionError("network call")

    monkeypatch.setattr(http.client.HTTPConnection, "connect", blocked)
    monkeypatch.setattr(http.client.HTTPSConnection, "connect", blocked)
    monkeypatch.setattr(urllib.request, "urlopen", blocked)
    conversation, checklist = load_demo()
    before = conversation.model_dump(mode="json")
    result = asyncio.run(evaluate_conversation(conversation, checklist))
    assert conversation.model_dump(mode="json") == before
    # Mock judge A and mock judge B answer differently on purpose, so every
    # criterion is disputed and left for review: the mock exercises the
    # comparison path rather than pretending to agree.
    expected_ids = [criterion.criterion_id for criterion in checklist.criteria]
    assert result.status is EvaluationStatus.partial
    assert result.disputed_criterion_ids == expected_ids
    assert result.unresolved_criterion_ids == expected_ids
    assert [item.criterion_id for item in result.criterion_results] == expected_ids
    assert [run.role.value for run in result.judge_runs] == ["judge_a", "judge_b", "adjudicator"]
    assert [run.model for run in result.judge_runs] == ["mock-a", "mock-b", "mock-adjudicator"]
    assert all(run.provider == "mock" for run in result.judge_runs)
    assert all(run.validation_status is ValidationStatus.valid for run in result.judge_runs)
    assert result.notes == ["adjudicator left unresolved: " + ", ".join(expected_ids)]
    assert result.usage.usage_known is False
    assert result.usage.input_tokens is None
    assert result.usage.estimated_cost_usd is None
    assert result.usage.provider_billed_cost_usd is None
    assert result.usage.provider_request_count == 0
    encoded = json.dumps(result.model_dump(mode="json"))
    for banned in ("confidence", "points", "weight", "gross_error", '"score"'):
        assert banned not in encoded
    assert "Здравствуйте, где посмотреть тариф?" not in encoded
    operator_ids = {
        message.message_id
        for message in conversation.messages
        if message.speaker.value == "operator"
    }
    for judgment in result.criterion_results:
        assert judgment.applicability is Applicability.undetermined
        assert judgment.needs_human_review is True
    for run in result.judge_runs:
        if run.role.value == "adjudicator":
            continue
        for judgment in run.judgments:
            assert judgment.evidence_message_ids
            assert set(judgment.evidence_message_ids) <= operator_ids
            assert "did not judge the transcript" in judgment.explanation


def test_mock_answers_follow_configuration_not_criterion_names() -> None:
    conversation, checklist = load_demo()
    result = asyncio.run(evaluate_conversation(conversation, checklist))
    run_a, run_b = result.judge_runs[0], result.judge_runs[1]
    a = {item.criterion_id: item for item in run_a.judgments}
    b = {item.criterion_id: item for item in run_b.judgments}
    assert a["demo_operator_replied"].answer is True
    assert a["demo_product_followup"].answer is True
    assert a["demo_clarity_anchor"].answer == 0
    assert a["demo_handoff_label"].answer == "system_handoff"
    assert b["demo_operator_replied"].answer is False
    assert b["demo_product_followup"].answer is False
    assert b["demo_clarity_anchor"].answer == 2
    assert b["demo_handoff_label"].answer == "unclear"


def test_no_operator_messages_follow_the_na_flag() -> None:
    conversation, checklist = load_demo()
    silent = conversation.model_copy(
        update={
            "messages": [
                message
                for message in conversation.messages
                if message.speaker.value != "operator"
            ]
        }
    )
    result = asyncio.run(evaluate_conversation(silent, checklist))
    # With no operator messages both mock variants answer identically, so the
    # judges agree and nothing is disputed; undetermined criteria stay unresolved.
    assert result.status is EvaluationStatus.partial
    by_id = {item.criterion_id: item for item in result.criterion_results}
    assert by_id["demo_product_followup"].applicability is Applicability.not_applicable
    assert by_id["demo_product_followup"].answer is None
    assert by_id["demo_product_followup"].na_reason == checklist.criteria[1].na_rule
    assert by_id["demo_operator_replied"].applicability is Applicability.undetermined
    assert by_id["demo_operator_replied"].needs_human_review is True
    assert result.unresolved_criterion_ids == ["demo_operator_replied", "demo_handoff_label"]
    assert result.disputed_criterion_ids == []


def test_invalid_output_is_not_returned_as_an_evaluation() -> None:
    conversation, checklist = load_demo()
    stub = StubProvider(raw_text="not json")
    run = asyncio.run(
        evaluate_single_judge(conversation, checklist, provider=stub)
    )
    result = assemble_result(conversation, checklist, [run])
    assert run.validation_status is ValidationStatus.invalid
    assert run.judgments == []
    assert result.status is EvaluationStatus.failed
    assert result.criterion_results == []
    assert result.unresolved_criterion_ids == [
        criterion.criterion_id for criterion in checklist.criteria
    ]


def test_provider_exception_does_not_leak_its_message() -> None:
    conversation, checklist = load_demo()
    stub = StubProvider(error=RuntimeError("sk-secret-token"))
    run = asyncio.run(evaluate_single_judge(conversation, checklist, provider=stub))
    encoded = json.dumps(run.model_dump(mode="json"))
    assert run.validation_errors == ["attempt 1: provider error: RuntimeError"]
    assert "sk-secret-token" not in encoded
    assert run.usage.usage_known is False
    assert run.usage.request_count == 1
    assert run.usage.input_tokens is None


def test_live_mode_does_not_substitute_a_mock(monkeypatch) -> None:
    conversation, checklist = load_demo()
    monkeypatch.setenv("AI_EVAL_MODE", "live")

    def fail_init(*args, **kwargs):
        raise AssertionError("mock provider constructed")

    monkeypatch.setattr("ai_eval.pipeline.MockProvider", fail_init)
    with pytest.raises(ConfigurationError, match="live mode is not configured"):
        asyncio.run(evaluate_conversation(conversation, checklist))


def test_reported_usage_is_priced_separately_from_billed_cost() -> None:
    conversation, checklist = load_demo()
    usage = UsageMetadata(
        usage_known=True,
        input_tokens=10,
        output_tokens=5,
        total_tokens=15,
        request_count=2,
        provider_billed_cost_usd=0.01,
    )
    response = asyncio.run(
        MockProvider().complete(
            build_prompt(conversation, checklist),
            conversation=conversation,
            checklist=checklist,
        )
    )
    stub = StubProvider(raw_text=response.raw_text, usage=usage)
    run = asyncio.run(
        evaluate_single_judge(
            conversation,
            checklist,
            provider=stub,
            environ={
                "AI_EVAL_MODE": "mock",
                "AI_EVAL_PRICE_INPUT_PER_MILLION": "2",
                "AI_EVAL_PRICE_OUTPUT_PER_MILLION": "4",
            },
        )
    )
    assert run.usage.estimated_cost_usd == pytest.approx(0.00004)
    assert run.usage.provider_billed_cost_usd == 0.01
    assert run.usage.request_count == 2
    summary = summarize_usage(
        [
            run.usage,
            UsageMetadata(usage_known=False, request_count=1),
        ]
    )
    assert summary.usage_known is False
    assert summary.input_tokens is None
    assert summary.estimated_cost_usd is None
    assert summary.provider_billed_cost_usd is None
    assert summary.provider_request_count == 3


def test_single_run_result_is_not_marked_as_a_comparison() -> None:
    conversation, checklist = load_demo()
    run = asyncio.run(evaluate_single_judge(conversation, checklist))
    result = assemble_result(conversation, checklist, [run])
    assert result.status is EvaluationStatus.completed
    assert result.disputed_criterion_ids == []
    assert result.notes == []
    assert len(result.judge_runs) == 1


def test_single_judge_builds_the_prompt_before_the_provider_runs() -> None:
    conversation, checklist = load_demo()
    stub = StubProvider(raw_text="{}")
    asyncio.run(evaluate_single_judge(conversation, checklist, provider=stub))
    assert stub.requests
    assert "demo_handoff_label" in stub.requests[0].messages[1].content
    assert (FIXTURES / "conversations" / "ru.json").exists()
