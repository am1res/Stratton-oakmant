// Writes data/reference.submission.json (our reviewed reference in the organizers' format) and
// docs/llm_prompt.md (the prompt the model gets, built from the current default checklist).
// Run: npm run export-reference
import { fileURLToPath } from 'node:url';
import path from 'node:path';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
import fs from 'node:fs';
import { buildMessages, responseSchema } from '../backend/llm/prompt.js';
import { normalizeRecord } from '../backend/data/source.js';
import { computeScore } from '../shared/scoring.js';
import { CRITERION_CODES } from '../backend/export.js';
const checklist = JSON.parse(fs.readFileSync('contracts/checklist.default.json', 'utf-8'));
const gt = JSON.parse(fs.readFileSync('data/ground_truth.dev.json', 'utf-8'));
const recs = JSON.parse(fs.readFileSync('data/dev.json', 'utf-8')).data.records;

// 1) reference in the organizers' submission format (only entries checked by Dastan)
const order = recs.map((r) => r.conversation_id);
const results = order.filter((id) => gt.labels[id]?.reviewed_by).map((id) => {
  const lab = gt.labels[id];
  const s = computeScore(checklist, lab.answers);
  return {
    conversation_id: id,
    status: 'ok',
    criteria: lab.criteria.map(({ criterion_id, value, rationale, evidence_turns }) => ({ criterion_id, value, rationale, evidence_turns })),
    score: { final_score: s.total, critical_flag: s.gross_error },
  };
});
const sub = { schema_version: '1.0', team_name: process.env.TEAM_NAME || 'Stratton Oakmont', model: { mode: 'human', name: 'reference: reviewed by Dastan' }, results };
fs.writeFileSync('data/reference.submission.json', JSON.stringify(sub, null, 2) + '\n');

// 2) the LLM prompt, as the model receives it (system + user for one example dialog)
const conv = normalizeRecord(recs.find((r) => r.conversation_id === 'p1-kz-005'));
const msgs = buildMessages(checklist, conv).messages;
const md = [
  '# LLM prompt',
  '',
  `Generated from \`contracts/checklist.default.json\` by \`backend/llm/prompt.js\` on ${new Date().toISOString().slice(0, 10)}. The prompt is rebuilt from the checklist on every evaluation, so editing the checklist in the UI changes it; this file is a snapshot for reading and review.`,
  '',
  'Criterion ids in the submission file: ' + Object.entries(CRITERION_CODES).map(([k, v]) => `${k} → \`${v}\``).join(', ') + '. In the prompt the model sees line numbers as `#msg_index` (0-based); the export adds 1.',
  '',
  ...msgs.flatMap((m) => [`## ${m.role} message${m.role === 'user' ? ' (example dialog: p1-kz-005)' : ''}`, '', '```text', typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2), '```', '']),
  '## Response JSON schema (Structured Outputs)',
  '',
  '```json',
  JSON.stringify(responseSchema(checklist.criteria), null, 2),
  '```',
  '',
].join('\n');
fs.writeFileSync('docs/llm_prompt.md', md);
console.log('results:', results.length, '| prompt chars:', md.length, '| roles:', msgs.map((m) => m.role).join(','));
