// Evaluation result. Owner: P3.
// Order follows the reviewer's questions: what's the score → is there a gross error → which
// criteria cost points and why → where is the proof. Each criterion row has its own evidence
// chips (jump to the message) and its own "Оспорить" action, so the appeal starts where the doubt is.
import { esc, fmtAnswer } from '../common/api.js';
import { stripHtml, verdictClass } from '../common/strip.js';
import { computeScore } from '/shared/scoring.js';
import { renderAppealInline } from '../appeals/form.js';

const GROSS = { insult: 'оскорбление клиента', bypass_service: 'услуга в обход компании', confidential_disclosure: 'раскрытие конфиденциальной информации' };

export function renderResult(el, ev, { onEvidence, onChanged, focus } = {}) {
  const cl = ev.checklist_snapshot;
  const byId = Object.fromEntries(cl.criteria.map((c) => [c.id, c]));
  const overrides = ev.final?.overrides || {};
  const answers = Object.fromEntries(ev.criteria.map((r) => [r.criterion_id, overrides[r.criterion_id]?.answer ?? r.answer]));
  const now = computeScore(cl, answers);
  const items = cl.criteria.map((c) => ({ id: c.id, name: c.name, type: c.type, answer: answers[c.id], points: now.criteria[c.id].points, effective_weight: now.criteria[c.id].effective_weight }));
  const results = Object.fromEntries(ev.criteria.map((r) => [r.criterion_id, r]));
  const grossRow = ev.criteria.find((r) => byId[r.criterion_id]?.type === 'flag' && answers[r.criterion_id] === 'yes');

  const chip = (c, a) => {
    const cls = verdictClass(c.type, a, now.criteria[c.id].points, now.criteria[c.id].effective_weight);
    const text = c.type === 'flag' ? (a === 'yes' ? 'Есть' : 'Нет') : fmtAnswer(a);
    return `<span class="v ${cls}">${esc(text)}</span>`;
  };
  const pts = (c) => {
    if (c.type === 'flag') return '';
    const x = now.criteria[c.id];
    if (!x.applicable) return `<span class="muted">—</span><small>N/A, вес ${c.weight} отдан остальным</small>`;
    return `${fmt(x.points)}<small>из ${fmt(x.effective_weight)}</small>`;
  };

  const row = (c) => {
    const r = results[c.id];
    if (!r) return '';
    const o = overrides[c.id];
    return `<div class="crit" id="crit-${esc(c.id)}" data-crit="${esc(c.id)}">
      <div>${chip(c, answers[c.id])}</div>
      <div>
        <div class="crit-name">${esc(c.name)}</div>
        <p class="crit-why">${esc(r.explanation)}</p>
        ${r.evidence?.length ? `<ul class="ev-quotes">${r.evidence.map((e) => `<li>#${e.msg_index} <q>${esc(e.quote)}</q>${e.proves ? ` — ${esc(e.proves)}` : ''}</li>`).join('')}</ul>` : ''}
        ${r.na_reason && r.answer === 'na' ? `<p class="crit-why muted">Почему N/A: ${esc(r.na_reason)}</p>` : ''}
        ${r.gross_error_type && answers[c.id] === 'yes' ? `<p class="crit-why error">Тип нарушения: ${esc(GROSS[r.gross_error_type] || r.gross_error_type)}</p>` : ''}
        ${o ? `<p class="override">После апелляции: было ${esc(fmtAnswer(r.answer))}, стало ${esc(fmtAnswer(o.answer))}. ${esc(o.reason)}</p>` : ''}
        <div class="crit-foot">
          ${(r.evidence_msg_indices || []).map((i) => `<button class="ev" data-ev="${i}" title="Показать реплику #${i}">#${i}</button>`).join('')}
          ${r.checked_range ? `<button class="ev range" data-ev="${r.checked_range[0]}" data-ev-to="${r.checked_range[1]}" title="Где ожидалось действие">проверено #${r.checked_range[0]}–${r.checked_range[1]}</button>` : ''}
          ${
            r.agreement === 'arbitrated' || r.agreement === 'arbiter_failed' || (r.confidence !== undefined && r.confidence < 1)
              ? `<span class="agreement">Стоит проверить</span>`
              : ''
          }
          ${r.reused_from ? `<span class="reused" title="Определение критерия не менялось с версии v${esc(r.reused_from.checklist_version)}, поэтому ответ перенесён без нового обращения к модели">перенесено из оценки от ${esc(fmtDate(r.reused_from.created_at))}</span>` : ''}
          <button class="link" data-appeal="${esc(c.id)}" style="margin-left:auto">Оспорить</button>
        </div>
        <div class="appeal-slot"></div>
      </div>
      <div class="crit-pts">${pts(c)}</div>
    </div>`;
  };

  const sections = (cl.sections || []).filter((s) => cl.criteria.some((c) => c.section === s.id));
  const loose = cl.criteria.filter((c) => !sections.some((s) => s.id === c.section));
  const total = ev.final ? ev.final.total : ev.score.total;

  el.innerHTML = `
    <section class="sheet">
      <div class="verdict">
        <div class="verdict-top">
          <div>
            <div class="score">${total ?? '—'}<small> из ${ev.score.max}</small></div>
          </div>
          ${ev.final && ev.final.total !== ev.score.total ? `<div><div class="score was">${ev.score.total ?? '—'}</div><div class="muted" style="font-size:12px">до апелляций</div></div>` : ''}
          <div class="run-meta">${new Date(ev.created_at).toLocaleString('ru-RU')}</div>
        </div>
        ${ev.provenance?.mock ? '<div class="test-banner">Тестовая оценка без ИИ (LLM_MOCK=1). Не использовать в отчётах.</div>' : ''}
        ${grossRow ? `<div class="gross-banner">Грубая ошибка: ${esc(GROSS[grossRow.gross_error_type] || 'см. критерий ' + grossRow.criterion_id)}. Отмечается отдельно и на балл не влияет.</div>` : ''}
        ${stripHtml(items, { large: true })}
        <div class="sections">${sections
          .filter((s) => now.sections[s.id] && now.sections[s.id].max > 0)
          .map((s) => `<span>${esc(s.name)} <b>${fmt(now.sections[s.id].points)}</b> из ${fmt(now.sections[s.id].max)}</span>`)
          .join('')}</div>
      </div>
      ${sections
        .map((s) => `<div class="crit-group"><h3>${esc(s.name)}</h3>${cl.criteria.filter((c) => c.section === s.id).map(row).join('')}</div>`)
        .join('')}
      ${loose.length ? `<div class="crit-group"><h3>Другие критерии</h3>${loose.map(row).join('')}</div>` : ''}
      ${runRecord(ev)}
    </section>`;

  // evidence → transcript
  el.querySelectorAll('[data-ev]').forEach((b) =>
    b.addEventListener('click', () => {
      const from = Number(b.dataset.ev);
      const to = b.dataset.evTo ? Number(b.dataset.evTo) : from;
      const crit = b.closest('[data-crit]').dataset.crit;
      const idxs = b.dataset.evTo ? range(from, to) : results[crit].evidence_msg_indices;
      setActive(crit);
      onEvidence?.(idxs, from);
    }),
  );
  // strip segment → criterion row
  el.querySelectorAll('.strip [data-crit]').forEach((s) =>
    s.addEventListener('click', () => {
      const row = el.querySelector(`#crit-${CSS.escape(s.dataset.crit)}`);
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setActive(s.dataset.crit);
    }),
  );
  // inline appeal
  el.querySelectorAll('[data-appeal]').forEach((b) =>
    b.addEventListener('click', () => {
      const slot = b.closest('.crit').querySelector('.appeal-slot');
      if (slot.childElementCount) return (slot.innerHTML = '');
      renderAppealInline(slot, ev, b.dataset.appeal, onChanged);
    }),
  );

  function setActive(id) {
    el.querySelectorAll('.crit.active, .seg-w.active').forEach((n) => n.classList.remove('active'));
    el.querySelector(`#crit-${CSS.escape(id)}`)?.classList.add('active');
    el.querySelector(`.strip [data-crit="${CSS.escape(id)}"]`)?.classList.add('active');
  }

  if (focus && results[focus]) {
    setActive(focus);
    setTimeout(() => el.querySelector(`#crit-${CSS.escape(focus)}`)?.scrollIntoView({ block: 'center' }), 50);
    const r = results[focus];
    if (r.evidence_msg_indices?.length) onEvidence?.(r.evidence_msg_indices, r.evidence_msg_indices[0]);
  }
}

