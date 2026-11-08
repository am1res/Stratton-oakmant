# Data contracts

Everyone codes against these shapes. **Only add fields.** Renaming or removing a field
needs agreement in the team chat first, because it silently breaks other people's code.

Mocks for UI work: `contracts/mocks/*.json` (or run the server with `LLM_MOCK=1`).

## Conversation (from the organizers' API, plus `msg_index`)

```json
{
  "conversation_id": "p1-ru-001",
  "channel": "agent chat",              // or "voice call"
  "language": "RU",                     // RU | KZ | EN
  "audio_url": null,                    // calls: "/api/conversations/<id>/audio" (proxied, never the signed link)
  "transcript": [
    { "msg_index": 0, "timestamp": "00:00", "offset_sec": 0, "speaker": "client", "text": "..." }
  ]
}
```

- `msg_index`: position in the transcript. Evidence links point to it.
- `timestamp`: the original string (`MM:SS` for chats, ISO 8601 for calls). Show it as-is.
- `offset_sec`: seconds since the first line. Use it only for seeking the audio player.
- `speaker`: `client | operator | bot | system`.
- `offset_sec` (calls): seconds into the AUDIO FILE, from the "recording started" event, with paused parts cut out.
- `recorded` (added): `false` for lines said while the recording was paused (not in the audio).

Voice analysis (added): `GET /api/conversations/:id/voice` →
`{available, overall: ok|possible_issue|clear_issue, summary, flags: [{msg_index, offset_sec, cue, label, reason}], notes: [{msg_index, offset_sec, kind, reason}], model, cost_usd}`
or `{available: false}`. Never part of the score.

Evaluation criterion (added fields): `evidence: [{msg_index, quote, proves}]`;
in `LLM_MODE=ensemble` also `agreement: agreed|arbitrated|arbiter_failed` and `votes: [A, B, arbiter?]`.
Evaluation (added): `mode: single|ensemble`. Appeal `original` (added): `evidence`, `checked_range`.
Batch (added): `POST /api/evaluate/batch {conversation_ids?, skip_done?}` → job has `skipped`.

## Checklist

See `checklist.default.json`. Per criterion:

| field | meaning |
|---|---|
| `id`, `section`, `name` | identity and grouping |
| `type` | `binary` (yes/no[/na]), `scale` (one of `scale[].value`, or na), `flag` (yes/no, no points: gross errors) |
| `weight` | points before N/A redistribution (flags: 0) |
| `na_allowed`, `na_rule` | when N/A is allowed |
| `yes_rule` | what "Yes" means (for scales: what is rated) |
| `scale` | `[{value, description}]`; the highest value gives the full weight |
| `decision_steps` | step-by-step rule for the AI (the main accuracy lever) |
| `examples` | `[{text, answer, why}]`, few-shot examples for the AI |

Checklist-level: `rounding` (decimals), `general_rules` (applied to every criterion), `version` (bumped on every save).

## Evaluation

```json
{
  "id": "ev_1731000000000_p1-ru-001",
  "conversation_id": "p1-ru-001",
  "checklist_id": "cqa-default",
  "checklist_version": 3,
  "checklist_snapshot": { "...": "full checklist used" },
  "model": "gpt-5-mini",
  "created_at": "2026-11-07T10:00:00Z",
  "criteria": [
    {
      "criterion_id": "c03",
      "answer": "na",                    // "yes" | "no" | "na" | number (scale value)
      "explanation": "Общий вопрос о тарифе, данные счёта не раскрывались.",
      "evidence_msg_indices": [9],       // messages that prove the answer
      "checked_range": null,             // [from, to] msg_index where a MISSING action was expected
      "na_reason": "Запрос не требовал идентификации.",
      "gross_error_type": null,          // c08 only: "insult" | "bypass_service" | "confidential_disclosure"
      "confidence": 1.0,                 // share of votes that agreed (1.0 when LLM_VOTES=1)
      "points": null,                    // filled by scoring: earned points after redistribution
      "effective_weight": null           // filled by scoring: weight after redistribution
    }
  ],
  "score": {
    "total": 88.13,                      // null when no weighted criterion is applicable
    "max": 100,
    "gross_error": false,
    "sections": { "s1": { "points": 21.25, "max": 31.25 } }
  },
  "usage": { "input_tokens": 3500, "output_tokens": 1200, "cost_usd": 0.0033, "calls": 1 },
  "prompt": "exact prompt sent (for the 'Show prompt' button)",
  "final": null                          // set when appeals change a criterion: same shape as `score` plus `criteria` overrides
}
```

## Appeal

```json
{
  "id": "ap_1731000000000",
  "evaluation_id": "ev_...",
  "conversation_id": "p1-ru-001",
  "criterion_id": "c04",
  "comment": "The operator did answer the second question at 03:20.",
  "status": "open",                      // open | confirmed | changed
  "original": { "answer": 10, "explanation": "..." },
  "ai_suggestion": null,                 // optional AI second opinion: { answer, explanation }
  "reviewer_decision": null,             // { answer, reason, decided_at }
  "created_at": "..."
}
```

When an appeal is `changed`, the backend recalculates the score with the new answer and
stores it in `evaluation.final`. The card shows `score` (original), the appeal decision and `final`.

## API (backend/server.js)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/conversations` | list with `latest_score`, `latest_criteria` (after appeals, with `confidence`), `gross_error`, `has_open_appeal`, `low_confidence` |
| GET | `/api/conversations/:id` | full conversation |
| POST | `/api/conversations/upload` | body: a conversation JSON (or `{records:[...]}`) |
| POST | `/api/data/reload` | re-fetch from the organizers' API (`{group_id}` optional) |
| GET | `/api/conversations/:id/audio` | proxied audio stream for calls |
| GET | `/api/checklists/current` | the active checklist |
| GET | `/api/checklists` | all saved versions |
| PUT | `/api/checklists/current` | save a new version (validates; bumps `version`) |
| POST | `/api/evaluate` | `{conversation_id, fresh?}` → Evaluation. After a checklist edit, criteria whose definition did not change keep their answer (`reused_from`, no model call); `fresh: true` re-asks everything. Every evaluation has `provenance` (transcript/checklist hashes, mode, models, prompt and app version, fresh vs reused criteria) |
| POST | `/api/evaluate/batch` | `{conversation_ids?, skip_done?, fresh?}` → job; all when omitted. Jobs are saved to `storage/jobs` after every conversation |
| GET | `/api/jobs/:id` | `{done, total, completed, errors, status}`; status `running` / `done` / `interrupted` |
| GET | `/api/jobs?status=interrupted` | jobs stopped by a server restart |
| POST | `/api/jobs/:id/resume` | continue an interrupted job; conversations with a saved result are not sent again |
| GET | `/api/labels?reviewer=` | blind labeling: only that reviewer's own labels, plus label counts per reviewer |
| PUT | `/api/labels/:conversation_id` | `{reviewer, answers, note?}` one reviewer's labels for one conversation |
| GET | `/api/evaluations?conversation_id=` | evaluations, newest first; `?lite=1` drops the prompt text (analytics) |
| GET | `/api/reference` (human labels first) | our reference labels `{status, labels}` from `data/ground_truth.dev.json` (AI-accuracy panel only, never used for grading) |
| GET | `/api/evaluations/:id` | one evaluation |
| POST | `/api/appeals` | `{evaluation_id, criterion_id, comment}` |
| GET | `/api/appeals?status=open` | appeals list |
| POST | `/api/appeals/:id/suggest` | AI second opinion for the reviewer |
| POST | `/api/appeals/:id/decide` | `{answer, reason}`; same answer = confirm |
