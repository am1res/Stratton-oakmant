// HTTP API + static frontend. Owner: P1. Routes are documented in contracts/README.md.
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config, ROOT } from './config.js';
import * as store from './storage.js';
import { loadConversations, normalizeRecord, getSignedAudioUrl } from './data/source.js';
import { evaluateConversation, runCriteria } from './llm/evaluate.js';
import { computeScore, validateChecklist, normalizeAnswer } from '../shared/scoring.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------------- conversations ----------------
let conversations = new Map();

async function reloadConversations(opts = {}) {
  const list = await loadConversations(opts);
  const uploads = await store.list('uploads');
  conversations = new Map([...list, ...uploads.map((u) => normalizeRecord(u))].map((c) => [c.conversation_id, c]));
  console.log(`[data] ${conversations.size} conversations loaded (group ${opts.groupId || config.api.groupId})`);
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  });

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function getConv(id) {
  const c = conversations.get(id);
  if (!c) throw httpError(404, `conversation ${id} not found`);
  return c;
}

app.get('/api/conversations', wrap(async (req, res) => {
  const evals = await store.list('evaluations');
  const appeals = await store.list('appeals');
  const latest = {};
  for (const e of evals) if (!latest[e.conversation_id] || e.created_at > latest[e.conversation_id].created_at) latest[e.conversation_id] = e;
  res.json(
    [...conversations.values()].map((c) => {
      const e = latest[c.conversation_id];
      const s = e ? e.final || e.score : null;
      return {
        conversation_id: c.conversation_id,
        channel: c.channel,
        language: c.language,
        group_id: c.group_id,
        messages: c.transcript.length,
        latest_evaluation_id: e?.id || null,
        latest_score: s ? s.total : null,
        gross_error: s ? s.gross_error : null,
        has_open_appeal: appeals.some((a) => a.conversation_id === c.conversation_id && a.status === 'open'),
      };
    }),
  );
}));

app.get('/api/conversations/:id', wrap(async (req, res) => res.json(getConv(req.params.id))));

app.post('/api/conversations/upload', wrap(async (req, res) => {
  const body = req.body;
  const records = Array.isArray(body) ? body : body.data?.records || body.records || [body];
  const added = [];
  for (const r of records) {
    if (!r.conversation_id || !Array.isArray(r.transcript)) throw httpError(400, 'each record needs conversation_id and transcript[]');
    const rec = { channel: 'agent chat', language: 'RU', audio_url: null, ...r, source: 'upload' };
    await store.put('uploads', rec.conversation_id, rec);
    conversations.set(rec.conversation_id, normalizeRecord(rec));
    added.push(rec.conversation_id);
  }
  res.json({ added });
}));

app.post('/api/data/reload', wrap(async (req, res) => {
  await reloadConversations({ groupId: req.body?.group_id || config.api.groupId, refresh: true });
  res.json({ count: conversations.size });
}));

// Audio proxy: keeps the signed link on the server, forwards Range for seeking.
app.get('/api/conversations/:id/audio', wrap(async (req, res) => {
  const url = getSignedAudioUrl(req.params.id);
  if (!url) throw httpError(404, 'no audio for this conversation');
  const headers = req.headers.range ? { Range: req.headers.range } : {};
  const upstream = await fetch(url, { headers });
  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}));

// ---------------- checklists ----------------
async function currentChecklist() {
  const all = await store.list('checklists');
  if (all.length) return all.sort((a, b) => b.version - a.version)[0];
  const def = JSON.parse(await fs.readFile(config.paths.defaultChecklist, 'utf-8'));
  return store.put('checklists', `${def.id}_v${def.version}`, { ...def, saved_at: new Date().toISOString() });
}

app.get('/api/checklists/current', wrap(async (req, res) => res.json(await currentChecklist())));
app.get('/api/checklists', wrap(async (req, res) => res.json((await store.list('checklists')).sort((a, b) => b.version - a.version))));

app.put('/api/checklists/current', wrap(async (req, res) => {
  const cur = await currentChecklist();
  const next = { ...req.body, id: cur.id, version: cur.version + 1, saved_at: new Date().toISOString() };
  const errors = validateChecklist(next);
  if (errors.length) return res.status(400).json({ error: 'invalid checklist', details: errors });
  res.json(await store.put('checklists', `${next.id}_v${next.version}`, next));
}));

app.post('/api/checklists/reset', wrap(async (req, res) => {
  const cur = await currentChecklist();
  const def = JSON.parse(await fs.readFile(config.paths.defaultChecklist, 'utf-8'));
  const next = { ...def, version: cur.version + 1, saved_at: new Date().toISOString() };
  res.json(await store.put('checklists', `${next.id}_v${next.version}`, next));
}));

// ---------------- evaluations ----------------
async function evaluateOne(id) {
  const ev = await evaluateConversation(await currentChecklist(), getConv(id));
  return store.put('evaluations', ev.id, ev);
}

app.post('/api/evaluate', wrap(async (req, res) => res.json(await evaluateOne(req.body.conversation_id))));

const jobs = new Map();
app.post('/api/evaluate/batch', wrap(async (req, res) => {
  const ids = req.body?.conversation_ids?.length ? req.body.conversation_ids : [...conversations.keys()];
  const job = { id: `job_${Date.now()}`, total: ids.length, done: 0, errors: [], status: 'running', evaluation_ids: [] };
  jobs.set(job.id, job);
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        job.evaluation_ids.push((await evaluateOne(id)).id);
      } catch (e) {
        job.errors.push({ conversation_id: id, error: e.message });
      }
      job.done++;
    }
  };
  Promise.all(Array.from({ length: config.llm.concurrency }, worker)).then(() => (job.status = 'done'));
  res.json(job);
}));

