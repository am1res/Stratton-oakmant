"""Live adapter tests with a fake client. No network, no key."""

import asyncio
import json
from types import SimpleNamespace

import openai
import pytest

try:  # the SDK's HTTP layer: httpx2 in newer releases, httpx in older ones
    import httpx2 as httpx
except ImportError:  # pragma: no cover - depends on the installed SDK
    import httpx

from ai_eval.errors import ConfigurationError, ProviderError
from ai_eval.models import JudgeRole, ResponseFormat, RoleSettings, ValidationStatus
from ai_eval.openai_provider import OpenAICompatibleProvider
from ai_eval.pipeline import evaluate_single_judge
from ai_eval.prompt import build_prompt
from ai_eval.provider import MockProvider

from helpers import load_demo


def _settings(**overrides) -> RoleSettings:
    data = {
        "base_url": "https://llm.internal.example.net/v1",
        "api_key_env": "AI_EVAL_JUDGE_A_API_KEY",
        "model": "vendor/model-id",
        "response_format": ResponseFormat.json_schema,
        "timeout_seconds": 30,
        "max_output_tokens": 800,
    }
    data.update(overrides)
    return RoleSettings(**data)


def _completion(content, *, finish_reason="stop", refusal=None, usage=True, model="vendor/model-id-2025"):
    usage_obj = None
    if usage:
        usage_obj = SimpleNamespace(prompt_tokens=120, completion_tokens=40, model_extra={})
    return SimpleNamespace(
        model=model,
        usage=usage_obj,
        choices=[
            SimpleNamespace(
                finish_reason=finish_reason,
                message=SimpleNamespace(content=content, refusal=refusal),
            )
        ],
    )


def _http_error(cls, status: int, message: str):
    request = httpx.Request("POST", "https://llm.internal.example.net/v1/chat/completions")
    response = httpx.Response(status, request=request)
    return cls(message, response=response, body={"error": {"message": message}})


class FakeClient:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        self.calls.append(kwargs)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _provider(outcomes, **settings):
    client = FakeClient(outcomes)
    provider = OpenAICompatibleProvider(
        _settings(**settings), "sk-not-real", role=JudgeRole.judge_a, client=client
    )
    return provider, client


def _mock_payload():
    conversation, checklist = load_demo()
    response = asyncio.run(
        MockProvider().complete(
            build_prompt(conversation, checklist), conversation=conversation, checklist=checklist
        )
    )
    return conversation, checklist, response.raw_text


async def _no_sleep(_: float) -> None:
    return None


def test_request_kwargs_follow_settings_and_omit_unsupported_params() -> None:
    conversation, checklist = load_demo()
    provider, _ = _provider([])
    kwargs = provider.request_kwargs(build_prompt(conversation, checklist))
    assert kwargs["model"] == "vendor/model-id"
    assert kwargs["max_completion_tokens"] == 800
    assert "max_tokens" not in kwargs
    assert "temperature" not in kwargs
    assert "reasoning_effort" not in kwargs
    assert kwargs["response_format"]["type"] == "json_schema"
    assert kwargs["response_format"]["json_schema"]["strict"] is True
    assert kwargs["messages"][0]["role"] == "system"

    provider, _ = _provider(
        [],
        response_format=ResponseFormat.json_object,
        max_tokens_param="max_tokens",
        temperature=0.0,
        reasoning_effort="low",
    )
    kwargs = provider.request_kwargs(build_prompt(conversation, checklist))
    assert kwargs["response_format"] == {"type": "json_object"}
    assert kwargs["max_tokens"] == 800
    assert kwargs["temperature"] == 0.0
    assert kwargs["reasoning_effort"] == "low"

    provider, _ = _provider([], response_format=ResponseFormat.prompt_json)
    kwargs = provider.request_kwargs(build_prompt(conversation, checklist))
    assert "response_format" not in kwargs


def test_successful_live_run_records_usage_and_latency() -> None:
    conversation, checklist, raw = _mock_payload()
    provider, client = _provider([_completion(raw)])
    run = asyncio.run(
        evaluate_single_judge(
            conversation,
            checklist,
            provider=provider,
            environ={
                "AI_EVAL_PRICE_INPUT_PER_MILLION": "1",
                "AI_EVAL_PRICE_OUTPUT_PER_MILLION": "10",
            },
        )
    )
    assert run.validation_status is ValidationStatus.valid
    assert len(run.judgments) == len(checklist.criteria)
    assert run.provider == "llm.internal.example.net"
    assert run.model == "vendor/model-id-2025"
    assert run.usage.usage_known is True
    assert run.usage.input_tokens == 120
    assert run.usage.output_tokens == 40
    assert run.usage.request_count == 1
    assert run.usage.estimated_cost_usd == pytest.approx((120 * 1 + 40 * 10) / 1_000_000)
    assert run.usage.provider_billed_cost_usd is None
    assert run.latency_ms >= 0
    assert len(client.calls) == 1


