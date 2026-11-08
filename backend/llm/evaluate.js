// Runs the AI evaluation for one conversation and turns it into an Evaluation (see contracts/README.md).
// Owner: P2.
//
// - One LLM call grades all criteria (cheap, consistent).
// - LLM_VOTES > 1 runs it N times in parallel and majority-votes each criterion;
//   the agreement share is stored as `confidence`.
// - LLM_MODE=ai_eval (default): the Python module in ai_eval/ runs two judges and an
//   adjudicator. LLM_MODE=ensemble keeps the JS A/B/arbiter path. LLM_MOCK=1 stays local.
// - The model never does arithmetic: scoring is done by shared/scoring.js.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config, ROOT } from '../config.js';
import { analyzeEmotion, readEmotion } from '../data/emotion.js';
import { buildMessages, responseSchema } from './prompt.js';
import { chatJson, costUsd } from './client.js';
import { normalizeAnswer, computeScore } from '../../shared/scoring.js';

const MAX_ATTEMPTS = 3;

/** Validate one model run; returns { byId } or throws. */
function parseRun(data, criteria, conv) {
  const maxIdx = conv.transcript.length - 1;
  const okIdx = (i) => Number.isInteger(i) && i >= 0 && i <= maxIdx;
  const byId = {};
  for (const item of data.criteria || []) {
    const c = criteria.find((x) => x.id === item.criterion_id);
    if (!c) continue;
    const indices = [...new Set((item.evidence_msg_indices || []).filter(okIdx))];
    const evidence = [];
    for (const e of item.evidence || []) {
      if (!e || !okIdx(e.msg_index) || evidence.some((x) => x.msg_index === e.msg_index)) continue;
      evidence.push({ msg_index: e.msg_index, quote: String(e.quote || '').slice(0, 300), proves: String(e.proves || '').slice(0, 200) });
    }
    for (const e of evidence) if (!indices.includes(e.msg_index)) indices.push(e.msg_index);
    byId[c.id] = {
      criterion_id: c.id,
      answer: normalizeAnswer(c, item.answer), // throws on invalid answers → retry
      reasoning: item.reasoning || '',
      explanation: item.explanation || '',
      evidence_msg_indices: indices.sort((a, b) => a - b),
      evidence: evidence.sort((a, b) => a.msg_index - b.msg_index),
      checked_range: Array.isArray(item.checked_range) && item.checked_range.length === 2 ? item.checked_range : null,
      na_reason: item.na_reason || null,
      gross_error_type: c.type === 'flag' ? item.gross_error_type || null : null,
    };
  }
  const missing = criteria.filter((c) => !byId[c.id]).map((c) => c.id);
  if (missing.length) throw new Error(`model skipped criteria: ${missing.join(', ')}`);
  return byId;
}

