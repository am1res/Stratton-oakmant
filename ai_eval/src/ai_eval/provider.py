"""Judge provider protocol and the mock provider.

The live adapter is in ai_eval.openai_provider. Mock mode never reaches an
API, and live mode is never downgraded into a mock result.
"""

from __future__ import annotations

import json
from typing import Protocol

from ai_eval.models import (
    UNKNOWN_USAGE,
    Checklist,
    Conversation,
    Criterion,
    ProviderRequest,
    ProviderResponse,
)


class JudgeProvider(Protocol):
    provider_name: str
    model_name: str

    async def complete(
        self,
        request: ProviderRequest,
        *,
        conversation: Conversation,
        checklist: Checklist,
    ) -> ProviderResponse:
        """Return the raw model text. Do not log the transcript or any API key."""


class MockProvider:
    """Deterministic structural placeholder.

    Variant "a" answers with the first configured value for each criterion,
    variant "b" with the last, so two mock judges disagree and exercise the
    comparison path. Neither reads the transcript or depends on criterion names.
    """

    provider_name = "mock"

    def __init__(self, variant: str = "a", *, undecided: bool = False) -> None:
        if variant not in ("a", "b"):
            raise ValueError("mock variant must be 'a' or 'b'")
        self.variant = variant
        self.undecided = undecided
        self.model_name = "mock-adjudicator" if undecided else f"mock-{variant}"

    async def complete(
        self,
        request: ProviderRequest,
        *,
        conversation: Conversation,
        checklist: Checklist,
    ) -> ProviderResponse:
        del request
        payload = {
            "criteria": [
                _undecided_item(criterion)
                if self.undecided
                else _mock_item(criterion, conversation, self.variant)
                for criterion in checklist.criteria
            ]
        }
        return ProviderResponse(
            raw_text=json.dumps(payload, ensure_ascii=False),
            usage=UNKNOWN_USAGE,
            provider=self.provider_name,
            model=self.model_name,
            finish_reason="stop",
        )


def _undecided_item(criterion: Criterion) -> dict[str, object]:
    return {
        "criterion_id": criterion.criterion_id,
        "applicability": "undetermined",
        "answer": None,
        "explanation": "Mock adjudicator does not decide disputes.",
        "evidence_message_ids": [],
        "checked_range": None,
        "na_reason": None,
        "needs_human_review": True,
        "review_reason": "Mock adjudicator does not decide disputes.",
    }


def _mock_item(criterion: Criterion, conversation: Conversation, variant: str) -> dict[str, object]:
    operator_ids = [
        message.message_id
        for message in conversation.messages
        if message.speaker.value == "operator"
    ]
    if operator_ids:
        return {
            "criterion_id": criterion.criterion_id,
            "applicability": "applicable",
            "answer": _placeholder_answer(criterion, variant),
            "explanation": (
                "Mock provider returned a structural placeholder. "
                "It did not judge the transcript."
            ),
            "evidence_message_ids": [operator_ids[0]],
            "checked_range": None,
            "na_reason": None,
            "needs_human_review": False,
            "review_reason": None,
        }
    message_ids = [message.message_id for message in conversation.messages]
    checked_range = None
    if message_ids:
        checked_range = {
            "start_message_id": message_ids[0],
            "end_message_id": message_ids[-1],
        }
    if criterion.allow_na:
        return {
            "criterion_id": criterion.criterion_id,
            "applicability": "not_applicable",
            "answer": None,
            "explanation": (
                "Mock provider returned not_applicable because this criterion "
                "allows N/A and no operator message is present. "
                "It did not judge the transcript."
            ),
            "evidence_message_ids": [],
            "checked_range": checked_range,
            "na_reason": criterion.na_rule,
            "needs_human_review": False,
            "review_reason": None,
        }
    return {
        "criterion_id": criterion.criterion_id,
        "applicability": "undetermined",
        "answer": None,
        "explanation": "Mock provider left this criterion undetermined. It did not judge the transcript.",
        "evidence_message_ids": [],
        "checked_range": checked_range,
        "na_reason": None,
        "needs_human_review": True,
        "review_reason": (
            "No operator message is present, and this criterion does not allow N/A."
        ),
    }


def _placeholder_answer(criterion: Criterion, variant: str) -> bool | int | float | str:
    pick = 0 if variant == "a" else -1
    if criterion.answer_type == "boolean":
        return variant == "a"
    if criterion.answer_type == "categorical":
        return criterion.allowed_values[pick]
    scale = criterion.scale
    if scale.allowed_values:
        return scale.allowed_values[pick]
    if scale.anchors:
        return scale.anchors[pick].value
    bound = scale.minimum if variant == "a" else scale.maximum
    if bound is None:
        raise RuntimeError("numeric criterion has no configured placeholder value")
    return bound