def test_rate_limit_then_success_uses_bounded_backoff() -> None:
    conversation, checklist, raw = _mock_payload()
    provider, client = _provider(
        [_http_error(openai.RateLimitError, 429, "slow down"), _completion(raw)]
    )
    slept: list[float] = []

    async def record(seconds: float) -> None:
        slept.append(seconds)

    run = asyncio.run(
        evaluate_single_judge(conversation, checklist, provider=provider, sleep=record)
    )
    assert run.validation_status is ValidationStatus.valid
    assert slept == [1.0]
    assert len(client.calls) == 2
    assert run.usage.request_count == 2
    assert run.usage.usage_known is False


def test_attempt_limit_is_explicit_and_failure_stays_failed() -> None:
    conversation, checklist, _ = _mock_payload()
    provider, client = _provider(
        [_http_error(openai.InternalServerError, 503, "down")] * 5
    )
    run = asyncio.run(
        evaluate_single_judge(
            conversation,
            checklist,
            provider=provider,
            environ={"AI_EVAL_MAX_ATTEMPTS": "2"},
            sleep=_no_sleep,
        )
    )
    assert run.validation_status is ValidationStatus.invalid
    assert run.judgments == []
    assert len(client.calls) == 2
    assert run.validation_errors == [
        "attempt 1: provider server_error: down",
        "attempt 2: provider server_error: down",
    ]


def test_timeout_is_transient_and_bad_request_is_not() -> None:
    conversation, checklist = load_demo()
    request = build_prompt(conversation, checklist)
    provider, _ = _provider(
        [openai.APITimeoutError(httpx.Request("POST", "https://llm.internal.example.net/v1"))]
    )
    with pytest.raises(ProviderError) as timeout:
        asyncio.run(provider.complete(request, conversation=conversation, checklist=checklist))
    assert timeout.value.transient is True
    assert timeout.value.kind == "timeout"

    provider, _ = _provider([_http_error(openai.BadRequestError, 400, "messages too long")])
    with pytest.raises(ProviderError) as bad:
        asyncio.run(provider.complete(request, conversation=conversation, checklist=checklist))
    assert bad.value.transient is False


