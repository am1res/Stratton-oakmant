#!/usr/bin/env bash
# Compare several Gemini models (and one prompt variant) on ONE call.
# Usage:  bash compare_models.sh            (default call p4-ru-001)
#         bash compare_models.sh p4-ru-004
# Run from the voice/ folder. Needs: ../data/dev.json (or DEV_JSON=...), out/audio/<call>.mp3
# from an earlier to_gemini.py run, and .env with GEMINI_API_KEY.
set -u
CALL="${1:-p4-ru-001}"
MODELS=("gemini-3.8-flash" "gemini-2.5-pro" "gemini-omni-flash-preview" "gemini-4-argon")
CMP="out_cmp/$CALL"
DEV="${DEV_JSON:-../data/dev.json}"
mkdir -p "$CMP"

# 1. Take just this one record out of dev.json
python3 - "$CALL" "$CMP/one_call.json" "$DEV" <<'EOF'
import json, sys
call, dst, dev = sys.argv[1], sys.argv[2], sys.argv[3]
recs = json.load(open(dev))["data"]["records"]
rec = [r for r in recs if r["conversation_id"] == call]
if not rec:
    sys.exit(f"{call} not found in {dev}")
json.dump(rec, open(dst, "w"), ensure_ascii=False)
EOF
[ $? -eq 0 ] || exit 1

# 2. Prompt variant: same instructions + explicit "coldness" rules
if [ ! -f voice_instructions_cold.txt ]; then
  cp voice_instructions.txt voice_instructions_cold.txt
  cat >> voice_instructions_cold.txt <<'EOF'

Extra focus - COLDNESS (this overrides "if unsure, flag nothing" for coldness only):
- Also flag a cold or indifferent manner: curt one-word refusals ("Нет, не делаем."),
  a flat unchanged voice while the client is upset, repeating "we can't / we don't do that"
  without offering any alternative or next step, brushing off the client's feelings.
- Judge the operator relative to the client's state: if the client is upset or says she
  feels unwelcome, a flat, indifferent tone is a problem. Use cue "flat" (or "other") and
  label "possible" unless it is very obvious.
EOF
  echo "Created voice_instructions_cold.txt"
fi

run() {  # run <name> <model> [extra args...]
  local name="$1" model="$2"; shift 2
  local dir="$CMP/$name"
  mkdir -p "$dir/audio"
  cp out/audio/"$CALL".* "$dir/audio/" 2>/dev/null   # reuse audio, no re-download
  echo "=== $name ($model) started $(date +%H:%M:%S)"
  local t0=$(date +%s)
  python3 to_gemini.py "$CMP/one_call.json" --out "$dir" --model "$model" --force --workers 1 "$@" \
    | grep -E "done|ERROR"
  echo "    took $(( $(date +%s) - t0 ))s"
}

for m in "${MODELS[@]}"; do run "$m" "$m"; done
run "gemini-3.8-flash+cold_prompt" "gemini-3.8-flash" --instructions voice_instructions_cold.txt

# 3. Side-by-side summary
python3 - "$CMP" "$CALL" <<'EOF'
import json, sys, pathlib
cmp_dir, call = pathlib.Path(sys.argv[1]), sys.argv[2]
# USD per 1M tokens (input, output). Google list prices checked Nov 7 2026; None = not checked.
PRICES = {"gemini-3.8-flash": (0.75, 3.75), "gemini-4-argon": (2.00, 10.00)}
print(f"\n================ {call}: comparison ================")
for d in sorted(p for p in cmp_dir.iterdir() if p.is_dir()):
    f = d / "voice" / f"{call}.json"
    print(f"\n## {d.name}")
    if not f.exists():
        print("   no result (see errors above)")
        continue
    r = json.loads(f.read_text())
    u = r["usage"]
    price = PRICES.get(r["model"])
    cost = f"${(u['input_tokens'] * price[0] + u['output_tokens'] * price[1]) / 1e6:.4f}" if price else "price not checked"
    print(f"   overall: {r['overall']} | tokens in/out: {u['input_tokens']}/{u['output_tokens']} | cost: {cost}")
    print(f"   summary: {r['summary']}")
    for x in r["flags"]:
        print(f"   FLAG [{x['message']}] {x['label']:<8} {x['cue']:<14} {x['reason']}")
    for x in r.get("notes", []):
        print(f"   note [{x['message']}] {x['kind']:<22} {x['reason']}")
    if r["rejected_flags"]:
        print(f"   ({len(r['rejected_flags'])} rejected: pointed at non-operator lines)")
EOF