const fmt = (x) => (x === null || x === undefined ? '—' : String(Math.round(x * 100) / 100).replace('.', ','));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

/** "Как получена эта оценка": the run record, for auditors and for proving the evaluation is live. */
function runRecord(ev) {
  const p = ev.provenance;
  if (!p) return '';
  const row = (k, v) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`;
  const list = (ids) => (ids?.length ? ids.map(esc).join(', ') : 'нет');
  return `<details class="prompt run-record"><summary>Как получена эта оценка</summary>
    <table>
      ${row('Время', esc(new Date(ev.created_at).toLocaleString('ru-RU')))}
      ${row('Режим и модели', `${esc(p.mode)}: ${esc(p.models)}`)}
      ${row('Версия промпта', esc(p.prompt_version || '—'))}
      ${row('Чек-лист', `v${esc(ev.checklist_version)}, отпечаток <code>${esc(p.checklist_hash)}</code>`)}
      ${row('Транскрипт', `отпечаток <code>${esc(p.transcript_hash)}</code>, источник: ${esc(p.source)}${p.data_group ? `, набор ${esc(p.data_group)}` : ''}`)}
      ${row('Спросили модель заново', list(p.fresh_criteria))}
      ${row('Перенесено без изменений', list(p.reused_criteria))}
      ${row('Версия приложения', `<code>${esc(p.app_version)}</code>`)}
      ${row('Обращений к модели', esc(ev.usage?.calls ?? '—'))}
    </table>
    <p class="muted">Отпечаток меняется при любом изменении текста диалога или чек-листа: по нему видно, что оценка сделана именно по этим данным.</p>
    ${ev.prompt ? `<details><summary>Инструкция, которую получила модель</summary><pre>${esc(ev.prompt)}</pre></details>` : ''}
  </details>`;
}
