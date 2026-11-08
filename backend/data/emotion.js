// Local per-line operator tone. Runs voice/emotion_lines.py and reads its JSON.
// Checklist scoring does not use these labels. The text judges may see the highlighted lines.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, ROOT } from '../config.js';
import { getSignedAudioUrl } from './source.js';
import { voicePython } from './voice.js';

const running = new Set();

export function emotionPath(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(config.paths.voiceOut, 'emotion', `${safe}.json`);
}

export async function readEmotion(id) {
  try {
    const raw = JSON.parse(await readFile(emotionPath(id), 'utf-8'));
    return Array.isArray(raw.lines) ? raw : null;
  } catch {
    return null;
  }
}

export function analyzeEmotion(conv) {
  const id = conv.conversation_id;
  if (running.has(id)) {
    const err = new Error('Разметка тона этого звонка уже идёт.');
    err.status = 409;
    throw err;
  }
  running.add(id);
  const record = {
    conversation_id: id,
    channel: conv.channel,
    language: conv.language,
    audio_url: getSignedAudioUrl(id) || '',
    transcript: conv.transcript.map((m) => ({ timestamp: m.timestamp, speaker: m.speaker, text: m.text })),
  };
  return run(record).finally(() => running.delete(id));
}

function run(record) {
  return new Promise((resolve, reject) => {
    const python = voicePython();
    if (!existsSync(python) && python === 'python3') {
      const err = new Error('Нет Python для emotion2vec. Создайте voice/.venv и установите funasr.');
      err.status = 500;
      reject(err);
      return;
    }
    mkdtemp(path.join(os.tmpdir(), 'cqa-emotion-'))
      .then(async (dir) => {
        const input = path.join(dir, 'call.json');
        await writeFile(input, JSON.stringify(record));
        const child = spawn(python, [
          path.join(ROOT, 'voice/emotion_lines.py'),
          input,
          '--out',
          config.paths.voiceOut,
        ], { cwd: ROOT, env: process.env });
        let text = '';
        child.stdout.on('data', (chunk) => { text += chunk; });
        child.stderr.on('data', (chunk) => { text += chunk; });
        child.on('error', (err) => {
          rm(dir, { recursive: true, force: true });
          reject(err);
        });
        child.on('close', async (code) => {
          await rm(dir, { recursive: true, force: true });
          if (code !== 0) {
            const err = new Error((text || `emotion2vec exited ${code}`).trim().slice(-500));
            err.status = 502;
            reject(err);
            return;
          }
          resolve(await readEmotion(record.conversation_id));
        });
      })
      .catch(reject);
  });
}
