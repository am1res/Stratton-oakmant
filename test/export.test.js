// Submission export: organizers' criterion ids, 1-based turns, N/A → null, reviewer overrides win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubmission } from '../backend/export.js';

const ev = (id, created_at, extra = {}) => ({
  conversation_id: id,
  created_at,
  checklist_snapshot: { criteria: [{ id: 'c01' }, { id: 'c02' }, { id: 'c06' }, { id: 'c08' }, { id: 'x1', code: 'custom' }, { id: 'x2' }] },
  criteria: [
    { criterion_id: 'c01', answer: 'yes', explanation: 'Поздоровался в #9.', evidence_msg_indices: [9] },
    { criterion_id: 'c02', answer: 'na', explanation: 'Данных хватало.', evidence_msg_indices: [], evidence: [{ msg_index: 4 }] },
    { criterion_id: 'c06', answer: 7, explanation: 'Один сбой #9 и #10.', evidence_msg_indices: [10, 9, 10] },
    { criterion_id: 'c08', answer: 'no', explanation: 'Нет.', evidence_msg_indices: [9] },
    { criterion_id: 'x1', answer: 'no', explanation: '', evidence_msg_indices: [] },
    { criterion_id: 'x2', answer: 'yes', explanation: '', evidence_msg_indices: [] },
  ],
  score: { total: 85.38, gross_error: false },
  ...extra,
});

test('export: format, ids, values, 1-based turns', () => {
  const out = buildSubmission({
    conversationIds: ['a', 'b'],
    evaluations: [ev('a', '2026-11-01T00:00:00Z', { score: { total: 10, gross_error: false } }), ev('a', '2026-11-02T00:00:00Z')],
    teamName: 'T',
    model: { mode: 'api', name: 'm' },
  });
  assert.equal(out.schema_version, '1.0');
  assert.deepEqual(out.model, { mode: 'api', name: 'm' });
  const [a, b] = out.results;
  assert.equal(a.status, 'ok');
  assert.deepEqual(a.score, { final_score: 85.38, critical_flag: false }); // newest evaluation
  const by = Object.fromEntries(a.criteria.map((c) => [c.criterion_id, c]));
  assert.deepEqual(Object.keys(by), ['contact', 'discovery', 'dialogue', 'critical', 'custom', 'x2']);
  assert.equal(by.contact.value, true);
  assert.deepEqual(by.contact.evidence_turns, [10]);
  assert.equal(by.contact.rationale, 'Поздоровался в #10.');
  assert.equal(by.discovery.value, null);
  assert.deepEqual(by.discovery.evidence_turns, [5]);
  assert.equal(by.dialogue.value, 7);
  assert.deepEqual(by.dialogue.evidence_turns, [10, 11]);
  assert.equal(by.dialogue.rationale, 'Один сбой #10 и #11.');
  assert.equal(by.critical.value, false);
  assert.equal(b.status, 'error');
});

test('export: reviewer decision wins', () => {
  const e = ev('a', '2026-11-02T00:00:00Z', {
    final: { total: 100, gross_error: true, overrides: { c06: { answer: 10, reason: 'Сбоя нет' }, c08: { answer: 'yes', reason: 'Раскрытие данных' } } },
  });
  const [r] = buildSubmission({ conversationIds: ['a'], evaluations: [e], teamName: 'T', model: {} }).results;
  const by = Object.fromEntries(r.criteria.map((c) => [c.criterion_id, c]));
  assert.equal(by.dialogue.value, 10);
  assert.equal(by.dialogue.rationale, 'Решение ревьюера: Сбоя нет');
  assert.equal(by.critical.value, true);
  assert.deepEqual(r.score, { final_score: 100, critical_flag: true });
});
