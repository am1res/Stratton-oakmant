// Checklist editor. Owner: P3.
// Supports the demo step "replace a criterion": add / delete / edit any criterion, its scale,
// N/A rule, decision steps and examples, then save a new version. New evaluations use it at once.
import { api, esc } from '../common/api.js';

const TYPES = { binary: 'Да / Нет', scale: 'Шкала', flag: 'Флаг без баллов' };

export async function render(el) {
  const current = await api.checklist();
  const versions = await api.checklistVersions();
  let draft = structuredClone(current);
  const open = new Set();
  let dirty = false;

  el.innerHTML = `
    <div class="page-head">
      <div class="grow">
        <h1>Чек-лист</h1>
        <p class="muted">${esc(current.name)}, версия ${current.version}. Всего версий: ${versions.length}.</p>
      </div>
      <span class="muted" id="status" aria-live="polite"></span>
      <button class="ghost" id="discard" disabled>Отменить изменения</button>
      <button id="save" disabled>Сохранить как версию ${current.version + 1}</button>
    </div>
    <section class="sheet">
      <div class="sheet-pad" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <div class="weightbar" id="weights"></div>
        <button class="ghost" id="add" style="margin-left:auto">Добавить критерий</button>
      </div>
      <div id="crits"></div>
    </section>
    <details class="sheet sheet-pad" style="margin-top:16px">
      <summary class="muted" style="cursor:pointer">Общие правила для модели и сброс</summary>
      <label class="field" style="margin-top:12px">Общие правила (по одному на строку, применяются ко всем критериям)
        <textarea id="general" rows="8">${esc((draft.general_rules || []).join('\n'))}</textarea>
      </label>
      <p style="margin-top:12px"><button class="danger" id="reset">Вернуть исходный чек-лист из PDF</button></p>
    </details>`;

  const crits = el.querySelector('#crits');
  const setDirty = () => {
    dirty = true;
    el.querySelector('#save').disabled = false;
    el.querySelector('#discard').disabled = false;
    el.querySelector('#status').textContent = 'Есть несохранённые изменения';
    weights();
  };

  function weights() {
    const sum = draft.criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0);
    const w = el.querySelector('#weights');
    w.className = `weightbar ${sum === 100 ? '' : 'bad'}`;
    w.innerHTML = `Сумма весов: <b>${sum}</b>${sum === 100 ? '' : '. Итог будет считаться из этой суммы, обычно нужно 100'}`;
  }

  function draw() {
    crits.innerHTML = draft.criteria.map((c, i) => critHtml(c, i, draft.sections || [], open.has(c.id))).join('');
    crits.querySelectorAll('details.crit-edit').forEach((d) =>
      d.addEventListener('toggle', () => (d.open ? open.add(d.dataset.id) : open.delete(d.dataset.id))),
    );
    weights();
  }
  draw();

  // All edits are delegated: inputs carry data-i (criterion index) and data-k (field)
  crits.addEventListener('input', (e) => {
    const t = e.target;
    const i = Number(t.closest('[data-i]')?.dataset.i);
    if (Number.isNaN(i)) return;
    const c = draft.criteria[i];
    const k = t.dataset.k;
    if (!k) return;
    if (k === 'weight') c.weight = Number(t.value);
    else if (k === 'na_allowed') c.na_allowed = t.checked;
    else if (k === 'decision_steps') c.decision_steps = lines(t.value);
    else if (k === 'examples') c.examples = parseExamples(t.value);
    else if (k === 'scale_value' || k === 'scale_desc') {
      const j = Number(t.dataset.j);
      c.scale[j][k === 'scale_value' ? 'value' : 'description'] = k === 'scale_value' ? Number(t.value) : t.value;
    } else c[k] = t.value;
    if (k === 'name') t.closest('details').querySelector('.sum-name').textContent = t.value;
    if (k === 'weight') t.closest('details').querySelector('.sum-weight').textContent = t.value;
    setDirty();
  });
  crits.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.k !== 'type') return;
    const c = draft.criteria[Number(t.closest('[data-i]').dataset.i)];
    c.type = t.value;
    if (c.type === 'scale' && !c.scale?.length) c.scale = [{ value: 10, description: 'Полностью выполнено' }, { value: 5, description: 'Частично' }, { value: 0, description: 'Не выполнено' }];
    if (c.type === 'flag') c.weight = 0;
    else if (!c.weight) c.weight = 10;
    setDirty();
    draw();
  });
  crits.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    e.preventDefault();
    const i = Number(b.closest('[data-i]').dataset.i);
    const c = draft.criteria[i];
    if (b.dataset.act === 'delete') {
      if (!confirm(`Удалить критерий ${c.id} «${c.name}»? Изменение вступит в силу после сохранения.`)) return;
      draft.criteria.splice(i, 1);
    }
    if (b.dataset.act === 'add-step') c.scale.push({ value: 0, description: '' });
    if (b.dataset.act === 'del-step') c.scale.splice(Number(b.dataset.j), 1);
    setDirty();
    draw();
  });

  el.querySelector('#general').addEventListener('input', (e) => {
    draft.general_rules = lines(e.target.value);
    setDirty();
  });

  el.querySelector('#add').onclick = () => {
    const n = Math.max(0, ...draft.criteria.map((c) => Number(String(c.id).replace(/\D/g, '')) || 0)) + 1;
    const id = `c${String(n).padStart(2, '0')}`;
    draft.criteria.push({
      id, section: draft.sections?.[0]?.id || 's1', name: 'Новый критерий', type: 'binary', weight: 10,
      na_allowed: false, yes_rule: '', na_rule: '', decision_steps: [], examples: [],
    });
    open.add(id);
    setDirty();
    draw();
    crits.querySelector(`[data-id="${id}"] input[data-k="name"]`)?.select();
  };

  el.querySelector('#discard').onclick = () => render(el);
  el.querySelector('#save').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const saved = await api.saveChecklist(draft);
      dirty = false;
      await render(el);
      el.querySelector('#status').innerHTML = `<span class="saved-note">Сохранено как версия ${saved.version}. Новые оценки используют её.</span>`;
    } catch (err) {
      el.querySelector('#status').innerHTML = `<span class="error">Не сохранено. ${esc(err.message)}</span>`;
      e.target.disabled = false;
    }
  };
  el.querySelector('#reset').onclick = async () => {
    if (!confirm('Вернуть исходный чек-лист? Будет создана новая версия, старые сохранятся.')) return;
    await api.resetChecklist();
    render(el);
  };
  window.onbeforeunload = () => (dirty ? true : undefined);
}

