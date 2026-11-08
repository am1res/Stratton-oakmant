"""Live adapter for OpenAI-compatible Chat Completions endpoints.

The SDK's own retries are disabled (max_retries=0) so the pipeline's attempt
limit is the only retry loop. Output-format behavior is never downgraded
after an error: a rejected response_format is a ConfigurationError.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import openai

from ai_eval.errors import ConfigurationError, ProviderError
from ai_eval.models import (
    Checklist,
    Conversation,
    JudgeRole,
    ProviderRequest,
    ProviderResponse,
    ResponseFormat,
    RoleSettings,
    UsageMetadata,
)

_DETAIL_LIMIT = 300
_FORMAT_MARKERS = ("response_format", "json_schema", "schema", "structured output")
_GENERATION_MARKERS = (
    "max_completion_tokens",
    "max_tokens",
    "temperature",
    "reasoning_effort",
    "reasoning",
)


class OpenAICompatibleProvider:
    def __init__(
        self,
        settings: RoleSettings,
        api_key: str,
        *,
        role: JudgeRole,
        client: Any | None = None,
    ) -> None:
        for name in ("base_url", "model", "response_format", "timeout_seconds", "max_output_tokens"):
            if getattr(settings, name) is None:
                raise ConfigurationError(f"{role.value}: {name} is required in live mode")
        self._settings = settings
        self._role = role
        self.model_name: str = settings.model  # type: ignore[assignment]
        self.provider_name = urlparse(settings.base_url or "").hostname or "openai-compatible"
        self._client = client or openai.AsyncOpenAI(
            base_url=settings.base_url,
            api_key=api_key,
            timeout=settings.timeout_seconds,
            max_retries=0,
        )

    async def complete(
        self,
        request: ProviderRequest,
        *,
        conversation: Conversation,
        checklist: Checklist,
    ) -> ProviderResponse:
        del conversation, checklist
        kwargs = self.request_kwargs(request)
        try:
            completion = await self._client.chat.completions.create(**kwargs)
        except openai.APITimeoutError as exc:
            raise ProviderError("timeout", _clip(str(exc)), transient=True) from exc
        except openai.RateLimitError as exc:
            raise ProviderError("rate_limit", _status_detail(exc), transient=True) from exc
        except openai.AuthenticationError as exc:
            raise ConfigurationError(
                f"{self.provider_name} rejected the API key for {self._role.value} "
                f"(HTTP {exc.status_code}). Check the variable named by "
                f"{_prefix(self._role)}_API_KEY_ENV."
            ) from exc
        except openai.PermissionDeniedError as exc:
            raise ConfigurationError(
                f"{self.provider_name} denied access for {self._role.value} "
                f"(HTTP {exc.status_code}): {_status_detail(exc)}"
            ) from exc
        except openai.NotFoundError as exc:
            raise ConfigurationError(
                f"{self.provider_name} returned HTTP 404 for {self._role.value}. "
                f"Check {_prefix(self._role)}_BASE_URL and "
                f"{_prefix(self._role)}_MODEL ({self.model_name}): {_status_detail(exc)}"
            ) from exc
        except openai.BadRequestError as exc:
            raise self._bad_request(exc) from exc
        except openai.InternalServerError as exc:
            raise ProviderError("server_error", _status_detail(exc), transient=True) from exc
        except openai.APIConnectionError as exc:
            raise ProviderError("connection", _clip(str(exc)), transient=True) from exc
        except openai.APIStatusError as exc:
            raise ProviderError(
                f"http_{exc.status_code}", _status_detail(exc), transient=False
            ) from exc
        return self._parse(completion)

    def request_kwargs(self, request: ProviderRequest) -> dict[str, Any]:
        settings = self._settings
        kwargs: dict[str, Any] = {
            "model": settings.model,
            "messages": [message.model_dump(mode="json") for message in request.messages],
            settings.max_tokens_param: settings.max_output_tokens,
        }
        if settings.response_format is ResponseFormat.json_schema:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "checklist_evaluation",
                    "strict": True,
                    "schema": request.json_schema,
                },
            }
        elif settings.response_format is ResponseFormat.json_object:
            kwargs["response_format"] = {"type": "json_object"}
        # prompt_json: no response_format parameter; the schema is in the prompt.
        if settings.temperature is not None:
            kwargs["temperature"] = settings.temperature
        if settings.reasoning_effort is not None:
            kwargs["reasoning_effort"] = settings.reasoning_effort
        return kwargs

    def _bad_request(self, exc: openai.BadRequestError) -> Exception:
        detail = _status_detail(exc)
        lowered = detail.lower()
        prefix = _prefix(self._role)
        if any(marker in lowered for marker in _FORMAT_MARKERS):
            return ConfigurationError(
                f"{self.provider_name} rejected response_format="
                f"{self._settings.response_format.value if self._settings.response_format else '?'} "
                f"for {self._role.value}: {detail}. Set {prefix}_RESPONSE_FORMAT to a "
                "value this model supports. The format was not downgraded automatically."
            )
        if any(marker in lowered for marker in _GENERATION_MARKERS):
            return ConfigurationError(
                f"{self.provider_name} rejected a generation setting for {self._role.value}: "
                f"{detail}. Adjust {prefix}_MAX_TOKENS_PARAM, {prefix}_TEMPERATURE, or "
                f"{prefix}_REASONING_EFFORT."
            )
        return ProviderError("bad_request", detail, transient=False)

    def _parse(self, completion: Any) -> ProviderResponse:
        choices = getattr(completion, "choices", None) or []
        if not choices:
            raise ProviderError("empty_response", "no choices returned", transient=False)
        choice = choices[0]
        message = getattr(choice, "message", None)
        refusal = getattr(message, "refusal", None) if message is not None else None
        content = getattr(message, "content", None) if message is not None else None
        model = getattr(completion, "model", None) or self.model_name
        return ProviderResponse(
            raw_text=content if isinstance(content, str) else "",
            usage=_usage(getattr(completion, "usage", None)),
            provider=self.provider_name,
            model=str(model),
            finish_reason=getattr(choice, "finish_reason", None),
            refusal=refusal if isinstance(refusal, str) and refusal else None,
        )


def _usage(usage: Any) -> UsageMetadata:
    if usage is None:
        return UsageMetadata(usage_known=False, request_count=1)
    prompt_tokens = getattr(usage, "prompt_tokens", None)
    completion_tokens = getattr(usage, "completion_tokens", None)
    if not isinstance(prompt_tokens, int) or not isinstance(completion_tokens, int):
        return UsageMetadata(usage_known=False, request_count=1)
    billed = None
    extra = getattr(usage, "model_extra", None) or {}
    cost = extra.get("cost") if isinstance(extra, dict) else None
    if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost >= 0:
        billed = float(cost)
    return UsageMetadata(
        usage_known=True,
        input_tokens=prompt_tokens,
        output_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
        request_count=1,
        provider_billed_cost_usd=billed,
    )


def _status_detail(exc: openai.APIStatusError) -> str:
    body = exc.body
    text = ""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            text = error["message"]
        elif isinstance(body.get("message"), str):
            text = body["message"]
    if not text:
        text = str(exc)
    return _clip(text)


def _clip(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= _DETAIL_LIMIT else text[:_DETAIL_LIMIT] + "..."


def _prefix(role: JudgeRole) -> str:
    return {
        JudgeRole.judge_a: "AI_EVAL_JUDGE_A",
        JudgeRole.judge_b: "AI_EVAL_JUDGE_B",
        JudgeRole.adjudicator: "AI_EVAL_ADJUDICATOR",
    }[role]
