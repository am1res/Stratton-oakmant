// Tests for the trust features: run record, reuse of unchanged answers after a checklist edit,
// saved/resumable batch jobs, reviewer conflict checks, blind labels as reference. Synthetic data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cqa-trust-'));
const chat = (id, text) => ({
  conversation_id: id,
  channel: 'agent chat',
  language: 'RU',
  audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Где посмотреть тариф?' },
    { timestamp: '00:30', speaker: 'system', text: 'Эскалация на оператора.' },
    { timestamp: '01:00', speaker: 'operator', text },
  ],
});
await fs.writeFile(
  path.join(tmp, 'dev.json'),
  JSON.stringify({ isSuccess: true, data: { records: [chat('a-1', 'Здравствуйте, я Алина.'), chat('a-2', 'Привет'), chat('a-3', 'Добрый день')] } }),
);
Object.assign(process.env, { LLM_MOCK: '1', LLM_MODE: 'single', CQA_DATA_FILE: path.join(tmp, 'dev.json'), STORAGE_DIR: path.join(tmp, 'storage') });
const { app, reloadConversations, markInterruptedJobs } = await import('../backend/server.js');
const store = await import('../backend/storage.js');

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
  await fs.rm(tmp, { recursive: true, force: true });
});

const json = async (p, opts) => {
  const r = await fetch(url + p, opts);
  return { status: r.status, body: await r.json() };
};
const send = (method, p, body) => json(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const post = (p, body) => send('POST', p, body);
const waitJob = async (id) => {
  for (let i = 0; i < 100; i++) {
    const { body } = await json(`/api/jobs/${id}`);
    if (body.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('job did not finish');
};

test('every evaluation carries a run record', async () => {
  const { body: ev } = await post('/api/evaluate', { conversation_id: 'a-1' });
  const p = ev.provenance;
  assert.match(p.transcript_hash, /^[0-9a-f]{16}$/);
  assert.match(p.checklist_hash, /^[0-9a-f]{16}$/);
  assert.equal(Object.keys(p.criteria_hashes).length, ev.checklist_snapshot.criteria.length);
  assert.equal(p.mock, true);
  assert.deepEqual(p.reused_criteria, []);
  assert.equal(p.fresh_criteria.length, ev.criteria.length);
  assert.ok(p.app_version);
});

test('evaluating again with the same checklist always asks the model again', async () => {
  const { body: ev } = await post('/api/evaluate', { conversation_id: 'a-1' });
  assert.deepEqual(ev.provenance.reused_criteria, []);
});

test('weight-only checklist edit: all answers reused, no model call, total recalculated', async () => {
  const { body: before } = await json('/api/evaluations?conversation_id=a-1');
  const { body: cl } = await json('/api/checklists/current');
  const edited = structuredClone(cl);
  edited.criteria.find((c) => c.id === 'c01').weight = 20; // weight only
  edited.criteria.find((c) => c.id === 'c01').section = edited.criteria.find((c) => c.id === 'c07').section; // section only
  const { status } = await send('PUT', '/api/checklists/current', edited);
  assert.equal(status, 200);
  const { body: ev } = await post('/api/evaluate', { conversation_id: 'a-1' });
  assert.equal(ev.provenance.fresh_criteria.length, 0, 'no criterion needed the model');
  assert.equal(ev.provenance.reused_criteria.length, ev.criteria.length);
  assert.equal(ev.usage.calls, 0);
  for (const c of ev.criteria) assert.equal(c.reused_from.evaluation_id, before[0].id);
  assert.equal(ev.checklist_version, cl.version + 1);
});

test('changing one criterion definition re-asks only that criterion', async () => {
  const { body: cl } = await json('/api/checklists/current');
  const edited = structuredClone(cl);
  edited.criteria.find((c) => c.id === 'c05').yes_rule = 'Новая формулировка эмпатии.';
  await send('PUT', '/api/checklists/current', edited);
  const { body: ev } = await post('/api/evaluate', { conversation_id: 'a-1' });
  assert.deepEqual(ev.provenance.fresh_criteria, ['c05']);
  assert.ok(!ev.criteria.find((c) => c.criterion_id === 'c05').reused_from);
  assert.ok(ev.criteria.find((c) => c.criterion_id === 'c01').reused_from);
});

test('fresh=true ignores earlier answers', async () => {
  const { body: cl } = await json('/api/checklists/current');
  await send('PUT', '/api/checklists/current', cl); // new version, same content
  const { body: ev } = await post('/api/evaluate', { conversation_id: 'a-1', fresh: true });
  assert.deepEqual(ev.provenance.reused_criteria, []);
});

test('batch jobs are saved, interrupted ones are marked and can be resumed without redoing work', async () => {
  const { body: job } = await post('/api/evaluate/batch', { conversation_ids: ['a-1', 'a-2', 'a-3'] });
  const done = await waitJob(job.id);
  assert.equal(done.status, 'done');
  const saved = await store.get('jobs', job.id);
  assert.equal(saved.completed.length, 3);

  // simulate a crash: a job left "running" on disk with one conversation done
  await store.put('jobs', 'job_crash', {
    id: 'job_crash', ids: ['a-1', 'a-2', 'a-3'], total: 3, done: 1, skipped: 0, completed: ['a-1'], errors: [],
    evaluation_ids: ['x'], status: 'running', fresh: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  await markInterruptedJobs();
  const { body: list } = await json('/api/jobs?status=interrupted');
  assert.ok(list.some((j) => j.id === 'job_crash'));
  const before = (await json('/api/evaluations?conversation_id=a-1')).body.length;
  const { status } = await post('/api/jobs/job_crash/resume', {});
  assert.equal(status, 200);
  const resumed = await waitJob('job_crash');
  assert.equal(resumed.status, 'done');
  assert.equal(resumed.completed.length, 3);
  assert.equal((await json('/api/evaluations?conversation_id=a-1')).body.length, before, 'a-1 was not evaluated again');
  assert.equal((await post('/api/jobs/job_crash/resume', {})).status, 409);
});

test('appeals: no duplicate open appeal, second reviewer cannot overwrite a decision', async () => {
  const { body: list } = await json('/api/evaluations?conversation_id=a-2');
  const ev = list[0];
  const { body: ap } = await post('/api/appeals', { evaluation_id: ev.id, criterion_id: 'c01', comment: 'Не согласен' });
  assert.equal((await post('/api/appeals', { evaluation_id: ev.id, criterion_id: 'c01', comment: 'Ещё раз' })).status, 409);
  const first = await post(`/api/appeals/${ap.id}/decide`, { answer: 'no', reason: 'Нет имени' });
  assert.equal(first.status, 200);
  const second = await post(`/api/appeals/${ap.id}/decide`, { answer: 'yes', reason: 'Другое мнение' });
  assert.equal(second.status, 409);
  const { body: after } = await json(`/api/evaluations/${ev.id}`);
  assert.equal(after.final.overrides.c01.answer, 'no', 'first decision kept');
});

test('blind labels: reviewers see only their own; agreement becomes reference, disagreement is disputed', async () => {
  const { body: cl } = await json('/api/checklists/current');
  const answers = (over = {}) => Object.fromEntries(cl.criteria.map((c) => [c.id, over[c.id] ?? (c.type === 'scale' ? Math.max(...c.scale.map((s) => s.value)) : c.type === 'flag' ? 'no' : 'yes')]));
  assert.equal((await send('PUT', '/api/labels/a-3', { reviewer: '', answers: answers() })).status, 400);
  assert.equal((await send('PUT', '/api/labels/a-3', { reviewer: 'Аня', answers: answers() })).status, 200);
  assert.equal((await send('PUT', '/api/labels/a-3', { reviewer: 'Борис', answers: answers({ c01: 'no' }) })).status, 200);
  const { body: mine } = await json('/api/labels?reviewer=' + encodeURIComponent('Аня'));
  assert.equal(mine.mine.length, 1);
  assert.equal(mine.mine[0].reviewer, 'Аня');
  assert.equal(mine.counts['Борис'], 1);
  const { body: ref } = await json('/api/reference');
  assert.equal(ref.status, 'human');
  assert.ok(!('c01' in ref.labels['a-3'].answers), 'disputed cell left out');
  assert.equal(ref.labels['a-3'].answers.c02, 'yes');
  assert.ok(ref.disputed.some((d) => d.conversation_id === 'a-3' && d.criterion_id === 'c01'));
});
