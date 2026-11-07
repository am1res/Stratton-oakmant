"""LLM adapters. The pipeline only depends on `complete_json`."""
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from functools import lru_cache

from django.conf import settings

logger = logging.getLogger("cqa.llm")


class LLMError(Exception):
    """A call that produced no usable JSON (API error, refusal, truncation, bad JSON)."""


@dataclass
class LLMResult:
    data: dict
    model: str
    latency_ms: int
    usage: dict = field(default_factory=dict)


class AnthropicClient:
    FALLBACK_BETA = "server-side-fallback-2026-07-01"

    def __init__(self):
        import anthropic

        self._anthropic = anthropic
        self.client = anthropic.Anthropic(max_retries=3)

    def complete_json(self, *, role, model, effort, system_blocks, user, schema):
        system = [
            # The checklist block is shared by every call under a version: cache it.
            {"type": "text", "text": system_blocks[0], "cache_control": {"type": "ephemeral"}},
            *({"type": "text", "text": text} for text in system_blocks[1:]),
        ]
        kwargs = dict(
            model=model,
            max_tokens=settings.CQA_LLM_MAX_TOKENS,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        )
        started = time.monotonic()
        try:
            if settings.CQA_USE_FALLBACKS:
                response = self.client.beta.messages.create(
                    betas=[self.FALLBACK_BETA], fallbacks="default", **kwargs
                )
            else:
                response = self.client.messages.create(**kwargs)
        except self._anthropic.APIError as exc:
            raise LLMError(f"{role}: API error: {exc}") from exc
        latency_ms = int((time.monotonic() - started) * 1000)

        if response.stop_reason == "refusal":
            category = getattr(response.stop_details, "category", None)
            raise LLMError(f"{role}: model declined the request (category={category})")
        if response.stop_reason == "max_tokens":
            raise LLMError(f"{role}: output truncated at max_tokens")
        text = next((b.text for b in response.content if b.type == "text"), None)
        if text is None:
            raise LLMError(f"{role}: no text block in response")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError(f"{role}: invalid JSON: {exc}") from exc

        u = response.usage
        usage = {
            "input_tokens": u.input_tokens,
            "output_tokens": u.output_tokens,
            "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
            "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
            "request_id": getattr(response, "_request_id", None),
        }
        return LLMResult(data=data, model=response.model, latency_ms=latency_ms, usage=usage)


class MockClient:
    """Deterministic fake verdicts for local development without an API key.

    Agents A and B pick values from a hash of (role, criterion, prompt), so they sometimes
    disagree and the arbiter path gets exercised.
    """

    def complete_json(self, *, role, model, effort, system_blocks, user, schema):
        criteria = schema["properties"]["criteria"]["properties"]
        out = {}
        for code, spec in criteria.items():
            values = spec["properties"]["value"]["enum"]
            seed = role if role == "ARBITER" else "agent"
            # A and B agree on most criteria; B deviates on roughly one in four.
            if role == "B" and _bucket(code, user, "deviate") < 0.25:
                seed = "B"
            value = values[int(_bucket(code, user, seed) * len(values))]
            item = {
                "value": value,
                "explanation": f"[mock {role}] chose {value}",
                "evidence": [{"msg_idx": 0, "quote": "", "proves": "mock evidence"}],
                "checked_from": -1,
                "checked_to": -1,
                "na_reason": "mock condition" if value == "N/A" else "",
            }
            if "decision_reason" in spec["properties"]:
                item["decision_reason"] = "[mock arbiter] decided"
            out[code] = item
        return LLMResult(data={"criteria": out}, model=f"mock-{model}", latency_ms=1)


def _bucket(*parts):
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 2**32


@lru_cache(maxsize=1)
def get_client():
    provider = settings.CQA_LLM_PROVIDER
    if provider == "anthropic":
        return AnthropicClient()
    if provider == "mock":
        return MockClient()
    raise ValueError(f"Unknown CQA_LLM_PROVIDER: {provider}")
