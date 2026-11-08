# AI evaluation module (single judge: mock or live)

This package evaluates a human support operator against a checklist supplied at call time. It contains the contract, the validators, a mock judge, a live adapter for OpenAI-compatible Chat Completions endpoints, and tests. It does not calculate a score.

The Node application on the `Amur` branch is unchanged. This package lives in `ai_eval/` so it does not replace `backend/llm/` or the shared checklist file.

## Public interface

```python
from ai_eval import evaluate_conversation, evaluate_single_judge

result = await evaluate_conversation(conversation, checklist)
judge_run = await evaluate_single_judge(conversation, checklist)
```

`evaluate_conversation` runs judge A and judge B in parallel on the same conversation and checklist version. Neither sees the other's output. `evaluate_single_judge` runs one role and is exposed for tests and debugging.

Both judges' runs are kept verbatim in `judge_runs`. `criterion_results` is built from them:

- Judges agree when applicability and the normalized typed answer match (numbers by value, booleans and strings exactly). Different evidence ids or wording are not a disagreement. The merged judgment keeps judge A's explanation and the union of both judges' evidence ids.
- Disagreement puts the criterion in `disputed_criterion_ids`; its result is `undetermined`, `answer: null`, `needs_human_review: true`, with both judges' positions in the explanation. Nothing is averaged. Adjudication (later stage) is the only thing that may resolve it.
- If one judge produced no valid result, the result is built from the other, `status` is `partial`, and `notes` says it is a single-judge result, not a two-judge comparison. If both failed, `status` is `failed`.

Agreement between two models is a fact about those two outputs. It is not a calibrated confidence and is not reported as one.

Input and output models are in `ai_eval.models`. The checklist is a discriminated union on `answer_type`:

- `boolean` — JSON `true` or `false`
- `numeric` — a number permitted by `scale`
- `categorical` — one of `allowed_values`, compared exactly

`explanation_language` is optional and names the language for `explanation`, `na_reason`, and `review_reason`. A numeric scale must define `allowed_values`, `anchors`, or both `minimum` and `maximum`. A `step` also needs `minimum`. The module does not fill in a missing bound, step, or mapping from anchors to points. `weight` is not part of this input. If rubric text is missing or contradicts itself, loading the checklist raises `ConfigurationError` before a judge runs.

N/A is `applicability = not_applicable`. It is accepted only when `allow_na` is true, `na_rule` is present, `answer` is null, and `na_reason` is set. `undetermined` keeps `answer` null and sets `needs_human_review`.

## What a valid result does not prove

The validators check shape: ids, answer type, N/A rules, evidence ids, and `checked_range` order. Order is position in `messages`, not a parsed timestamp. An evidence id that exists in the conversation does not show that the explanation is true. Passing validation is not semantic correctness.

## Mock judge

`AI_EVAL_MODE` defaults to `mock`. The mock provider does not read the transcript. For a configured criterion it returns a structural placeholder and cites the first operator message. Mock judge A picks the first configured value (`true`, first category, first anchor); mock judge B picks the last, so a mock two-judge run disputes every criterion and shows the review path. If there is no operator message, a criterion that allows N/A becomes `not_applicable` and one that does not becomes `undetermined`. Explanations say that the transcript was not judged.

Token usage on the mock path is unknown (`usage_known: false`, token fields null). Null cost is unknown, not zero. `estimated_cost_usd` is filled only when reported token counts and both price settings exist. `provider_billed_cost_usd` is stored only when a provider reports it.

## Live judge

`AI_EVAL_MODE=live` sends one Chat Completions request for the whole checklist through the OpenAI Python SDK (`ai_eval.openai_provider`). There is no default model id and no default API URL. Missing or placeholder values raise `ConfigurationError` before any request; a mock result is never substituted.

Per role (`AI_EVAL_JUDGE_A_*`, `AI_EVAL_JUDGE_B_*`, `AI_EVAL_ADJUDICATOR_*`): base URL, the name of the variable holding the key, model id, `RESPONSE_FORMAT`, timeout, `MAX_OUTPUT_TOKENS`, `MAX_TOKENS_PARAM` (`max_completion_tokens` or `max_tokens`), and optional `TEMPERATURE` / `REASONING_EFFORT` that are sent only when set. Both judges must be configured in live mode; judge B is checked before judge A sends anything.

`RESPONSE_FORMAT` options: `json_schema` (strict schema enforced by the API; schema omitted from the prompt), `json_object` (API asked for JSON; schema text in the prompt), `prompt_json` (no `response_format` parameter at all; schema text in the prompt). All three are validated here with Pydantic. Use `prompt_json` for an endpoint whose `response_format` support is unconfirmed, such as a vendor's OpenAI-compatibility layer.

Failure handling:

- SDK retries are disabled (`max_retries=0`). The pipeline retries timeouts, rate limits, connection errors, and 5xx up to `AI_EVAL_MAX_ATTEMPTS` (default 3) with backoff 1s, 2s, 4s, capped at 8s.
- A structurally invalid answer gets one repair request that lists the validation errors. If that also fails, the run is `invalid` and the result is `failed`.
- Refusals and truncated output (`finish_reason=length`) are failures, not repairs.
- HTTP 401/403/404 and a rejected `response_format` or generation parameter raise `ConfigurationError` with the setting to change. The format is not downgraded automatically.
- Usage is summed across retries and the repair. Any request without reported usage makes the total unknown; `request_count` still counts every attempt.
- When a repair succeeds, the first attempt's errors are kept in `judge_runs[].notes` so prompt problems stay visible.
- Criteria with `allow_na=false` get a schema (and answer-format line) without `not_applicable`, so the model cannot emit N/A for them.

## Token budget

The prompt is built for cost: checklist and transcript are compact JSON, the full JSON schema is attached to the request (for `json_schema` endpoints) but never pasted into the prompt, and a short `<answer_format>` block (one line per criterion, derived from the checklist) tells the model the shape. The system prompt sets an output budget: explanations of at most `EXPLANATION_BUDGET_CHARS` (240) characters, no transcript quotes, single-line JSON. Measured on the official 8-criterion checklist and a 12-message chat: ~4.2–4.6k input tokens per judge; ~0.65k output tokens from gpt-4o-mini, ~1.5–2k from claude-sonnet-5 (whose billed output includes tokens beyond the visible ~700-token text, i.e. model-side reasoning).

Anthropic's compatibility endpoint accepts `response_format: json_schema` in principle but rejects this module's schema (per-criterion `anyOf` plus nullable fields exceed its limit of 16 union-typed parameters), so Claude runs with `prompt_json`. The optional checklist field `explanation_language` (e.g. `"Russian"`) fixes the reviewer-facing language explicitly; without it the judge follows the language of the checklist text.

Error messages contain the provider host, the status code, and a trimmed provider message. They never contain the key. The transcript is not logged.

## CLI

From this directory, with the package installed:

```bash
python -m ai_eval \
  --conversation fixtures/conversations/ru.json \
  --checklist fixtures/checklists/demo.json \
  --output output/ru.json
```

The same command accepts `fixtures/conversations/kz.json` and `fixtures/conversations/en.json`. The checklist file is marked `DEMO CHECKLIST` and is not an official rubric. Exit code `0` means a result file was written. The `status` field inside it is `completed`, `partial`, or `failed`. Exit code `2` means the input or the provider configuration could not be used, and no result file is written.

To evaluate a record straight from the organizers' dataset export (the `invoke` JSON with `data.records[]`), use `--dataset <file> --conversation-id <id>` instead of `--conversation`. The adapter in `ai_eval.datasets` assigns message ids from transcript position (`<conversation_id>#<index>`) and keeps timestamps unchanged.

`fixtures/checklists/official_chat_v1.json` is a transcription of the official 8-criterion chat checklist PDF into this module's input format, plus later clarifications in `additional_instructions` (N/A when the data was already sufficient, score the corrected outcome, how to count dialogue slips, which farewells count). Those clarifications are checklist data: the prompt includes them because it includes the checklist, and the evaluator code does not name the criteria. Weights and the scoring procedure are deliberately not included. `fixtures/checklists/demo.json` remains a synthetic checklist for tests.

`--baseline path/to/reference.submission.json` prints how many answers match that file for the conversation just evaluated. The reference uses its own criterion ids; `fixtures/baselines/reference_criterion_map.json` maps them onto the checklist. A match is the same applicability and the same typed answer. A disputed, undetermined result is not counted as a match. The comparison does not change the result and does not score evidence text.

For a live run, copy `.env.example` to `.env`, fill in judge A, and add `--env-file .env`. `--env-file` loads `KEY=VALUE` lines without overriding variables that are already set. Values are not printed. `.env` is git-ignored. Each live run is one paid request plus any retries and at most one repair; the CLI prints request count, tokens, and estimated cost when known.

## Tests

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

Tests do not make a network call and need no key. The live adapter is tested with a fake client. Dependencies are Pydantic v2, the OpenAI SDK, and pytest.

## Boundaries

Included: models, prompt construction, mock providers, live OpenAI-compatible adapter, structural validation, two independent judges with bounded retries and one repair each, disagreement detection, usage fields, CLI, dataset import adapter, fixtures, tests.

The adjudicator runs only after both judges return a valid result and disagree. One call covers every disputed criterion: the full transcript, those criterion definitions and their rules, and the two judgments with explanations and evidence ids. Agreed criteria are not sent again. A decision the adjudicator marks undetermined, or a failed adjudication call, stays unresolved for a human. If either primary judge fails, the adjudicator is not called. Configure it with `AI_EVAL_ADJUDICATOR_*`. `AI_EVAL_ADJUDICATOR_API_KEY_ENV` may name another role's key variable, so the secret is not copied.

Not included: score totals, N/A weight redistribution, persistence, authentication, the dataset API, and appeals.

The prompt tells the model to treat transcript text as untrusted data, to follow the checklist that was passed in, to judge only the human operator, and to preserve Russian, Kazakh, and English without requiring a translation. Criterion names inside the prompt come from the checklist object.
