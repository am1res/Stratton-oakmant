"""Import adapter for the organizers' dataset export.

The export has no message ids. This adapter assigns stable ids from the
transcript position: "<conversation_id>#<index>". Timestamps are copied
unchanged. Audio links are dropped; they are not part of the evaluation input.
"""

from __future__ import annotations

from typing import Any

from ai_eval.errors import ConfigurationError
from ai_eval.models import Conversation, parse_conversation


def dataset_records(payload: object) -> list[dict[str, Any]]:
    """Accept the raw API envelope, a {"records": [...]} object, or a bare list."""
    if isinstance(payload, dict):
        if isinstance(payload.get("data"), dict) and isinstance(payload["data"].get("records"), list):
            records = payload["data"]["records"]
        elif isinstance(payload.get("records"), list):
            records = payload["records"]
        elif "conversation_id" in payload and "transcript" in payload:
            records = [payload]
        else:
            raise ConfigurationError("dataset JSON has no records")
    elif isinstance(payload, list):
        records = payload
    else:
        raise ConfigurationError("dataset JSON must be an object or a list")
    if not all(isinstance(record, dict) for record in records):
        raise ConfigurationError("dataset records must be objects")
    return records


def conversation_from_record(record: dict[str, Any]) -> Conversation:
    conversation_id = record.get("conversation_id")
    transcript = record.get("transcript")
    if not isinstance(conversation_id, str) or not conversation_id:
        raise ConfigurationError("dataset record has no conversation_id")
    if not isinstance(transcript, list):
        raise ConfigurationError(f"{conversation_id}: transcript is not a list")
    messages = []
    for index, item in enumerate(transcript):
        if not isinstance(item, dict):
            raise ConfigurationError(f"{conversation_id}: transcript[{index}] is not an object")
        messages.append(
            {
                "message_id": f"{conversation_id}#{index}",
                "timestamp": str(item.get("timestamp", "")),
                "speaker": item.get("speaker"),
                "text": item.get("text", ""),
            }
        )
    return parse_conversation(
        {
            "conversation_id": conversation_id,
            "channel": record.get("channel"),
            "language": record.get("language"),
            "messages": messages,
        }
    )


def find_record(records: list[dict[str, Any]], conversation_id: str) -> dict[str, Any]:
    for record in records:
        if record.get("conversation_id") == conversation_id:
            return record
    raise ConfigurationError(f"conversation {conversation_id} is not in the dataset")
