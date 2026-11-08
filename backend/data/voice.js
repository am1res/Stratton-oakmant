// Runs voice/to_gemini.py for one call and returns when voice/out/voice/<id>.json exists.
// The checklist score is untouched. Owner of the script: the voice pipeline; this file only starts it.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, ROOT } from '../config.js';

const running = new Set();

export function voicePython() {
  if (process.env.VOICE_PYTHON) return process.env.VOICE_PYTHON;
  const venv = path.join(ROOT, 'voice/.venv/bin/python');
  if (existsSync(venv)) return venv;
  const app = path.join(ROOT, 'ai_eval/.venv/bin/python');
  return existsSync(app) ? app : 'python3';
}

export function analyzeCall(record, { force = false } = {}) {
  const id = record.conversation_id;
  if (running.has(id)) {
    const err = new Error('Анализ этого звонка уже идёт.');
    err.status = 409;
    throw err;
  }
  running.add(id);
  return run(record, force).finally(() => running.delete(id));
}

function run(record, force) {
  return new Promise((resolve, reject) => {
    mkdtemp(path.join(os.tmpdir(), 'cqa-voice-'))
      .then(async (dir) => {
        const input = path.join(dir, 'call.json');
        await writeFile(input, JSON.stringify(record));
        const child = spawn(voicePython(), [
          path.join(ROOT, 'voice/to_gemini.py'),
          input,
          '--out', config.paths.voiceOut,
          '--workers', '1',
          ...(force ? ['--force'] : []),
        ], { cwd: ROOT, env: process.env });
        let text = '';
        child.stdout.on('data', (chunk) => { text += chunk; });
        child.stderr.on('data', (chunk) => { text += chunk; });
        child.on('error', (err) => {
          rm(dir, { recursive: true, force: true });
          reject(err);
        });
        child.on('close', (code) => {
          rm(dir, { recursive: true, force: true });
          const failed = code !== 0 || /ERROR:/.test(text) || /No API key/.test(text);
          if (failed) {
            const message = text.trim().split('\n').filter(Boolean).slice(-4).join(' ') || `voice analysis exited ${code}`;
            const err = new Error(message.slice(0, 500));
            err.status = /No API key|API key|401|403/.test(message) ? 400 : 502;
            reject(err);
            return;
          }
          resolve();
        });
      })
      .catch(reject);
  });
}
