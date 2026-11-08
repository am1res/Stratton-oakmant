"""CLI. Writes one evaluation JSON file.

AI_EVAL_MODE=mock (default) makes no provider call. AI_EVAL_MODE=live makes
one judge request per run, plus bounded retries and at most one repair.
The transcript is never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from ai_eval.baseline import compare_result, format_comparison, reference_for
from ai_eval.config import load_env_file
from ai_eval.datasets import conversation_from_record, dataset_records, find_record
from ai_eval.errors import ConfigurationError
from ai_eval.models import parse_checklist, parse_conversation
from ai_eval.pipeline import evaluate_conversation


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate one conversation with a single judge (mock or live)."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--conversation", help="Path to a conversation JSON in this module's format")
    source.add_argument(
        "--dataset",
        help="Path to the organizers' dataset export; requires --conversation-id",
    )
    parser.add_argument("--conversation-id", help="Record to pick from --dataset")
    parser.add_argument("--checklist", required=True, help="Path to checklist JSON")
    parser.add_argument("--output", required=True, help="Path to write the evaluation JSON")
    parser.add_argument(
        "--env-file",
        help="Optional KEY=VALUE file. Existing environment variables win. Values are not printed.",
    )
    parser.add_argument(
        "--baseline",
        help="Reference submission JSON. Prints answer matches for this conversation; does not change the result.",
    )
    args = parser.parse_args(argv)
    if args.dataset and not args.conversation_id:
        parser.error("--dataset requires --conversation-id")
    try:
        if args.env_file:
            load_env_file(args.env_file, os.environ)
        if args.dataset:
            records = dataset_records(_read_json(args.dataset))
            conversation = conversation_from_record(find_record(records, args.conversation_id))
        else:
            conversation = parse_conversation(_read_json(args.conversation))
        checklist = parse_checklist(_read_json(args.checklist))
        result = asyncio.run(evaluate_conversation(conversation, checklist))
    except ConfigurationError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"cannot read input: {exc.strerror or exc.__class__.__name__}", file=sys.stderr)
        return 2
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(result.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    usage = result.usage
    tokens = (
        f"in={usage.input_tokens} out={usage.output_tokens}"
        if usage.usage_known
        else "unknown"
    )
    cost = (
        f"{usage.estimated_cost_usd:.6f}" if usage.estimated_cost_usd is not None else "unknown"
    )
    print(
        f"wrote {output} status={result.status.value} "
        f"requests={usage.provider_request_count} tokens={tokens} "
        f"estimated_cost_usd={cost} disputed={result.disputed_criterion_ids} "
        f"unresolved={result.unresolved_criterion_ids}"
    )
    for run in result.judge_runs:
        print(
            f"  {run.role.value}: {run.provider}/{run.model} {run.validation_status.value} "
            f"requests={run.usage.request_count} latency_ms={run.latency_ms:.0f}"
        )
        for error in run.validation_errors:
            print(f"    validation: {error}", file=sys.stderr)
        for note in run.notes:
            print(f"    note: {note}", file=sys.stderr)
    for note in result.notes:
        print(f"  note: {note}", file=sys.stderr)
    if args.baseline:
        answers, id_map = reference_for(Path(args.baseline), result.conversation_id)
        print(format_comparison(result.conversation_id, compare_result(result, answers, id_map)))
    return 0


def _read_json(path: str) -> object:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigurationError(
            f"cannot read {path}: {exc.strerror or exc.__class__.__name__}"
        ) from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConfigurationError(f"invalid JSON in {path}: line {exc.lineno}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
