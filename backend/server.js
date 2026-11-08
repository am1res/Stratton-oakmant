// HTTP API + static frontend. Owner: P1. Routes are documented in contracts/README.md.
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT } from './config.js';
import * as store from './storage.js';
import { loadConversations, normalizeRecord, getSignedAudioUrl, setDemoArrangement, arrangeScenarios, operatorAndDate } from './data/source.js';
import { getAudioFile } from './data/audio.js';
import { analyzeCall } from './data/voice.js';
import { analyzeEmotion, readEmotion } from './data/emotion.js';
import { evaluateConversation, runCriteria } from './llm/evaluate.js';
import { computeScore, validateChecklist, normalizeAnswer } from '../shared/scoring.js';
import { buildSubmission } from './export.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------------- conversations ----------------
let conversations = new Map();

async function reloadConversations(opts = {}) {
  await loadArrangement().catch(() => {}); // demo scenario arrangement, if one was saved
  const list = await loadConversations(opts);
  // extra sets (CQA_EXTRA_GROUPS) are always fetched from the API; if it fails, the cached copy is used
  for (const g of config.api.extraGroups.filter((g) => g !== (opts.groupId || config.api.groupId))) {
    try {
      const extra = await loadConversations({ groupId: g, refresh: true });
      list.push(...extra);
      console.log(`[data] + ${extra.length} conversations from group ${g}`);
    } catch (e) {
      console.error(`[data] could not load group ${g}: ${e.message}`);
    }
  }
  const uploads = await store.list('uploads');
  conversations = new Map([...list, ...uploads.map((u) => normalizeRecord(u))].map((c) => [c.conversation_id, c]));
  console.log(`[data] ${conversations.size} conversations loaded (group ${[opts.groupId || config.api.groupId, ...config.api.extraGroups].join(' + ')})`);
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

/** Per-criterion answers and points after appeals, for the score strip. */
function criteriaSummary(e) {
  const answers = Object.fromEntries(e.criteria.map((r) => [r.criterion_id, e.final?.overrides?.[r.criterion_id]?.answer ?? r.answer]));
  const s = computeScore(e.checklist_snapshot, answers);
  return e.checklist_snapshot.criteria.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    answer: answers[c.id],
    points: s.criteria[c.id].points,
    effective_weight: s.criteria[c.id].effective_weight,
    confidence: e.criteria.find((r) => r.criterion_id === c.id)?.confidence ?? 1,
  }));
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
        operator: c.operator,
        operator_source: c.operator_source,
        date: c.date,
        date_source: c.date_source,
        messages: c.transcript.length,
        latest_evaluation_id: e?.id || null,
        latest_score: s ? s.total : null,
        // compact per-criterion summary for the score strip in the list
        latest_criteria: e ? criteriaSummary(e) : null,
        gross_error: s ? s.gross_error : null,
        has_open_appeal: appeals.some((a) => a.conversation_id === c.conversation_id && a.status === 'open'),
        low_confidence: e ? e.criteria.some((r) => !e.final?.overrides?.[r.criterion_id] && r.confidence !== undefined && r.confidence < 1) : false,
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

// Audio: the signed link stays on the server. The organizers' link returns an HTML player page,
// not audio, so backend/data/audio.js follows it to the real mp3 and caches it in storage/audio/.
// sendFile handles Range requests, so seeking works.
app.get('/api/conversations/:id/audio', wrap(async (req, res) => {
  getConv(req.params.id);
  const found = await getAudioFile(req.params.id, getSignedAudioUrl(req.params.id)).catch((e) => {
    throw httpError(502, e.message);
  });
  if (!found) throw httpError(404, 'no audio for this conversation');
  res.sendFile(found.file, { headers: { 'Content-Type': found.mime, 'Cache-Control': 'no-store' } });
}));

