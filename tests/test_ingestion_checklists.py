import copy
import json

from django.test import TestCase

from ingestion.models import Conversation
from ingestion.services import DatasetImportError, group_url, import_payload

from .helpers import SAMPLE_PAYLOAD, SEED, import_sample, seed_checklist


class IngestionTests(TestCase):
    def test_import_preserves_timestamps_and_computes_offsets(self):
        import_sample()
        call = Conversation.objects.get(conversation_id="call-en-001")
        messages = list(call.messages.all())
        self.assertEqual(messages[1].timestamp_raw, "2025-05-01T10:00:07+05:00")
        self.assertEqual([m.offset_sec for m in messages], [0.0, 7.0, 60.0])
        self.assertEqual(call.audio_url, "https://example.com/call-en-001.mp3")
        chat = Conversation.objects.get(conversation_id="p1-ru-001")
        self.assertEqual(chat.messages.get(idx=3).offset_sec, 70.0)
        self.assertFalse(chat.messages.get(idx=0).is_evaluable)

    def test_reimport_is_idempotent(self):
        import_sample()
        payload = copy.deepcopy(SAMPLE_PAYLOAD)
        payload["data"]["records"][0]["transcript"] = payload["data"]["records"][0]["transcript"][:2]
        import_payload("DEV", payload)
        self.assertEqual(Conversation.objects.count(), 2)
        self.assertEqual(Conversation.objects.get(conversation_id="p1-ru-001").messages.count(), 2)

    def test_group_url_replaces_existing_group_id(self):
        url = group_url("https://x.test/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sig=abc&group_id=DEV", "CTRL")
        self.assertEqual(url, "https://x.test/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sig=abc&group_id=CTRL")
        self.assertEqual(group_url("https://x.test/invoke", "DEV"), "https://x.test/invoke?group_id=DEV")

    def test_api_error_is_reported(self):
        with self.assertRaises(DatasetImportError):
            import_payload("X", {"isSuccess": False, "error": "bad group", "data": None})

    def test_upload_endpoint(self):
        response = self.client.post(
            "/api/datasets/upload/", {"group_id": "CONTROL", "payload": SAMPLE_PAYLOAD}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 201, response.content)
        listing = self.client.get("/api/conversations/?group_id=CONTROL").json()
        self.assertEqual(listing["count"], 2)


class ChecklistTests(TestCase):
    def test_seed_creates_active_version(self):
        version = seed_checklist()
        self.assertTrue(version.is_active)
        self.assertEqual(version.criteria.count(), 8)
        c4 = version.criteria.get(code="C4")
        self.assertEqual(c4.allowed_values(), ["20", "15", "10", "5", "0", "N/A"])

    def test_replacing_a_criterion_creates_a_new_version_via_api(self):
        v1 = seed_checklist()
        detail = self.client.get(f"/api/checklist-versions/{v1.id}/").json()
        criteria = [c for c in detail["criteria"] if c["code"] != "C5"]
        criteria.append({
            "code": "C9", "title": "Offers mobile app", "answer_type": "binary", "weight": 15,
            "na_allowed": False, "na_condition": "", "rule_text": "YES = the operator mentioned the mobile app.",
        })
        body = {"comment": "Replace C5", "clarifications": detail["clarifications"], "sections": [], "criteria": criteria}
        response = self.client.post(
            f"/api/checklists/{v1.checklist_id}/versions/", json.dumps(body), content_type="application/json"
        )
        self.assertEqual(response.status_code, 201, response.content)
        v2 = response.json()
        self.assertEqual(v2["version"], 2)
        self.assertTrue(v2["is_active"])
        self.assertIn("C9", [c["code"] for c in v2["criteria"]])
        v1.refresh_from_db()
        self.assertFalse(v1.is_active)
        self.assertEqual(v1.criteria.count(), 8)  # old version untouched

    def test_invalid_criterion_rejected(self):
        v1 = seed_checklist()
        seed = json.loads(SEED.read_text(encoding="utf-8"))["version"]
        seed["criteria"][3]["allowed_steps"] = []
        response = self.client.post(
            f"/api/checklists/{v1.checklist_id}/versions/", json.dumps(seed), content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)
