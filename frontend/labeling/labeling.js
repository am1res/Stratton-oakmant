// Blind labeling. Owner: P4 (QA).
// A reviewer grades a conversation against the checklist WITHOUT seeing the AI's answers, the
// score or other reviewers' labels. Two reviewers per conversation: where they agree, that answer
// becomes the reference for the AI-accuracy panel; where they disagree, the cell is reported as
// disputed and left out. Labels never change any evaluation or score.
import { api, esc, SPEAKER, humanError } from '../common/api.js';
import { currentPath } from '../common/app.js';

const KEY = 'cqa.reviewer';
const getName = () => {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
};
const setName = (v) => {
  try {
    localStorage.setItem(KEY, v);
  } catch {}
};

export async function render(el, { id } = {}) {
  const path = currentPath();
  const reviewer = getName();
  const [convs, checklist, labels] = await Promise.all([api.conversations(), api.checklist(), api.labels(reviewer)]);
  if (currentPath() !== path) return;
  const mine = Object.fromEntries(labels.mine.map((l) => [l.conversation_id, l]));
  const todo = convs.filter((c) => !mine[c.conversation_id]);
  const current = id ? convs.find((c) => c.conversation_id === id) : null;

  el.innerHTML = `
    <div class="page-head">
      <div class="grow"><h1>Разметка вслепую</h1>
        <p class="muted">Оцените диалог по чек-листу сами, не видя ответа ИИ. Ответы двух проверяющих сравниваются: совпавшие становятся эталоном для проверки точности ИИ, расхождения показываются отдельно. На оценки и баллы разметка не влияет.</p></div>
      <label class="field">Ваше имя<input id="who" value="${esc(reviewer)}" placeholder="Например, Айгерим" autocomplete="name"></label>
    </div>
    <div class="label-layout">
      <section class="sheet label-list" aria-label="Диалоги для разметки">
        <div class="thead"><h2>Диалоги</h2><span class="muted" style="font-size:12px">${reviewer ? `размечено вами: ${labels.mine.length}` : 'введите имя'}</span></div>
        <p class="muted label-counts">${Object.entries(labels.counts).map(([r, n]) => `${esc(r)}: ${n}`).join(', ') || 'Пока никто не размечал.'}</p>
        <ul class="plain">${[...todo, ...convs.filter((c) => mine[c.conversation_id])]
          .map(
            (c) => `<li><a href="#/labeling/${encodeURIComponent(c.conversation_id)}" ${c.conversation_id === id ? 'aria-current="true"' : ''}>${esc(c.conversation_id)}</a>
              <span class="muted">${esc(c.language)}</span>${mine[c.conversation_id] ? ' <span class="v pass">размечен</span>' : ''}</li>`,
          )
          .join('')}</ul>
      </section>
      <div id="work"></div>
    </div>`;

  el.querySelector('#who').addEventListener('change', (e) => {
    setName(e.target.value.trim());
    render(el, { id });
  });

  const work = el.querySelector('#work');
  if (!reviewer) {
    work.innerHTML = '<section class="sheet state-box"><h2>Сначала введите имя</h2><p class="muted">Имя нужно, чтобы отличать разметку разных проверяющих.</p></section>';
    return;
  }
  if (!current) {
    const next = todo[0];
    work.innerHTML = `<section class="sheet state-box"><h2>${next ? 'Выберите диалог' : 'Вы разметили все диалоги'}</h2>
      ${next ? `<p><a class="btn" href="#/labeling/${encodeURIComponent(next.conversation_id)}">Начать с ${esc(next.conversation_id)}</a></p>` : ''}</section>`;
    return;
  }

  const conv = await api.conversation(current.conversation_id);
  if (currentPath() !== path) return;
  const prev = mine[conv.conversation_id];
  const options = (c) => {
    const base = c.type === 'scale' ? c.scale.map((s) => s.value) : ['yes', 'no'];
    if (c.na_allowed) base.push('na');
    return base;
  };
  const label = (c, o) => (o === 'na' ? 'N/A' : c.type === 'flag' ? (o === 'yes' ? 'Есть нарушение' : 'Нет') : o === 'yes' ? 'Да' : o === 'no' ? 'Нет' : String(o));

  work.innerHTML = `
    <div class="label-work">
      <section class="sheet" aria-label="Транскрипт">
        <div class="thead"><h2>${esc(conv.conversation_id)}</h2><span class="muted" style="font-size:12px">${esc(conv.language)}, оценивается только оператор</span></div>
        <div class="transcript">${conv.transcript
          .map((m) => `<div class="msg ${esc(m.speaker)}">${m.speaker === 'system' ? `#${m.msg_index} ${esc(m.text)}` : `<div class="who"><b>${esc(SPEAKER[m.speaker] || m.speaker)}</b><span>#${m.msg_index}</span></div>${esc(m.text)}`}</div>`)
          .join('')}</div>
      </section>
      <form class="sheet label-form" id="form">
        ${checklist.criteria
          .map(
            (c) => `<fieldset class="label-crit">
              <legend>${esc(c.name)}</legend>
              ${c.yes_rule ? `<p class="muted">${esc(c.yes_rule)}</p>` : ''}
              ${c.na_allowed && c.na_rule ? `<p class="muted">N/A: ${esc(c.na_rule)}</p>` : ''}
              <div class="seg" role="radiogroup" aria-label="${esc(c.name)}">${options(c)
                .map((o) => `<label class="seg-opt"><input type="radio" name="${esc(c.id)}" value="${esc(o)}" ${prev && String(prev.answers[c.id]) === String(o) ? 'checked' : ''} required><span>${esc(label(c, o))}</span></label>`)
                .join('')}</div>
            </fieldset>`,
          )
          .join('')}
        <label class="field">Комментарий (необязательно)<textarea id="note" rows="2">${esc(prev?.note || '')}</textarea></label>
        <div class="row"><button type="submit">${prev ? 'Сохранить изменения' : 'Сохранить и к следующему'}</button><span class="muted" id="msg" aria-live="polite"></span></div>
      </form>
    </div>`;

  work.querySelector('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const answers = Object.fromEntries(checklist.criteria.map((c) => [c.id, fd.get(c.id)]));
    try {
      await api.saveLabel(conv.conversation_id, reviewer, answers, work.querySelector('#note').value);
      const next = todo.find((c) => c.conversation_id !== conv.conversation_id);
      location.hash = next && !prev ? `#/labeling/${encodeURIComponent(next.conversation_id)}` : `#/labeling/${encodeURIComponent(conv.conversation_id)}`;
      if (prev) render(el, { id: conv.conversation_id });
    } catch (err) {
      work.querySelector('#msg').textContent = `Не сохранено: ${humanError(err)}`;
    }
  });
}
