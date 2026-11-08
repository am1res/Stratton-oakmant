"""Label each operator turn with a local emotion2vec model.

Writes voice/out/emotion/<id>.json. Labels are acoustic hints for the
transcript and for the text judges. They are not checklist scores.

Requires funasr in this folder's virtualenv. Audio is cut with the ffmpeg
binary shipped by imageio-ffmpeg, so a system ffmpeg is not required.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from to_gemini import build_transcript, fetch_audio  # noqa: E402

MODEL_ID = "iic/emotion2vec_plus_base"
HIGHLIGHT = {"angry", "disgusted"}
# Phone clips shorter than this are a name, a fragment, or silence. The model
# assigns those a confident emotion anyway, so they are not labeled.
MIN_VOICED_SEC = 1.0
# A harsh mark needs a sustained phrase, not a one-second spike.
HIGHLIGHT_VOICED_SEC = 1.5
THRESHOLD = 0.85
LABELS_RU = {
    "angry": "злость",
    "disgusted": "отвращение",
    "fearful": "страх",
    "happy": "радость",
    "neutral": "спокойно",
    "other": "другое",
    "sad": "грусть",
    "surprised": "удивление",
    "unknown": "неясно",
}


def english_label(raw: str) -> str:
    text = str(raw or "").strip().lower()
    if "/" in text:
        text = text.split("/")[-1]
    text = text.replace(" ", "")
    for name in LABELS_RU:
        if name in text:
            return name
    return text or "unknown"


def top_label(result: dict) -> tuple[str, float]:
    labels = result.get("labels") or []
    scores = result.get("scores") or []
    if not labels or not scores or len(labels) != len(scores):
        raw = result.get("label") or result.get("text") or ""
        return english_label(raw), float(result.get("score") or 0)
    best = max(range(len(scores)), key=lambda i: scores[i])
    return english_label(labels[best]), float(scores[best])


def highlight(label: str, score: float, voiced_sec: float) -> bool:
    # The angry/disgusted head is not usable on these phone recordings. After
    # silence was trimmed, a polite line ("Это очень приятно. Здравствуйте…")
    # still scored angry at 0.999, and a plain "Здравствуйте" scored 0.88.
    # Duration and score checks removed the silence false alarms. They do not
    # make the remaining angry labels trustworthy, so nothing is marked and
    # nothing is sent to the checklist judges.
    del label, score, voiced_sec
    return False


def ffmpeg_bin() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def cut_wav(audio: Path, start: float, end: float, dest: Path) -> None:
    if end - start < 0.4:
        raise ValueError("clip too short")
    subprocess.run(
        [
            ffmpeg_bin(),
            "-y",
            "-ss",
            f"{max(0.0, start):.3f}",
            "-to",
            f"{end:.3f}",
            "-i",
            str(audio),
            "-ac",
            "1",
            "-ar",
            "16000",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )


def operator_spans(sidecar: dict) -> list[dict]:
    messages = sidecar["messages"]
    spans = []
    for index, message in enumerate(messages):
        if message["speaker"] != "operator" or not message.get("recorded", True):
            continue
        start = float(message["audio_sec"])
        end = start + 4.0
        for later in messages[index + 1 :]:
            end = float(later["audio_sec"])
            break
        end = min(end, start + 12.0)
        if end - start < 0.4:
            continue
        spans.append(
            {
                "msg_index": message["n"] - 1,
                "line_number": message["n"],
                "start": start,
                "end": end,
            }
        )
    return spans


def trim_to_speech(wav: Path) -> float | None:
    """Keep the longest stretch of speech and return how many seconds of it are voiced.

    The turn window runs until the next line, so a short reply is often followed
    by several seconds of silence. emotion2vec then labels the silence. Returns
    None when the clip does not contain enough speech to trust.
    """
    with wave.open(str(wav)) as handle:
        rate = handle.getframerate()
        count = handle.getnframes()
        raw = handle.readframes(count)
        if handle.getsampwidth() != 2 or handle.getnchannels() != 1:
            return None
    samples = struct.unpack("<" + "h" * (len(raw) // 2), raw)
    hop = max(1, int(rate * 0.02))
    frames = []
    for start in range(0, len(samples) - hop, hop):
        frame = samples[start : start + hop]
        frames.append(math.sqrt(sum(sample * sample for sample in frame) / len(frame)))
    if not frames:
        return None
    ordered = sorted(frames)
    floor = ordered[max(0, len(ordered) // 10)]
    typical = ordered[min(len(ordered) - 1, int(len(ordered) * 0.6))]
    # Stay above the quiet tail, but never above the typical frame. A clip that
    # is speech all the way through has no quiet tail, and a threshold of
    # "three times the floor" would then mark every frame as silence.
    threshold = min(max(300.0, floor * 3), typical * 0.85)
    voiced = [level >= threshold for level in frames]
    bridge = int(0.35 / 0.02)
    clusters: list[tuple[int, int, int]] = []
    index = 0
    while index < len(voiced):
        if not voiced[index]:
            index += 1
            continue
        end = index
        gap = 0
        voiced_frames = 0
        while end < len(voiced):
            if voiced[end]:
                voiced_frames += 1
                gap = 0
                end += 1
                continue
            gap += 1
            if gap > bridge:
                break
            end += 1
        clusters.append((index, end - gap, voiced_frames))
        index = end
    if not clusters:
        return None
    start_frame, end_frame, voiced_frames = max(clusters, key=lambda item: item[2])
    voiced_sec = voiced_frames * 0.02
    if voiced_sec < MIN_VOICED_SEC:
        return None
    pad = int(0.12 * rate)
    start = max(0, start_frame * hop - pad)
    end = min(len(samples), end_frame * hop + pad)
    chunk = samples[start:end]
    with wave.open(str(wav), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(struct.pack("<" + "h" * len(chunk), *chunk))
    return round(voiced_sec, 3)


def load_model():
    from funasr import AutoModel

    cached = Path.home() / ".cache/huggingface/hub/models--emotion2vec--emotion2vec_plus_base/snapshots"
    local = next((path for path in sorted(cached.glob("*")) if (path / "model.pt").exists()), None) if cached.exists() else None
    if local is not None:
        return AutoModel(model=str(local), device="cpu", disable_update=True)
    return AutoModel(model=MODEL_ID, hub="hf", device="cpu", disable_update=True)


def classify_clip(model, wav: Path) -> tuple[str, float]:
    rows = model.generate(
        str(wav),
        output_dir=None,
        granularity="utterance",
        extract_embedding=False,
    )
    row = rows[0] if isinstance(rows, list) and rows else rows
    if not isinstance(row, dict):
        return "unknown", 0.0
    return top_label(row)


def analyze_record(record: dict, out_dir: Path, model=None) -> dict:
    text, sidecar = build_transcript(record, "cut")
    del text
    audio_dir = out_dir / "audio"
    emotion_dir = out_dir / "emotion"
    audio_dir.mkdir(parents=True, exist_ok=True)
    emotion_dir.mkdir(parents=True, exist_ok=True)
    audio_path, _mime, error = fetch_audio(record, audio_dir)
    if error or audio_path is None:
        raise RuntimeError(error or "no audio")
    spans = operator_spans(sidecar)
    if model is None:
        model = load_model()
    lines = []
    with tempfile.TemporaryDirectory(prefix="cqa-emotion-") as tmp:
        folder = Path(tmp)
        for span in spans:
            wav = folder / f"{span['msg_index']}.wav"
            try:
                cut_wav(audio_path, span["start"], span["end"], wav)
                voiced_sec = trim_to_speech(wav)
                if voiced_sec is None:
                    continue
                label, score = classify_clip(model, wav)
            except (subprocess.CalledProcessError, ValueError, OSError):
                continue
            lines.append(
                {
                    "msg_index": span["msg_index"],
                    "label": label,
                    "label_ru": LABELS_RU.get(label, label),
                    "score": round(score, 3),
                    "voiced_sec": voiced_sec,
                    "highlight": highlight(label, score, voiced_sec),
                }
            )
    payload = {
        "conversation_id": record["conversation_id"],
        "model": MODEL_ID,
        "lines": lines,
    }
    (emotion_dir / f"{record['conversation_id']}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="One call record, or a dataset JSON")
    parser.add_argument("--out", default="out")
    parser.add_argument("--id", default="", help="Analyze only this conversation_id")
    args = parser.parse_args()
    records = json.loads(Path(args.input).read_text(encoding="utf-8"))
    if isinstance(records, dict) and "data" in records:
        records = records["data"]["records"]
    elif isinstance(records, dict):
        records = [records]
    if args.id:
        records = [record for record in records if record.get("conversation_id") == args.id]
    if not records:
        print("no matching call", file=sys.stderr)
        return 1
    try:
        payload = analyze_record(records[0], Path(args.out))
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    flagged = [line for line in payload["lines"] if line["highlight"]]
    print(f"lines={len(payload['lines'])} highlighted={len(flagged)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
