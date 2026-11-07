// Conversation card: transcript (left) + evaluation (right). Owner: P4.
// The bot/client exchange before the operator joins is context, not graded, so it is folded
// by default and the handover is marked. Evidence chips highlight messages like a marker pen.
import { api, esc, CHANNEL, SPEAKER } from '../common/api.js';
import { renderResult } from '../results/panel.js';
import { createPlayer } from '../player/player.js';
import { refreshNav } from '../common/app.js';

const HANDOVER = /эскалация на оператора|transferred to an agent|операторға жіберілді|агент присоединился|agent joined/i;

export async function render(el, { id, focus }) {
  const [conv, evals] = await Promise.all([api.conversation(id), api.evaluations(id)]);
  const ev = evals[0] || null;
  const handover = conv.transcript.find((m) => m.speaker === 'system' && HANDOVER.test(m.text));
  const preludeEnd = handover ? handover.msg_index : -1;

  const msg = (m) => `<div class="msg ${esc(m.speaker)}" id="msg-${m.msg_index}" data-offset="${m.offset_sec ?? ''}">
      ${m.speaker === 'system' ? '' : `<div class="who"><b>${esc(SPEAKER[m.speaker] || m.speaker)}</b><span>#${m.msg_index}</span><span>${esc(shortTime(m.timestamp))}</span></div>`}
      ${m.speaker === 'system' ? `#${m.msg_index} ${esc(m.text)}` : esc(m.text)}</div>`;

  const prelude = conv.transcript.filter((m) => m.msg_index < preludeEnd);
  const rest = conv.transcript.filter((m) => m.msg_index > preludeEnd);

  el.innerHTML = `
    <a class="crumb" href="#/conversations">← Все диалоги</a>
    <div class="page-head">
      <h1 class="grow">${esc(conv.conversation_id)}</h1>
      <span class="muted">${esc(conv.language)}, ${esc(CHANNEL[conv.channel] || conv.channel)}, ${conv.transcript.length} реплик</span>
      <button id="run">${ev ? 'Оценить заново' : 'Оценить диалог'}</button>
    </div>
    <div class="card-layout">
      <section class="sheet transcript-wrap" aria-label="Транскрипт">
        <div class="thead"><h2>Транскрипт</h2><span class="muted" style="font-size:12px">оценивается только оператор</span></div>
        <div id="player" style="padding:0 16px"></div>
        <div class="transcript" id="transcript">
          ${prelude.length ? `<button class="ghost prelude-toggle" id="prelude-btn">Показать начало: клиент и бот до оператора, ${prelude.length} реплик</button><div id="prelude" hidden>${prelude.map(msg).join('')}</div>` : ''}
          ${handover ? `<div class="handover" id="msg-${handover.msg_index}">#${handover.msg_index} Подключился оператор</div>` : ''}
          ${rest.map(msg).join('')}
        </div>
      </section>
      <div id="result">${
        ev
          ? ''
          : `<section class="sheet not-rated"><h2>Диалог ещё не оценён</h2><p class="muted">Оценка займёт несколько секунд. Используется текущая версия чек-листа.</p><button id="run2">Оценить диалог</button></section>`
      }</div>
    </div>`;

  const player = conv.audio_url ? createPlayer(el.querySelector('#player'), conv.audio_url) : null;
  const preludeBox = el.querySelector('#prelude');
  el.querySelector('#prelude-btn')?.addEventListener('click', (e) => {
    preludeBox.hidden = !preludeBox.hidden;
    e.target.textContent = preludeBox.hidden ? `Показать начало: клиент и бот до оператора, ${prelude.length} реплик` : 'Скрыть начало';
  });

  function highlight(idxs, first) {
    el.querySelectorAll('.msg.highlight').forEach((n) => n.classList.remove('highlight'));
    if (idxs.some((i) => i < preludeEnd) && preludeBox?.hidden) el.querySelector('#prelude-btn').click();
    idxs.forEach((i) => el.querySelector(`#msg-${i}`)?.classList.add('highlight'));
    const node = el.querySelector(`#msg-${first}`);
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (player && node?.dataset.offset) player.seek(Number(node.dataset.offset));
  }

  if (ev) renderResult(el.querySelector('#result'), ev, { onEvidence: highlight, onChanged: refreshNav, focus });

  const run = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Оцениваю…';
    try {
      await api.evaluate(id);
      render(el, { id });
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Повторить оценку';
      el.querySelector('#result').insertAdjacentHTML('afterbegin', `<p class="error sheet sheet-pad" style="margin-bottom:12px">Оценка не выполнена: ${esc(err.message)}</p>`);
    }
  };
  el.querySelector('#run').onclick = run;
  el.querySelector('#run2')?.addEventListener('click', run);
}

// "2026-11-03T13:49:47.26+00:00" → "13:49:47"; chats keep "01:15"
function shortTime(ts) {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts;
}
