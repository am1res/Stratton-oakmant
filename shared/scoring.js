// Scoring per the CQA checklist (page 2, "Порядок расчёта"). Pure functions, no I/O.
// Works in the browser (<script type="module">) and in Node. Owner: P3.
//
// 1. N/A only where allowed.
// 2. "yes" = full weight, "no" = 0; scale answers are one of the scale values.
// 3. Scale → points proportional to weight; the top scale value gives the full weight.
// 4. Drop N/A criteria and redistribute their weight proportionally (max stays 100).
// 5. Round the total to `rounding` decimals; if no weighted criterion applies, total = null.
//    Gross errors (type "flag") are reported separately and never change the total.

export function roundTo(x, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round((x + Number.EPSILON) * f) / f;
}

function scaleMax(c) {
  return Math.max(...c.scale.map((s) => s.value));
}

/** Normalise an AI/user answer for criterion c. Returns "yes" | "no" | "na" | number, or throws. */
export function normalizeAnswer(c, answer) {
  if (answer === null || answer === undefined) throw new Error(`${c.id}: missing answer`);
  const a = typeof answer === 'string' ? answer.trim().toLowerCase() : answer;
  if (a === 'na' || a === 'n/a') {
    if (!c.na_allowed) throw new Error(`${c.id}: N/A not allowed`);
    return 'na';
  }
  if (c.type === 'binary' || c.type === 'flag') {
    if (a === 'yes' || a === 'да' || a === true) return 'yes';
    if (a === 'no' || a === 'нет' || a === false) return 'no';
    throw new Error(`${c.id}: expected yes/no, got ${answer}`);
  }
  if (c.type === 'scale') {
    const n = Number(a);
    const allowed = c.scale.map((s) => s.value);
    if (!allowed.includes(n)) throw new Error(`${c.id}: ${answer} is not one of ${allowed.join(', ')}`);
    return n;
  }
  throw new Error(`${c.id}: unknown type ${c.type}`);
}

/**
 * @param checklist  checklist config (see contracts/checklist.default.json)
 * @param answers    { [criterion_id]: "yes"|"no"|"na"|number }
 * @returns {{ total:number|null, max:number, gross_error:boolean, gross_criteria:string[],
 *            criteria:Object<string,{answer, raw_points, effective_weight, points, applicable}>,
 *            sections:Object<string,{points:number,max:number}> }}
 */
export function computeScore(checklist, answers) {
  const decimals = checklist.rounding ?? 2;
  const weighted = checklist.criteria.filter((c) => c.type !== 'flag');
  const flags = checklist.criteria.filter((c) => c.type === 'flag');

  const norm = {};
  for (const c of checklist.criteria) norm[c.id] = normalizeAnswer(c, answers[c.id]);

  const applicable = weighted.filter((c) => norm[c.id] !== 'na' && c.weight > 0);
  const applicableWeight = applicable.reduce((s, c) => s + c.weight, 0);
  const totalWeight = weighted.reduce((s, c) => s + c.weight, 0);
  const factor = applicableWeight > 0 ? totalWeight / applicableWeight : 0;

  const criteria = {};
  let sum = 0;
  for (const c of weighted) {
    const a = norm[c.id];
    if (a === 'na') {
      criteria[c.id] = { answer: a, raw_points: null, effective_weight: 0, points: null, applicable: false };
      continue;
    }
    const raw = c.type === 'binary' ? (a === 'yes' ? c.weight : 0) : (a / scaleMax(c)) * c.weight;
    const points = raw * factor;
    sum += raw; // total is computed from raw sum once, to avoid float drift
    criteria[c.id] = {
      answer: a,
      raw_points: raw,
      effective_weight: roundTo(c.weight * factor, 4),
      points: roundTo(points, 4),
      applicable: true,
    };
  }

  const gross = flags.filter((c) => norm[c.id] === 'yes').map((c) => c.id);
  for (const c of flags) {
    criteria[c.id] = { answer: norm[c.id], raw_points: null, effective_weight: 0, points: null, applicable: true };
  }

  const sections = {};
  for (const s of checklist.sections || []) {
    const inSec = weighted.filter((c) => c.section === s.id && criteria[c.id].applicable);
    if (!weighted.some((c) => c.section === s.id)) continue;
    sections[s.id] = {
      points: roundTo(inSec.reduce((x, c) => x + criteria[c.id].points, 0), decimals),
      max: roundTo(inSec.reduce((x, c) => x + criteria[c.id].effective_weight, 0), decimals),
    };
  }

  return {
    total: applicableWeight > 0 ? roundTo((sum * totalWeight) / applicableWeight, decimals) : null,
    max: totalWeight,
    gross_error: gross.length > 0,
    gross_criteria: gross,
    criteria,
    sections,
  };
}

/** Validate a checklist before saving. Returns a list of error strings (empty = ok). */
export function validateChecklist(cl) {
  const errors = [];
  if (!cl || !Array.isArray(cl.criteria) || cl.criteria.length === 0) return ['Checklist has no criteria'];
  const ids = new Set();
  for (const c of cl.criteria) {
    const tag = c.id || '(no id)';
    if (!c.id) errors.push('Criterion without id');
    if (ids.has(c.id)) errors.push(`Duplicate id ${c.id}`);
    ids.add(c.id);
    if (!c.name) errors.push(`${tag}: name is required`);
    if (!['binary', 'scale', 'flag'].includes(c.type)) errors.push(`${tag}: type must be binary, scale or flag`);
    if (c.type !== 'flag' && !(Number(c.weight) > 0)) errors.push(`${tag}: weight must be > 0`);
    if (c.type === 'scale') {
      if (!Array.isArray(c.scale) || c.scale.length < 2) errors.push(`${tag}: scale needs at least 2 steps`);
      else if (c.scale.some((s) => typeof s.value !== 'number')) errors.push(`${tag}: scale values must be numbers`);
    }
    if (c.na_allowed && !c.na_rule) errors.push(`${tag}: N/A is allowed but na_rule is empty`);
    if (cl.sections?.length && !cl.sections.some((s) => s.id === c.section)) errors.push(`${tag}: unknown section ${c.section}`);
  }
  return errors;
}
