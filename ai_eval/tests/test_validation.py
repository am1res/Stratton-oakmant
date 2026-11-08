import json

import pytest

from ai_eval.validation import parse_judge_payload

from helpers import applicable_boolean, boolean_criterion, checklist, conversation


def _parse(items: list[dict], criteria: list[dict] | None = None, messages: list[dict] | None = None):
    return parse_judge_payload(
        json.dumps({"criteria": items}),
        conversation(messages),
        checklist(criteria or [boolean_criterion()]),
    )


def test_valid_boolean_judgment_passes() -> None:
    judgments, errors = _parse([applicable_boolean()])
    assert errors == []
    assert judgments[0].answer is True
    assert judgments[0].evidence_message_ids == ["m2"]


def test_false_explanation_is_not_a_structural_failure() -> None:
    item = applicable_boolean()
    item["explanation"] = "The operator was silent."
    judgments, errors = _parse([item])
    assert errors == []
    assert judgments[0].explanation == "The operator was silent."


def test_checked_range_can_stand_in_for_evidence_ids() -> None:
    item = applicable_boolean()
    item["evidence_message_ids"] = []
    item["checked_range"] = {"start_message_id": "m1", "end_message_id": "m2"}
    judgments, errors = _parse([item])
    assert errors == []
    assert judgments[0].checked_range is not None
    assert judgments[0].checked_range.start_message_id == "m1"


def test_same_message_range_is_in_order() -> None:
    item = applicable_boolean()
    item["evidence_message_ids"] = []
    item["checked_range"] = {"start_message_id": "m2", "end_message_id": "m2"}
    _, errors = _parse([item])
    assert errors == []


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda item: item.update({"answer": "yes"}), "answer does not match"),
        (lambda item: item.update({"answer": 1}), "answer does not match"),
        (lambda item: item.update({"answer": None}), "answer does not match"),
        (lambda item: item.update({"evidence_message_ids": []}), "applicable requires"),
        (lambda item: item.update({"evidence_message_ids": ["missing"]}), "not in the conversation"),
        (lambda item: item.update({"evidence_message_ids": ["m2", "m2"]}), "duplicate evidence"),
        (
            lambda item: item.update(
                {"checked_range": {"start_message_id": "m2", "end_message_id": "m1"}}
            ),
            "out of order",
        ),
        (
            lambda item: item.update(
                {"checked_range": {"start_message_id": "nope", "end_message_id": "m2"}}
            ),
            "not in the conversation",
        ),
        (lambda item: item.update({"explanation": "   "}), "explanation is empty"),
        (lambda item: item.update({"needs_human_review": True}), "requires review_reason"),
        (
            lambda item: item.update({"review_reason": "Look again."}),
            "review_reason must be null",
        ),
        (lambda item: item.update({"na_reason": "Because."}), "na_reason must be null"),
    ],
)
def test_applicable_boolean_rejections(mutate, expected: str) -> None:
    item = applicable_boolean()
    mutate(item)
    judgments, errors = _parse([item])
    assert judgments == []
    assert any(expected in error for error in errors)


def test_missing_duplicate_and_unknown_ids() -> None:
    extra = applicable_boolean()
    extra["criterion_id"] = "other_rule"
    judgments, errors = _parse([applicable_boolean(), extra])
    assert judgments == []
    assert "unknown criterion_id: other_rule" in errors

    judgments, errors = _parse([])
    assert "missing criterion_id: demo_bool" in errors

    judgments, errors = _parse([applicable_boolean(), applicable_boolean()])
    assert "duplicate criterion_id: demo_bool" in errors


def test_na_rules() -> None:
    allowed = boolean_criterion(
        allow_na=True,
        na_rule="Not applicable when the client never asks a question.",
    )
    na_item = applicable_boolean()
    na_item.update(
        {
            "applicability": "not_applicable",
            "answer": None,
            "evidence_message_ids": [],
            "na_reason": allowed["na_rule"],
        }
    )
    judgments, errors = _parse([na_item], [allowed])
    assert errors == []
    assert judgments[0].answer is None

    blocked = dict(na_item)
    _, errors = _parse([blocked])
    assert any("N/A is not allowed" in error for error in errors)

    with_answer = dict(na_item)
    with_answer["answer"] = False
    _, errors = _parse([with_answer], [allowed])
    assert any("null answer" in error for error in errors)

    without_reason = dict(na_item)
    without_reason["na_reason"] = None
    _, errors = _parse([without_reason], [allowed])
    assert any("requires na_reason" in error for error in errors)


