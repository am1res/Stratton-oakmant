# Team guide

## Who owns what

Only edit your own folders. Need a change elsewhere? Ask the owner.

| Person | Owns | First tasks |
|---|---|---|
| **P1 · AI engine** | `backend/llm/`, `eval/`, `contracts/checklist.default.json` (decision_steps, examples) | Add your OpenAI key, run `npm run eval -- --limit 10`, read the mismatches, improve the prompt and decision steps, repeat. **Accuracy is the main ranking criterion.** |
| **P2 · Backend + integration** | `backend/server.js`, `backend/storage.js`, `backend/data/`, `shared/scoring.js`, `package.json`, `contracts/README.md` | Real API link in `.env`, `npm run fetch-data`, audio proxy on `p4-ru-002`, control-set switch, README run steps. |
| **P3 · Main frontend** | `frontend/index.html`, `frontend/common/` (app shell, router, API client, styles, score strip), `frontend/conversations/`, `frontend/results/`, `frontend/player/` | List, card, transcript anchors, evidence navigation, result states, audio player. Check audio sync on real calls (`OFFSET_SHIFT` in `player.js`). |
| **P4 · Checklist, appeals, QA** | `frontend/checklist/`, `frontend/appeals/`, `data/ground_truth.dev.json`, demo script | Review the draft ground truth (`check` entries first), rehearse "replace a criterion", reviewer flow, demo script. |

Shared (small edits only, pull right before editing, announce in chat): `contracts/`, `README.md`.
P3 owns the app shell (`frontend/index.html`, `frontend/common/`): ask P3 to add a route or nav item.

## Git routine (everyone works on the `Amur` branch; `main` stays empty)

```bash
git checkout Amur
git pull --rebase           # before you start and before every push
git add <your files>
git commit -m "results: show N/A reason"
git pull --rebase
git push origin Amur
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
