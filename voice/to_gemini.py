"""CQA voice pipeline: organizers' JSON in -> transcripts, audio, Gemini voice analysis out.

Give it the JSON (full API response, a list of records, or one record):
    python to_gemini.py dev.json

For every conversation it:
  1. writes a numbered transcript for Gemini        -> out/transcripts/<id>.txt
     and a message index (number -> audio second)   -> out/transcripts/<id>.json
  2. calls only: downloads audio from audio_url      -> out/audio/<id>.<ext>   (cached)
  3. calls only: sends audio + transcript to Gemini  -> out/voice/<id>.json    (skipped if done)
At the end it prints a summary and writes out/summary.csv.
Chats get step 1 only (they have no audio).

Setup (once):
    pip install requests google-genai
    export GEMINI_API_KEY=...      # or a line GEMINI_API_KEY=... in a .env file

Options:
    --no-gemini          steps 1-2 only, no API key needed (good first test)
    --list-models        print the Gemini models your key can use, then exit
    --model NAME         Gemini model (default: $GEMINI_MODEL, else gemini-3.8-flash)
    --pause-mode keep    use if the audio keeps silence where recording was paused
    --force              redo Gemini analysis even if a result already exists
    --workers N          conversations processed at the same time (default 4)
    --instructions FILE  instructions for Gemini (default: voice_instructions.txt,
                         created next to this script on first run - edit it freely)
    --out DIR            output folder (default: out)
"""
import argparse
import base64
import binascii
import csv
import html
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_MODEL = "gemini-3.8-flash"     # check the exact name with --list-models
PRICE_IN, PRICE_OUT = 0.75, 3.75       # USD per 1M tokens, Gemini 3.8 Flash list price (Nov 2026);
                                       # audio input may be priced differently - check Google's page
INLINE_LIMIT = 15 * 1024 * 1024        # bigger audio files go through the Files API

SPEAKERS = {"operator": "OPERATOR", "client": "CLIENT", "bot": "BOT", "system": "SYSTEM"}
RE_RECORDING = re.compile(r"запис|record", re.I)
RE_START = re.compile(r"запущен|started", re.I)
RE_PAUSE = re.compile(r"приостановлен|paused", re.I)
RE_RESUME = re.compile(r"возобновлен|resumed", re.I)

DEFAULT_INSTRUCTIONS = """\
You are a call-center quality reviewer at a brokerage (Freedom Broker, Kazakhstan).
You get the audio of a phone call and its automatic transcript. Transcript lines are
numbered like [15] and have mm:ss times from the start of the audio. The transcript was
made by speech recognition and has errors: when text and audio disagree, trust the audio.
Personal data in the transcript is masked; that is expected.

Task: judge ONLY the OPERATOR's voice and manner. Ignore the client, the bot and system lines.
Find moments where the operator sounds contemptuous, dismissive, condescending, irritated
or mocking - especially when the words are polite but the tone is not.
Cues: audible sigh before answering; sarcastic or stretched intonation; mocking stress on
words; flat, bored "I don't care" delivery; a short laugh or snort at the client; talking
over or cutting off the client; rude words.

Rules:
- Calm, normal, professional speech is not a problem. Fast speech, an accent, a tired voice
  or poor audio quality alone are not contempt.
- Repeating a question or insisting on identity verification is part of the job, not contempt.
- Flag a moment only if you can tie it to a specific OPERATOR line number.
- Use "clear" only when most listeners would agree; otherwise "possible". If unsure, flag nothing.
- In "reason", say in one sentence what exactly you heard.

Notes (moments worth showing that are NOT problems):
- If the operator interrupted the client but then apologized for it (e.g. "извините, что
  перебил"), do NOT flag it. Add a note with kind "apology_after_interrupt", "message" =
  the line number of the apology, and in "reason" mention the interrupted line, e.g. "[7]".
- Other operator apologies (for waiting, for an error) -> kind "apology_other".
- A clearly warm, empathetic reaction to the client's problem -> kind "empathy".
- Notes must also point to a specific OPERATOR line number.

Output language and references:
- Write "reason" and "summary" in Russian.
- In "reason" and "summary", refer to transcript lines as [n], e.g. "в [7] оператор перебил клиента".
"""


