import json

import pytest

from ai_eval.errors import ConfigurationError
from ai_eval.models import parse_checklist, parse_conversation

from helpers import FIXTURES


def test_demo_fixtures_load_and_keep_timestamps() -> None:
    for name in ("ru.json", "kz.json", "en.json"):
        raw = json.loads((FIXTURES / "conversations" / name).read_text(encoding="utf-8"))
        conversation = parse_conversation(raw)
        assert [message.timestamp for message in conversation.messages] == [
            message["timestamp"] for message in raw["messages"]
        ]
        assert conversation.language.value == raw["language"]
    checklist = parse_checklist(
        json.loads((FIXTURES / "checklists" / "demo.json").read_text(encoding="utf-8"))
    )
    assert "DEMO CHECKLIST" in checklist.shared_instructions
    assert "not an official" in checklist.shared_instructions
    assert [criterion.answer_type for criterion in checklist.criteria] == [
        "boolean",
        "boolean",
        "numeric",
        "categorical",
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {"answer_type": "numeric", "scale": {}},
        {"answer_type": "numeric", "scale": {"step": 1}},
        {"answer_type": "numeric", "scale": {"minimum": 0, "step": 1}},
        {
            "answer_type": "numeric",
            "scale": {
                "allowed_values": [0, 1],
                "anchors": [
                    {"value": 0, "description": "Low"},
                    {"value": 2, "description": "High"},
                ],
            },
        },
        {"answer_type": "boolean", "allow_na": True},
        {"answer_type": "boolean", "allow_na": False, "na_rule": "Unused rule"},
        {"answer_type": "categorical", "allowed_values": ["Yes", "Yes"]},
        {"answer_type": "boolean", "allowed_values": ["yes", "no"]},
    ],
)
def test_incomplete_rubric_is_a_configuration_error(payload: dict) -> None:
    criterion = {
        "criterion_id": "custom_rule",
        "name": "Custom rule",
        "description": "A caller-supplied rule.",
        "allow_na": False,
    }
    criterion.update(payload)
    with pytest.raises(ConfigurationError) as caught:
        parse_checklist(
            {
                "checklist_version_id": "bad",
                "shared_instructions": "",
                "criteria": [criterion],
            }
        )
    message = str(caught.value)
    assert "configuration error" in message
    assert "Custom rule" not in message


def test_duplicate_criterion_and_weight_are_rejected() -> None:
    criterion = {
        "criterion_id": "custom_rule",
        "name": "Custom rule",
        "description": "A caller-supplied rule.",
        "answer_type": "boolean",
        "allow_na": False,
    }
    with pytest.raises(ConfigurationError):
        parse_checklist(
            {
                "checklist_version_id": "bad",
                "shared_instructions": "",
                "criteria": [criterion, dict(criterion)],
            }
        )
    weighted = dict(criterion)
    weighted["weight"] = 10
    with pytest.raises(ConfigurationError):
        parse_checklist(
            {
                "checklist_version_id": "bad",
                "shared_instructions": "",
                "criteria": [weighted],
            }
        )


def test_duplicate_message_id_is_rejected() -> None:
    with pytest.raises(ConfigurationError):
        parse_conversation(
            {
                "conversation_id": "dup",
                "channel": "agent chat",
                "language": "RU",
                "messages": [
                    {"message_id": "m1", "timestamp": "00:00", "speaker": "client", "text": "One"},
                    {"message_id": "m1", "timestamp": "00:01", "speaker": "operator", "text": "Two"},
                ],
            }
        )