async function oneRun(checklist, conv, opts) {
  const { messages, criteria } = buildMessages(checklist, conv, { ...opts, explanationLanguage: config.llm.explanationLanguage });
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = config.llm.mock
        ? mockRun(criteria, conv, opts.role)
        : await chatJson({ messages, schema: responseSchema(criteria), model: opts.model });
      usage.input_tokens += r.usage.input_tokens;
      usage.output_tokens += r.usage.output_tokens;
      usage.calls++;
      return { byId: parseRun(r.data, criteria, conv), usage, prompt: messages };
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] ${conv.conversation_id}${opts.role ? ` (${opts.role})` : ''} attempt ${attempt} failed: ${e.message}`);
    }
  }
  throw lastErr;
}

function vote(runs, c) {
  const answers = runs.map((r) => r.byId[c.id].answer);
  const counts = new Map();
  for (const a of answers) counts.set(a, (counts.get(a) || 0) + 1);
  let best = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  let winner = best[0][0];
  if (best.length > 1 && best[0][1] === best[1][1] && c.type === 'scale') {
    const nums = answers.filter((a) => typeof a === 'number').sort((a, b) => a - b);
    if (nums.length) winner = nums[Math.floor((nums.length - 1) / 2)]; // tie on a scale → lower median
  }
  const chosen = runs.find((r) => r.byId[c.id].answer === winner).byId[c.id];
  return { ...chosen, confidence: Math.round(((counts.get(winner) || 0) / runs.length) * 100) / 100, votes: answers };
}

const sumUsage = (runs) => {
  const usage = runs.reduce(
    (u, r) => ({ input_tokens: u.input_tokens + r.usage.input_tokens, output_tokens: u.output_tokens + r.usage.output_tokens, calls: u.calls + r.usage.calls }),
    { input_tokens: 0, output_tokens: 0, calls: 0 },
  );
  usage.cost_usd = Math.round(costUsd(usage) * 1e6) / 1e6;
  return usage;
};

function mergeEvidence(x, y) {
  const evidence = [...x.evidence];
  for (const e of y.evidence) if (!evidence.some((z) => z.msg_index === e.msg_index)) evidence.push(e);
  const indices = [...new Set([...x.evidence_msg_indices, ...y.evidence_msg_indices])].sort((a, b) => a - b);
  return { evidence: evidence.sort((a, b) => a.msg_index - b.msg_index), evidence_msg_indices: indices };
}

/** Evaluators A and B in parallel, arbiter on disagreements. */
async function ensemble(checklist, conv, opts) {
  const [a, b] = await Promise.all([
    oneRun(checklist, conv, { ...opts, role: 'A' }),
    oneRun(checklist, conv, { ...opts, role: 'B', model: config.llm.modelB || undefined }),
  ]);
  const criteria = checklist.criteria;
  const disputed = criteria.filter((c) => a.byId[c.id].answer !== b.byId[c.id].answer);
  let arb = null;
  if (disputed.length) {
    const pos = (r) => `${JSON.stringify(r.answer)} — ${r.explanation} (реплики: ${r.evidence_msg_indices.map((i) => `#${i}`).join(', ') || 'нет'})`;
    const note = [
      'Оценщики A и B разошлись по этим критериям. Реши каждый из них сам.',
      ...disputed.map((c) => `- ${c.id}: оценщик A → ${pos(a.byId[c.id])}; оценщик B → ${pos(b.byId[c.id])}`),
    ].join('\n');
    try {
      arb = await oneRun(checklist, conv, { ...opts, role: 'ARBITER', model: config.llm.modelArbiter || undefined, criteriaIds: disputed.map((c) => c.id), extraNote: note });
    } catch (e) {
      console.warn(`[llm] ${conv.conversation_id} arbiter failed, keeping evaluator A on ${disputed.map((c) => c.id).join(', ')}: ${e.message}`);
    }
  }
  const results = criteria.map((c) => {
    const x = a.byId[c.id];
    const y = b.byId[c.id];
    if (x.answer === y.answer) return { ...x, ...mergeEvidence(x, y), confidence: 1, agreement: 'agreed', votes: [x.answer, y.answer] };
    if (arb) {
      const z = arb.byId[c.id];
      return { ...z, confidence: 0.5, agreement: 'arbitrated', votes: [x.answer, y.answer, z.answer] };
    }
    return { ...x, confidence: 0.5, agreement: 'arbiter_failed', votes: [x.answer, y.answer] };
  });
  return { results, usage: sumUsage([a, b, ...(arb ? [arb] : [])]), prompt: a.prompt };
}

/**
 * @param opts.criteriaIds / opts.extraNote  passed to the prompt builder (appeal second opinion)
 * @param opts.votes  override LLM_VOTES
 */
function pythonBin() {
  if (process.env.AI_EVAL_PYTHON) return process.env.AI_EVAL_PYTHON;
  const venv = `${ROOT}/ai_eval/.venv/bin/python`;
  return existsSync(venv) ? venv : 'python3';
}

/** Two judges plus an adjudicator, implemented in ai_eval/. Scoring stays in shared/scoring.js. */
async function toneLabels(conv) {
  if (conv.channel !== 'voice call') return [];
  let saved = await readEmotion(conv.conversation_id);
  if (!saved) {
    try {
      saved = await analyzeEmotion(conv);
    } catch (err) {
      console.warn(`[emotion] ${conv.conversation_id}: ${err.message}`);
      return [];
    }
  }
  return (saved?.lines || []).filter((line) => line.highlight);
}

function runAiEval(checklist, conv, opts = {}) {
  const payload = { checklist, conversation: conv, tone_labels: opts.toneLabels || [] };
  if (opts.criteriaIds) payload.criteria_ids = opts.criteriaIds;
  if (opts.extraNote) payload.extra_note = opts.extraNote;
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ['-m', 'ai_eval.team_node'], {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: `${ROOT}/ai_eval/src` },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((err || `ai_eval exited ${code}`).trim().slice(0, 500)));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('ai_eval returned non-JSON'));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function runCriteria(checklist, conv, opts = {}) {
  if (!config.llm.mock && config.llm.mode === 'ai_eval') {
    const bridge = await runAiEval(checklist, conv, opts);
    return { results: bridge.criteria, usage: bridge.usage, prompt: bridge.prompt, model: bridge.model };
  }
  if (config.llm.mode === 'ensemble' && !opts.criteriaIds) return ensemble(checklist, conv, opts);
  const n = opts.votes || config.llm.votes;
  const runs = await Promise.all(Array.from({ length: n }, () => oneRun(checklist, conv, opts)));
  const criteria = opts.criteriaIds ? checklist.criteria.filter((c) => opts.criteriaIds.includes(c.id)) : checklist.criteria;
  return { results: criteria.map((c) => vote(runs, c)), usage: sumUsage(runs), prompt: runs[0].prompt };
}

/** Full evaluation of a conversation with a checklist. */
export async function evaluateConversation(checklist, conv) {
  const toneLabelsForJudges = await toneLabels(conv);
  const { results, usage, prompt, model } = await runCriteria(checklist, conv, { toneLabels: toneLabelsForJudges });
  const answers = Object.fromEntries(results.map((r) => [r.criterion_id, r.answer]));
  const score = computeScore(checklist, answers);
  const now = new Date();
  return {
    id: `ev_${now.getTime()}_${conv.conversation_id}`,
    conversation_id: conv.conversation_id,
    group_id: conv.group_id || null,
    checklist_id: checklist.id,
    checklist_version: checklist.version,
    checklist_snapshot: checklist,
    model: model || (config.llm.mock ? 'mock' : config.llm.model),
    mode: config.llm.mode,
    votes: config.llm.votes,
    created_at: now.toISOString(),
    criteria: results.map((r) => ({
      ...r,
      points: score.criteria[r.criterion_id].points,
      effective_weight: score.criteria[r.criterion_id].effective_weight,
    })),
    score: { total: score.total, max: score.max, gross_error: score.gross_error, sections: score.sections },
    usage,
    prompt: prompt.map((m) => `### ${m.role}\n${m.content}`).join('\n\n'),
    final: null,
  };
}