# ---------------------------------------------------------------- loading
def load_records(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and "data" in data:
        return data["data"]["records"]
    if isinstance(data, dict):
        return [data]
    return data


def load_dotenv():
    for folder in (Path.cwd(), HERE):
        env = folder / ".env"
        if env.exists():
            for line in env.read_text(encoding="utf-8").splitlines():
                if "=" in line and not line.lstrip().startswith("#"):
                    key, value = line.split("=", 1)
                    os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_instructions(path_arg):
    if path_arg:
        return Path(path_arg).read_text(encoding="utf-8")
    default = HERE / "voice_instructions.txt"
    if not default.exists():
        default.write_text(DEFAULT_INSTRUCTIONS, encoding="utf-8")
        print(f"Created {default.name} - edit it to change what Gemini looks for.")
    return default.read_text(encoding="utf-8")


# ---------------------------------------------------------------- transcripts
def parse_iso(ts):
    """Parse ISO time; trims 7-digit fractions so it works on Python 3.10 too."""
    ts = re.sub(r"(\.\d{6})\d+", r"\1", ts)
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def mmss(seconds):
    seconds = max(0, int(round(seconds)))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def chat_seconds(ts):
    total = 0
    for part in ts.split(":"):
        total = total * 60 + int(part)
    return total


def audio_times(transcript, pause_mode):
    """Second in the audio for each message, plus whether it was recorded."""
    wall = [parse_iso(m["timestamp"]) for m in transcript]
    start = wall[0]
    for m, t in zip(transcript, wall):
        if m["speaker"] == "system" and RE_RECORDING.search(m["text"]) and RE_START.search(m["text"]):
            start = t
            break

    result, paused_total, paused_since = [], 0.0, None
    for m, t in zip(transcript, wall):
        text = m["text"] if m["speaker"] == "system" else ""
        if RE_RECORDING.search(text):
            if RE_PAUSE.search(text) and paused_since is None:
                paused_since = t
            elif RE_RESUME.search(text) and paused_since is not None:
                paused_total += (t - paused_since).total_seconds()
                paused_since = None
        elapsed = (t - start).total_seconds()
        if pause_mode == "cut":
            current = (t - paused_since).total_seconds() if paused_since else 0.0
            elapsed -= paused_total + current
        result.append((max(0.0, elapsed), paused_since is None))

    wall_dur = (wall[-1] - start).total_seconds()
    still = (wall[-1] - paused_since).total_seconds() if paused_since else 0.0
    return result, wall_dur, wall_dur - paused_total - still


def build_transcript(record, pause_mode):
    transcript = record["transcript"]
    is_call = record.get("channel") == "voice call"
    if is_call:
        times, wall_dur, cut_dur = audio_times(transcript, pause_mode)
    else:
        times = [(chat_seconds(m["timestamp"]), True) for m in transcript]
        wall_dur = cut_dur = None

    header = (
        f"conversation_id: {record['conversation_id']} | channel: {record.get('channel')} | "
        f"language: {record.get('language')}\n"
        + ("Times are mm:ss from the start of the audio recording.\n" if is_call
           else "Times are mm:ss as given in the chat.\n")
        + "Lines marked (not recorded) happened while recording was paused.\n"
    )
    lines, index = [], []
    for n, (m, (sec, recorded)) in enumerate(zip(transcript, times), start=1):
        who = SPEAKERS.get(m["speaker"], m["speaker"].upper())
        note = "" if recorded else " (not recorded)"
        lines.append(f"[{n}] {mmss(sec)} {who}{note}: {' '.join(m['text'].split())}")
        index.append({"n": n, "speaker": m["speaker"], "timestamp": m["timestamp"],
                      "audio_sec": round(sec, 2), "recorded": recorded})

    sidecar = {
        "conversation_id": record["conversation_id"],
        "channel": record.get("channel"),
        "language": record.get("language"),
        "pause_mode": pause_mode if is_call else None,
        "expected_audio_length": (
            {"if_pauses_cut": mmss(cut_dur), "if_pauses_kept": mmss(wall_dur)} if is_call else None),
        "messages": index,
    }
    return header + "\n" + "\n".join(lines) + "\n", sidecar


# ---------------------------------------------------------------- audio
def sniff_audio(data):
    """Return (extension, mime type) if the bytes look like audio."""
    if data[:3] == b"ID3":
        return "mp3", "audio/mp3"
    if len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        layer = (data[1] >> 1) & 3
        return ("aac", "audio/aac") if layer == 0 else ("mp3", "audio/mp3")
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav", "audio/wav"
    if data[:4] == b"OggS":
        return "ogg", "audio/ogg"
    if data[:4] == b"fLaC":
        return "flac", "audio/flac"
    if data[4:8] == b"ftyp":
        return "m4a", "audio/mp4"
    if data[:4] == b"\x1aE\xdf\xa3":
        return "webm", "audio/webm"
    return None


def iter_strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from iter_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from iter_strings(v)


def http_get(url):
    import requests
    r = requests.get(url, timeout=180)
    r.raise_for_status()
    return r.content


RE_MEDIA_SRC = re.compile(r"<(?:source|audio)\b[^>]*?\bsrc\s*=\s*[\"']([^\"']+)[\"']", re.I)


def extract_audio(data, depth=0):
    """The link may return audio bytes, an HTML player page with the real link inside
    (the organizers' links do this; the inner link expires in ~1 hour), or JSON with
    base64 audio or another link."""
    kind = sniff_audio(data)
    if kind:
        return data, kind
    if depth >= 2:
        return None, None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None, None

    if "<html" in text[:500].lower() or "<audio" in text.lower():
        for src in RE_MEDIA_SRC.findall(text):
            try:
                found = extract_audio(http_get(html.unescape(src)), depth + 1)
            except Exception:
                continue
            if found[0]:
                return found
        return None, None

    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return None, None
    for s in iter_strings(obj):
        s = s.strip()
        if s.startswith("data:") and ";base64," in s:
            s = s.split(";base64,", 1)[1]
        if s.startswith(("http://", "https://")):
            try:
                found = extract_audio(http_get(s), depth + 1)
            except Exception:
                continue
            if found[0]:
                return found
        elif len(s) > 1000:
            try:
                raw = base64.b64decode(s)
            except (binascii.Error, ValueError):
                continue
            kind = sniff_audio(raw)
            if kind:
                return raw, kind
    return None, None


def fetch_audio(record, audio_dir):
    """Return (path, mime, error). Uses the cached file if it was downloaded before."""
    cid = record["conversation_id"]
    for cached in audio_dir.glob(f"{cid}.*"):
        if cached.suffix != ".bin":
            kind = sniff_audio(cached.read_bytes()[:16])
            if kind:
                return cached, kind[1], None

    last_error = None
    for attempt in range(3):
        try:
            data = http_get(record["audio_url"])
            break
        except Exception as e:  # network errors, timeouts, HTTP 5xx
            last_error = e
            time.sleep(2 * (attempt + 1))
    else:
        return None, None, f"download failed: {last_error}"

    audio, kind = extract_audio(data)
    if not audio:
        raw = audio_dir / f"{cid}.unknown.bin"
        raw.write_bytes(data)
        if RE_MEDIA_SRC.search(data.decode("utf-8", "replace")):
            return None, None, (f"player page found, but the audio link inside failed "
                                f"(it expires in ~1 hour; just run again) - saved {raw.name}")
        return None, None, f"not audio - saved {raw.name} to inspect (starts with {data[:40]!r})"
    path = audio_dir / f"{cid}.{kind[0]}"
    path.write_bytes(audio)
    return path, kind[1], None


# ---------------------------------------------------------------- Gemini
def make_client():
    from google import genai
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise SystemExit("No API key: set GEMINI_API_KEY (or put it in .env), or run with --no-gemini")
    return genai.Client(api_key=key)


def voice_schema():
    from typing import List, Literal
    from pydantic import BaseModel

    # Field order matters: the model writes the evidence first, then decides the label.
    class Flag(BaseModel):
        message: int
        time: str
        cue: Literal["sigh", "sarcasm", "flat", "mocking_stress", "laugh",
                     "interrupt", "rude_words", "other"]
        reason: str
        label: Literal["possible", "clear"]

    # Notable moments that are NOT problems (e.g. interrupted but apologized right away).
    class Note(BaseModel):
        message: int
        time: str
        kind: Literal["apology_after_interrupt", "apology_other", "empathy", "other"]
        reason: str

    class VoiceResult(BaseModel):
        flags: List[Flag]
        notes: List[Note]
        summary: str

    return VoiceResult


def analyze_voice(client, model, instructions, schema, audio_path, mime, transcript_txt):
    from google.genai import types

    if audio_path.stat().st_size > INLINE_LIMIT:
        audio_part = client.files.upload(file=str(audio_path), config={"mime_type": mime})
    else:
        audio_part = types.Part.from_bytes(data=audio_path.read_bytes(), mime_type=mime)
    prompt = instructions.strip()
    if transcript_txt:  # None in --audio-only mode: the model only hears the call
        prompt += "\n\nTRANSCRIPT:\n" + transcript_txt
    config = types.GenerateContentConfig(
        response_mime_type="application/json", response_schema=schema, temperature=0)

    last_error = None
    for attempt in range(3):
        try:
            resp = client.models.generate_content(
                model=model, contents=[audio_part, prompt], config=config)
            parsed = resp.parsed if isinstance(resp.parsed, schema) else schema.model_validate_json(resp.text)
            u = resp.usage_metadata
            usage = {
                "input_tokens": getattr(u, "prompt_token_count", None) or 0,
                "output_tokens": (getattr(u, "candidates_token_count", None) or 0)
                                 + (getattr(u, "thoughts_token_count", None) or 0),
            }
            return parsed.model_dump(), usage
        except Exception as e:
            if getattr(e, "code", None) in (400, 401, 403, 404):  # wrong key/model/request: no retry
                raise
            last_error = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Gemini failed 3 times: {last_error}")


def _check_items(items, by_n, kind):
    kept, rejected = [], []
    for f in items:
        m = by_n.get(f["message"])
        if m is None:
            rejected.append({**f, "type": kind, "why_rejected": "no such line number"})
        elif m["speaker"] != "operator":
            rejected.append({**f, "type": kind, "why_rejected": f"line is {m['speaker']}, not operator"})
        else:
            kept.append({**f, "audio_sec": m["audio_sec"], "heard_at": f["time"]})
    return kept, rejected


def parse_clock(text):
    """'4:17', '04:17' or '00:04:17' -> seconds; None if it can't be read."""
    m = re.search(r"(\d+):(\d{1,2})(?::(\d{1,2}))?", str(text))
    if not m:
        return None
    a, b, c = m.groups()
    return int(a) * 3600 + int(b) * 60 + int(c) if c else int(a) * 60 + int(b)


def map_times_to_lines(result, sidecar, window=8.0):
    """--audio-only: the model gives only times. Point each flag/note at the nearest
    OPERATOR line (within `window` seconds) so the UI can still jump to it."""
    ops = [m for m in sidecar["messages"] if m["speaker"] == "operator" and m["recorded"]]
    for key in ("flags", "notes"):
        for item in result.get(key, []):
            t = parse_clock(item.get("time"))
            best = min(ops, key=lambda m: abs(m["audio_sec"] - t), default=None) if t is not None else None
            if best is not None and abs(best["audio_sec"] - t) <= window:
                item["message"] = best["n"]
            else:
                item["message"] = 0  # no operator line near that time -> will be rejected
    return result


def check_flags(result, sidecar):
    """Keep only flags/notes that point to a real OPERATOR line; attach the exact audio second."""
    by_n = {m["n"]: m for m in sidecar["messages"]}
    flags, rejected = _check_items(result["flags"], by_n, "flag")
    notes, rejected_notes = _check_items(result.get("notes", []), by_n, "note")
    if any(f["label"] == "clear" for f in flags):
        overall = "clear_issue"
    elif flags:
        overall = "possible_issue"
    else:
        overall = "ok"
    return overall, flags, notes, rejected + rejected_notes


# ---------------------------------------------------------------- pipeline
def process(record, args, ctx):
    cid = record["conversation_id"]
    row = {"id": cid, "channel": record.get("channel"), "audio": "", "voice": "",
           "flags": "", "notes": "", "cost_usd": ""}
    try:
        text, sidecar = build_transcript(record, args.pause_mode)
        (ctx["dirs"]["transcripts"] / f"{cid}.txt").write_text(text, encoding="utf-8")
        (ctx["dirs"]["transcripts"] / f"{cid}.json").write_text(
            json.dumps(sidecar, ensure_ascii=False, indent=2), encoding="utf-8")

        if record.get("channel") != "voice call":
            row["audio"] = "no audio (chat)"
            return row
        if not record.get("audio_url"):
            row["audio"] = "call without audio_url"
            return row

        voice_file = ctx["dirs"]["voice"] / f"{cid}.json"
        if voice_file.exists() and not args.force and not args.no_gemini:
            done = json.loads(voice_file.read_text(encoding="utf-8"))
            row.update(audio="cached", voice=done["overall"] + " (cached)",
                       flags=len(done["flags"]), notes=len(done.get("notes", [])),
                       cost_usd=done.get("cost_usd", ""))
            return row

        path, mime, error = fetch_audio(record, ctx["dirs"]["audio"])
        if error:
            row["audio"] = error
            return row
        row["audio"] = f"ok ({path.name})"
        if args.no_gemini:
            return row

        started = time.time()
        print(f"  ... {cid}: sent to Gemini", flush=True)
        result, usage = analyze_voice(ctx["client"], args.model, ctx["instructions"],
                                      ctx["schema"], path, mime,
                                      None if args.audio_only else text)
        if args.audio_only:
            result = map_times_to_lines(result, sidecar)
        overall, kept, notes, rejected = check_flags(result, sidecar)
        print(f"  done {cid} in {time.time() - started:.0f}s: {overall}, "
              f"{len(kept)} flags, {len(notes)} notes", flush=True)
        cost = (usage["input_tokens"] * PRICE_IN + usage["output_tokens"] * PRICE_OUT) / 1e6
        voice_file.write_text(json.dumps({
            "conversation_id": cid,
            "model": args.model,
            "audio_file": path.name,
            "pause_mode": args.pause_mode,
            "audio_only": args.audio_only,
            "overall": overall,
            "summary": result["summary"],
            "flags": kept,
            "notes": notes,
            "rejected_flags": rejected,
            "usage": usage,
            "cost_usd": round(cost, 5),
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        row.update(voice=overall, flags=len(kept), notes=len(notes), cost_usd=round(cost, 5))
    except Exception as e:  # one broken record must not stop the batch
        row["voice"] = f"ERROR: {type(e).__name__}: {e}"
    return row


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?", help="JSON file from the organizers' API")
    ap.add_argument("--out", default="out")
    ap.add_argument("--model", default=None)
    ap.add_argument("--pause-mode", choices=["cut", "keep"], default="cut")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--instructions", default=None)
    ap.add_argument("--no-gemini", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list-models", action="store_true")
    ap.add_argument("--audio-only", action="store_true",
                    help="send only the audio (no transcript); model reports mm:ss times, "
                         "script maps them to the nearest operator line. "
                         "Use with --instructions voice_instructions_audio_only.txt")
    args = ap.parse_args()

    load_dotenv()
    args.model = args.model or os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL

    if args.list_models:
        client = make_client()  # keep a reference: the SDK closes its connection when the client is garbage-collected
        for m in client.models.list():
            if "gemini" in m.name:
                print(m.name)
        return
    if not args.input:
        ap.error("give the JSON file, e.g.  python to_gemini.py dev.json")

    out = Path(args.out)
    dirs = {name: out / name for name in ("transcripts", "audio", "voice")}
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)

    ctx = {"dirs": dirs, "client": None, "schema": None, "instructions": None}
    if not args.no_gemini:
        ctx.update(client=make_client(), schema=voice_schema(),
                   instructions=load_instructions(args.instructions))

    records = load_records(args.input)
    calls = sum(1 for r in records if r.get("channel") == "voice call")
    print(f"{len(records)} records ({calls} calls). Model: "
          f"{'none (--no-gemini)' if args.no_gemini else args.model}. Working...")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(lambda r: process(r, args, ctx), records))

    with open(out / "summary.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    for r in rows:
        if r["channel"] == "voice call" or r["voice"].startswith("ERROR"):
            print(f"  {r['id']:<14} audio: {r['audio']:<28} voice: {r['voice']}  flags: {r['flags']}"
                  f"  notes: {r['notes']}  ${r['cost_usd']}")
    paid = [r["cost_usd"] for r in rows if isinstance(r["cost_usd"], float)]
    if paid:
        print(f"Gemini cost this run: ${sum(paid):.4f} for {len(paid)} calls "
              f"(${sum(paid) / len(paid):.4f} per call)")
    print(f"Chats: {len(records) - calls} transcripts written. Output: {out.resolve()}")


if __name__ == "__main__":
    main()
