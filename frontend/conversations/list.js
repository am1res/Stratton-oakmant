// Conversation list. Owner: P4.
// Job: "which conversations need my attention?" → summary first, gross errors and open appeals
// stand out, the score strip shows which criteria failed without opening the card.
import { api, esc, CHANNEL } from '../common/api.js';
import { stripHtml } from '../common/strip.js';

const state = { lang: '', channel: '', onlyProblems: false, q: '', sort: 'id' };

export async function render(el) {
  const list = await api.conversations();
  const scored = list.filter((c) => c.latest_score !== null);
  const avg = scored.length ? Math.round(scored.reduce((s, c) => s + c.latest_score, 0) / scored.length) : null;
  const gross = list.filter((c) => c.gross_error).length;
  const appeals = list.filter((c) => c.has_open_appeal).length;
  const langs = [...new Set(list.map((c) => c.language))];

  el.innerHTML = `
    <div class="page-head"><h1 class="grow">Диалоги</h1></div>
    <section class="sheet" style="overflow:hidden">
      <div class="stats">
        <div class="stat"><b>${list.length}</b><span>диалогов в наборе</span></div>
        <div class="stat"><b>${scored.length}</b><span>оценено</span></div>
        <div class="stat"><b>${avg ?? '—'}</b><span>средний балл</span></div>
        <div class="stat ${gross ? 'alert' : ''}"><b>${gross}</b><span>с грубыми ошибками</span></div>
        <div class="stat"><b>${appeals}</b><span>с открытой апелляцией</span></div>
        <div class="actions">
          <div class="progress" id="progress" hidden><i style="width:0"></i></div>
          <span class="muted" id="progress-text" aria-live="polite"></span>
          <label class="btn ghost" tabindex="0">Загрузить транскрипт<input type="file" id="upload" accept=".json,application/json" hidden></label>
          <button id="batch">${scored.length ? 'Переоценить все' : 'Оценить все'}</button>
        </div>
      </div>
      <div class="filters">
        <input type="search" id="q" placeholder="Поиск по ID" value="${esc(state.q)}" aria-label="Поиск по ID">
        <select id="lang" aria-label="Язык"><option value="">Все языки</option>${langs.map((l) => `<option ${l === state.lang ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select id="channel" aria-label="Канал"><option value="">Чаты и звонки</option><option value="agent chat" ${state.channel === 'agent chat' ? 'selected' : ''}>Только чаты</option><option value="voice call" ${state.channel === 'voice call' ? 'selected' : ''}>Только звонки</option></select>
        <label class="check"><input type="checkbox" id="problems" ${state.onlyProblems ? 'checked' : ''}> Только требующие внимания</label>
        <select id="sort" aria-label="Сортировка" style="margin-left:auto">
          <option value="id" ${state.sort === 'id' ? 'selected' : ''}>По ID</option>
          <option value="score" ${state.sort === 'score' ? 'selected' : ''}>Сначала низкий балл</option>
        </select>
      </div>
      <table class="grid">
        <thead><tr><th>Диалог</th><th>Язык и канал</th><th>Из чего сложился балл</th><th style="text-align:right">Итог</th><th>Внимание</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <p class="strip-note">Полоса: каждый критерий — отрезок шириной в свой вес, заливка — набранные баллы; штриховка — критерии N/A, их вес отдан остальным.</p>
    </section>`;

  const rows = el.querySelector('#rows');
  const draw = () => {
    let items = list.filter(
      (c) =>
        (!state.lang || c.language === state.lang) &&
        (!state.channel || c.channel === state.channel) &&
        (!state.q || c.conversation_id.toLowerCase().includes(state.q.toLowerCase())) &&
        (!state.onlyProblems || c.gross_error || c.has_open_appeal || (c.latest_score !== null && c.latest_score < 70)),
    );
    if (state.sort === 'score') items = [...items].sort((a, b) => (a.latest_score ?? 999) - (b.latest_score ?? 999));
    rows.innerHTML = items.length
      ? items
          .map(
            (c) => `<tr data-id="${esc(c.conversation_id)}" tabindex="0">
          <td class="id"><a href="#/conversations/${encodeURIComponent(c.conversation_id)}">${esc(c.conversation_id)}</a></td>
          <td><span class="lang">${esc(c.language)}</span><span class="chan">${esc(CHANNEL[c.channel] || c.channel)}</span></td>
          <td class="strip-cell">${c.latest_criteria ? stripHtml(c.latest_criteria) : '<span class="muted">не оценён</span>'}</td>
          <td class="num">${c.latest_score ?? '<span class="muted">—</span>'}</td>
          <td>${[c.gross_error ? '<span class="flag">Грубая ошибка</span>' : '', c.has_open_appeal ? '<span class="flag appeal">Апелляция</span>' : ''].filter(Boolean).join('<br>')}</td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="5" class="empty">Нет диалогов под эти фильтры. <button class="link" id="reset-filters">Сбросить фильтры</button></td></tr>`;
    rows.querySelector('#reset-filters')?.addEventListener('click', () => {
      Object.assign(state, { lang: '', channel: '', onlyProblems: false, q: '' });
      render(el);
    });
  };
  draw();

  rows.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) location.hash = `#/conversations/${encodeURIComponent(tr.dataset.id)}`;
  });
  rows.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && e.key === 'Enter') location.hash = `#/conversations/${encodeURIComponent(tr.dataset.id)}`;
  });
  const bind = (sel, key, prop = 'value') =>
    el.querySelector(sel).addEventListener('input', (e) => {
      state[key] = e.target[prop];
      draw();
    });
  bind('#q', 'q');
  bind('#lang', 'lang');
  bind('#channel', 'channel');
  bind('#sort', 'sort');
  bind('#problems', 'onlyProblems', 'checked');

  el.querySelector('#batch').onclick = async (e) => {
    e.target.disabled = true;
    const ids = list.filter((c) => (!state.lang || c.language === state.lang) && (!state.channel || c.channel === state.channel)).map((c) => c.conversation_id);
    const job = await api.evaluateBatch(ids);
    const bar = el.querySelector('#progress');
    const text = el.querySelector('#progress-text');
    bar.hidden = false;
    const tick = async () => {
      const j = await api.job(job.id);
      bar.firstElementChild.style.width = `${(j.done / j.total) * 100}%`;
      text.textContent = `Оценено ${j.done} из ${j.total}${j.errors.length ? `, не удалось: ${j.errors.length}` : ''}`;
      if (j.status === 'done') setTimeout(() => render(el), 600);
      else setTimeout(tick, 1200);
    };
    tick();
  };

  el.querySelector('#upload').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = el.querySelector('#progress-text');
    try {
      const r = await api.upload(JSON.parse(await file.text()));
      text.textContent = `Добавлено: ${r.added.join(', ')}`;
      setTimeout(() => render(el), 900);
    } catch (err) {
      text.textContent = `Файл не загружен: ${err.message}. Нужен JSON с conversation_id и transcript.`;
    }
  };
}