// ---------- Mock LLM for UI work and tests (LLM_MOCK=1). Not a real evaluation. ----------
// Evaluator B disagrees on about a quarter of the criteria, so the arbiter path gets exercised.
const bucket = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 4;

function mockRun(criteria, conv, role) {
  const firstOp = conv.transcript.find((m) => m.speaker === 'operator');
  const idx = firstOp ? [firstOp.msg_index] : [];
  const top = (c) => (c.type === 'scale' ? String(Math.max(...c.scale.map((s) => s.value))) : c.type === 'flag' ? 'no' : 'yes');
  const other = (c) => (c.type === 'scale' ? String(Math.min(...c.scale.map((s) => s.value))) : c.type === 'flag' ? 'no' : 'no');
  return {
    usage: { input_tokens: 0, output_tokens: 0 },
    data: {
      criteria: criteria.map((c) => ({
        criterion_id: c.id,
        reasoning: 'mock',
        answer: role === 'B' && bucket(conv.conversation_id + c.id) === 0 ? other(c) : top(c),
        evidence_msg_indices: idx,
        evidence: firstOp ? [{ msg_index: firstOp.msg_index, quote: firstOp.text.slice(0, 60), proves: 'тестовая цитата' }] : [],
        checked_range: null,
        na_reason: null,
        gross_error_type: null,
        explanation: `[MOCK${role ? ` ${role}` : ''}] ${c.name}: тестовый ответ.`,
      })),
    },
  };
}
