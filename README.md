# CQA: Conversation Quality Analytics

Prototype for the Freedom Broker conversation-quality hackathon. A reviewer opens a support chat or call, sees a checklist score with the evidence behind it, and can appeal a criterion. The browser talks only to the Node app on port 3000.

The score is computed in code from the checklist. Models judge the operator. They do not invent the total.

## Technologies

| Piece | Stack |
|---|---|
| Web app | Node.js 20, Express 4, static ES modules (no React). Font: Golos Text. |
| Score | `shared/scoring.js`. Same module in the browser and in Node. |
| Checklist evaluation | Python 3.11+ package `ai_eval/`. Pydantic v2, OpenAI Python SDK, pytest. |
| Judge transport | OpenAI-compatible Chat Completions. Judge A uses `json_schema`. Judge B and the adjudicator use `prompt_json` (Anthropic’s compatibility endpoint rejects this schema). |
| Call audio | The organizers’ `audio_url` is an HTML player page. The server follows it, caches the mp3, and serves it with HTTP Range so the player can seek. Cuts use the ffmpeg binary shipped with `imageio-ffmpeg`. |
| Voice review | Python, `google-genai`. Gemini listens to the operator and writes a reviewer note. |
| Line tone | Local [emotion2vec+](https://github.com/ddlBoJack/emotion2vec) `iic/emotion2vec_plus_base` through FunASR and PyTorch. No API key. |
| Persistence | JSON files under `storage/` (evaluations, appeals, checklist versions). |
| Tests | Node’s built-in test runner (`npm test`). pytest for `ai_eval` (no network, no key). |

A Django project is also in the tree (`manage.py`, `evaluations/`, `checklists/`, `appeals/`, `ingestion/`, `docker-compose.yml` with Postgres 16, Redis 7, and Celery). It is a separate backend with its own Anthropic pipeline. The UI does not call it.

## How a review works

```
organizer dataset (or a local JSON file)
        │
        ▼
backend/data/source.js     normalize transcript, keep signed audio URLs on the server
        │
        ├─ chats ──────────────────────────────────────────────┐
        │                                                      │
        └─ calls                                               │
             ├─ Gemini voice note     hint only, not a score   │
             └─ emotion2vec chips     hint only, not a score   │
                                                                ▼
                         contracts/checklist.default.json
                                        │
                                        ▼
                         Node spawns ai_eval/.venv Python
                         (-m ai_eval.team_node)
                                        │
                    judge A and judge B, in parallel, same transcript
                    neither sees the other
                                        │
                         disagree on a criterion?
                           yes → one adjudicator call, disputed criteria only
                           no  → keep the agreed answer
                                        │
                                        ▼
                         shared/scoring.js
                         yes / no / scale / N/A redistribution / gross-error flag
                                        │
                                        ▼
                         storage/*.json  →  the card in the browser
```

Only the human operator is graded. Bot and system lines are context. The checklist is data: names, rules, scales, examples, and N/A rules are read from the checklist file and sent to the models. The evaluator does not hardcode the eight official criteria.

### What the pages do

- **Диалоги.** List of conversations, filters, batch evaluation. The bar under a row is the checklist: width is weight, fill is points earned, hatching is N/A.
- **A conversation.** Transcript on the left, score on the right. Evidence chips jump to the cited line and, on a call, seek the audio. **Оспорить** starts an appeal on that criterion. **Печать / PDF** prints the card.
- **Операторы.** Average score, early-versus-late change, weakest criterion. The organizers’ export has no operator names and no chat dates, so those fields are demo values (`data/demo_operators.json`) unless the record already has them. `DEMO_OPERATORS=0` turns the demo names off. Scores stay real.
- **Аналитика.** Where points are lost, the score histogram, language and channel comparison, gross errors, and agreement with the reference labels in `data/ground_truth.dev.json`.
- **Апелляции.** A reviewer compares the original answer, the operator’s appeal, and an optional model suggestion, then decides.
- **Чек-лист.** Edit weights, rules, scales, and examples. Saving creates a new version. Older versions can be restored. The next evaluation uses the current version.

The screen shows the score, the explanation, and the evidence. It does not show model ids, token cost, or the raw prompt.

## Checklist evaluation

`LLM_MODE=ai_eval` (the default) is the path above.

1. Node sends the current checklist and the conversation to `ai_eval.team_node` on stdin.
2. The package maps the team checklist (binary, scale, flag) onto its own answer types. A flag means “a violation was found,” not a weighted point.
3. Two judges run at the same time. They agree when applicability matches and the typed answer matches. `true` is not `1`. Different evidence line ids are not a disagreement.
4. If both judges are valid and they disagree, the adjudicator sees only the disputed criteria, both judgments, and the full transcript. One call. Agreed criteria are not sent again.
5. An undetermined adjudicator answer stays unresolved. The card then shows **Стоит проверить** and scoring falls back so the row can still be totaled. That marker is “the judges did not settle this,” not a calibrated confidence.
6. If one judge fails, the other judge’s answers are kept and labeled as a single-judge result. The adjudicator is not called. If both fail, the evaluation fails. A failed call is never rewritten into a plausible score.

Structural validators check ids, types, evidence ids, `checked_range` order, and N/A rules. They do not prove the explanation is true.

Scoring, in `shared/scoring.js`:

- `yes` takes the full weight, `no` takes 0.
- A scale answer is proportional: the top anchor takes the full weight.
- N/A drops that criterion and redistributes its weight. The maximum stays 100.
- A gross-error flag is reported beside the total and does not change it.
- The total is half-up rounded (`1.005` → `1.01`).

`LLM_MOCK=1` skips Python and returns fake answers, so the UI can be exercised with no key. `LLM_MODE=single` and `LLM_MODE=ensemble` keep the older JavaScript client in `backend/llm/`. They are not the default.

The Python package can also be run on its own. Fixtures, the official-checklist transcription, and the baseline comparison live under `ai_eval/`. See [ai_eval/README.md](ai_eval/README.md).

## Calls

Two separate listeners. Neither one changes the checklist score.

**Gemini** (`voice/to_gemini.py`) hears the recording and the transcript. It looks for a cold, dismissive, irritated, or mocking operator, and it can note an apology or a moment of empathy. The card shows **Тон в норме**, **Возможна проблема с тоном**, or **Проблема с тоном**, plus the short summary. Needs `GEMINI_API_KEY`. Details: [voice/README.md](voice/README.md).

**emotion2vec** (`voice/emotion_lines.py`) labels each operator turn locally. The card shows a guess only when the line has at least 2.5 seconds of actual speech and the guess is not “calm”: **≈ грустнее**, **≈ резче**, **≈ теплее**, and similar. There is no percent. Fragments and silence are dropped, because a short reply plus the gap until the next line was being scored as an emotion. These chips are not sent to the checklist judges.

Phone audio often pushes this model toward “sad,” and it has scored ordinary lines, including a greeting, as angry. Treat the chip as a hint.

## Run

Node 20 or newer, and Python 3.12 for the two virtualenvs (3.11 is enough for `ai_eval` alone).

```bash
npm install
cp .env.example .env
```

Checklist judges:

```bash
cd ai_eval
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env          # judge A, judge B, adjudicator
cd ..
```

Call voice and the local tone model:

```bash
cd voice
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install torch   # FunASR needs it; it is not in requirements.txt
cd ..
```

Put `GEMINI_API_KEY` in the root `.env`. emotion2vec downloads `iic/emotion2vec_plus_base` from Hugging Face on first use (about 1 GB) and then reads the local snapshot.

```bash
npm start                     # http://localhost:3000
```

`npm run dev` restarts the server when backend files change.

Without keys, set `LLM_MOCK=1`. Chats still load and score with placeholder answers. Voice buttons will fail until `GEMINI_API_KEY` is set. The tone button needs the voice virtualenv and the downloaded model.

### Dataset

`CQA_GROUP_ID=DEV` reads the organizers’ API (`CQA_API_BASE` is the invoke URL without `&group_id=`).

To work offline, point `CQA_DATA_FILE` at a saved export. The loader accepts the organizer envelope `{ data: { records: [...] } }` and a bare list of records.

```bash
npm run fetch-data -- DEV    # writes data/cache/
```

A new control set is `CQA_GROUP_ID=<id from the organizers>` and a restart, or `POST /api/data/reload` with `{ "group_id": "..." }`.

## Configuration

Root `.env` (see `.env.example`):

| Variable | Role |
|---|---|
| `PORT` | HTTP port. Default 3000. |
| `CQA_API_BASE`, `CQA_GROUP_ID` | Organizer dataset. |
| `CQA_DATA_FILE` | Local JSON instead of the API. |
| `LLM_MODE` | `ai_eval` (default), `single`, or `ensemble`. |
| `LLM_MOCK` | `1` skips the Python judges. |
| `AI_EVAL_PYTHON` | Interpreter for `ai_eval`. Default `ai_eval/.venv/bin/python`. |
| `DEMO_OPERATORS` | `0` hides demo operator names. |
| `GEMINI_API_KEY` | Voice review. `GEMINI_MODEL` overrides the model. |
| `VOICE_OUT_DIR` | Where voice notes, tone files, and cached mp3s are written. Default `voice/out`. |
| `VOICE_PYTHON` | Interpreter for the voice scripts. Default `voice/.venv/bin/python`. |

Judge URLs, model ids, and keys are `AI_EVAL_*` in `ai_eval/.env`. The Node process loads that file without overriding variables already set. Do not commit either `.env`.

`LLM_MODE=single` or `ensemble` uses `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` from the root file instead.

## Tests

```bash
npm test                      # scoring, API, audio, checklist
cd ai_eval && .venv/bin/pytest
```

Node tests use synthetic data and do not call a provider. pytest does not call a provider either. A live judge run is a paid request: use the `ai_eval` CLI, described in [ai_eval/README.md](ai_eval/README.md).

```bash
npm run eval                  # compare stored evaluations to data/ground_truth.dev.json
npm run eval -- --ids p1-ru-009,p1-en-014
```

## Layout

```
frontend/          pages: list, card, operators, analytics, appeals, checklist
backend/           Express API, dataset, audio, evaluation bridge
shared/scoring.js  the only score
contracts/         checklist and the JSON shapes the team shares
ai_eval/           judges, adjudicator, validators, fixtures
voice/             Gemini review and emotion2vec
storage/           evaluations, appeals, checklist versions, cached audio (gitignored)
data/              demo operator names, reference labels, optional local dataset
```

Field-level shapes and routes: [contracts/README.md](contracts/README.md). Who owns which folder: [CONTRIBUTING.md](CONTRIBUTING.md).
