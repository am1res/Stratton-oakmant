from unittest import mock

from django.test import TestCase, override_settings

from evaluations.models import CriterionResult, Evaluation, Status
from evaluations.services import pipeline
from evaluations.services.runs import start_run
from ingestion.models import Conversation

from .helpers import ScriptedClient, import_sample, seed_checklist

GOOD = {"C1": "YES", "C2": "N/A", "C3": "N/A", "C4": "20", "C5": "YES", "C6": "10", "C7": "YES", "C8": "NO"}


class PipelineTests(TestCase):
    def setUp(self):
        self.version = seed_checklist()
        import_sample()
        self.conversation = Conversation.objects.get(conversation_id="p1-ru-001")

    def evaluate(self, client):
        run = start_run(self.version, [self.conversation], background=False)
        evaluation = run.evaluations.get()
        with mock.patch.object(pipeline, "get_client", return_value=client):
            return pipeline.evaluate(evaluation.id)

    def test_agreement_skips_arbiter(self):
        client = ScriptedClient({"A": GOOD, "B": GOOD})
        ev = self.evaluate(client)
        self.assertEqual(ev.status, Status.DONE, ev.error)
        self.assertFalse(ev.arbiter_used)
        self.assertEqual(sorted(c["role"] for c in client.calls), ["A", "B"])
        self.assertEqual(ev.total_score, 100.0)
        self.assertFalse(ev.critical_violation)
        self.assertEqual(ev.verdicts.count(), 2)

    def test_disagreement_goes_to_arbiter_for_disputed_criteria_only(self):
        b = {**GOOD, "C6": "7", "C8": "YES"}
        client = ScriptedClient({"A": GOOD, "B": b, "ARBITER": {"C6": "7", "C8": "NO"}})
        ev = self.evaluate(client)
        self.assertEqual(ev.status, Status.DONE, ev.error)
        self.assertTrue(ev.arbiter_used)
        arbiter_call = next(c for c in client.calls if c["role"] == "ARBITER")
        self.assertEqual(set(arbiter_call["schema"]["properties"]["criteria"]["properties"]), {"C6", "C8"})
        c6 = ev.results.get(criterion__code="C6")
        self.assertEqual((c6.value_a, c6.value_b, c6.value_arbiter, c6.final_value), ("10", "7", "7", "7"))
        self.assertEqual(c6.agreement, CriterionResult.Agreement.ARBITRATED)
        self.assertEqual(c6.arbiter_reason, "arbiter says so")
        # Applicable: C1 10 + C4 20 + C5 15 + C6 10.5 + C7 5 = 60.5 of 65.
        self.assertEqual(ev.total_score, round(60.5 / 65 * 100, 2))
        self.assertEqual(ev.ai_total_score, ev.total_score)
        self.assertFalse(ev.critical_violation)

    def test_one_agent_failing_falls_back_to_the_other(self):
        client = ScriptedClient({"B": GOOD}, fail_roles={"A"})
        ev = self.evaluate(client)
        self.assertEqual(ev.status, Status.DONE, ev.error)
        self.assertEqual(ev.results.first().agreement, CriterionResult.Agreement.SINGLE)

    def test_both_agents_failing_marks_evaluation_failed(self):
        ev = self.evaluate(ScriptedClient({}, fail_roles={"A", "B"}))
        self.assertEqual(ev.status, Status.FAILED)
        self.assertIn("Both agents failed", ev.error)

    def test_invalid_evidence_index_is_dropped(self):
        data = {"criteria": {code: {
            "value": value, "explanation": "", "checked_from": 2, "checked_to": 99, "na_reason": "",
            "evidence": [{"msg_idx": 99, "quote": "", "proves": ""}, {"msg_idx": 3, "quote": "", "proves": ""}],
        } for code, value in GOOD.items()}}
        criteria = list(self.version.criteria.all())
        verdicts = pipeline.normalize(data, criteria, valid_idx=set(range(7)))
        self.assertEqual([e["msg_idx"] for e in verdicts["C1"]["evidence"]], [3])
        self.assertIsNone(verdicts["C1"]["checked_range"])

    def test_prompt_is_built_from_the_checklist(self):
        client = ScriptedClient({"A": GOOD, "B": GOOD})
        self.evaluate(client)
        system = client.calls[0]["system"][0]
        self.assertIn("C4: Correct and complete consultation", system)
        self.assertIn("N/A only when: The chat ended before the client stated a request.", system)
        self.assertIn("#0 [00:00] BOT (context): ", client.calls[0]["user"])

    def test_already_done_conversations_are_skipped(self):
        self.evaluate(ScriptedClient({"A": GOOD, "B": GOOD}))
        run = start_run(self.version, [self.conversation], background=False)
        self.assertEqual(run.skipped, 1)
        self.assertEqual(run.evaluations.count(), 0)

    @override_settings(CQA_LLM_PROVIDER="mock")
    def test_runs_api_with_mock_provider(self):
        from evaluations.services import llm, runs

        llm.get_client.cache_clear()
        with mock.patch.object(runs, "dispatch", side_effect=lambda ids: [pipeline.evaluate(i) for i in ids]):
            with self.captureOnCommitCallbacks(execute=True):
                response = self.client.post(
                    "/api/runs/", {"dataset": "DEV"}, content_type="application/json"
                )
        llm.get_client.cache_clear()
        self.assertEqual(response.status_code, 201, response.content)
        run_id = response.json()["id"]
        progress = self.client.get(f"/api/runs/{run_id}/").json()["progress"]
        self.assertEqual(progress["done"], 2, progress)
        ev = Evaluation.objects.filter(run_id=run_id).first()
        detail = self.client.get(f"/api/evaluations/{ev.id}/").json()
        self.assertEqual(len(detail["results"]), 8)
        self.assertIn("message", detail["results"][0]["evidence"][0])
