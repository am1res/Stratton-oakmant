// Conversation card: transcript (left) + evaluation (right). Owner: P3.
// - The bot/client exchange before the operator joins is context, not graded: folded by default.
// - Every message has a stable anchor #msg-<index>; #/conversations/<id>?m=<index> opens the card
//   with that message highlighted, ?c=<criterion> opens it focused on a criterion.
// - States: not rated / evaluating (with elapsed time) / failed (with a fix and retry) / result.
// - Calls: the player follows the transcript, and evidence chips seek the audio.
import { api, esc, CHANNEL, SPEAKER, humanError } from '../common/api.js';
import { renderResult } from '../results/panel.js';
import { createPlayer } from '../player/player.js';
import { refreshNav, currentPath } from '../common/app.js';

const HANDOVER = /эскалация на оператора|transferred to an agent|операторға жіберілді|агент присоединился|agent joined/i;

export async function render(el, { id, focus, msg, evaluationId }) {
  const path = currentPath();
  const [conv, evals] = await Promise.all([api.conversation(id), api.evaluations(id)]);
  if (currentPath() !== path) return; // navigated away while loading
  const ev = (evaluationId && evals.find((e) => e.id === evaluationId)) || evals[0] || null;
  const handover = conv.transcript.find((m) => m.speaker === 'system' && HANDOVER.test(m.text));
  const preludeEnd = handover ? handover.msg_index : -1;

  const line = (m) => `<div class="msg ${esc(m.speaker)}" id="msg-${m.msg_index}" data-idx="${m.msg_index}" data-offset="${m.offset_sec ?? ''}">
      ${m.speaker === 'system' ? '' : `<div class="who"><b>${esc(SPEAKER[m.speaker] || m.speaker)}</b><a class="anchor" href="#/conversations/${encodeURIComponent(id)}?m=${m.msg_index}" title="Ссылка на реплику">#${m.msg_index}</a><span>${esc(shortTime(m.timestamp))}</span></div>`}
      ${m.speaker === 'system' ? `#${m.msg_index} ${esc(m.text)}` : esc(m.text)}</div>`;

  const prelude = conv.transcript.filter((m) => m.msg_index < preludeEnd);
  const rest = conv.transcript.filter((m) => m.msg_index > preludeEnd);
  const history = evals.length > 1
    ? `<label class="history">История оценок
        <select id="history">${evals
          .map((e) => `<option value="${esc(e.id)}" ${e.id === ev.id ? 'selected' : ''}>${new Date(e.created_at).toLocaleString('ru-RU')}, v${e.checklist_version}, ${(e.final ?? e.score).total ?? '—'}</option>`)
          .join('')}</select></label>`
    : '';

  el.innerHTML = `
    <a class="crumb" href="#/conversations">← Все диалоги</a>
    <div class="page-head">
      <h1 class="grow">${esc(conv.conversation_id)}</h1>
      <span class="muted">${conv.operator ? `<a href="#/operators/${encodeURIComponent(conv.operator)}">${esc(conv.operator)}</a>${conv.operator_source === 'demo' ? ' (демо)' : ''}, ` : ''}${conv.date ? `${esc(conv.date.slice(8, 10))}.${esc(conv.date.slice(5, 7))}.${esc(conv.date.slice(0, 4))}${conv.date_source === 'demo' ? ' (демо)' : ''}, ` : ''}${esc(conv.language)}, ${esc(CHANNEL[conv.channel] || conv.channel)}, ${conv.transcript.length} реплик</span>
      ${history}
      <button class="ghost" id="print" title="Отчёт по оценке: печать или сохранение в PDF">Печать / PDF</button>
      <button id="run">${ev ? 'Оценить заново' : 'Оценить диалог'}</button>
    </div>
    <div class="card-layout">
      <section class="sheet transcript-wrap" aria-label="Транскрипт">
        <div class="thead"><h2>Транскрипт</h2><span class="muted" style="font-size:12px">оценивается только оператор</span></div>
        <div id="player"></div>
        <div id="voice"></div>
        <div class="transcript" id="transcript">
          ${prelude.length ? `<button class="ghost prelude-toggle" id="prelude-btn">Показать начало: клиент и бот до оператора, ${prelude.length} реплик</button><div id="prelude" hidden>${prelude.map(line).join('')}</div>` : ''}
          ${handover ? `<div class="handover" id="msg-${handover.msg_index}" data-idx="${handover.msg_index}">#${handover.msg_index} Подключился оператор</div>` : ''}
          ${rest.map(line).join('')}
        </div>
      </section>
      <div id="result"></div>
    </div>`;

  const result = el.querySelector('#result');
  const runBtn = el.querySelector('#run');
  const preludeBox = el.querySelector('#prelude');
  const preludeBtn = el.querySelector('#prelude-btn');
  const transcript = el.querySelector('#transcript');

  const togglePrelude = (show) => {
    if (!preludeBox) return;
    preludeBox.hidden = !show;
    preludeBtn.textContent = show ? 'Скрыть начало' : `Показать начало: клиент и бот до оператора, ${prelude.length} реплик`;
  };
  preludeBtn?.addEventListener('click', () => togglePrelude(preludeBox.hidden));

  // ---- audio: follows the transcript while playing ----
  const player = conv.audio_url
    ? createPlayer(el.querySelector('#player'), conv.audio_url, {
        onTime: (sec) => {
          const nodes = [...transcript.querySelectorAll('.msg[data-offset]:not([data-offset=""])')];
          let current = null;
          for (const n of nodes) if (Number(n.dataset.offset) <= sec + 0.5) current = n;
          transcript.querySelectorAll('.msg.playing').forEach((n) => n !== current && n.classList.remove('playing'));
          if (current && !current.classList.contains('playing')) {
            current.classList.add('playing');
            if (Number(current.dataset.idx) < preludeEnd) togglePrelude(true);
            if (player.following()) current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        },
      })
    : null;

  function highlight(idxs, first) {
    el.querySelectorAll('.msg.highlight, .handover.highlight').forEach((n) => n.classList.remove('highlight'));
    if (idxs.some((i) => i < preludeEnd)) togglePrelude(true);
    idxs.forEach((i) => el.querySelector(`#msg-${i}`)?.classList.add('highlight'));
    const node = el.querySelector(`#msg-${first}`);
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (player && node?.dataset.offset) player.seek(Number(node.dataset.offset));
  }

  // ---- result area states ----
  const showResult = (e) => renderResult(result, e, { onEvidence: highlight, onChanged: refreshNav, focus });
  const showNotRated = () => {
    result.innerHTML = `<section class="sheet state-box"><h2>Диалог ещё не оценён</h2>
      <p class="muted">Оценка занимает 10–30 секунд. Будет использована текущая версия чек-листа.</p>
      <p><button data-run>Оценить диалог</button></p></section>`;
    result.querySelector('[data-run]').onclick = run;
  };
  const showRunning = () => {
    const started = Date.now();
    result.innerHTML = `<section class="sheet state-box" aria-live="polite" aria-busy="true">
      <div class="spinner" aria-hidden="true"></div>
      <h2>Модель оценивает диалог</h2>
      <p class="muted"><span data-elapsed>0</span> с. Обычно это 10–30 секунд; можно перейти к другому диалогу, оценка сохранится.</p></section>`;
    const t = setInterval(() => {
      const n = result.querySelector('[data-elapsed]');
      if (!n) return clearInterval(t);
      n.textContent = Math.round((Date.now() - started) / 1000);
    }, 1000);
    return () => clearInterval(t);
  };
  const showFailed = (err, previous) => {
    result.innerHTML = `<section class="sheet state-box error-box" role="alert">
      <h2>Оценка не выполнена</h2>
      <p>${esc(humanError(err))}</p>
      <p><button data-run>Повторить оценку</button>${previous ? ' <button class="ghost" data-prev>Показать прошлую оценку</button>' : ''}</p></section>`;
    result.querySelector('[data-run]').onclick = run;
    result.querySelector('[data-prev]')?.addEventListener('click', () => showResult(previous));
  };

  async function run() {
    runBtn.disabled = true;
    runBtn.textContent = 'Оцениваю…';
    const stop = showRunning();
    try {
      const fresh = await api.evaluate(id);
      stop();
      if (currentPath() !== path) return;
      refreshNav();
      render(el, { id, evaluationId: fresh.id });
    } catch (err) {
      stop();
      if (currentPath() !== path) return;
      runBtn.disabled = false;
      runBtn.textContent = ev ? 'Оценить заново' : 'Оценить диалог';
      showFailed(err, ev);
    }
  }
  runBtn.onclick = run;
  el.querySelector('#print').onclick = () => {
    togglePrelude(true);
    el.querySelectorAll('details.prompt').forEach((d) => (d.open = false));
    window.print();
  };
  el.querySelector('#history')?.addEventListener('change', (e) => render(el, { id, evaluationId: e.target.value }));

  if (ev) showResult(ev);
  else showNotRated();

  // ---- voice analysis (calls only): a hint for the reviewer, not part of the score ----
  if (conv.channel === 'voice call') {
    api
      .voice(id)
      .then((v) => {
        if (currentPath() !== path) return;
        renderVoice(el.querySelector('#voice'), v, (i) => highlight([i], i));
      })
      .catch(() => {});
  }

  // deep link to a message
  if (msg !== null && msg !== undefined && msg !== '') {
    const i = Number(msg);
    if (Number.isInteger(i)) setTimeout(() => highlight([i], i), 50);
  }
}

