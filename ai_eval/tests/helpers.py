import json
from pathlib import Path

from ai_eval.models import Checklist, Conversation, ProviderRequest, ProviderResponse

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"
SRC = ROOT / "src"
SOURCE = SRC

OFFICIAL_CRITERION_NAMES = [
    "Установление контакта",
    "Выявление потребности",
    "Идентификация",
    "Корректная и полная консультация",
    "Эмпатия и клиентоориентированность",
    "Управление диалогом, скорость и грамотность",
    "Завершение",
    "Грубые ошибки",
]


def load_demo() -> tuple[Conversation, Checklist]:
    conversation = Conversation.model_validate(
        json.loads((FIXTURES / "conversations" / "ru.json").read_text(encoding="utf-8"))
    )
    checklist = Checklist.model_validate(
        json.loads((FIXTURES / "checklists" / "demo.json").read_text(encoding="utf-8"))
    )
    return conversation, checklist


def conversation(messages: list[dict[str, str]] | None = None) -> Conversation:
    if messages is None:
        messages = [
            {"message_id": "m1", "timestamp": "00:00", "speaker": "client", "text": "Question"},
            {"message_id": "m2", "timestamp": "00:01", "speaker": "operator", "text": "Answer"},
        ]
    return Conversation.model_validate(
        {
            "conversation_id": "conv-1",
            "channel": "agent chat",
            "language": "EN",
            "messages": messages,
        }
    )


def checklist(criteria: list[dict]) -> Checklist:
    return Checklist.model_validate(
        {
            "checklist_version_id": "test-list",
            "shared_instructions": "Test rubric.",
            "criteria": criteria,
        }
    )


def boolean_criterion(**overrides: object) -> dict:
    data: dict[str, object] = {
        "criterion_id": "demo_bool",
        "name": "Demo boolean",
        "description": "Synthetic boolean criterion.",
        "answer_type": "boolean",
        "allow_na": False,
    }
    data.update(overrides)
    return data


def applicable_boolean(criterion_id: str = "demo_bool") -> dict:
    return {
        "criterion_id": criterion_id,
        "applicability": "applicable",
        "answer": True,
        "explanation": "The operator message m2 is the cited evidence.",
        "evidence_message_ids": ["m2"],
        "checked_range": None,
        "na_reason": None,
        "needs_human_review": False,
        "review_reason": None,
    }


class StubProvider:
    provider_name = "stub"
    model_name = "stub-model"

    def __init__(
        self,
        raw_text: str = "",
        usage: object | None = None,
        error: Exception | None = None,
    ) -> None:
        self.raw_text = raw_text
        self.usage = usage
        self.error = error
        self.requests: list[ProviderRequest] = []

    async def complete(
        self,
        request: ProviderRequest,
        *,
        conversation: Conversation,
        checklist: Checklist,
    ) -> ProviderResponse:
        del conversation, checklist
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        from ai_eval.models import UNKNOWN_USAGE, UsageMetadata

        usage = self.usage if isinstance(self.usage, UsageMetadata) else UNKNOWN_USAGE
        return ProviderResponse(
            raw_text=self.raw_text,
            usage=usage,
            provider=self.provider_name,
            model=self.model_name,
        )