function critHtml(c, i, sections, isOpen) {
  const isScale = c.type === 'scale';
  return `<details class="crit-edit" data-i="${i}" data-id="${esc(c.id)}" ${isOpen ? 'open' : ''}>
    <summary>
      <span class="tag">${esc(c.id)}</span>
      <span class="sum-name" style="font-weight:500">${esc(c.name)}</span>
      <span class="tag">${TYPES[c.type] || c.type}</span>
      <span class="tag">вес <span class="sum-weight">${c.weight}</span></span>
      <span class="tag">${c.na_allowed ? 'N/A можно' : ''}</span>
    </summary>
    <div class="body">
      <label class="field">Название<input data-k="name" value="${esc(c.name)}"></label>
      <label class="field">Раздел<select data-k="section">${sections.map((s) => `<option value="${esc(s.id)}" ${s.id === c.section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label class="field">Тип ответа<select data-k="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">Вес${c.type === 'flag' ? ' (у флага баллов нет)' : ''}<input data-k="weight" type="number" min="0" value="${c.weight}" ${c.type === 'flag' ? 'disabled' : ''}></label>
      <label class="field full">${isScale ? 'Что оценивается' : c.type === 'flag' ? 'Что считается нарушением' : 'Когда ставить «Да»'}<textarea data-k="yes_rule" rows="2">${esc(c.yes_rule)}</textarea></label>
      ${
        isScale
          ? `<div class="full"><div class="field" style="margin-bottom:6px">Шкала (верхняя ступень даёт полный вес)</div>${c.scale
              .map((s, j) => `<div class="scale-row"><input data-k="scale_value" data-j="${j}" type="number" value="${s.value}" aria-label="Баллы"><input data-k="scale_desc" data-j="${j}" value="${esc(s.description)}" aria-label="Описание ступени"><button class="link" data-act="del-step" data-j="${j}" title="Удалить ступень">✕</button></div>`)
              .join('')}<button class="link" data-act="add-step">Добавить ступень</button></div>`
          : ''
      }
      <label class="check full"><input type="checkbox" data-k="na_allowed" ${c.na_allowed ? 'checked' : ''}> Разрешить N/A</label>
      ${c.na_allowed ? `<label class="field full">Когда ставить N/A<textarea data-k="na_rule" rows="2">${esc(c.na_rule)}</textarea></label>` : ''}
      <label class="field full">Порядок решения для модели (по шагу на строку). Главный рычаг точности
        <textarea data-k="decision_steps" rows="4">${esc((c.decision_steps || []).join('\n'))}</textarea></label>
      <label class="field full">Примеры (по одному на строку: ответ | реплика | почему)
        <textarea data-k="examples" rows="3">${esc((c.examples || []).map((x) => `${x.answer} | ${x.text} | ${x.why}`).join('\n'))}</textarea></label>
      <div class="full"><button class="danger" data-act="delete">Удалить критерий</button></div>
    </div>
  </details>`;
}

const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
function parseExamples(v) {
  return lines(v).map((l) => {
    const [answer, text, why] = l.split('|').map((s) => s.trim());
    return { answer: /^\d+$/.test(answer) ? Number(answer) : answer, text: text || '', why: why || '' };
  });
}