def test_undetermined_must_be_unscored_and_flagged() -> None:
    item = applicable_boolean()
    item.update(
        {
            "applicability": "undetermined",
            "answer": None,
            "evidence_message_ids": [],
            "needs_human_review": True,
            "review_reason": "The rubric does not say which message counts.",
        }
    )
    judgments, errors = _parse([item])
    assert errors == []
    assert judgments[0].needs_human_review is True

    scored = dict(item)
    scored["answer"] = True
    _, errors = _parse([scored])
    assert any("undetermined requires a null answer" in error for error in errors)

    unflagged = dict(item)
    unflagged["needs_human_review"] = False
    unflagged["review_reason"] = None
    _, errors = _parse([unflagged])
    assert any("undetermined requires needs_human_review" in error for error in errors)


def test_numeric_scale_rules() -> None:
    ranged = {
        "criterion_id": "span",
        "name": "Span",
        "description": "A continuous demo scale.",
        "answer_type": "numeric",
        "allow_na": False,
        "scale": {"minimum": 0, "maximum": 10, "step": 2},
    }
    listed = {
        "criterion_id": "anchors",
        "name": "Anchors",
        "description": "Discrete demo anchors.",
        "answer_type": "numeric",
        "allow_na": False,
        "scale": {
            "anchors": [
                {"value": 0, "description": "None"},
                {"value": 5, "description": "Partial"},
            ]
        },
    }

    def numeric_item(criterion_id: str, answer: object) -> dict:
        item = applicable_boolean(criterion_id)
        item["answer"] = answer
        return item

    judgments, errors = _parse(
        [numeric_item("span", 4), numeric_item("anchors", 5)],
        [ranged, listed],
    )
    assert errors == []
    assert [judgment.answer for judgment in judgments] == [4, 5]

    _, errors = _parse([numeric_item("span", 3)], [ranged])
    assert any("does not match" in error for error in errors)
    _, errors = _parse([numeric_item("span", 12)], [ranged])
    assert errors
    _, errors = _parse([numeric_item("anchors", 3)], [listed])
    assert errors
    _, errors = _parse([numeric_item("anchors", True)], [listed])
    assert errors
    _, errors = _parse([numeric_item("anchors", "5")], [listed])
    assert errors


def test_categorical_values_are_exact() -> None:
    category = {
        "criterion_id": "label",
        "name": "Label",
        "description": "A small closed set.",
        "answer_type": "categorical",
        "allowed_values": ["yes", "no"],
        "allow_na": False,
    }
    item = applicable_boolean("label")
    item["answer"] = "yes"
    judgments, errors = _parse([item], [category])
    assert errors == []
    assert judgments[0].answer == "yes"

    item["answer"] = "Yes"
    _, errors = _parse([item], [category])
    assert any("does not match" in error for error in errors)


def test_non_json_markdown_and_duplicate_keys_are_rejected() -> None:
    conv = conversation()
    rubric = checklist([boolean_criterion()])
    judgments, errors = parse_judge_payload("```json\n{\"criteria\": []}\n```", conv, rubric)
    assert judgments == []
    assert errors == ["response is not valid JSON"]

    raw = '{"criteria": [], "criteria": []}'
    _, errors = parse_judge_payload(raw, conv, rubric)
    assert errors == ["duplicate JSON key: criteria"]


def test_every_criterion_is_returned_once_in_checklist_order() -> None:
    first = boolean_criterion(criterion_id="second_in_payload")
    second = boolean_criterion(criterion_id="first_in_payload")
    items = [
        applicable_boolean("first_in_payload"),
        applicable_boolean("second_in_payload"),
    ]
    judgments, errors = _parse(items, [first, second])
    assert errors == []
    assert [judgment.criterion_id for judgment in judgments] == [
        "second_in_payload",
        "first_in_payload",
    ]

