// Gemini "listening" results for the calls, exported next to the submission:
//   results/audio_additional/voice_review.json  +  README.md
// This is an extra, NOT part of the score: the checklist is graded from the transcript only.
// Source: voice/out/voice/<id>.json, written by voice/to_gemini.py (or the "Послушать запись" button).
// Line numbers: Gemini refers to transcript lines as [n], 1-based and counting every line (bot and
// system too) — the same numbering as evidence_turns in results.json.
// Run: npm run export-voice
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const voiceDir = path.resolve(ROOT, process.env.VOICE_OUT_DIR || 'voice/out', 'voice');
const outDir = path.join(ROOT, 'results', 'audio_additional');

// which set each conversation belongs to, from the submitted results files
const setOf = new Map();
const calls = [];
for (const set of ['dev', 'prod']) {
  const f = path.join(ROOT, 'results', set, 'results.json');
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf-8')).results) setOf.set(r.conversation_id, set);
}
for (const f of ['data/dev.json', ...fs.readdirSync('data/cache').filter((x) => x.endsWith('.json')).map((x) => `data/cache/${x}`)].filter((f) => fs.existsSync(f))) {
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf-8').replace(/^﻿/, ''));
    const recs = Array.isArray(j) ? j : j.data?.records || j.records || [];
    for (const r of recs) if (r.channel === 'voice call' && !calls.includes(r.conversation_id)) calls.push(r.conversation_id);
  } catch {}
}

const turnsIn = (s) => [...String(s || '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
const point = (x) => ({ turn: Number.isInteger(x.message) ? x.message : null, ...x });

const results = [];
for (const file of fs.existsSync(voiceDir) ? fs.readdirSync(voiceDir).filter((f) => f.endsWith('.json')).sort() : []) {
  const v = JSON.parse(fs.readFileSync(path.join(voiceDir, file), 'utf-8'));
  results.push({
    conversation_id: v.conversation_id,
    set: setOf.get(v.conversation_id) || null,
    model: v.model,
    listened_to: v.audio_only ? 'audio only' : 'audio + transcript',
    overall: v.overall, // ok | possible_issue | clear_issue
    summary: v.summary,
    summary_turns: turnsIn(v.summary),
    flags: (v.flags || []).map(point), // moments where the operator may sound cold / dismissive / mocking
    notes: (v.notes || []).map(point), // e.g. apologized after interrupting
    used_in_score: false,
    cost_usd: v.cost_usd ?? null,
    created_at: v.created_at,
  });
}
const done = new Set(results.map((r) => r.conversation_id));
const missing = calls.filter((id) => !done.has(id));

const out = {
  schema_version: '1.0',
  team_name: process.env.TEAM_NAME || 'Stratton Oakmont',
  about:
    'Extra, not part of the checklist score. Gemini listened to every call recording and flagged moments where the operator may sound cold, dismissive, irritated or mocking. In the app this is a hint for the reviewer with jump-to-moment buttons; a human confirms each flag. Turns are 1-based and count every line, like evidence_turns in results.json.',
  used_in_score: false,
  calls_total: calls.length,
  calls_listened: results.length,
  calls_missing: missing,
  results,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'voice_review.json'), JSON.stringify(out, null, 2) + '\n');

const row = (r) => `| ${r.conversation_id} | ${r.set || '—'} | ${r.overall} | ${r.flags.length} | ${r.notes.length} | ${String(r.summary || '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160)} |`;
const md = `# Голос звонков (дополнительно, в оценке не учитывается)

Чек-лист оценивается **только по расшифровке** (results/dev, results/prod). Дополнительно **Gemini прослушал записи всех звонков**
и отметил моменты, где оператор может звучать холодно, пренебрежительно, раздражённо или с насмешкой.

- В приложении это подсказка ревьюеру в карточке звонка (блок «Голос») с переходом к моменту записи. Каждую отметку подтверждает человек.
- **В балл это не входит** (\`used_in_score: false\`): по исследованиям 2026 года аудиомодели опираются больше на слова, чем на интонацию,
  а проверить точность на 5 звонках DEV нельзя. Поэтому голос мы держим отдельно от оценки.
- В контрольном наборе (prod) звонков нет — только чаты.
- Нумерация реплик: \`turn\` = номер строки с 1, считая реплики бота и системы (как \`evidence_turns\` в results.json).

Звонков: ${calls.length}, прослушано: ${results.length}${missing.length ? `, не прослушаны: ${missing.join(', ')}` : ''}.

| Звонок | Набор | Итог по голосу | Отметок | Заметок | Кратко |
|---|---|---|---|---|---|
${results.map(row).join('\n')}

Как получено: \`voice/to_gemini.py\` (модель ${[...new Set(results.map((r) => r.model))].join(', ') || '—'}), экспорт: \`npm run export-voice\`.
`;
fs.writeFileSync(path.join(outDir, 'README.md'), md);
console.log(`voice_review.json: ${results.length} calls listened, ${missing.length} missing${missing.length ? ` (${missing.join(', ')})` : ''} → results/audio_additional/`);