// Voice analysis (tone of the operator) made by voice/to_gemini.py. A hint for the reviewer,
// never part of the score. The Python pipeline numbers lines from 1 ([n]); here we convert to
// msg_index (n - 1) and take the audio second from our own transcript, so seeks match the player.
app.post('/api/conversations/:id/voice', wrap(async (req, res) => {
  const conv = getConv(req.params.id);
  if (conv.channel !== 'voice call') throw httpError(400, 'Анализ голоса только для звонков.');
  const audioUrl = getSignedAudioUrl(req.params.id);
  if (!audioUrl) throw httpError(400, 'У этого звонка нет ссылки на запись.');
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    throw httpError(400, 'Нет ключа Gemini. Впишите GEMINI_API_KEY в файл .env в корне проекта и перезапустите сервер.');
  }
  await analyzeCall({
    conversation_id: conv.conversation_id,
    channel: conv.channel,
    language: conv.language,
    audio_url: audioUrl,
    transcript: conv.transcript.map((m) => ({ timestamp: m.timestamp, speaker: m.speaker, text: m.text })),
  }, { force: req.query.force === '1' });
  req.method = 'GET';
  return voiceReport(req, res);
}));

app.get('/api/conversations/:id/voice', wrap(voiceReport));

app.get('/api/conversations/:id/emotion', wrap(async (req, res) => {
  getConv(req.params.id);
  const saved = await readEmotion(req.params.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json(saved ? { available: true, ...saved } : { available: false, lines: [] });
}));

app.post('/api/conversations/:id/emotion', wrap(async (req, res) => {
  const conv = getConv(req.params.id);
  if (conv.channel !== 'voice call') throw httpError(400, 'Разметка тона только для звонков.');
  const saved = await analyzeEmotion(conv);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ available: true, ...(saved || { lines: [] }) });
}));

async function voiceReport(req, res) {
  const conv = getConv(req.params.id);
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(path.join(config.paths.voiceOut, 'voice', `${req.params.id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`), 'utf-8'));
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ available: false });
  }
  const renumber = (s) => String(s || '').replace(/\[(\d+)\](?:\s*[-–]\s*\[(\d+)\])?/g, (m, a, b) => (b ? `#${a - 1}–#${b - 1}` : `#${a - 1}`));
  const point = (x) => {
    const idx = Number.isInteger(x.message) && x.message > 0 ? x.message - 1 : null;
    const msg = idx !== null ? conv.transcript[idx] : null;
    return { ...x, msg_index: msg ? idx : null, offset_sec: msg?.offset_sec ?? null, reason: renumber(x.reason) };
  };
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    available: true,
    overall: raw.overall,
    summary: renumber(raw.summary),
    flags: (raw.flags || []).map(point),
    notes: (raw.notes || []).map(point),
    model: raw.model,
    audio_only: !!raw.audio_only,
    cost_usd: raw.cost_usd,
    created_at: raw.created_at,
  });
}

// ---------------- checklists ----------------
// Several checklists can exist (e.g. the default one from the PDF and a new set of criteria for
// another team). Each has its own id and versions; storage/checklists/<id>_v<version>.json.
// ONE of them is active (storage/settings/active_checklist.json): new evaluations use its latest version.
let seeding = null; // the default checklist is written once, even if 4 batch workers ask at the same time
const readDefault = async () => JSON.parse(await fs.readFile(config.paths.defaultChecklist, 'utf-8'));
async function activeChecklistId() {
  const saved = await store.get('settings', 'active_checklist');
  if (saved?.id) return saved.id;
  return (await readDefault()).id;
}
async function versionsOf(id) {
  return (await store.list('checklists')).filter((c) => c.id === id).sort((a, b) => b.version - a.version);
}
async function currentChecklist() {
  const id = await activeChecklistId();
  const versions = await versionsOf(id);
  if (versions.length) return versions[0];
  seeding ??= (async () => {
    const def = await readDefault();
    if (def.id !== id) {
      // the active id points to a checklist that is gone: fall back to the default one
      await store.put('settings', 'active_checklist', { id: def.id });
      const v = await versionsOf(def.id);
      if (v.length) return v[0];
    }
    return store.put('checklists', `${def.id}_v${def.version}`, { ...def, saved_at: new Date().toISOString() });
  })().finally(() => (seeding = null));
  return seeding;
}

