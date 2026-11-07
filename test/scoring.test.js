import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeScore, validateChecklist, normalizeAnswer } from '../shared/scoring.js';

const cl = JSON.parse(readFileSync(new URL('../contracts/checklist.default.json', import.meta.url), 'utf-8'));

test('default checklist is valid and weights sum to 100', () => {
  assert.deepEqual(validateChecklist(cl), []);
  assert.equal(cl.criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + c.weight, 0), 100);
});

test('everything perfect = 100', () => {
  const r = computeScore(cl, { c01: 'yes', c02: 'yes', c03: 'yes', c04: 20, c05: 'yes', c06: 10, c07: 'yes', c08: 'no' });
  assert.equal(r.total, 100);
  assert.equal(r.gross_error, false);
});

test('worked example: c02 and c07 N/A → weight redistributed, 88.13', () => {
  // applicable weight 80; raw = 10 + 20 + 15 + 15 + 10.5 = 70.5; 70.5 * 100 / 80 = 88.125 → 88.13
  const r = computeScore(cl, { c01: 'yes', c02: 'na', c03: 'yes', c04: 15, c05: 'yes', c06: 7, c07: 'na', c08: 'no' });
  assert.equal(r.total, 88.13);
  assert.equal(r.criteria.c02.applicable, false);
  assert.equal(r.criteria.c01.effective_weight, 12.5);
});

test('all applicable weighted criteria still sum to 100 max after redistribution', () => {
  const r = computeScore(cl, { c01: 'yes', c02: 'na', c03: 'na', c04: 'na', c05: 'yes', c06: 10, c07: 'na', c08: 'no' });
  const maxSum = Object.values(r.criteria).reduce((s, c) => s + c.effective_weight, 0);
  assert.equal(Math.round(maxSum * 1000) / 1000, 100);
  assert.equal(r.total, 100);
});

test('gross error is flagged separately and does not change the total', () => {
  const a = { c01: 'yes', c02: 'na', c03: 'na', c04: 0, c05: 'no', c06: 7, c07: 'no', c08: 'yes' };
  const r = computeScore(cl, a);
  assert.equal(r.gross_error, true);
  assert.deepEqual(r.gross_criteria, ['c08']);
  // applicable: c01 10, c04 20, c05 15, c06 15, c07 5 = 65; raw = 10 + 0 + 0 + 10.5 + 0 = 20.5 → 31.54
  assert.equal(r.total, 31.54);
  assert.equal(computeScore(cl, { ...a, c08: 'no' }).total, 31.54);
});

test('no applicable weighted criteria → total null', () => {
  const only = {
    ...cl,
    criteria: [
      { id: 'a', section: 's1', name: 'A', type: 'binary', weight: 50, na_allowed: true, na_rule: 'x' },
      { id: 'b', section: 's1', name: 'B', type: 'flag', weight: 0, na_allowed: false },
    ],
  };
  const r = computeScore(only, { a: 'na', b: 'no' });
  assert.equal(r.total, null);
});

test('N/A rejected where not allowed; scale value must be a defined step', () => {
  const c01 = cl.criteria.find((c) => c.id === 'c01');
  const c04 = cl.criteria.find((c) => c.id === 'c04');
  assert.throws(() => normalizeAnswer(c01, 'na'));
  assert.throws(() => normalizeAnswer(c04, 12));
  assert.equal(normalizeAnswer(c04, '15'), 15);
  assert.equal(normalizeAnswer(c01, 'Да'), 'yes');
});

test('sections report points and max after redistribution', () => {
  const r = computeScore(cl, { c01: 'yes', c02: 'na', c03: 'yes', c04: 15, c05: 'yes', c06: 7, c07: 'na', c08: 'no' });
  assert.deepEqual(r.sections.s1, { points: 12.5, max: 12.5 });
  assert.deepEqual(r.sections.s2, { points: 43.75, max: 50 });
  assert.equal(r.sections.s4, undefined);
});

test('a replaced criterion works without code changes', () => {
  const changed = structuredClone(cl);
  const i = changed.criteria.findIndex((c) => c.id === 'c05');
  changed.criteria[i] = {
    id: 'c09', section: 's3', name: 'Новый критерий', type: 'scale', weight: 15, na_allowed: false,
    scale: [{ value: 0, description: 'плохо' }, { value: 5, description: 'хорошо' }], yes_rule: 'x',
  };
  assert.deepEqual(validateChecklist(changed), []);
  const r = computeScore(changed, { c01: 'yes', c02: 'yes', c03: 'yes', c04: 20, c09: 5, c06: 10, c07: 'yes', c08: 'no' });
  assert.equal(r.total, 100);
});
