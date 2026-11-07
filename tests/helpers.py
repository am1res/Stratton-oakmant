import json
from pathlib import Path

from checklists.serializers import ChecklistVersionSerializer
from checklists.services import create_version, get_or_create_checklist
from evaluations.services.llm import LLMResult
from ingestion.services import import_payload

SEED = Path(__file__).resolve().parents[1] / "checklists" / "seed" / "freedom_broker_v1.json"

SAMPLE_PAYLOAD = {
    "error": "",
    "isSuccess": True,
    "data": {
        "dataset_group_id": "DEV",
        "total_records": 2,
        "records": [
            {
                "conversation_id": "p1-ru-001",
                "channel": "agent chat",
                "language": "RU",
                "transcript": [
                    {"timestamp": "00:00", "speaker": "bot", "text": "Здравствуйте! Чем помочь?"},
                    {"timestamp": "00:02", "speaker": "client", "text": "Какие тарифы на торговлю?"},
                    {"timestamp": "00:40", "speaker": "operator", "text": "Здравствуйте! Меня зовут Айгерим."},
                    {"timestamp": "01:10", "speaker": "operator", "text": "Тариф Standard: комиссия 0,1%."},
                    {"timestamp": "01:30", "speaker": "client", "text": "Спасибо"},
                    {"timestamp": "01:45", "speaker": "operator", "text": "Чем ещё помочь? До свидания!"},
                    {"timestamp": "01:50", "speaker": "system", "text": "Chat closed"},
                ],
                "audio_url": None,
            },
            {
                "conversation_id": "call-en-001",
                "channel": "voice call",
                "language": "EN",
                "transcript": [
                    {"timestamp": "2025-05-01T10:00:00+05:00", "speaker": "operator", "text": "Hello, this is Dan."},
                    {"timestamp": "2025-05-01T10:00:07+05:00", "speaker": "client", "text": "Hi, my card is blocked."},
                    {"timestamp": "2025-05-01T10:01:00+05:00", "speaker": "operator", "text": "Let me check."},
                ],
                "audio_url": "https://example.com/call-en-001.mp3",
            },
        ],
    },
}


def seed_checklist():
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    body = ChecklistVersionSerializer(data=seed["version"])
    body.is_valid(raise_exception=True)
    return create_version(get_or_create_checklist(seed["checklist"]["name"]), body.validated_data)


def import_sample(group_id="DEV"):
    return import_payload(group_id, SAMPLE_PAYLOAD)


def verdict(value, idx=2, explanation="ok", **extra):
    return {
        "value": value,
        "explanation": explanation,
        "evidence": [{"msg_idx": idx, "quote": "", "proves": "something"}],
        "checked_from": -1,
        "checked_to": -1,
        "na_reason": "condition met" if value == "N/A" else "",
        **extra,
    }


class ScriptedClient:
    """Fake LLM: per role, a dict code -> value (missing codes default to the first allowed value)."""

    def __init__(self, scripts, fail_roles=()):
        self.scripts = scripts
        self.fail_roles = set(fail_roles)
        self.calls = []

    def complete_json(self, *, role, model, effort, system_blocks, user, schema):
        from evaluations.services.llm import LLMError

        self.calls.append({"role": role, "schema": schema, "system": system_blocks, "user": user})
        if role in self.fail_roles:
            raise LLMError(f"{role} scripted failure")
        criteria = schema["properties"]["criteria"]["properties"]
        out = {}
        for code, spec in criteria.items():
            value = self.scripts.get(role, {}).get(code, spec["properties"]["value"]["enum"][0])
            extra = {"decision_reason": "arbiter says so"} if "decision_reason" in spec["properties"] else {}
            out[code] = verdict(value, explanation=f"{role} on {code}", **extra)
        return LLMResult(data={"criteria": out}, model=model, latency_ms=5, usage={"input_tokens": 1})
