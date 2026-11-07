// Evaluation result panel. Owner: P3.
// Shows per criterion: answer, points, weight, explanation, evidence links, checked range,
// N/A reason; plus sections, total, gross error badge, and the original vs final total after appeals.
// TODO(P3): nicer layout, section grouping, confidence display, "Show prompt" modal.
import { esc, fmtAnswer } from '../common/api.js';

export function renderResult(el, ev, { onEvidence } = {}) {
  const cl = ev.checklist_snapshot;
  const byId = Object.fromEntries(cl.criteria.map((c) => [c.id, c]));
  const s = ev.score;
  const overrides = ev.final?.overrides || {};

  const badge = (a) => `<span class="badge ${a === 'yes' || a === 'no' || a === 'na' ? a : ''}">${fmtAnswer(a)}</span>`;
  const links = (idxs) => (idxs || []).map((i) => `<a class="evidence" data-idx="${i}">#${i}</a>`).join(' ');

  el.innerHTML = `
    <div class="panel" style="margin-bottom:12px">
      <div style="display:flex;gap:16px;align-items:baseline;flex-wrap:wrap">
        <div style="font-size:28px;font-weight:700">${s.total ?? '—'}<span class="muted" style="font-size:14px"> / ${s.max}</span></div>
        ${ev.final ? `<div>после апелляций: <strong style="font-size:22px">${ev.final.total ?? '—'}</strong></div>` : ''}
        ${s.gross_error || ev.final?.gross_error ? '<span class="badge gross">Грубая ошибка</span>' : ''}
        <span class="muted" style="margin-left:auto">$${ev.usage?.cost_usd ?? 0} · ${ev.usage?.calls ?? 0} вызов(ов)</span>
      </div>
      <div class="muted" style="margin-top:6px">${(cl.sections || [])
        .filter((x) => s.sections[x.id])
        .map((x) => `${esc(x.name)}: ${s.sections[x.id].points} / ${s.sections[x.id].max}`)
        .join(' · ')}</div>
    </div>
    <table>
      <thead><tr><th>Критерий</th><th>Ответ</th><th>Баллы</th><th>Обоснование</th></tr></thead>
      <tbody>${ev.criteria
        .map((r) => {
          const c = byId[r.criterion_id];
          const o = overrides[r.criterion_id];
          return `<tr>
            <td><strong>${esc(r.criterion_id)}</strong> ${esc(c?.name)}<div class="muted">вес ${c?.weight ?? 0}${r.effective_weight && r.effective_weight !== c?.weight ? ` → ${r.effective_weight}` : ''}</div></td>
            <td>${badge(r.answer)}${o ? `<div>→ ${badge(o.answer)} <span class="muted">апелляция</span></div>` : ''}
                ${r.confidence < 1 ? `<div class="muted">уверенность ${Math.round(r.confidence * 100)}%</div>` : ''}</td>
            <td>${r.points ?? '—'}</td>
            <td>${esc(r.explanation)}
              <div>${links(r.evidence_msg_indices)}
                ${r.checked_range ? `<span class="muted">проверен участок </span><a class="evidence" data-idx="${r.checked_range[0]}">#${r.checked_range[0]}–#${r.checked_range[1]}</a>` : ''}</div>
              ${r.na_reason ? `<div class="muted">N/A: ${esc(r.na_reason)}</div>` : ''}
              ${r.gross_error_type ? `<div class="error">${esc(r.gross_error_type)}</div>` : ''}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>
    <details style="margin-top:8px"><summary class="muted">Показать промпт (доказательство, что критерии применяются вживую)</summary>
      <pre style="white-space:pre-wrap;font-size:12px">${esc(ev.prompt)}</pre></details>`;

  el.querySelectorAll('a.evidence').forEach((a) => (a.onclick = () => onEvidence?.(Number(a.dataset.idx))));
}
