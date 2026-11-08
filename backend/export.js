// Results file in the organizers' submission format (schema_version 1.0):
// { schema_version, team_name, model: {mode, name}, results: [{conversation_id, status, criteria: [
//   {criterion_id, value, rationale, evidence_turns}], score: {final_score, critical_flag}}] }
//
// - criterion_id: the organizers' names (contact, discovery, ...). A criterion added in the UI can set
//   its own `code`; otherwise its internal id is used.
// - value: yes → true, no → false, N/A → null, scale → number. "critical" is true when a gross error was found.
// - evidence_turns: 1-based and counting every line (bot and system too) = msg_index + 1.
//   "#N" in the rationale text is shifted the same way, so the text and the numbers agree.
// - A reviewer decision on an appeal wins over the AI answer (and its reason becomes the rationale).

export const CRITERION_CODES = {
  c01: 'contact',
  c02: 'discovery',
  c03: 'identification',
  c04: 'consultation',
  c05: 'empathy',
  c06: 'dialogue',
  c07: 'closure',
  c08: 'critical',
};

const shiftRefs = (text) => String(text || '').replace(/#(\d+)/g, (_, n) => `#${Number(n) + 1}`);

export function toValue(answer) {
  if (answer === 'na' || answer === null || answer === undefined) return null;
  if (answer === 'yes') return true;
  if (answer === 'no') return false;
  return typeof answer === 'number' ? answer : Number(answer);
}

function turnsOf(c) {
  const idx = c.evidence_msg_indices?.length ? c.evidence_msg_indices : (c.evidence || []).map((e) => e.msg_index);
  return [...new Set(idx.filter(Number.isInteger))].sort((a, b) => a - b).map((i) => i + 1);
}

/** One result entry from a stored evaluation. */
export function resultFromEvaluation(ev) {
  const defs = new Map((ev.checklist_snapshot?.criteria || []).map((d) => [d.id, d]));
  const overrides = ev.final?.overrides || {};
  const criteria = ev.criteria.map((c) => {
    const def = defs.get(c.criterion_id) || {};
    const o = overrides[c.criterion_id];
    return {
      criterion_id: def.code || CRITERION_CODES[c.criterion_id] || c.criterion_id,
      value: toValue(o ? o.answer : c.answer),
      rationale: o ? `Решение ревьюера: ${o.reason}` : shiftRefs(c.explanation || c.reasoning),
      evidence_turns: turnsOf(c),
    };
  });
  const s = ev.final || ev.score || {};
  return {
    conversation_id: ev.conversation_id,
    status: 'ok',
    criteria,
    score: { final_score: s.total ?? null, critical_flag: !!s.gross_error },
  };
}

/**
 * conversationIds: every conversation of the dataset, in order (missing ones get status "error").
 * evaluations: stored evaluations; the newest one per conversation is used.
 */
export function buildSubmission({ conversationIds, evaluations, teamName, model }) {
  const latest = new Map();
  for (const ev of evaluations) {
    const cur = latest.get(ev.conversation_id);
    if (!cur || ev.created_at > cur.created_at) latest.set(ev.conversation_id, ev);
  }
  return {
    schema_version: '1.0',
    team_name: teamName,
    model,
    results: conversationIds.map((id) =>
      latest.has(id)
        ? resultFromEvaluation(latest.get(id))
        : { conversation_id: id, status: 'error', error: 'not evaluated', criteria: [], score: null },
    ),
  };
}
