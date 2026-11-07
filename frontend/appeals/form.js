// "Оспорить" form inside the conversation card. Owner: P4.
import { api, esc, fmtAnswer } from '../common/api.js';

export function renderAppealForm(el, ev, onDone) {
  const names = Object.fromEntries(ev.checklist_snapshot.criteria.map((c) => [c.id, c.name]));
  el.innerHTML = `
    <div class="panel" style="margin-top:12px">
      <h3 style="margin-top:0">Апелляция</h3>
      <select id="crit">${ev.criteria
        .map((r) => `<option value="${esc(r.criterion_id)}">${esc(r.criterion_id)} ${esc(names[r.criterion_id])} (${fmtAnswer(r.answer)})</option>`)
        .join('')}</select>
      <textarea id="comment" rows="3" style="width:100%;margin:8px 0" placeholder="Почему вы не согласны с оценкой?"></textarea>
      <button id="send">Подать апелляцию</button> <span id="msg" class="muted"></span>
    </div>`;
  el.querySelector('#send').onclick = async () => {
    try {
      await api.createAppeal(ev.id, el.querySelector('#crit').value, el.querySelector('#comment').value);
      el.querySelector('#msg').textContent = 'Апелляция подана. Её видит проверяющий в разделе «Апелляции».';
      onDone?.();
    } catch (e) {
      el.querySelector('#msg').textContent = e.message;
    }
  };
}