app.get('/api/checklists/current', wrap(async (req, res) => res.json(await currentChecklist())));
// versions of the ACTIVE checklist (the editor's history)
app.get('/api/checklists', wrap(async (req, res) => res.json(await versionsOf((await currentChecklist()).id))));

// every checklist (latest version of each) for the selector
app.get('/api/checklists/all', wrap(async (req, res) => {
  const active = (await currentChecklist()).id;
  const latest = new Map();
  for (const c of await store.list('checklists')) if (!latest.has(c.id) || c.version > latest.get(c.id).version) latest.set(c.id, c);
  res.json(
    [...latest.values()]
      .map((c) => ({ id: c.id, name: c.name, version: c.version, criteria: c.criteria.length, saved_at: c.saved_at, active: c.id === active }))
      .sort((a, b) => (a.saved_at || '').localeCompare(b.saved_at || '')),
  );
}));

// new checklist: a copy of the active one, or a blank one with a single starter criterion. It becomes active.
app.post('/api/checklists/new', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw httpError(400, 'name is required');
  const cur = await currentChecklist();
  const id = `cl-${Date.now().toString(36)}`;
  const base =
    req.body?.base === 'empty'
      ? {
          rounding: cur.rounding ?? 2,
          first_response_threshold_sec: cur.first_response_threshold_sec ?? 180,
          general_rules: cur.general_rules || [],
          sections: [{ id: 's1', name: 'Основной раздел' }],
          criteria: [{ id: 'c01', section: 's1', name: 'Новый критерий', type: 'binary', weight: 100, na_allowed: false, yes_rule: 'Опишите, в каких случаях ставится «Да», а в каких — «Нет».', na_rule: '', decision_steps: [], examples: [] }],
        }
      : structuredClone({ rounding: cur.rounding, first_response_threshold_sec: cur.first_response_threshold_sec, general_rules: cur.general_rules, sections: cur.sections, criteria: cur.criteria });
  const next = { ...base, id, name, version: 1, created_from: req.body?.base === 'empty' ? null : { id: cur.id, version: cur.version }, saved_at: new Date().toISOString() };
  const errors = validateChecklist(next);
  if (errors.length) return res.status(400).json({ error: 'invalid checklist', details: errors });
  await store.put('checklists', `${id}_v1`, next);
  await store.put('settings', 'active_checklist', { id });
  res.json(next);
}));

// choose which checklist new evaluations use
app.post('/api/checklists/activate', wrap(async (req, res) => {
  const id = String(req.body?.id || '');
  if (!(await versionsOf(id)).length) throw httpError(404, `checklist ${id} not found`);
  await store.put('settings', 'active_checklist', { id });
  res.json(await currentChecklist());
}));

app.put('/api/checklists/current', wrap(async (req, res) => {
  const cur = await currentChecklist();
  const next = { ...req.body, id: cur.id, version: cur.version + 1, saved_at: new Date().toISOString() };
  const errors = validateChecklist(next);
  if (errors.length) return res.status(400).json({ error: 'invalid checklist', details: errors });
  res.json(await store.put('checklists', `${next.id}_v${next.version}`, next));
}));

// Roll back to any saved version. History stays immutable: the chosen version is copied as a
// NEW version (cur + 1), so evaluations made under every version keep pointing to their snapshot.
app.post('/api/checklists/restore', wrap(async (req, res) => {
  const wanted = Number(req.body?.version);
  const all = await versionsOf((await currentChecklist()).id);
  const old = all.find((c) => c.version === wanted);
  if (!old) throw httpError(404, `checklist version ${req.body?.version} not found`);
  const cur = await currentChecklist();
  if (old.version === cur.version) throw httpError(400, `version ${wanted} is already the current one`);
  const next = { ...old, version: cur.version + 1, restored_from: old.version, saved_at: new Date().toISOString() };
  const errors = validateChecklist(next);
  if (errors.length) return res.status(400).json({ error: 'invalid checklist', details: errors });
  res.json(await store.put('checklists', `${next.id}_v${next.version}`, next));
}));

