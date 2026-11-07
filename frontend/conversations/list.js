// Conversation list + batch run. Owner: P4.
// TODO(P4): filters (language, channel, score, appeal status), sorting.
import { api, esc } from '../common/api.js';

export async function render(el) {
  const list = await api.conversations();
  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
      <h2 style="margin:0 auto 0 0">Диалоги (${list.length})</h2>
      <span id="progress" class="muted"></span>
      <label class="secondary" style="cursor:pointer"><input type="file" id="upload" accept=".json" hidden><span class="badge">Загрузить транскрипт</span></label>
      <button id="batch">Оценить все</button>
    </div>
    <table>
      <thead><tr><th>ID</th><th>Канал</th><th>Язык</th><th>Реплик</th><th>Итог</th><th>Грубые</th><th>Апелляция</th></tr></thead>
      <tbody>${list
        .map(
          (c) => `<tr>
            <td><a href="#/conversations/${encodeURIComponent(c.conversation_id)}">${esc(c.conversation_id)}</a></td>
            <td>${esc(c.channel)}</td><td>${esc(c.language)}</td><td>${c.messages}</td>
            <td>${c.latest_score ?? '<span class="muted">—</span>'}</td>
            <td>${c.gross_error ? '<span class="badge gross">да</span>' : ''}</td>
            <td>${c.has_open_appeal ? '<span class="badge">открыта</span>' : ''}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>`;

  el.querySelector('#batch').onclick = async (e) => {
    e.target.disabled = true;
    const job = await api.evaluateBatch();
    const p = el.querySelector('#progress');
    const tick = async () => {
      const j = await api.job(job.id);
      p.textContent = `Оценено ${j.done}/${j.total}${j.errors.length ? `, ошибок: ${j.errors.length}` : ''}`;
      if (j.status === 'done') render(el);
      else setTimeout(tick, 1500);
    };
    tick();
  };

  el.querySelector('#upload').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const r = await api.upload(JSON.parse(await file.text()));
      alert(`Загружено: ${r.added.join(', ')}`);
      render(el);
    } catch (err) {
      alert(err.message);
    }
  };
}
