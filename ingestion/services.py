"""Import conversations from the organizers' API (or an uploaded payload of the same shape)."""
import logging
from datetime import datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests
from django.conf import settings
from django.db import transaction

from .models import Conversation, Dataset, Message

logger = logging.getLogger("cqa.ingestion")


class DatasetImportError(Exception):
    pass


def parse_offset(timestamp):
    """Return seconds for "MM:SS" / "HH:MM:SS" or an ISO 8601 datetime, else None.

    ISO values are returned as epoch seconds; the caller turns them into offsets.
    """
    if not timestamp:
        return None
    value = timestamp.strip()
    parts = value.split(":")
    if 2 <= len(parts) <= 3 and all(p.replace(".", "", 1).isdigit() for p in parts):
        seconds = 0.0
        for part in parts:
            seconds = seconds * 60 + float(part)
        return seconds
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def group_url(base_url, group_id):
    """Set group_id on the configured link, replacing one already in it.

    The API rejects duplicate query keys, and the copied link may already carry group_id.
    """
    parts = urlsplit(base_url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "group_id"]
    query.append(("group_id", group_id))
    return urlunsplit(parts._replace(query=urlencode(query)))


def fetch_group(group_id):
    if not settings.CQA_DATASET_API_URL:
        raise DatasetImportError("CQA_DATASET_API_URL is not configured")
    try:
        response = requests.get(
            group_url(settings.CQA_DATASET_API_URL, group_id), timeout=settings.CQA_DATASET_API_TIMEOUT
        )
    except requests.RequestException as exc:
        raise DatasetImportError(f"Dataset API request failed: {exc}") from exc
    if not response.ok:
        raise DatasetImportError(f"Dataset API returned HTTP {response.status_code}: {response.text[:500]}")
    try:
        return response.json()
    except ValueError as exc:
        raise DatasetImportError(f"Dataset API returned invalid JSON: {exc}") from exc


def extract_records(payload):
    """Accept the full API response, its `data` object, or a bare list of records."""
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        raise DatasetImportError("Payload must be an object or a list of records")
    if "isSuccess" in payload and not payload["isSuccess"]:
        raise DatasetImportError(f"Dataset API returned an error: {payload.get('error') or 'unknown'}")
    data = payload.get("data", payload)
    records = data.get("records")
    if not isinstance(records, list):
        raise DatasetImportError("Payload has no `records` list")
    for i, record in enumerate(records):
        if not isinstance(record, dict) or not record.get("conversation_id"):
            raise DatasetImportError(f"Record {i} has no conversation_id")
    return records


@transaction.atomic
def import_payload(group_id, payload):
    """Idempotent upsert: re-importing a group replaces each conversation's transcript."""
    records = extract_records(payload)
    dataset, _ = Dataset.objects.update_or_create(
        group_id=group_id,
        defaults={"total_records": len(records), "raw_response": payload if isinstance(payload, dict) else {}},
    )
    for record in records:
        conversation, _ = Conversation.objects.update_or_create(
            dataset=dataset,
            conversation_id=record["conversation_id"],
            defaults={
                "channel": record.get("channel", Conversation.Channel.CHAT),
                "language": (record.get("language") or "").upper(),
                "audio_url": record.get("audio_url") or None,
            },
        )
        conversation.messages.all().delete()
        Message.objects.bulk_create(build_messages(conversation, record.get("transcript") or []))
    logger.info("Imported %d conversations for group %s", len(records), group_id)
    return dataset


def build_messages(conversation, transcript):
    raw_offsets = [parse_offset(item.get("timestamp", "")) for item in transcript]
    base = next((o for o in raw_offsets if o is not None), None)
    return [
        Message(
            conversation=conversation,
            idx=idx,
            speaker=item.get("speaker", Message.Speaker.SYSTEM),
            timestamp_raw=item.get("timestamp", ""),
            offset_sec=None if offset is None or base is None else round(offset - base, 3),
            text=item.get("text", ""),
        )
        for idx, (item, offset) in enumerate(zip(transcript, raw_offsets))
    ]


def import_group(group_id):
    return import_payload(group_id, fetch_group(group_id))