app.get('/api/jobs/:id', wrap(async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) throw httpError(404, 'job not found');
  res.json(job);
}));

app.get('/api/evaluations', wrap(async (req, res) => {
  let list = await store.list('evaluations');
  if (req.query.conversation_id) list = list.filter((e) => e.conversation_id === req.query.conversation_id);
  res.json(list.sort((a, b) => b.created_at.localeCompare(a.created_at)));
}));

app.get('/api/evaluations/:id', wrap(async (req, res) => {
  const ev = await store.get('evaluations', req.params.id);
  if (!ev) throw httpError(404, 'evaluation not found');
  res.json(ev);
}));

// ---------------- appeals ----------------
app.post('/api/appeals', wrap(async (req, res) => {
  const { evaluation_id, criterion_id, comment } = req.body;
  const ev = await store.get('evaluations', evaluation_id);
  if (!ev) throw httpError(404, 'evaluation not found');
  const crit = ev.criteria.find((c) => c.criterion_id === criterion_id);
  if (!crit) throw httpError(400, 'criterion not in this evaluation');
  if (!comment?.trim()) throw httpError(400, 'comment is required');
  const now = new Date();
  const appeal = {
    id: `ap_${now.getTime()}`,
    evaluation_id,
    conversation_id: ev.conversation_id,
    criterion_id,
    comment: comment.trim(),
    status: 'open',
    original: { answer: crit.answer, explanation: crit.explanation, evidence_msg_indices: crit.evidence_msg_indices },
    ai_suggestion: null,
    reviewer_decision: null,
    created_at: now.toISOString(),
  };
  res.json(await store.put('appeals', appeal.id, appeal));
}));

app.get('/api/appeals', wrap(async (req, res) => {
  let list = await store.list('appeals');
  if (req.query.status) list = list.filter((a) => a.status === req.query.status);
  if (req.query.conversation_id) list = list.filter((a) => a.conversation_id === req.query.conversation_id);
  res.json(list.sort((a, b) => b.created_at.localeCompare(a.created_at)));
}));

app.post('/api/appeals/:id/suggest', wrap(async (req, res) => {
  const appeal = await store.get('appeals', req.params.id);
  if (!appeal) throw httpError(404, 'appeal not found');
  const ev = await store.get('evaluations', appeal.evaluation_id);
  const note = `Оценка критерия ${appeal.criterion_id} оспорена. Исходный ответ: ${JSON.stringify(appeal.original.answer)} (${appeal.original.explanation}). Комментарий апелляции: «${appeal.comment}». Переоцени этот критерий независимо и строго по правилам; комментарий может быть как верным, так и неверным.`;
  const { results, usage } = await runCriteria(ev.checklist_snapshot, getConv(appeal.conversation_id), { criteriaIds: [appeal.criterion_id], extraNote: note });
  appeal.ai_suggestion = { answer: results[0].answer, explanation: results[0].explanation, evidence_msg_indices: results[0].evidence_msg_indices, usage };
  res.json(await store.put('appeals', appeal.id, appeal));
}));

app.post('/api/appeals/:id/decide', wrap(async (req, res) => {
  const appeal = await store.get('appeals', req.params.id);
  if (!appeal) throw httpError(404, 'appeal not found');
  if (!req.body.reason?.trim()) throw httpError(400, 'reason is required');
  const ev = await store.get('evaluations', appeal.evaluation_id);
  const crit = ev.checklist_snapshot.criteria.find((c) => c.id === appeal.criterion_id);
  const answer = normalizeAnswer(crit, req.body.answer);
  const changed = answer !== appeal.original.answer;
  appeal.status = changed ? 'changed' : 'confirmed';
  appeal.reviewer_decision = { answer, reason: req.body.reason.trim(), decided_at: new Date().toISOString() };
  await store.put('appeals', appeal.id, appeal);

  // Recalculate the final result from the original answers plus every decided appeal on this evaluation.
  const decided = (await store.list('appeals')).filter((a) => a.evaluation_id === ev.id && a.reviewer_decision);
  const answers = Object.fromEntries(ev.criteria.map((c) => [c.criterion_id, c.answer]));
  const overrides = {};
  for (const a of decided.sort((x, y) => x.reviewer_decision.decided_at.localeCompare(y.reviewer_decision.decided_at))) {
    answers[a.criterion_id] = a.reviewer_decision.answer;
    overrides[a.criterion_id] = { answer: a.reviewer_decision.answer, appeal_id: a.id, reason: a.reviewer_decision.reason };
  }
  const s = computeScore(ev.checklist_snapshot, answers);
  ev.final = { total: s.total, max: s.max, gross_error: s.gross_error, sections: s.sections, overrides, updated_at: new Date().toISOString() };
  await store.put('evaluations', ev.id, ev);
  res.json({ appeal, evaluation: ev });
}));

// ---------------- meta + static ----------------
app.get('/api/meta', (req, res) =>
  res.json({ model: config.llm.mock ? 'mock' : config.llm.model, votes: config.llm.votes, group_id: config.api.groupId, price_in: config.llm.priceIn, price_out: config.llm.priceOut }),
);
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use(express.static(path.join(ROOT, 'frontend')));

export { app, reloadConversations };

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'backend', 'server.js')) {
  await reloadConversations().catch((e) => console.error(`[data] could not load conversations: ${e.message}`));
  app.listen(config.port, () => console.log(`CQA running on http://localhost:${config.port}  (model: ${config.llm.mock ? 'mock' : config.llm.model})`));
}
