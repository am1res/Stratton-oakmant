import json

from ai_eval.baseline import compare_judgments, load_id_map, load_reference
from ai_eval.models import Applicability, CriterionJudgment
from ai_eval.prompt import build_prompt

from helpers import FIXTURES, conversation, load_demo


def _judgment(criterion_id: str, applicability: str, answer: object) -> CriterionJudgment:
    return CriterionJudgment(
        criterion_id=criterion_id,
        applicability=Applicability(applicability),
        answer=answer,
        explanation="placeholder",
        evidence_message_ids=["m2"] if applicability == "applicable" else [],
        checked_range=None,
        na_reason="not needed" if applicability == "not_applicable" else None,
        needs_human_review=applicability == "undetermined",
        review_reason="unresolved" if applicability == "undetermined" else None,
    )


def test_reference_values_match_applicability_and_typed_answers(tmp_path) -> None:
    path = tmp_path / "reference.json"
    path.write_text(
        json.dumps(
            {
                "results": [
                    {
                        "conversation_id": "conv-1",
                        "criteria": [
                            {"criterion_id": "contact", "value": True},
                            {"criterion_id": "discovery", "value": None},
                            {"criterion_id": "consultation", "value": 20},
                            {"criterion_id": "critical", "value": False},
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    answers = load_reference(path)["conv-1"]
    id_map = {
        "contact": "c01",
        "discovery": "c02",
        "consultation": "c04",
        "critical": "c08",
    }
    judgments = [
        _judgment("c01", "applicable", True),
        _judgment("c02", "not_applicable", None),
        _judgment("c04", "applicable", 20.0),
        _judgment("c08", "undetermined", None),
    ]
    diffs = {item.reference_id: item for item in compare_judgments(judgments, answers, id_map)}
    assert diffs["contact"].matched is True
    assert diffs["discovery"].matched is True
    assert diffs["consultation"].matched is True
    assert diffs["critical"].matched is False
    assert diffs["critical"].actual_value == "undetermined"


def test_shipped_map_covers_the_reference_names() -> None:
    mapping = load_id_map()
    assert set(mapping) == {
        "contact",
        "discovery",
        "identification",
        "consultation",
        "empathy",
        "dialogue",
        "closure",
        "critical",
    }
    assert len(set(mapping.values())) == 8


def test_official_checklist_puts_the_clarifications_in_the_prompt() -> None:
    checklist_path = FIXTURES / "checklists" / "official_chat_v1.json"
    payload = json.loads(checklist_path.read_text(encoding="utf-8"))
    from ai_eval.models import parse_checklist

    checklist = parse_checklist(payload)
    prompt = build_prompt(conversation(), checklist).messages[1].content
    for phrase in (
        "даже если оператор зря переспросил",
        "если неверный первый ответ исправлен в том же диалоге",
        "Один сбой = 7",
        "это сбой здесь, а не в критерии выявления потребности",
        "Голое разговорное",
        "Сау болыңыз!",
    ):
        assert phrase in prompt
    assert checklist.checklist_version_id.endswith("v2")


def test_demo_prompt_does_not_gain_the_official_clarifications() -> None:
    conversation_demo, checklist = load_demo()
    prompt = build_prompt(conversation_demo, checklist).messages[1].content
    assert "Сау болыңыз" not in prompt
    assert "зря переспросил" not in prompt
