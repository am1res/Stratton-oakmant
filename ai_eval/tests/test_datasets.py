import pytest

from ai_eval.datasets import conversation_from_record, dataset_records, find_record
from ai_eval.errors import ConfigurationError


def _record() -> dict:
    return {
        "conversation_id": "p1-ru-001",
        "channel": "agent chat",
        "language": "RU",
        "audio_url": None,
        "transcript": [
            {"timestamp": "00:00", "speaker": "client", "text": "Вопрос"},
            {"timestamp": "00:38", "speaker": "system", "text": "Эскалация на оператора."},
            {"timestamp": "01:15", "speaker": "operator", "text": "Ответ"},
        ],
    }


def test_envelope_shapes_are_accepted() -> None:
    record = _record()
    assert dataset_records({"data": {"records": [record]}}) == [record]
    assert dataset_records({"records": [record]}) == [record]
    assert dataset_records([record]) == [record]
    assert dataset_records(record) == [record]
    with pytest.raises(ConfigurationError):
        dataset_records({"data": {}})


def test_record_becomes_conversation_with_positional_ids() -> None:
    conversation = conversation_from_record(_record())
    assert conversation.conversation_id == "p1-ru-001"
    assert conversation.language.value == "RU"
    assert [m.message_id for m in conversation.messages] == [
        "p1-ru-001#0",
        "p1-ru-001#1",
        "p1-ru-001#2",
    ]
    assert [m.timestamp for m in conversation.messages] == ["00:00", "00:38", "01:15"]
    assert conversation.messages[2].speaker.value == "operator"


def test_bad_record_and_missing_id_are_configuration_errors() -> None:
    broken = _record()
    broken["transcript"][0]["speaker"] = "narrator"
    with pytest.raises(ConfigurationError):
        conversation_from_record(broken)
    with pytest.raises(ConfigurationError, match="not in the dataset"):
        find_record([_record()], "p9-xx-999")
