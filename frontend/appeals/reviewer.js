// Reviewer screen. Owner: P4.
// Reviewer sees the disputed score, comment and dialogue fragment; can ask for an AI second
// opinion; confirms or changes the score with a reason. The backend recalculates the total.
// TODO(P4): show the dialogue fragment with more context, history of decided appeals.
import { api, esc, fmtAnswer } from '../common/api.js';

export async function render(el) {
  const appeals = await api.appeals();
  if (!appeals.length) {
    el.innerHTML = '<h2>Апелляции</h2><p class="muted">Пока нет апелляций.</p>';
    return;
  }
  el.innerHTML = `<h2>Апелляции</h2><div id="list"></div>`;
  const list = el.querySelector('#list');

  for (const ap of appeals) {
    const [ev, conv] = await Promise.all([api.evaluation(ap.evaluation_id), api.conversation(ap.conversation_id)]);
    const crit = ev.checklist_snapshot.criteria.find((c) => c.id === ap.criterion_id);
    const options =
      crit.type === 'scale'
        ? crit.scale.map((s) => s.value)
        : ['yes', 'no'];
    if (crit.na_allowed) options.push('na');
    const frag = conv.transcript.filter((m) => (ap.original.evidence_msg_indices || []).includes(m.msg_index));

    const box = document.createElement('div');
    box.className = 'panel';
    box.style.marginBottom = '12px';
    box.innerHTML = `
      <div style="display:flex;gap:8px;align-items:baseline">
        <strong>${esc(ap.conversation_id)} · ${esc(crit.id)} ${esc(crit.name)}</strong>
        <span class="badge">${esc(ap.status)}</span>
        <a href="#/conversations/${encodeURIComponent(ap.conversation_id)}" style="margin-left:auto">открыть карточку</a>
      </div>
      <p>Исходная оценка: <strong>${fmtAnswer(ap.original.answer)}</strong>, ${esc(ap.original.explanation)}</p>
      <p>Комментарий: «${esc(ap.comment)}»</p>
      ${frag.map((m) => `<div class="msg ${esc(m.speaker)}"><div class="meta">#${m.msg_index} · ${esc(m.speaker)}</div>${esc(m.text)}</div>`).join('')}
      <div class="ai">${ap.ai_suggestion ? `<p>🤖 Второе мнение ИИ: <strong>${fmtAnswer(ap.ai_suggestion.answer)}</strong>, ${esc(ap.ai_suggestion.explanation)}</p>` : ''}</div>
      ${
        ap.reviewer_decision
          ? `<p>Решение: <strong>${fmtAnswer(ap.reviewer_decision.answer)}</strong>, ${esc(ap.reviewer_decision.reason)}. Итог: ${ev.score.total} → <strong>${ev.final?.total ?? '—'}</strong></p>`
          : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
              <button class="secondary" data-act="suggest">Второе мнение ИИ</button>
              <select data-f="answer">${options.map((o) => `<option value="${o}" ${o === ap.original.answer ? 'selected' : ''}>${fmtAnswer(o)}</option>`).join('')}</select>
              <input data-f="reason" placeholder="Причина решения" style="flex:1;min-width:200px">
              <button data-act="decide">Сохранить решение</button>
            </div><p class="error" data-f="err"></p>`
      }`;
    list.appendChild(box);

    box.querySelector('[data-act="suggest"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Думаю…';
      try {
        await api.suggest(ap.id);
        render(el);
      } catch (err) {
        box.querySelector('[data-f="err"]').textContent = err.message;
      }
    });
    box.querySelector('[data-act="decide"]')?.addEventListener('click', async () => {
      try {
        await api.decide(ap.id, box.querySelector('[data-f="answer"]').value, box.querySelector('[data-f="reason"]').value);
        render(el);
      } catch (err) {
        box.querySelector('[data-f="err"]').textContent = err.message;
      }
    });
  }
}