const VOICE_OVERALL = {
  ok: ['pass', 'Тон в норме'],
  possible_issue: ['partial', 'Возможна проблема с тоном'],
  clear_issue: ['fail', 'Проблема с тоном'],
};
const CUE = { sigh: 'вздох', sarcasm: 'сарказм', flat: 'холодный / безучастный тон', mocking_stress: 'насмешливое ударение', laugh: 'смешок', interrupt: 'перебивает', rude_words: 'грубые слова', other: 'другое' };
const NOTE = { apology_after_interrupt: 'извинился, что перебил', apology_other: 'извинился', empathy: 'эмпатия', other: 'заметка' };

function renderVoice(box, v, onJump) {
  if (!box) return;
  if (!v?.available) {
    box.innerHTML = `<details class="voice"><summary>Анализ голоса: нет данных</summary>
      <p class="muted">Запустите <code>python3 voice/to_gemini.py data/dev.json --out voice/out</code>, затем обновите страницу.</p></details>`;
    return;
  }
  const [cls, title] = VOICE_OVERALL[v.overall] || ['na', v.overall];
  const item = (x, label, kind) =>
    `<li class="${kind}">${x.msg_index !== null ? `<button class="ev" data-jump="${x.msg_index}" title="Перейти к реплике и включить запись">#${x.msg_index}</button>` : `<span class="muted">${esc(x.heard_at || x.time || '')}</span>`}
      <b>${esc(label)}</b>${x.label === 'clear' ? ' <span class="v fail">явно</span>' : x.label === 'possible' ? ' <span class="v partial">возможно</span>' : ''}
      <span class="crit-why">${esc(x.reason)}</span></li>`;
  box.innerHTML = `<details class="voice" ${v.flags.length ? 'open' : ''}>
      <summary><span class="v ${cls}">${esc(title)}</span> Анализ голоса оператора <span class="muted">подсказка для проверяющего, на балл не влияет</span></summary>
      <p class="crit-why">${esc(v.summary)}</p>
      ${v.flags.length ? `<ul class="voice-list">${v.flags.map((f) => item(f, CUE[f.cue] || f.cue, 'flag-item')).join('')}</ul>` : ''}
      ${v.notes.length ? `<ul class="voice-list">${v.notes.map((n) => item(n, NOTE[n.kind] || n.kind, 'note-item')).join('')}</ul>` : ''}
      <p class="muted voice-meta">${esc(v.model || '')}${v.audio_only ? ', только аудио' : ''}${v.cost_usd ? `, $${Number(v.cost_usd).toFixed(4)}` : ''}</p>
    </details>`;
  box.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => onJump(Number(b.dataset.jump))));
}

// "2026-11-03T13:49:47.26+00:00" → "13:49:47"; chats keep "01:15"
function shortTime(ts) {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts;
}
