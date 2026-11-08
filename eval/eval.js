// Accuracy harness: runs the AI on labelled conversations and compares with our ground truth.
// Owner: P2. The organizers rank teams by closeness to THEIR ground truth, so this is the
// number to improve. Re-run after every prompt / checklist / model change.
//
//   npm run eval                       # all labelled conversations
//   npm run eval -- --limit 10         # first 10
//   npm run eval -- --ids p1-ru-009,p1-en-014
//   npm run eval -- --checklist path/to/checklist.json --gt data/ground_truth.dev.json
//   npm run eval -- --check-gt         # only validate the ground-truth file, no LLM calls
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, config } from '../backend/config.js';
import { loadConversations } from '../backend/data/source.js';
import { runCriteria } from '../backend/llm/evaluate.js';
import { computeScore, normalizeAnswer } from '../shared/scoring.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);

const checklist = JSON.parse(await fs.readFile(path.resolve(ROOT, args.checklist || 'contracts/checklist.default.json'), 'utf-8'));
const gt = JSON.parse(await fs.readFile(path.resolve(ROOT, args.gt || 'data/ground_truth.dev.json'), 'utf-8')).labels;

// Validate ground truth against the checklist
const gtErrors = [];
for (const [id, e] of Object.entries(gt)) {
  for (const c of checklist.criteria) {
    try {
      normalizeAnswer(c, e.answers[c.id]);
    } catch (err) {
      gtErrors.push(`${id}: ${err.message}`);
    }
  }
}
if (gtErrors.length) {
  console.error('Ground truth does not match the checklist:\n' + gtErrors.join('\n'));
  process.exit(1);
}
if (args['check-gt']) {
  console.log(`Ground truth OK: ${Object.keys(gt).length} conversations.`);
  process.exit(0);
}

const all = await loadConversations();
let ids = args.ids ? String(args.ids).split(',') : Object.keys(gt);
ids = ids.filter((id) => gt[id] && all.some((c) => c.conversation_id === id));
if (args.limit) ids = ids.slice(0, Number(args.limit));
console.log(`Evaluating ${ids.length} conversations with ${config.llm.mock ? 'MOCK' : config.llm.model} (votes=${config.llm.votes})...`);

const rows = [];
let cost = 0;
const queue = [...ids];
await Promise.all(
  Array.from({ length: config.llm.concurrency }, async () => {
    while (queue.length) {
      const id = queue.shift();
      const conv = all.find((c) => c.conversation_id === id);
      try {
        const { results, usage } = await runCriteria(checklist, conv);
        cost += usage.cost_usd;
        rows.push({ id, results });
        process.stdout.write('.');
      } catch (e) {
        rows.push({ id, error: e.message });
        process.stdout.write('x');
      }
    }
  }),
);
console.log('\n');

// ---- metrics ----
const per = Object.fromEntries(checklist.criteria.map((c) => [c.id, { ok: 0, n: 0, absErr: 0 }]));
const mismatches = [];
let totalAbsErr = 0, totalN = 0, gross = { tp: 0, fp: 0, fn: 0 };
for (const r of rows.filter((r) => !r.error)) {
  const truth = gt[r.id].answers;
  const pred = Object.fromEntries(r.results.map((x) => [x.criterion_id, x.answer]));
  for (const c of checklist.criteria) {
    const t = normalizeAnswer(c, truth[c.id]);
    const p = pred[c.id];
    per[c.id].n++;
    if (t === p) per[c.id].ok++;
    else {
      const x = r.results.find((y) => y.criterion_id === c.id);
      mismatches.push({ id: r.id, criterion: c.id, truth: t, pred: p, explanation: x.explanation });
    }
    if (c.type === 'scale' && typeof t === 'number' && typeof p === 'number') per[c.id].absErr += Math.abs(t - p);
    if (c.type === 'flag') {
      if (t === 'yes' && p === 'yes') gross.tp++;
      else if (t === 'no' && p === 'yes') gross.fp++;
      else if (t === 'yes' && p === 'no') gross.fn++;
    }
  }
  const ts = computeScore(checklist, truth).total;
  const ps = computeScore(checklist, pred).total;
  if (ts !== null && ps !== null) {
    totalAbsErr += Math.abs(ts - ps);
    totalN++;
  }
}

const table = checklist.criteria.map((c) => ({
  criterion: `${c.id} ${c.name}`.slice(0, 40),
  accuracy: per[c.id].n ? `${Math.round((per[c.id].ok / per[c.id].n) * 100)}%` : '-',
  ...(c.type === 'scale' ? { 'scale MAE': (per[c.id].absErr / Math.max(1, per[c.id].n)).toFixed(2) } : {}),
}));
console.table(table);
const allOk = Object.values(per).reduce((s, x) => s + x.ok, 0);
const allN = Object.values(per).reduce((s, x) => s + x.n, 0);
console.log(`Overall criterion accuracy: ${((allOk / allN) * 100).toFixed(1)}%  (${allOk}/${allN})`);
console.log(`Total score MAE: ${(totalAbsErr / Math.max(1, totalN)).toFixed(2)} points`);
console.log(`Gross errors: caught ${gross.tp}, missed ${gross.fn}, false alarms ${gross.fp}`);
console.log(`Cost: $${cost.toFixed(4)}   Errors: ${rows.filter((r) => r.error).length}`);

if (mismatches.length) {
  console.log('\nMismatches:');
  for (const m of mismatches.sort((a, b) => a.criterion.localeCompare(b.criterion))) {
    console.log(`  ${m.criterion} ${m.id}: truth=${m.truth} pred=${m.pred} | ${m.explanation}`);
  }
}

await fs.mkdir(path.join(ROOT, 'eval', 'results'), { recursive: true });
const file = path.join(ROOT, 'eval', 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(file, JSON.stringify({ model: config.llm.model, votes: config.llm.votes, table, overall: allOk / allN, total_mae: totalAbsErr / Math.max(1, totalN), gross, cost, mismatches, rows }, null, 1));
console.log(`\nSaved ${path.relative(ROOT, file)}`);
