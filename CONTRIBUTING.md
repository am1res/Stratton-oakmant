# Team guide

## Who owns what

Only edit your own folders. Need a change elsewhere? Ask the owner.

| Person | Owns | First tasks |
|---|---|---|
| **P1 · Backend** | `backend/server.js`, `backend/storage.js`, `backend/data/`, `package.json` | Put the real API link in your `.env`, check `npm run fetch-data`. Test the audio proxy on `p4-ru-002`. Prepare the control-set switch. README run steps. |
| **P2 · AI** | `backend/llm/`, `eval/`, `contracts/checklist.default.json` (decision_steps, examples) | Add your OpenAI key, run `npm run eval -- --limit 10`, read the mismatches, improve the prompt and decision steps, repeat. Compare gpt-5-mini vs a stronger model vs `LLM_VOTES=3`. **Accuracy is the main ranking criterion.** |
| **P3 · Checklist + results** | `frontend/checklist/`, `frontend/results/`, `shared/scoring.js` | Checklist editor: add/delete criterion, scale steps, decision steps, examples. Rehearse "replace a criterion". Polish the result panel. |
| **P4 · Card + appeals** | `frontend/conversations/`, `frontend/appeals/`, `frontend/player/`, `data/ground_truth.dev.json` | **First:** review the draft ground truth: every entry with a non-empty `check` list, then spot-check the rest. Then filters on the list, call player seek check, reviewer screen polish. |

Shared (small edits only, pull right before editing, announce in chat): `contracts/`, `frontend/index.html`,
`frontend/common/`, `README.md`.

## Git routine (everyone commits to `main`)

```bash
git pull --rebase           # before you start and before every push
git add <your files>
git commit -m "results: show N/A reason"
git pull --rebase
git push
```

- Prefix messages with your area: `api:`, `llm:`, `eval:`, `checklist:`, `results:`, `card:`, `appeals:`, `contracts:`, `docs:`.
- Push every 30–45 minutes. Never push code that stops `npm start` from working.
- Changing `contracts/`? Post in chat first, **only add fields**, commit it on its own.
- Broke `main`? Fix it or `git revert <hash> && git push` straight away.

## Never commit

`.env` (API keys), `data/dev.json` or any raw dataset (call `audio_url`s contain signed keys and real
customer recordings), `storage/`. All of these are in `.gitignore`. Check `git status` before committing.

## Ground truth (accuracy work)

`data/ground_truth.dev.json` is a **draft** written from the checklist text. It is our best guess
at the organizers' reference grades, not official. Rules we agreed on (change here and in the
checklist `decision_steps` together):

- Account data revealed without identification → c03 = No **and** c08 = Yes (confidential disclosure).
- Operator closes the chat ("Оператор закрыл чат") → c07 = No, never N/A. N/A only when the client left or the connection dropped.
- Bare farewell after the question was resolved ("Хорошего дня!") → c07 = Yes. Bare "Goodbye." to an open question → No.
- Calls are not labelled yet. Add 2–3 if time allows.

## Hour 23 checklist

1. P1: set the control `group_id`, reload data, confirm the new conversations appear.
2. P2: click **Оценить все** (or `POST /api/evaluate/batch`), watch progress, re-run any errors.
3. P3: replace a criterion in the editor, save, re-evaluate one conversation, open **Показать промпт** to prove it was used.
4. P1: final commit and push before the code freeze. Send the repo link.