def test_refusal_and_truncation_are_not_repaired() -> None:
    conversation, checklist, raw = _mock_payload()
    provider, client = _provider([_completion(None, refusal="I cannot help with that.")])
    run = asyncio.run(
        evaluate_single_judge(conversation, checklist, provider=provider, sleep=_no_sleep)
    )
    assert run.validation_errors == ["model refused the request"]
    assert len(client.calls) == 1

    provider, client = _provider([_completion(raw[: len(raw) // 2], finish_reason="length")])
    run = asyncio.run(
        evaluate_single_judge(conversation, checklist, provider=provider, sleep=_no_sleep)
    )
    assert run.validation_status is ValidationStatus.invalid
    assert "truncated" in run.validation_errors[0]
    assert len(client.calls) == 1


def test_one_repair_attempt_then_stop() -> None:
    conversation, checklist, raw = _mock_payload()
    broken = json.loads(raw)
    broken["criteria"][0]["evidence_message_ids"] = ["not-a-message"]
    broken_text = json.dumps(broken)

    provider, client = _provider([_completion(broken_text), _completion(raw)])
    run = asyncio.run(
        evaluate_single_judge(conversation, checklist, provider=provider, sleep=_no_sleep)
    )
    assert run.validation_status is ValidationStatus.valid
    assert len(client.calls) == 2
    assert run.notes and run.notes[0].startswith("repaired after first attempt:")
    assert "not-a-message" in run.notes[0]
    assert "<answer_format>" in client.calls[0]["messages"][1]["content"]
    repair_messages = client.calls[1]["messages"]
    assert repair_messages[-2]["role"] == "assistant"
    assert "not-a-message" in repair_messages[-1]["content"]
    assert run.usage.request_count == 2
    assert run.usage.input_tokens == 240

    provider, client = _provider([_completion(broken_text), _completion(broken_text), _completion(raw)])
    run = asyncio.run(
        evaluate_single_judge(conversation, checklist, provider=provider, sleep=_no_sleep)
    )
    assert run.validation_status is ValidationStatus.invalid
    assert run.judgments == []
    assert len(client.calls) == 2
    assert any(error.startswith("first attempt:") for error in run.validation_errors)
    assert any(error.startswith("repair attempt:") for error in run.validation_errors)


def test_auth_and_format_rejections_are_configuration_errors_without_the_key() -> None:
    conversation, checklist = load_demo()
    request = build_prompt(conversation, checklist)

    provider, _ = _provider([_http_error(openai.AuthenticationError, 401, "Incorrect API key")])
    with pytest.raises(ConfigurationError) as auth:
        asyncio.run(provider.complete(request, conversation=conversation, checklist=checklist))
    assert "AI_EVAL_JUDGE_A_API_KEY_ENV" in str(auth.value)
    assert "sk-not-real" not in str(auth.value)

    provider, _ = _provider(
        [_http_error(openai.BadRequestError, 400, "response_format json_schema is not supported")]
    )
    with pytest.raises(ConfigurationError) as fmt:
        asyncio.run(provider.complete(request, conversation=conversation, checklist=checklist))
    assert "AI_EVAL_JUDGE_A_RESPONSE_FORMAT" in str(fmt.value)
    assert "not downgraded" in str(fmt.value)

    provider, _ = _provider(
        [_http_error(openai.BadRequestError, 400, "Unsupported parameter: max_tokens")]
    )
    with pytest.raises(ConfigurationError) as gen:
        asyncio.run(provider.complete(request, conversation=conversation, checklist=checklist))
    assert "AI_EVAL_JUDGE_A_MAX_TOKENS_PARAM" in str(gen.value)

    provider, _ = _provider([_http_error(openai.NotFoundError, 404, "model does not exist")])
    with pytest.raises(ConfigurationError) as missing:
        asyncio.run(provider.complete(request, conversation=conversation, checklist=checklist))
    assert "AI_EVAL_JUDGE_A_MODEL" in str(missing.value)


def test_configuration_error_from_provider_propagates_through_the_pipeline() -> None:
    conversation, checklist = load_demo()
    provider, _ = _provider([_http_error(openai.AuthenticationError, 401, "bad key")])
    with pytest.raises(ConfigurationError):
        asyncio.run(evaluate_single_judge(conversation, checklist, provider=provider))


def test_missing_usage_is_unknown_not_zero() -> None:
    conversation, checklist, raw = _mock_payload()
    provider, _ = _provider([_completion(raw, usage=False)])
    run = asyncio.run(evaluate_single_judge(conversation, checklist, provider=provider))
    assert run.validation_status is ValidationStatus.valid
    assert run.usage.usage_known is False
    assert run.usage.input_tokens is None
    assert run.usage.request_count == 1


def test_live_mode_requires_real_settings_before_any_call(monkeypatch) -> None:
    conversation, checklist = load_demo()
    monkeypatch.setenv("AI_EVAL_MODE", "live")
    monkeypatch.setenv("AI_EVAL_JUDGE_A_API_KEY_ENV", "AI_EVAL_JUDGE_A_API_KEY")
    monkeypatch.setenv("AI_EVAL_JUDGE_A_API_KEY", "sk-PASTE")
    with pytest.raises(ConfigurationError) as caught:
        asyncio.run(evaluate_single_judge(conversation, checklist))
    text = str(caught.value)
    assert "base URL is not set" in text
    assert "model id is not set" in text
    assert "still a placeholder" in text
    assert "sk-PASTE" not in text


def test_two_judge_run_checks_judge_b_before_judge_a_spends_a_request(monkeypatch) -> None:
    """A complete judge A plus an unconfigured judge B must not call anything."""
    from ai_eval import pipeline

    conversation, checklist = load_demo()
    monkeypatch.setenv("AI_EVAL_MODE", "live")
    for key, value in {
        "AI_EVAL_JUDGE_A_BASE_URL": "https://llm.internal.example.net/v1",
        "AI_EVAL_JUDGE_A_API_KEY_ENV": "AI_EVAL_JUDGE_A_API_KEY",
        "AI_EVAL_JUDGE_A_API_KEY": "sk-test-not-real",
        "AI_EVAL_JUDGE_A_MODEL": "vendor/model-id",
        "AI_EVAL_JUDGE_A_RESPONSE_FORMAT": "json_schema",
        "AI_EVAL_JUDGE_A_TIMEOUT_SECONDS": "30",
        "AI_EVAL_JUDGE_A_MAX_OUTPUT_TOKENS": "800",
    }.items():
        monkeypatch.setenv(key, value)

    async def no_call(*args, **kwargs):
        raise AssertionError("a judge request was attempted")

    monkeypatch.setattr(pipeline, "evaluate_single_judge", no_call)
    with pytest.raises(ConfigurationError, match="judge_b"):
        asyncio.run(pipeline.evaluate_conversation(conversation, checklist))
