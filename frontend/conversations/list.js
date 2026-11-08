// Conversation list. Owner: P3.
// Job: "which conversations need my attention?" → summary first, gross errors and open appeals
// stand out, the score strip shows which criteria failed without opening the card.
import { api, esc, CHANNEL, humanError } from '../common/api.js';
import { currentPath } from '../common/app.js';
import { exportAllCsv } from '../analytics/dashboard.js';
import { stripHtml } from '../common/strip.js';

const state = { lang: '', channel: '', onlyProblems: false, onlyUnsure: false, q: '', sort: 'id' };
let activeJob = null; // survives re-renders, so leaving the page doesn't lose batch progress
let lastFailures = [];

export async function render(el) {
  const list = await api.conversations();
  if (!list.length) return renderEmpty(el);
  const scored = list.filter((c) => c.latest_score !== null);
  const langs = [...new Set(list.map((c) => c.language))];

  el.innerHTML = `
    <div class="page-head"><h1 class="grow">Диалоги</h1></div>
    <section class="sheet" style="overflow:hidden">
      <div class="stats">
        <div id="stat-nums" style="display:contents"></div>
        <div class="actions">
          <div class="progress" id="progress" hidden><i style="width:0"></i></div>
          <span class="muted" id="progress-text" aria-live="polite"></span>
          <button class="ghost" id="csv">Скачать CSV</button>
          <a class="btn ghost" id="export-json" href="/api/export?download=1" title="Результаты в формате сдачи организаторам (schema 1.0)">Скачать JSON для сдачи</a>
          <label class="btn ghost" tabindex="0">Загрузить транскрипт<input type="file" id="upload" accept=".json,application/json" hidden></label>
          ${scored.length ? '<button class="ghost" id="batch-new" title="Пропустить диалоги, уже оценённые текущей версией чек-листа">Оценить неоценённые</button>' : ''}
          <button id="batch">${scored.length ? 'Переоценить все' : 'Оценить все'}</button>
        </div>
      </div>
      <div id="failures"></div>
      <div class="filters">
        <input type="search" id="q" placeholder="Поиск по ID" value="${esc(state.q)}" aria-label="Поиск по ID">
        <select id="lang" aria-label="Язык"><option value="">Все языки</option>${langs.map((l) => `<option ${l === state.lang ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select id="channel" aria-label="Канал"><option value="">Чаты и звонки</option><option value="agent chat" ${state.channel === 'agent chat' ? 'selected' : ''}>Только чаты</option><option value="voice call" ${state.channel === 'voice call' ? 'selected' : ''}>Только звонки</option></select>
        <label class="check"><input type="checkbox" id="problems" ${state.onlyProblems ? 'checked' : ''}> Только требующие внимания</label>
        <label class="check"><input type="checkbox" id="unsure" ${state.onlyUnsure ? 'checked' : ''}> ИИ не уверен</label>
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
  // Summary numbers follow the filters (language, channel, search, checkboxes).
  const drawStats = (items) => {
    const sc = items.filter((c) => c.latest_score !== null);
    const avg = sc.length ? Math.round(sc.reduce((s, c) => s + c.latest_score, 0) / sc.length) : null;
    const gross = items.filter((c) => c.gross_error).length;
    const appeals = items.filter((c) => c.has_open_appeal).length;
    const filtered = items.length !== list.length;
    el.querySelector('#stat-nums').innerHTML = `
        <div class="stat"><b>${filtered ? `${items.length} <small class="muted">из ${list.length}</small>` : list.length}</b><span>${filtered ? 'диалогов под фильтром' : 'диалогов в наборе'}</span></div>
        <div class="stat"><b>${sc.length}</b><span>оценено</span></div>
        <div class="stat"><b>${avg ?? '—'}</b><span>средний балл</span></div>
        <div class="stat ${gross ? 'alert' : ''}"><b>${gross}</b><span>с грубыми ошибками</span></div>
        <div class="stat"><b>${appeals}</b><span>с открытой апелляцией</span></div>`;
  };
  const draw = () => {
    let items = list.filter(
      (c) =>
        (!state.lang || c.language === state.lang) &&
        (!state.channel || c.channel === state.channel) &&
        (!state.q || c.conversation_id.toLowerCase().includes(state.q.toLowerCase())) &&
        (!state.onlyProblems || c.gross_error || c.has_open_appeal || c.low_confidence || (c.latest_score !== null && c.latest_score < 70)) &&
        (!state.onlyUnsure || c.low_confidence),
    );
    if (state.sort === 'score') items = [...items].sort((a, b) => (a.latest_score ?? 999) - (b.latest_score ?? 999));
    drawStats(items);
    rows.innerHTML = items.length
      ? items
          .map(
            (c) => `<tr data-id="${esc(c.conversation_id)}" tabindex="0">
          <td class="id"><a href="#/conversations/${encodeURIComponent(c.conversation_id)}">${esc(c.conversation_id)}</a>${c.operator ? `<span class="op-meta">${esc(c.operator)}${c.date ? `, ${esc(c.date.slice(8, 10))}.${esc(c.date.slice(5, 7))}` : ''}${c.operator_source === 'demo' || c.date_source === 'demo' ? ' (демо)' : ''}</span>` : ''}</td>
          <td><span class="lang">${esc(c.language)}</span><span class="chan">${esc(CHANNEL[c.channel] || c.channel)}</span></td>
          <td class="strip-cell">${c.latest_criteria ? stripHtml(c.latest_criteria) : '<span class="muted">не оценён</span>'}</td>
          <td class="num">${c.latest_score ?? '<span class="muted">—</span>'}</td>
          <td>${[c.gross_error ? '<span class="flag">Грубая ошибка</span>' : '', c.has_open_appeal ? '<span class="flag appeal">Апелляция</span>' : '', c.low_confidence ? '<span class="flag unsure" title="Модели разошлись в ответах: стоит проверить вручную">Проверить вручную</span>' : ''].filter(Boolean).join('<br>')}</td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="5" class="empty">Нет диалогов под эти фильтры. <button class="link" id="reset-filters">Сбросить фильтры</button></td></tr>`;
    rows.querySelector('#reset-filters')?.addEventListener('click', () => {
      Object.assign(state, { lang: '', channel: '', onlyProblems: false, onlyUnsure: false, q: '' });
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
  bind('#unsure', 'onlyUnsure', 'checked');
  el.querySelector('#csv').onclick = async () => {
    try {
      await exportAllCsv();
    } catch (err) {
      el.querySelector('#progress-text').textContent = humanError(err);
    }
  };

  const batchBtn = el.querySelector('#batch');
  const bar = el.querySelector('#progress');
  const text = el.querySelector('#progress-text');
  const path = currentPath();

  const showFailures = () => {
    const box = el.querySelector('#failures');
    if (!lastFailures.length) return (box.innerHTML = '');
    box.innerHTML = `<div class="fail-box" role="alert">
      <p><strong>Не удалось оценить ${lastFailures.length}:</strong> ${lastFailures.map((f) => esc(f.conversation_id)).join(', ')}</p>
      <p class="muted">${esc(humanError({ message: lastFailures[0].error }))}</p>
      <p><button data-retry>Повторить для них</button></p></div>`;
    box.querySelector('[data-retry]').onclick = () => startJob(lastFailures.map((f) => f.conversation_id));
  };

  const poll = async () => {
    if (currentPath() !== path) return; // keep activeJob; polling resumes when the list is opened again
    try {
      const j = await api.job(activeJob.id);
      if (currentPath() !== path) return; // user opened another page while we waited: don't touch it
      bar.hidden = false;
      bar.firstElementChild.style.width = `${j.total ? (j.done / j.total) * 100 : 100}%`;
      text.textContent = `Оценено ${j.done} из ${j.total}${j.skipped ? `, пропущено уже оценённых: ${j.skipped}` : ''}${j.errors.length ? `, не удалось: ${j.errors.length}` : ''}`;
      batchBtn.disabled = true;
      if (j.status === 'done') {
        activeJob = null;
        lastFailures = j.errors;
        // re-render the list only if the user is still on it (it used to overwrite an open card)
        setTimeout(() => currentPath() === path && render(el), 500);
      } else setTimeout(poll, 1200);
    } catch (err) {
      text.textContent = `Прогресс недоступен: ${humanError(err)}`;
      activeJob = null;
      batchBtn.disabled = false;
    }
  };

  async function startJob(ids, skipDone = false) {
    batchBtn.disabled = true;
    lastFailures = [];
    showFailures();
    try {
      const job = await api.evaluateBatch(ids, skipDone);
      if (!job.total) {
        // nothing to do: say so and keep the message (no re-render that would erase it)
        text.textContent = `Всё уже оценено текущей версией чек-листа (пропущено: ${job.skipped}). Чтобы оценить заново, нажмите «Переоценить все».`;
        batchBtn.disabled = false;
        return;
      }
      activeJob = job;
      poll();
    } catch (err) {
      batchBtn.disabled = false;
      text.textContent = `Не запущено: ${humanError(err)}`;
    }
  }

  const visibleIds = () => list.filter((c) => (!state.lang || c.language === state.lang) && (!state.channel || c.channel === state.channel)).map((c) => c.conversation_id);
  batchBtn.onclick = () => startJob(visibleIds());
  const newBtn = el.querySelector('#batch-new');
  if (newBtn) newBtn.onclick = () => startJob(visibleIds(), true);
  if (activeJob) poll();
  showFailures();

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

function renderEmpty(el) {
  el.innerHTML = `
    <div class="page-head"><h1 class="grow">Диалоги</h1></div>
    <section class="sheet state-box">
      <h2>Диалоги не загружены</h2>
      <p class="muted">Сервер не смог получить данные организаторов. Проверьте CQA_API_BASE в .env (ссылка без &amp;group_id=…) или положите файл в data/dev.json и укажите CQA_DATA_FILE=data/dev.json.</p>
      <p><button id="reload">Загрузить данные заново</button> <label class="btn ghost" tabindex="0">Загрузить транскрипт из файла<input type="file" id="upload-empty" accept=".json,application/json" hidden></label></p>
      <p class="error" id="empty-msg" aria-live="polite"></p>
    </section>`;
  el.querySelector('#reload').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api.reloadData();
      if (r.count) render(el);
      else el.querySelector('#empty-msg').textContent = 'Данных по-прежнему нет.';
    } catch (err) {
      el.querySelector('#empty-msg').textContent = humanError(err);
    }
    e.target.disabled = false;
  };
  el.querySelector('#upload-empty').onchange = async (e) => {
    try {
      await api.upload(JSON.parse(await e.target.files[0].text()));
      render(el);
    } catch (err) {
      el.querySelector('#empty-msg').textContent = `Файл не загружен: ${humanError(err)}`;
    }
  };
}
