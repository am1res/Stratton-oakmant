// Reviewer screen. Owner: P4.
// The reviewer compares three things side by side: the original grade, the appeal with the
// disputed fragment, and an optional AI second opinion. The decision is always the reviewer's.
import { api, esc, fmtAnswer, APPEAL_STATUS, SPEAKER } from '../common/api.js';
import { refreshNav } from '../common/app.js';
import { computeScore } from '/shared/scoring.js';

let tab = 'open';

export async function render(el) {
  const all = await api.appeals();
  const open = all.filter((a) => a.status === 'open');
  const done = all.filter((a) => a.status !== 'open');
  const list = tab === 'open' ? open : done;

  el.innerHTML = `
    <div class="page-head">
      <h1 class="grow">Апелляции</h1>
      <div class="seg" role="group" aria-label="Фильтр">
        <button aria-pressed="${tab === 'open'}" data-tab="open">Ждут решения (${open.length})</button>
        <button aria-pressed="${tab === 'done'}" data-tab="done">Решённые (${done.length})</button>
      </div>
    </div>
    <section class="sheet" id="list">${
      list.length
        ? ''
        : `<div class="empty">${tab === 'open' ? 'Нет апелляций, ожидающих решения. Оспорить оценку можно в карточке диалога, кнопкой «Оспорить» у критерия.' : 'Решённых апелляций пока нет.'}</div>`
    }</section>`;
  el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => ((tab = b.dataset.tab), render(el))));

  const box = el.querySelector('#list');
  const blocks = await Promise.all(list.map((ap) => block(ap)));
  blocks.forEach((b) => box.appendChild(b));

  async function block(ap) {
    const [ev, conv] = await Promise.all([api.evaluation(ap.evaluation_id), api.conversation(ap.conversation_id)]);
    const crit = ev.checklist_snapshot.criteria.find((c) => c.id === ap.criterion_id);
    const options = crit.type === 'scale' ? crit.scale.map((s) => s.value) : ['yes', 'no'];
    if (crit.na_allowed) options.push('na');
    const frag = conv.transcript.filter((m) => (ap.original.evidence_msg_indices || []).includes(m.msg_index));
    const label = (o) => (crit.type === 'flag' ? (o === 'yes' ? 'Есть нарушение' : 'Нет нарушения') : fmtAnswer(o));

    const node = document.createElement('article');
    node.className = 'appeal';
    node.innerHTML = `
      <div class="appeal-head">
        <h2 class="grow">${esc(crit.id)} ${esc(crit.name)}</h2>
        <a href="#/conversations/${encodeURIComponent(ap.conversation_id)}?c=${encodeURIComponent(crit.id)}">Диалог ${esc(ap.conversation_id)}</a>
        <span class="muted">${new Date(ap.created_at).toLocaleString('ru-RU')}</span>
      </div>
      <div class="compare">
        <div>
          <h4>Оценка системы</h4>
          <div><span class="v ${cls(crit, ap.original.answer)}">${esc(label(ap.original.answer))}</span></div>
          <p>${esc(ap.original.explanation)}</p>
        </div>
        <div>
          <h4>Апелляция</h4>
          <p class="quote">${esc(ap.comment)}</p>
          ${frag.map((m) => `<p style="font-size:13px"><span class="muted">#${m.msg_index} ${esc(SPEAKER[m.speaker] || m.speaker)}:</span> ${esc(m.text)}</p>`).join('')}
        </div>
        <div>
          <h4>Второе мнение ИИ</h4>
          ${
            ap.ai_suggestion
              ? `<div><span class="v ${cls(crit, ap.ai_suggestion.answer)}">${esc(label(ap.ai_suggestion.answer))}</span></div><p>${esc(ap.ai_suggestion.explanation)}</p>`
              : ap.status === 'open'
                ? `<p class="muted">Модель заново оценит только этот критерий с учётом комментария.</p><div><button class="ghost" data-suggest>Запросить второе мнение</button></div>`
                : '<p class="muted">Не запрашивалось.</p>'
          }
        </div>
      </div>
      ${
        ap.reviewer_decision
          ? `<p><strong>${esc(APPEAL_STATUS[ap.status])}:</strong> ${esc(label(ap.reviewer_decision.answer))}. ${esc(ap.reviewer_decision.reason)}<br>
             <span class="muted">Итог диалога: ${ev.score.total ?? '—'} → ${ev.final?.total ?? '—'}</span></p>`
          : `<div class="decision">
              <div class="seg" role="group" aria-label="Решение">${options
                .map((o) => `<button type="button" data-answer="${o}" aria-pressed="${o === ap.original.answer}">${esc(label(o))}</button>`)
                .join('')}</div>
              <input data-reason placeholder="Причина решения (видна в карточке диалога)" aria-label="Причина решения">
              <button data-decide>Сохранить решение</button>
            </div>
            <p class="preview-total" data-preview aria-live="polite"></p>
            <p class="error" data-err aria-live="polite"></p>`
      }`;

    let chosen = ap.original.answer;
    // Preview of the total before saving: current answers (with earlier decisions) + this choice
    const base = Object.fromEntries(ev.criteria.map((r) => [r.criterion_id, ev.final?.overrides?.[r.criterion_id]?.answer ?? r.answer]));
    const fmt = (x) => (x === null ? '—' : String(x).replace('.', ','));
    const nowTotal = computeScore(ev.checklist_snapshot, base).total;
    const preview = () => {
      const p = node.querySelector('[data-preview]');
      if (!p) return;
      const next = computeScore(ev.checklist_snapshot, { ...base, [crit.id]: chosen }).total;
      p.textContent = next === nowTotal
        ? `Итог диалога не изменится: ${fmt(nowTotal)}.`
        : `После решения итог пересчитается: ${fmt(nowTotal)} → ${fmt(next)}. Исходная оценка останется в карточке.`;
    };
    node.querySelectorAll('[data-answer]').forEach((b) =>
      b.addEventListener('click', () => {
        chosen = isNaN(Number(b.dataset.answer)) ? b.dataset.answer : Number(b.dataset.answer);
        node.querySelectorAll('[data-answer]').forEach((x) => x.setAttribute('aria-pressed', x === b));
        node.querySelector('[data-decide]').textContent = chosen === ap.original.answer ? 'Подтвердить оценку' : 'Изменить оценку';
        preview();
      }),
    );
    if (node.querySelector('[data-decide]')) node.querySelector('[data-decide]').textContent = 'Подтвердить оценку';
    preview();

    node.querySelector('[data-suggest]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Модель думает…';
      try {
        await api.suggest(ap.id);
        render(el);
      } catch (err) {
        node.querySelector('[data-err]').textContent = `Второе мнение не получено: ${err.message}`;
        e.target.disabled = false;
        e.target.textContent = 'Запросить второе мнение';
      }
    });
    node.querySelector('[data-decide]')?.addEventListener('click', async () => {
      const reason = node.querySelector('[data-reason]').value;
      if (!reason.trim()) {
        node.querySelector('[data-err]').textContent = 'Укажите причину решения.';
        return node.querySelector('[data-reason]').focus();
      }
      try {
        await api.decide(ap.id, chosen, reason);
        refreshNav();
        render(el);
      } catch (err) {
        node.querySelector('[data-err]').textContent = err.message;
      }
    });
    return node;
  }
}

function cls(c, a) {
  if (a === 'na') return 'na';
  if (c.type === 'flag') return a === 'yes' ? 'gross' : 'pass';
  if (c.type === 'binary') return a === 'yes' ? 'pass' : 'fail';
  const max = Math.max(...c.scale.map((s) => s.value));
  return a >= max ? 'pass' : a <= 0 ? 'fail' : 'partial';
}
