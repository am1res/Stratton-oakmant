// Run record ("provenance") for every evaluation, and the rules for reusing unchanged answers.
// Owner: P2.
//
// Why: an auditor (or the jury) must be able to see that an evaluation was produced fresh, from
// which transcript, checklist, prompt and models. And after a checklist edit, only criteria whose
// MEANING changed need new model calls: a weight-only edit is recalculated without any call.
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const sha = (obj) => crypto.createHash('sha256').update(typeof obj === 'string' ? obj : stable(obj)).digest('hex').slice(0, 16);

/** JSON with sorted keys, so the same content always gives the same hash. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

// Fields that change the score but not the model's judgement.
const SCORE_ONLY_CRITERION_FIELDS = ['weight', 'section'];
const NOT_GLOBAL_FIELDS = ['criteria', 'sections', 'version', 'saved_at', 'restored_from', 'rounding', 'id', 'name'];
const omit = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !keys.includes(k)));

export const transcriptHash = (conv) => sha(conv.transcript.map((m) => ({ s: m.speaker, t: m.text, ts: m.timestamp })));
export const criterionHash = (c) => sha(omit(c, SCORE_ONLY_CRITERION_FIELDS));
export const globalRulesHash = (checklist) => sha(omit(checklist, NOT_GLOBAL_FIELDS));
export const checklistHash = (checklist) => sha(omit(checklist, ['saved_at', 'restored_from']));

let appVersion = null;
export function getAppVersion() {
  if (appVersion) return appVersion;
  try {
    appVersion = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    try {
      appVersion = `pkg-${JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version}`;
    } catch {
      appVersion = 'unknown';
    }
  }
  return appVersion;
}

/**
 * Which criteria of `checklist` can reuse the answer from `previous` for this conversation.
 * Reuse only when the checklist version changed (a plain "evaluate again" always runs fresh),
 * the transcript, global rules, mode, models and prompt version are identical, and the
 * criterion's own definition (everything except weight/section) is identical.
 */
export function reusableCriteria(checklist, conv, previous, current) {
  const p = previous?.provenance;
  if (!p || p.mock !== current.mock) return [];
  if (previous.checklist_version === checklist.version) return [];
  if (p.transcript_hash !== transcriptHash(conv)) return [];
  if (p.global_rules_hash !== globalRulesHash(checklist)) return [];
  if (p.mode !== current.mode || p.models !== current.models) return [];
  if (current.prompt_version && p.prompt_version && current.prompt_version !== p.prompt_version) return [];
  const prevHashes = p.criteria_hashes || {};
  return checklist.criteria
    .filter((c) => prevHashes[c.id] && prevHashes[c.id] === criterionHash(c))
    .filter((c) => previous.criteria.some((r) => r.criterion_id === c.id))
    .map((c) => c.id);
}

export function buildProvenance(checklist, conv, { mode, models, mock, promptVersion, reused, freshIds }) {
  return {
    transcript_hash: transcriptHash(conv),
    checklist_hash: checklistHash(checklist),
    global_rules_hash: globalRulesHash(checklist),
    criteria_hashes: Object.fromEntries(checklist.criteria.map((c) => [c.id, criterionHash(c)])),
    mode,
    models,
    mock,
    prompt_version: promptVersion || null,
    app_version: getAppVersion(),
    data_group: conv.group_id || null,
    source: conv.source || 'api',
    fresh_criteria: freshIds,
    reused_criteria: reused,
  };
}
