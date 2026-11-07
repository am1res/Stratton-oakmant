from unittest import mock

from django.test import TestCase

from evaluations.services import pipeline
from evaluations.services.runs import start_run
from ingestion.models import Conversation

from .helpers import ScriptedClient, import_sample, seed_checklist
from .test_pipeline import GOOD


class AppealTests(TestCase):
    def setUp(self):
        version = seed_checklist()
        import_sample()
        conversation = Conversation.objects.get(conversation_id="p1-ru-001")
        run = start_run(version, [conversation], background=False)
        with mock.patch.object(pipeline, "get_client", return_value=ScriptedClient({"A": GOOD, "B": GOOD})):
            self.evaluation = pipeline.evaluate(run.evaluations.get().id)
        self.c6 = self.evaluation.results.get(criterion__code="C6")

    def appeal(self, comment="The operator kept the client waiting"):
        return self.client.post(
            f"/api/criterion-results/{self.c6.id}/appeals/", {"comment": comment}, content_type="application/json"
        )

    def decide(self, appeal_id, **body):
        return self.client.post(f"/api/appeals/{appeal_id}/decision/", body, content_type="application/json")

    def test_change_recalculates_total_and_keeps_audit_trail(self):
        response = self.appeal()
        self.assertEqual(response.status_code, 201, response.content)
        appeal = response.json()
        self.assertEqual(appeal["criterion"]["disputed_value"], "10")
        self.assertTrue(appeal["fragment"])

        response = self.decide(appeal["id"], decision="change", new_value="4", reason="Client re-asked twice")
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["previous_total"], 100.0)

        self.evaluation.refresh_from_db()
        # C6: 4/10*15 = 6 -> earned 56 of 65
        self.assertEqual(self.evaluation.total_score, round(56 / 65 * 100, 2))
        self.assertEqual(self.evaluation.ai_total_score, 100.0)

        audit = self.client.get(f"/api/evaluations/{self.evaluation.id}/audit/").json()
        self.assertTrue(audit["changed"])
        c6 = next(c for c in audit["criteria"] if c["code"] == "C6")
        self.assertEqual((c6["ai_value"], c6["final_value"], c6["source"]), ("10", "4", "review"))
        self.assertEqual(c6["appeals"][0]["decision"]["reason"], "Client re-asked twice")

    def test_confirm_keeps_score(self):
        appeal = self.appeal().json()
        response = self.decide(appeal["id"], decision="confirm", reason="Replies were clear")
        self.assertEqual(response.status_code, 201, response.content)
        self.evaluation.refresh_from_db()
        self.assertEqual(self.evaluation.total_score, 100.0)

    def test_reason_is_mandatory_and_value_must_be_allowed(self):
        appeal = self.appeal().json()
        self.assertEqual(self.decide(appeal["id"], decision="change", new_value="4", reason="").status_code, 400)
        self.assertEqual(self.decide(appeal["id"], decision="change", new_value="5", reason="x").status_code, 400)

    def test_only_one_open_appeal_per_criterion(self):
        self.appeal()
        self.assertEqual(self.appeal().status_code, 400)

    def test_reviewer_queue(self):
        self.appeal()
        queue = self.client.get("/api/appeals/?status=open").json()
        self.assertEqual(queue["count"], 1)
        self.assertEqual(queue["results"][0]["criterion"]["code"], "C6")
