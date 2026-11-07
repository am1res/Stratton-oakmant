// Conversation card: transcript (left) + evaluation result (right). Owner: P4.
// Evidence links call highlight(msg_index): scroll + highlight, and seek the audio for calls.
import { api, esc } from '../common/api.js';
import { renderResult } from '../results/panel.js';
import { createPlayer } from '../player/player.js';
import { renderAppealForm } from '../appeals/form.js';

export async function render(el, { id }) {
  const [conv, evals] = await Promise.all([api.conversation(id), api.evaluations(id)]);
  const ev = evals[0] || null;

  el.innerHTML = `
    <p><a href="#/conversations">← Все диалоги</a></p>
    <h2>${esc(conv.conversation_id)} <span class="muted">· ${esc(conv.channel)} · ${esc(conv.language)}</span></h2>
    <div class="split">
      <div class="panel">
        <div id="player"></div>
        <div class="transcript" id="transcript">${conv.transcript
          .map(
            (m) => `<div class="msg ${esc(m.speaker)}" id="msg-${m.msg_index}" data-offset="${m.offset_sec ?? ''}">
              <div class="meta">#${m.msg_index} · ${esc(m.timestamp)} · ${esc(m.speaker)}</div>${esc(m.text)}</div>`,
          )
          .join('')}</div>
      </div>
      <div>
        <div class="panel" style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
          <button id="run">${ev ? 'Переоценить' : 'Оценить'}</button>
          <span class="muted" id="runinfo">${ev ? `оценено ${new Date(ev.created_at).toLocaleString()} · чек-лист v${ev.checklist_version} · ${esc(ev.model)}` : 'ещё не оценён'}</span>
        </div>
        <div id="result"></div>
        <div id="appeal"></div>
      </div>
    </div>`;

  const player = conv.audio_url ? createPlayer(el.querySelector('#player'), conv.audio_url) : null;

  function highlight(idx) {
    el.querySelectorAll('.msg.highlight').forEach((n) => n.classList.remove('highlight'));
    const node = el.querySelector(`#msg-${idx}`);
    if (!node) return;
    node.classList.add('highlight');
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (player && node.dataset.offset !== '') player.seek(Number(node.dataset.offset));
  }

  if (ev) {
    renderResult(el.querySelector('#result'), ev, { onEvidence: highlight });
    renderAppealForm(el.querySelector('#appeal'), ev, () => render(el, { id }));
  }

  el.querySelector('#run').onclick = async (e) => {
    e.target.disabled = true;
    el.querySelector('#runinfo').textContent = 'Оценка выполняется…';
    try {
      await api.evaluate(id);
      render(el, { id });
    } catch (err) {
      el.querySelector('#runinfo').textContent = err.message;
      e.target.disabled = false;
    }
  };
}
