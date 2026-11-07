"""Build agent prompts and JSON output schemas from a checklist version.

Nothing about specific criteria is hardcoded: replacing a criterion in the DB changes
the prompt and the schema on the next evaluation.
"""
import hashlib
import json

from checklists.models import Criterion

NO_RANGE = -1

BASE_INSTRUCTIONS = """\
You evaluate a contact-center operator's performance in one client conversation, using the checklist below.

General rules:
- Evaluate only the operator. Messages from `bot` and `system` are context: never credit or blame the operator for them, but you may cite them as evidence (for example, a chat-closed system event).
- Conversations are in Russian, Kazakh or English. Apply the same standard in every language. Write explanations in English; keep quotes in the original language.
- For each criterion choose exactly one of its allowed values. N/A is allowed only where the criterion lists an N/A condition, and only when that condition is met; then fill `na_reason` with the condition that applies. Otherwise leave `na_reason` empty.
- Cite evidence by message number (#n in the transcript), with a short verbatim quote and what it proves. Cite only numbers that exist.
- For a missing action, set `checked_from` / `checked_to` to the message range where the action was expected and cite the message closest to where it should have been. Otherwise set both to -1.
- Base every conclusion on what is visible in the transcript. Do not compute points or totals.
"""

ROLE_INSTRUCTIONS = {
    "A": """\
Method: rule-first. Go criterion by criterion. Break the rule into its individual conditions and check each condition against the transcript before choosing a value.""",
    "B": """\
Method: evidence-first. First read the whole transcript and note every operator action that matters for quality: greeting and introduction, questions asked, identity checks, answers given, waits announced, closing, and anything risky. Then decide each criterion only from those notes. Count an action as done only if it is visible in the transcript.""",
    "ARBITER": """\
You are the deciding evaluator. Two independent evaluators assessed this conversation and disagreed on the criteria listed in the request. Re-read the transcript yourself, test each evaluator's position against the rule and the messages they cite, and decide. You may choose a value neither of them chose if the rule requires it. In `decision_reason`, say which position was right and why.""",
}


def render_criterion(c):
    lines = [f"### {c.code}: {c.title}"]
    if c.answer_type == Criterion.AnswerType.FLAG:
        lines.append("Type: flag (reported separately, not scored).")
    lines.append(f"Allowed values: {' | '.join(c.allowed_values())}")
    lines.append(f"Rule: {c.rule_text}")
    if c.answer_type == Criterion.AnswerType.SCALE and c.scale_descriptions:
        lines.append("Scale:")
        for value in c.allowed_values():
            if value in c.scale_descriptions:
                lines.append(f"- {value}: {c.scale_descriptions[value]}")
    if c.na_allowed:
        lines.append(f"N/A only when: {c.na_condition}")
    else:
        lines.append("N/A is not allowed.")
    return "\n".join(lines)


def render_transcript(conversation, messages):
    header = (
        f"Conversation {conversation.conversation_id} | channel: {conversation.channel} | "
        f"language: {conversation.language}"
    )
    lines = []
    for m in messages:
        speaker = m.speaker.upper() if m.is_evaluable or m.speaker == "client" else f"{m.speaker.upper()} (context)"
        lines.append(f"#{m.idx} [{m.timestamp_raw}] {speaker}: {m.text}")
    return f"{header}\n\n<transcript>\n" + "\n".join(lines) + "\n</transcript>"


def _criterion_schema(c, extra=None):
    properties = {
        "value": {"type": "string", "enum": c.allowed_values()},
        "explanation": {"type": "string"},
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "msg_idx": {"type": "integer"},
                    "quote": {"type": "string"},
                    "proves": {"type": "string"},
                },
                "required": ["msg_idx", "quote", "proves"],
                "additionalProperties": False,
            },
        },
        "checked_from": {"type": "integer"},
        "checked_to": {"type": "integer"},
        "na_reason": {"type": "string"},
        **(extra or {}),
    }
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def _object_of(criteria, extra=None):
    return {
        "type": "object",
        "properties": {
            "criteria": {
                "type": "object",
                "properties": {c.code: _criterion_schema(c, extra) for c in criteria},
                "required": [c.code for c in criteria],
                "additionalProperties": False,
            }
        },
        "required": ["criteria"],
        "additionalProperties": False,
    }


class PromptBuilder:
    def __init__(self, version, criteria):
        self.version = version
        self.criteria = criteria

    def checklist_block(self):
        """Identical for every agent and conversation under one version, so it is cached."""
        parts = [BASE_INSTRUCTIONS, f"# Checklist: {self.version.checklist.name} (v{self.version.version})"]
        parts += [render_criterion(c) for c in self.criteria]
        if self.version.clarifications:
            parts.append("## Clarifications\n" + self.version.clarifications)
        return "\n\n".join(parts)

    def system_blocks(self, role):
        return [self.checklist_block(), ROLE_INSTRUCTIONS[role]]

    def agent_user(self, conversation, messages):
        return render_transcript(conversation, messages) + "\n\nEvaluate the operator on every criterion."

    def arbiter_user(self, conversation, messages, disputes):
        """disputes: {code: {"A": verdict, "B": verdict}}"""
        return (
            render_transcript(conversation, messages)
            + "\n\nThe evaluators disagreed on these criteria:\n<disputes>\n"
            + json.dumps(disputes, ensure_ascii=False, indent=1, sort_keys=True)
            + "\n</disputes>\n\nDecide each disputed criterion."
        )

    def agent_schema(self):
        return _object_of(self.criteria)

    def arbiter_schema(self, codes):
        disputed = [c for c in self.criteria if c.code in codes]
        return _object_of(disputed, extra={"decision_reason": {"type": "string"}})


def prompt_hash(system_blocks, user, schema):
    payload = json.dumps([system_blocks, user, schema], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
