# CQA: Conversation Quality Analytics

Prototype for the Freedom Broker CQA hackathon. It grades operators in support chats and calls
against a configurable checklist using an LLM, shows the score with evidence links, and supports
appeals with a reviewer decision.

## Run it

Requires Node.js 20+.

```bash
npm install
cp .env.example .env        # then fill in CQA_API_BASE and LLM_API_KEY
npm start                   # http://localhost:3000
```

- **No API key yet / building UI?** Set `LLM_MOCK=1` in `.env`. You get fake answers and no API calls.
- **Organizer API blocked or slow?** Save the JSON from the browser to `data/dev.json` and set
  `CQA_DATA_FILE=data/dev.json`. It is git-ignored.
- **Control set (hour 23):** set `CQA_GROUP_ID=<value from organizers>` and restart, or call
  `POST /api/data/reload` with `{"group_id": "..."}`. Then click **Оценить все**.

```bash
npm test                    # scoring unit tests
npm run eval                # accuracy vs our ground truth (data/ground_truth.dev.json)
npm run eval -- --ids p1-ru-009,p1-en-014
npm run fetch-data -- DEV   # download a dataset into data/cache/
```

## How it works

```
Organizer API ──► backend/data/source.js (UTF-8, msg_index, offset_sec, audio links kept server-side)
                        │
checklist (config) ──► backend/llm/prompt.js  builds the prompt FROM the checklist:
                        │   general rules + per-criterion yes/N/A rules, scale,
                        │   decision_steps, examples + computed facts about the dialogue
                        ▼
                  backend/llm/client.js  any OpenAI-compatible model, Structured Outputs (JSON schema)
                        │   LLM_VOTES=N → N runs, majority vote, confidence
                        ▼
                  shared/scoring.js  weights, scale → points, N/A redistribution,
                        │             gross error flag, rounding (the model never does maths)
                        ▼
                  storage/ (JSON files): evaluations, appeals, checklist versions
                        ▼
                  frontend/ (plain HTML/CSS/JS modules, ready to wrap as a Dynamics 365 web resource)
```

- **Changing a criterion needs no code.** Every criterion, including new ones added in the UI, gets
  its rules, scale, decision steps and examples from the checklist config. Each evaluation stores the
  checklist version and the exact prompt (the **Показать промпт** button).
- **Model is configurable.** OpenAI by default. NVIDIA NIM or a local Ollama model is one line in `.env`.
- **Analytics page:** where operators lose points per criterion, score distribution, RU/KZ/EN and chat/call comparison,
  gross errors, the AI's agreement with our reference labels, and score changes after a checklist edit. CSV export.
- **Reviewer helpers:** "ИИ не уверен" flag when votes disagree (`LLM_VOTES>1`), print/PDF report per conversation.
- **Cost:** shown per evaluation (`usage.cost_usd`); set `LLM_PRICE_IN/OUT` for your model.

## Integration branch: what was added on top of `Amur`

| Area | What | Where |
|---|---|---|
| Call audio | The organizers' `audio_url` returns an **HTML player page**, not audio; the mp3 link inside **expires in ~1 hour**. The server follows the page, downloads the mp3 once to `storage/audio/` and serves it with Range (seeking works). It also reuses `voice/out/audio/` if the voice pipeline already downloaded it. | `backend/data/audio.js`, `GET /api/conversations/:id/audio` |
| Audio timing | `offset_sec` now means seconds **into the audio file**: counted from "Запись … запущены" with paused parts cut out (DEV calls pause for ~13–20 s when the operator joins; the old offsets were late by that much after the pause). Lines said during a pause get `recorded: false`. | `backend/data/source.js` (`audioOffsets`) |
| Voice analysis | Gemini listens to each call and flags cold / dismissive / mocking moments of the operator, plus notes like "apologized after interrupting". Shown in the call card with jump-to-moment buttons. **A hint for the reviewer, never part of the score.** | `voice/` (Python), `GET /api/conversations/:id/voice`, card |
| Evidence quotes | Each criterion keeps `evidence: [{msg_index, quote, proves}]` next to `evidence_msg_indices`; the card shows the quotes. | `backend/llm/prompt.js`, `results/panel.js` |
| Reviewer context | The disputed fragment shows each evidence line with **2 lines of context** and the `checked_range` of a missing action. | `appeals/reviewer.js` |
| Ensemble mode | `LLM_MODE=ensemble`: evaluators A (rule-first) and B (evidence-first) in parallel, an arbiter only on disagreements; each criterion gets `agreement` (`agreed` / `arbitrated` / `arbiter_failed`). Ported from the Django `backend` branch. | `backend/llm/evaluate.js` |
| Skip done | **«Оценить неоценённые»** skips conversations already evaluated under the current checklist version (after a criterion change the version goes up, so all are re-evaluated). API: `skip_done: true`. | `server.js`, `list.js` |
| Operators page | **Операторы**: per operator dialogs, average score, change early → late dialogs, weakest criterion, gross errors; detail page with a weekly chart and per-criterion change. The data has no operator or chat date, so they are **demo values** (labelled «демо»): for the DEV set they come from `data/demo_operators.json`, arranged into scenarios (Дамир strong, Ержан weak + all gross errors, Айгерим improving, Мирас declining, Алина/Валерия ordinary + calls) by the draft reference grades; other conversations (e.g. the control set) get stable random ones; real `operator_name` / `operator_id` / `date` fields win, calls use their real date. `DEMO_OPERATORS=0` turns it off. Scores are real. | `frontend/operators/`, `backend/data/source.js` |
| Checklist history | **Чек-лист → История версий**: see every saved version, what differs from the current one, restore any (copied as a new version, history kept). | `editor.js`, `POST /api/checklists/restore` |
| Exact rounding | Half-up rounding without float surprises (`1.005 → 1.01`). | `shared/scoring.js` |
| Bug fixes | (1) First batch on an empty storage: 4 workers saved the default checklist through one temp file at once, and ~3 conversations failed. (2) When a batch finished, the list re-rendered over an opened conversation card. | `storage.js`, `server.js`, `list.js` |

Tests: `npm test` (21 tests; `test/integration.test.js` covers everything above with synthetic data).

## Team

See [CONTRIBUTING.md](CONTRIBUTING.md) for who owns which folder and how we commit.
Data shapes and API routes: [contracts/README.md](contracts/README.md).
