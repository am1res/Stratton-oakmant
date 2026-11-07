// Runs the AI evaluation for one conversation and turns it into an Evaluation (see contracts/README.md).
// Owner: P2.
//
// - One LLM call grades all criteria (cheap, consistent).
// - LLM_VOTES > 1 runs it N times in parallel and majority-votes each criterion;
//   the agreement share is stored as `confidence`.
// - The model never does arithmetic: scoring is done by shared/scoring.js.
import { config } from '../config.js';
import { buildMessages, responseSchema } from './prompt.js';
import { chatJson, costUsd } from './client.js';
import { normalizeAnswer, computeScore } from '../../shared/scoring.js';

const MAX_ATTEMPTS = 3;

/** Validate one model run; returns { byId } or throws. */
function parseRun(data, criteria, conv) {
  const maxIdx = conv.transcript.length - 1;
  const byId = {};
  for (const item of data.criteria || []) {
    const c = criteria.find((x) => x.id === item.criterion_id);
    if (!c) continue;
    byId[c.id] = {
      criterion_id: c.id,
      answer: normalizeAnswer(c, item.answer), // throws on invalid answers → retry
      reasoning: item.reasoning || '',
      explanation: item.explanation || '',
      evidence_msg_indices: (item.evidence_msg_indices || []).filter((i) => Number.isInteger(i) && i >= 0 && i <= maxIdx),
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
      const r = config.llm.mock ? mockRun(criteria, conv) : await chatJson({ messages, schema: responseSchema(criteria) });
      usage.input_tokens += r.usage.input_tokens;
      usage.output_tokens += r.usage.output_tokens;
      usage.calls++;
      return { byId: parseRun(r.data, criteria, conv), usage, prompt: messages };
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] ${conv.conversation_id} attempt ${attempt} failed: ${e.message}`);
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

/**
 * @param opts.criteriaIds / opts.extraNote  passed to the prompt builder (appeal second opinion)
 * @param opts.votes  override LLM_VOTES
 */
export async function runCriteria(checklist, conv, opts = {}) {
  const n = opts.votes || config.llm.votes;
  const runs = await Promise.all(Array.from({ length: n }, () => oneRun(checklist, conv, opts)));
  const criteria = opts.criteriaIds ? checklist.criteria.filter((c) => opts.criteriaIds.includes(c.id)) : checklist.criteria;
  const usage = runs.reduce(
    (u, r) => ({ input_tokens: u.input_tokens + r.usage.input_tokens, output_tokens: u.output_tokens + r.usage.output_tokens, calls: u.calls + r.usage.calls }),
    { input_tokens: 0, output_tokens: 0, calls: 0 },
  );
  usage.cost_usd = Math.round(costUsd(usage) * 1e6) / 1e6;
  return { results: criteria.map((c) => vote(runs, c)), usage, prompt: runs[0].prompt };
}

/** Full evaluation of a conversation with a checklist. */
export async function evaluateConversation(checklist, conv) {
  const { results, usage, prompt } = await runCriteria(checklist, conv);
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
    model: config.llm.mock ? 'mock' : config.llm.model,
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
function mockRun(criteria, conv) {
  const firstOp = conv.transcript.find((m) => m.speaker === 'operator');
  const idx = firstOp ? [firstOp.msg_index] : [];
  return {
    usage: { input_tokens: 0, output_tokens: 0 },
    data: {
      criteria: criteria.map((c) => ({
        criterion_id: c.id,
        reasoning: 'mock',
        answer: c.type === 'scale' ? String(Math.max(...c.scale.map((s) => s.value))) : c.type === 'flag' ? 'no' : 'yes',
        evidence_msg_indices: idx,
        checked_range: null,
        na_reason: null,
        gross_error_type: null,
        explanation: `[MOCK] ${c.name}: тестовый ответ.`,
      })),
    },
  };
}
