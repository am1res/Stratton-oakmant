import json
from pathlib import Path

from ai_eval.models import Applicability, CriterionJudgment, EvaluationResult, EvaluationStatus, JudgeRole, JudgeRun, UsageSummary, ValidationStatus
from ai_eval.team_node import checklist_from_team, conversation_from_team, to_team_result

ROOT = Path(__file__).resolve().parents[2]
CHECKLIST = json.loads((ROOT / "contracts" / "checklist.default.json").read_text(encoding="utf-8"))


def _judgment(criterion_id: str, applicability: str, answer: object) -> CriterionJudgment:
    return CriterionJudgment(
        criterion_id=criterion_id,
        applicability=Applicability(applicability),
        answer=answer,
        explanation="because",
        evidence_message_ids=["9"] if applicability == "applicable" else [],
        checked_range=None,
        na_reason="rule" if applicability == "not_applicable" else None,
        needs_human_review=applicability == "undetermined",
        review_reason="review" if applicability == "undetermined" else None,
    )


def _run(role: JudgeRole, judgments: list[CriterionJudgment]) -> JudgeRun:
    return JudgeRun(
        role=role,
        provider="test",
        model="test-model",
        prompt_version="v",
        judgments=judgments,
        usage={"usage_known": False, "request_count": 1},
        latency_ms=1,
        validation_status=ValidationStatus.valid,
        validation_errors=[],
    )


def test_team_checklist_and_transcript_map_into_our_models() -> None:
    checklist = checklist_from_team(CHECKLIST)
    by_id = {item.criterion_id: item for item in checklist.criteria}
    assert by_id["c01"].answer_type == "boolean"
    assert by_id["c01"].allow_na is False
    assert by_id["c02"].allow_na is True
    assert by_id["c04"].answer_type == "numeric"
    assert by_id["c04"].scale.anchors[0].value == 20
    assert by_id["c08"].answer_type == "boolean"
    conversation = conversation_from_team(
        {
            "conversation_id": "p1-ru-001",
            "channel": "agent chat",
            "language": "RU",
            "transcript": [
                {"msg_index": 9, "timestamp": "01:15", "speaker": "operator", "text": "Здравствуйте"},
            ],
        }
    )
    assert conversation.messages[0].message_id == "9"
    assert conversation.messages[0].timestamp == "01:15"


def test_result_maps_back_to_scoring_answers_and_message_indices() -> None:
    judgments = [
        _judgment("c01", "applicable", True),
        _judgment("c02", "not_applicable", None),
        _judgment("c04", "applicable", 20),
        _judgment("c08", "applicable", False),
    ]
    result = EvaluationResult(
        conversation_id="p1-ru-001",
        checklist_version_id="cqa-default-v1",
        status=EvaluationStatus.completed,
        criterion_results=judgments,
        judge_runs=[_run(JudgeRole.judge_a, judgments), _run(JudgeRole.judge_b, judgments)],
        disputed_criterion_ids=[],
        unresolved_criterion_ids=[],
        usage=UsageSummary(provider_request_count=2, usage_known=False),
    )
    payload = to_team_result(
        CHECKLIST,
        {"transcript": [{"msg_index": 9, "timestamp": "01:15", "speaker": "operator", "text": "Здравствуйте"}]},
        result,
    )
    by_id = {item["criterion_id"]: item for item in payload["criteria"]}
    assert by_id["c01"]["answer"] == "yes"
    assert by_id["c01"]["evidence_msg_indices"] == [9]
    assert by_id["c01"]["evidence"][0]["quote"] == "Здравствуйте"
    assert by_id["c01"]["agreement"] == "agreed"
    assert by_id["c01"]["confidence"] == 1
    assert by_id["c02"]["answer"] == "na"
    assert by_id["c04"]["answer"] == 20
    assert by_id["c08"]["answer"] == "no"
    assert "Здравствуйте" not in json.dumps(payload["prompt"])


def test_each_judges_own_answer_is_returned_by_role() -> None:
    # judge A says yes, judge B says no, the adjudicator decides yes: per-judge accuracy needs all three
    a = [_judgment("c01", "applicable", True), _judgment("c02", "not_applicable", None)]
    b = [_judgment("c01", "applicable", False), _judgment("c02", "not_applicable", None)]
    adj = [_judgment("c01", "applicable", True)]
    result = EvaluationResult(
        conversation_id="p1-ru-001",
        checklist_version_id="cqa-default-v1",
        status=EvaluationStatus.completed,
        criterion_results=[adj[0], a[1]],
        judge_runs=[_run(JudgeRole.judge_a, a), _run(JudgeRole.judge_b, b), _run(JudgeRole.adjudicator, adj)],
        disputed_criterion_ids=["c01"],
        unresolved_criterion_ids=[],
        usage=UsageSummary(provider_request_count=3, usage_known=False),
    )
    payload = to_team_result(CHECKLIST, {"transcript": [{"msg_index": 9, "timestamp": "01:15", "speaker": "operator", "text": "x"}]}, result)
    by_id = {item["criterion_id"]: item for item in payload["criteria"]}
    assert by_id["c01"]["judge_answers"] == {"judge_a": "yes", "judge_b": "no", "adjudicator": "yes"}
    assert by_id["c02"]["judge_answers"] == {"judge_a": "na", "judge_b": "na"}