app.post('/api/checklists/reset', wrap(async (req, res) => {
  const cur = await currentChecklist();
  const def = JSON.parse(await fs.readFile(config.paths.defaultChecklist, 'utf-8'));
  // the PDF criteria go into the ACTIVE checklist as its next version (its id and name stay)
  const next = { ...def, id: cur.id, name: cur.name, version: cur.version + 1, saved_at: new Date().toISOString() };
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
  let ids = req.body?.conversation_ids?.length ? req.body.conversation_ids : [...conversations.keys()];
  // skip_done (ported from the Django branch): don't pay again for conversations that already have
  // an evaluation under the CURRENT checklist version. After a criterion change the version goes up,
  // so everything is evaluated again.
  let skipped = 0;
  if (req.body?.skip_done) {
    const cur = await currentChecklist();
    const done = new Set((await store.list('evaluations')).filter((e) => e.checklist_id === cur.id && e.checklist_version === cur.version).map((e) => e.conversation_id));
    const before = ids.length;
    ids = ids.filter((id) => !done.has(id));
    skipped = before - ids.length;
  }
  const job = { id: `job_${Date.now()}`, total: ids.length, done: 0, skipped, errors: [], status: ids.length ? 'running' : 'done', evaluation_ids: [] };
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
  if (req.query.lite) list = list.map(({ prompt, ...rest }) => rest); // analytics doesn't need the prompt text
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
    original: {
      answer: crit.answer,
      explanation: crit.explanation,
      evidence_msg_indices: crit.evidence_msg_indices,
      evidence: crit.evidence || [],
      checked_range: crit.checked_range || null,
    },
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

// ---------------- demo operators: scenario arrangement ----------------
// The data has no operators or chat dates. data/demo_operators.json (committed) arranges the demo
// names/dates for the DEV set into readable scenarios (strong, weak, improving, declining), built
// from the draft reference grades. POST /api/demo/arrange can rebuild it from the latest AI scores
// into storage/demo/operators.json, which then takes priority. Conversations in neither file (e.g.
// the control set) keep random demo values. The page banner says it is an arrangement for the demo.
const DEMO_FILE = path.join(ROOT, 'data', 'demo_operators.json');

function reapplyDemo() {
  for (const c of conversations.values()) {
    if (c.operator_source !== 'demo' && c.date_source !== 'demo') continue;
    Object.assign(c, operatorAndDate({ conversation_id: c.conversation_id, transcript: c.transcript }));
  }
}

async function readArrangement() {
  const fromStorage = await store.get('demo', 'operators');
  if (fromStorage) return { ...fromStorage, source: fromStorage.source || 'scores' };
  try {
    return JSON.parse(await fs.readFile(DEMO_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

async function loadArrangement() {
  const saved = await readArrangement();
  setDemoArrangement(saved?.assignments || {});
  return saved;
}

app.get('/api/demo/arrangement', wrap(async (req, res) => {
  const saved = await readArrangement();
  res.json(saved ? { active: true, source: saved.source, created_at: saved.created_at, count: Object.keys(saved.assignments).length } : { active: false });
}));

app.post('/api/demo/arrange', wrap(async (req, res) => {
  const evals = await store.list('evaluations');
  const latest = {};
  for (const e of evals) if (!latest[e.conversation_id] || e.created_at > latest[e.conversation_id].created_at) latest[e.conversation_id] = e;
  const items = [...conversations.values()]
    .filter((c) => latest[c.conversation_id] && c.operator_source === 'demo')
    .map((c) => {
      const e = latest[c.conversation_id];
      const sc = e.final || e.score;
      return { id: c.conversation_id, score: sc.total ?? 0, isCall: c.channel === 'voice call', gross: !!sc.gross_error };
    });
  if (items.length < 12) throw httpError(400, `нужно хотя бы 12 оценённых диалогов, сейчас ${items.length}`);
  const saved = await store.put('demo', 'operators', { created_at: new Date().toISOString(), source: 'scores', assignments: arrangeScenarios(items) });
  setDemoArrangement(saved.assignments);
  reapplyDemo();
  res.json({ active: true, created_at: saved.created_at, count: Object.keys(saved.assignments).length });
}));

app.delete('/api/demo/arrange', wrap(async (req, res) => {
  await fs.rm(path.join(config.paths.storage, 'demo', 'operators.json'), { force: true });
  const saved = await loadArrangement(); // back to data/demo_operators.json, if present
  reapplyDemo();
  res.json(saved ? { active: true, source: saved.source } : { active: false });
}));

// Reference labels (our own ground truth) for the "AI accuracy" panel. Not used for grading.
app.get('/api/reference', wrap(async (req, res) => {
  try {
    const gt = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'ground_truth.dev.json'), 'utf-8'));
    res.json({ status: gt._status || 'draft', labels: gt.labels || {} });
  } catch {
    res.json({ status: 'none', labels: {} });
  }
}));

// ---------------- meta + static ----------------
function modelLabel() {
  if (config.llm.mock) return 'mock';
  if (config.llm.mode === 'ai_eval') {
    const { a, b, adjudicator } = config.llm.judges;
    return [a && `A ${a}`, b && `B ${b}`, adjudicator && `arbiter ${adjudicator}`].filter(Boolean).join(' · ') || 'ai_eval';
  }
  return config.llm.model;
}

// ---------------- results for the organizers (backend/export.js) ----------------
// Format from the organizers' guide: schema_version 1.0, team_name, model, results[].
// The file goes to results/dev/results.json (DEV set) or results/prod/results.json (control set),
// then it has to be committed and pushed.
// DEV set → results/dev, every other set (the control set) → results/prod
const targetOf = (c) => (String(c.group_id || config.api.groupId).toUpperCase() === 'DEV' ? 'dev' : 'prod');
async function submission(target) {
  const ids = [...conversations.values()].filter((c) => !target || targetOf(c) === target).map((c) => c.conversation_id);
  const evaluations = (await store.list('evaluations')).filter((e) => ids.includes(e.conversation_id));
  const local = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(config.llm.baseUrl);
  return buildSubmission({
    conversationIds: ids,
    evaluations,
    teamName: config.teamName,
    model: { mode: config.llm.mock ? 'mock' : local ? 'local' : 'api', name: modelLabel() },
  });
}
app.get('/api/export', wrap(async (req, res) => {
  const target = req.query.target === 'dev' || req.query.target === 'prod' ? req.query.target : null;
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="results_${target || 'all'}.json"`);
  res.json(await submission(target));
}));

// writes results/dev/results.json and/or results/prod/results.json — one file per set that is loaded
app.post('/api/export/save', wrap(async (req, res) => {
  const wanted = req.body?.target === 'dev' || req.body?.target === 'prod' ? [req.body.target] : ['dev', 'prod'];
  const present = new Set([...conversations.values()].map(targetOf));
  const files = [];
  for (const target of wanted.filter((t) => present.has(t))) {
    const out = await submission(target);
    const file = path.join(ROOT, 'results', target, 'results.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    const ok = out.results.filter((r) => r.status === 'ok').length;
    files.push({ path: `results/${target}/results.json`, target, total: out.results.length, ok, missing: out.results.length - ok });
  }
  res.json({ files });
}));

app.get('/api/meta', (req, res) =>
  res.json({ model: modelLabel(), mode: config.llm.mode, votes: config.llm.votes, group_id: config.api.groupId, price_in: config.llm.priceIn, price_out: config.llm.priceOut }),
);
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use(express.static(path.join(ROOT, 'frontend'), {
  maxAge: 0,
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
}));

export { app, reloadConversations };

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'backend', 'server.js')) {
  await reloadConversations().catch((e) => console.error(`[data] could not load conversations: ${e.message}`));
  app.listen(config.port, () => console.log(`CQA running on http://localhost:${config.port}  (mode: ${config.llm.mode}, model: ${modelLabel()})`));
}
