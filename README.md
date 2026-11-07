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
- **Cost:** shown per evaluation (`usage.cost_usd`); set `LLM_PRICE_IN/OUT` for your model.

## Team

See [CONTRIBUTING.md](CONTRIBUTING.md) for who owns which folder and how we commit.
Data shapes and API routes: [contracts/README.md](contracts/README.md).
