// Tests for the integration work: audio from the player page, pause-aware offsets, voice panel API,
// evidence quotes, ensemble mode (A + B + arbiter), skip_done batches. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cqa-test-'));
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4000, 1)]);

// --- fake organizer server: an HTML player page (like the real one) that points to an mp3 ---
let base;
const fake = http.createServer((req, res) => {
  if (req.url.startsWith('/real.mp3')) return res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(MP3);
  if (req.url === '/player') {
    return res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(`<!DOCTYPE html><html><head><title>Воспроизведение записи</title></head><body>
        <audio id="myAudio" controls><source src="${base}/real.mp3?sp=r&amp;sig=abc%3D&amp;rsct=audio%2Fmpeg" type="audio/mpeg"></audio></body></html>`);
  }
  if (req.url === '/dead') return res.writeHead(200).end(`<html><audio><source src="${base}/expired.mp3"></audio></html>`);
  res.writeHead(404).end('nope');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${fake.address().port}`;

// --- synthetic dataset: a call with a recording pause, and a chat ---
const T = (s) => new Date(Date.UTC(2026, 10, 3, 12, 0, 0) + s * 1000).toISOString().replace('Z', '+00:00');
const call = {
  conversation_id: 't-call',
  channel: 'voice call',
  language: 'RU',
  audio_url: `${base}/player`,
  transcript: [
    { timestamp: T(0), speaker: 'system', text: 'Запись и транскрибирование запущены.' },
    { timestamp: T(10), speaker: 'bot', text: 'Здравствуйте, нажмите 2.' },
    { timestamp: T(50), speaker: 'system', text: 'Запись и транскрибирование приостановлены.' },
    { timestamp: T(60), speaker: 'system', text: 'Агент присоединился к разговору с клиентом.' },
    { timestamp: T(70), speaker: 'system', text: 'Запись и транскрибирование возобновлены.' },
    { timestamp: T(75), speaker: 'operator', text: 'Здравствуйте, меня зовут Айгерим, чем помочь?' },
    { timestamp: T(80), speaker: 'client', text: 'Хочу купить облигации.' },
    { timestamp: T(90), speaker: 'operator', text: 'Нет, не делаем.' },
  ],
};
const chat = {
  conversation_id: 't-chat',
  channel: 'agent chat',
  language: 'KZ',
  audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Сәлем' },
    { timestamp: '00:05', speaker: 'operator', text: 'Сәлеметсіз бе! Атым Дана.' },
  ],
};
await fs.writeFile(path.join(tmp, 'dev.json'), JSON.stringify({ isSuccess: true, data: { records: [call, chat] } }));
await fs.mkdir(path.join(tmp, 'voice', 'voice'), { recursive: true });
await fs.writeFile(
  path.join(tmp, 'voice', 'voice', 't-call.json'),
  JSON.stringify({
    overall: 'possible_issue',
    summary: 'В [8] сухой отказ, в [6] вежливое приветствие.',
    flags: [{ message: 8, time: '00:20', cue: 'flat', reason: 'Сухо в [8]', label: 'possible', audio_sec: 20 }],
    notes: [{ message: 6, time: '00:05', kind: 'empathy', reason: 'Тепло', audio_sec: 5 }],
    model: 'gemini-test',
    cost_usd: 0.01,
  }),
);

Object.assign(process.env, {
  LLM_MOCK: '1',
  LLM_MODE: 'ensemble',
  CQA_DATA_FILE: path.join(tmp, 'dev.json'),
  VOICE_OUT_DIR: path.join(tmp, 'voice'),
  STORAGE_DIR: path.join(tmp, 'storage'),
});
const { app, reloadConversations } = await import('../backend/server.js');
const { audioOffsets } = await import('../backend/data/source.js');
const { sniffAudio, mediaLinks } = await import('../backend/data/audio.js');

let server;
let url;
before(async () => {
  await reloadConversations();
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  fake.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const json = async (p, opts) => {
  const r = await fetch(url + p, opts);
  return { status: r.status, body: await r.json() };
};
const post = (p, body) => json(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('offsets: paused part is cut out, paused lines are marked', () => {
  const o = audioOffsets(call.transcript);
  assert.equal(o[1].offset_sec, 10); // bot, before the pause
  assert.equal(o[2].recorded, false); // "приостановлены"
  assert.equal(o[3].recorded, false); // agent joined during the pause
  assert.equal(o[3].offset_sec, 50); // pinned to the pause start
  assert.equal(o[5].offset_sec, 55); // 75 s wall clock - 20 s pause
  assert.equal(o[7].offset_sec, 70);
  const c = audioOffsets(chat.transcript);
  assert.deepEqual(c.map((x) => x.offset_sec), [0, 5]);
});

test('audio helpers: sniff formats and read the player page', () => {
  assert.equal(sniffAudio(MP3), 'mp3');
  assert.equal(sniffAudio(Buffer.from('<!DOCTYPE html><html>')), null);
  assert.deepEqual(mediaLinks('<audio><source src="https://x/a.mp3?a=1&amp;b=2" type="audio/mpeg"></audio>'), ['https://x/a.mp3?a=1&b=2']);
});

test('audio endpoint follows the HTML player page, caches the mp3 and supports Range', async () => {
  const r = await fetch(`${url}/api/conversations/t-call/audio`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /audio\/mpeg/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.length, MP3.length);
  const cached = await fs.readdir(path.join(tmp, 'storage', 'audio'));
  assert.deepEqual(cached, ['t-call.mp3']);
  const part = await fetch(`${url}/api/conversations/t-call/audio`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  const chatAudio = await fetch(`${url}/api/conversations/t-chat/audio`);
  assert.equal(chatAudio.status, 404);
});

test('conversation API exposes recorded flag and audio proxy link only', async () => {
  const { body } = await json('/api/conversations/t-call');
  assert.equal(body.audio_url, '/api/conversations/t-call/audio');
  assert.equal(body.transcript[3].recorded, false);
  assert.ok(!JSON.stringify(body).includes(base), 'organizer link must not reach the browser');
});

test('voice endpoint converts line numbers [n] → #(n-1) and uses our offsets', async () => {
  const { body } = await json('/api/conversations/t-call/voice');
  assert.equal(body.available, true);
  assert.equal(body.summary, 'В #7 сухой отказ, в #5 вежливое приветствие.');
  assert.equal(body.flags[0].msg_index, 7);
  assert.equal(body.flags[0].offset_sec, 70);
  assert.equal(body.flags[0].reason, 'Сухо в #7');
  assert.equal(body.notes[0].msg_index, 5);
  const none = await json('/api/conversations/t-chat/voice');
  assert.deepEqual(none.body, { available: false });
});

test('ensemble evaluation: A+B agree or arbiter decides; evidence has quotes; score computed', async () => {
  const { status, body: ev } = await post('/api/evaluate', { conversation_id: 't-call' });
  assert.equal(status, 200);
  assert.equal(ev.mode, 'ensemble');
  assert.equal(ev.criteria.length, ev.checklist_snapshot.criteria.length);
  for (const c of ev.criteria) {
    assert.ok(['agreed', 'arbitrated', 'arbiter_failed'].includes(c.agreement));
    assert.ok(Array.isArray(c.evidence));
  }
  assert.ok(ev.criteria.some((c) => c.evidence[0]?.quote), 'quotes are kept');
  assert.equal(typeof ev.score.total, 'number');
});

test('ensemble with a disagreement goes to the arbiter', async () => {
  // find a conversation id for which mock evaluator B disagrees somewhere
  const { body: ev } = await post('/api/evaluate', { conversation_id: 't-chat' });
  const { body: ev2 } = await post('/api/evaluate', { conversation_id: 't-call' });
  const all = [...ev.criteria, ...ev2.criteria];
  assert.ok(all.some((c) => c.agreement === 'arbitrated'), 'at least one criterion was arbitrated');
  for (const c of all.filter((x) => x.agreement === 'arbitrated')) {
    assert.equal(c.confidence, 0.5);
    assert.equal(c.votes.length, 3);
  }
});

test('batch with skip_done skips conversations already evaluated under the current version', async () => {
  const { body: job } = await post('/api/evaluate/batch', { conversation_ids: ['t-call', 't-chat'], skip_done: true });
  assert.equal(job.skipped, 2);
  assert.equal(job.total, 0);
  assert.equal(job.status, 'done');
  const { body: job2 } = await post('/api/evaluate/batch', { conversation_ids: ['t-call'] });
  assert.equal(job2.total, 1);
  for (let i = 0; i < 50; i++) {
    const { body } = await json(`/api/jobs/${job2.id}`);
    if (body.status === 'done') {
      assert.equal(body.done, 1);
      assert.equal(body.errors.length, 0);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('batch did not finish');
});

test('appeal keeps checked_range and quotes; decision recalculates the total', async () => {
  const { body: list } = await json('/api/evaluations?conversation_id=t-call');
  const ev = list[0];
  const crit = ev.criteria.find((c) => c.criterion_id === 'c05');
  const { body: ap } = await post('/api/appeals', { evaluation_id: ev.id, criterion_id: 'c05', comment: 'Оператор был холоден в #7' });
  assert.ok('checked_range' in ap.original);
  assert.ok(Array.isArray(ap.original.evidence));
  const other = crit.answer === 'yes' ? 'no' : 'yes';
  const { body: d } = await post(`/api/appeals/${ap.id}/decide`, { answer: other, reason: 'Холодный тон в #7' });
  assert.equal(d.appeal.status, 'changed');
  assert.notEqual(d.evaluation.final.total, ev.score.total);
});

test('first batch on an empty storage: no failures from parallel checklist seeding', async () => {
  await fs.rm(path.join(tmp, 'storage', 'checklists'), { recursive: true, force: true });
  await fs.rm(path.join(tmp, 'storage', 'evaluations'), { recursive: true, force: true });
  const { body: job } = await post('/api/evaluate/batch', { conversation_ids: ['t-call', 't-chat', 't-call', 't-chat', 't-call'] });
  for (let i = 0; i < 100; i++) {
    const { body } = await json(`/api/jobs/${job.id}`);
    if (body.status === 'done') {
      assert.deepEqual(body.errors, []);
      assert.equal(body.done, 5);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('batch did not finish');
});

test('checklist: restore an older version as a new version, history kept', async () => {
  const { body: cur } = await json('/api/checklists/current');
  const withNew = {
    ...cur,
    criteria: [...cur.criteria, { id: 'c09', section: cur.sections[0].id, name: 'Тестовый критерий', type: 'binary', weight: 10, na_allowed: false, yes_rule: 'x', decision_steps: [], examples: [] }],
  };
  const put = await fetch(`${url}/api/checklists/current`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withNew) });
  const saved = await put.json();
  assert.equal(saved.version, cur.version + 1);
  assert.ok(saved.criteria.some((c) => c.id === 'c09'));

  const { status, body: restored } = await post('/api/checklists/restore', { version: cur.version });
  assert.equal(status, 200);
  assert.equal(restored.version, cur.version + 2);
  assert.equal(restored.restored_from, cur.version);
  assert.ok(!restored.criteria.some((c) => c.id === 'c09'));
  const { body: now } = await json('/api/checklists/current');
  assert.equal(now.version, restored.version);
  const { body: all } = await json('/api/checklists');
  assert.ok(all.some((v) => v.version === saved.version), 'the version with c09 is still in history');

  assert.equal((await post('/api/checklists/restore', { version: 999 })).status, 404);
  assert.equal((await post('/api/checklists/restore', { version: now.version })).status, 400);
});

test('operators: demo name + date are stable, calls keep their real date, real fields win', async () => {
  const { body: list } = await json('/api/conversations');
  const callRow = list.find((c) => c.conversation_id === 't-call');
  const chatRow = list.find((c) => c.conversation_id === 't-chat');
  assert.equal(callRow.operator_source, 'demo');
  assert.equal(callRow.date_source, 'call');
  assert.equal(callRow.date, '2026-11-03');
  assert.equal(chatRow.date_source, 'demo');
  assert.match(chatRow.date, /^2026-(09|10|11)-\d{2}$/);
  const again = (await json('/api/conversations')).body.find((c) => c.conversation_id === 't-chat');
  assert.equal(again.operator, chatRow.operator);
  assert.equal(again.date, chatRow.date);
  const { operatorAndDate } = await import('../backend/data/source.js');
  const real = operatorAndDate({ conversation_id: 'x', operator_name: 'Мирас Т.', date: '2026-10-01T10:00:00Z', transcript: [] });
  assert.deepEqual(real, { operator: 'Мирас Т.', operator_source: 'data', date: '2026-10-01', date_source: 'data' });
});

test('demo scenarios: strong / weak / improving / declining from real scores; calls keep real dates', async () => {
  const { arrangeScenarios } = await import('../backend/data/source.js');
  const items = Array.from({ length: 36 }, (_, i) => ({ id: `c${i}`, score: 20 + i * 2, isCall: false }));
  items.push({ id: 'call1', score: 50, isCall: true }, { id: 'call2', score: 90, isCall: true });
  items.push({ id: 'gross100', score: 100, isCall: false, gross: true });
  const a = arrangeScenarios(items);
  assert.equal(a.gross100.operator, 'Ержан', 'a gross error never goes to the strong operator');
  const score = Object.fromEntries(items.map((x) => [x.id, x.score]));
  const of = (name) => Object.entries(a).filter(([, v]) => v.operator === name).sort(([, x], [, y]) => (x.date || '').localeCompare(y.date || '')).map(([id]) => score[id]);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const half = (xs) => [mean(xs.slice(0, Math.floor(xs.length / 2))), mean(xs.slice(Math.ceil(xs.length / 2)))];
  const weakNoGross = Object.entries(a).filter(([id, v]) => v.operator === 'Ержан' && id !== 'gross100').map(([id]) => score[id]);
  assert.ok(Math.min(...of('Дамир')) > Math.max(...weakNoGross), 'strong above weak');
  const [upEarly, upLate] = half(of('Айгерим'));
  const [downEarly, downLate] = half(of('Мирас'));
  assert.ok(upLate > upEarly + 10, 'Айгерим improves');
  assert.ok(downEarly > downLate + 10, 'Мирас declines');
  assert.equal(a.call1.date, null);
  assert.ok(['Алина', 'Валерия'].includes(a.call1.operator));
  assert.equal(Object.keys(a).length, items.length, 'every scored conversation is assigned');
});

test('demo arrange endpoint: refuses with too few scores; reset works', async () => {
  const r = await post('/api/demo/arrange', {});
  assert.equal(r.status, 400);
  const d = await json('/api/demo/arrange', { method: 'DELETE' });
  assert.equal(d.status, 200);
  const st = (await json('/api/demo/arrangement')).body;
  assert.equal(typeof st.active, 'boolean'); // falls back to data/demo_operators.json when it exists
});

test('committed demo arrangement covers the DEV ids with valid names and dates', async () => {
  const f = JSON.parse(await fs.readFile(new URL('../data/demo_operators.json', import.meta.url), 'utf-8'));
  const { DEMO_OPERATOR_NAMES } = await import('../backend/data/source.js');
  const entries = Object.entries(f.assignments);
  assert.ok(entries.length >= 60);
  for (const [, a] of entries) {
    assert.ok(DEMO_OPERATOR_NAMES.includes(a.operator));
    assert.ok(a.date === null || /^2026-(09|10|11)-\d{2}$/.test(a.date));
  }
});
