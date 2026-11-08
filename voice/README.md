# Voice analysis (calls)

Gemini listens to each call and flags moments where the **operator** sounds cold, dismissive,
irritated or mocking, plus notes like "interrupted but apologized". It is a **hint for the
reviewer** shown in the call card. It never changes the checklist score.

Research in 2026 (VoxParadox, EACL "Do Audio LLMs Listen or Just Transcribe?") shows audio
models lean on the words more than on the voice, so a human confirms every flag.

## Run

```bash
cd voice
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
echo "GEMINI_API_KEY=your_key" > .env

python3 to_gemini.py --list-models                       # check the key, see model names
python3 to_gemini.py ../data/dev.json --out out --no-gemini   # transcripts + audio only (free)
python3 to_gemini.py ../data/dev.json --out out --workers 1   # full run (calls only)
```

The web app reads `voice/out/voice/<id>.json` and uses `voice/out/audio/<id>.mp3` as a local
audio copy (setting: `VOICE_OUT_DIR` in the main `.env`). Re-runs skip finished calls; add `--force`.

Options worth knowing:

- `--instructions voice_instructions_cold.txt`: stricter about coldness (found the cold reply in p4-ru-001).
- `--audio-only --instructions voice_instructions_audio_only.txt`: no transcript, the model only listens.
- `--pause-mode keep`: only if a recording keeps silence where recording was paused (DEV calls do not).
- `bash compare_models.sh p4-ru-001`: same call through several models / prompts.

Notes:

- The organizers' `audio_url` returns an HTML player page; the real mp3 link inside expires in ~1 hour.
  The script follows it and caches the mp3 in `out/audio/`.
- Free Gemini tier: slow (up to ~5 min per call) and Google may use the data to improve its products.
  Pro / Argon models are not available on the free tier.
- Cost on the paid tier: about $0.01 per call with gemini-3.8-flash (list price, Nov 2026).
- Never commit `.env`, `out/`, `out_cmp/` (real customer audio and transcripts).
