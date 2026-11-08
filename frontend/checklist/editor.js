// Checklist editor. Owner: P3.
// Supports the demo step "replace a criterion": add / delete / edit any criterion, its scale,
// N/A rule, decision steps and examples, then save a new version. New evaluations use it at once.
import { api, esc } from '../common/api.js';

const TYPES = { binary: 'Да / Нет', scale: 'Шкала', flag: 'Флаг без баллов' };

export async function render(el) {
  const [current, versions, all] = await Promise.all([api.checklist(), api.checklistVersions(), api.checklistsAll()]);
  let draft = structuredClone(current);
  const open = new Set();
  let dirty = false;

  el.innerHTML = `
    <div class="page-head">
      <div class="grow">
        <h1>Чек-лист</h1>
        <p class="muted">${esc(current.name)}, версия ${current.version}. Всего версий: ${versions.length}. Новые оценки используют этот чек-лист.</p>
      </div>
      <label class="field cl-pick">Активный чек-лист
        <select id="pick">${all.map((c) => `<option value="${esc(c.id)}" ${c.active ? 'selected' : ''}>${esc(c.name)} · v${c.version} · ${c.criteria} крит.</option>`).join('')}</select>
      </label>
      <button id="new-open">+ Новый чек-лист</button>
    </div>
    <section class="sheet sheet-pad new-cl" id="new-panel" hidden>
      <h2 style="margin:0 0 12px">Новый чек-лист</h2>
      <div class="new-cl-row">
        <label class="field" style="flex:1 1 260px">Название<input id="new-name" placeholder="Например: Звонки, отдел продаж"></label>
        <label class="check"><input type="radio" name="new-base" value="copy" checked> Копия текущего «${esc(current.name)}»</label>
        <label class="check"><input type="radio" name="new-base" value="empty"> Пустой (один критерий для начала)</label>
        <button id="new-create">Создать и сделать активным</button>
        <button class="ghost" id="new-cancel">Отмена</button>
      </div>
      <p class="muted" style="margin:8px 0 0">Старые чек-листы и оценки по ним сохраняются. Переключаться между чек-листами можно в списке «Активный чек-лист».</p>
    </section>
    <section class="sheet">
      <div class="sheet-pad" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <div class="weightbar" id="weights"></div>
      </div>
      <div class="crit-cols" aria-hidden="true"><span>ID</span><span>Критерий</span><span>Тип ответа</span><span>Вес</span><span>N/A</span><span></span></div>
      <div id="crits"></div>
      <div class="editor-bar">
        <button class="ghost" id="add">+ Добавить критерий</button>
        <span class="muted grow" id="status" aria-live="polite"></span>
        <button class="ghost" id="discard" disabled>Отменить изменения</button>
        <button id="save" disabled>Сохранить как версию ${current.version + 1}</button>
      </div>
    </section>
    <details class="sheet sheet-pad" style="margin-top:16px" id="history">
      <summary style="cursor:pointer">История версий (${versions.length}) — посмотреть и вернуть любую</summary>
      <p class="muted" style="margin:8px 0">Восстановление копирует выбранную версию как новую. Старые версии и оценки, сделанные по ним, не меняются.</p>
      <div class="versions">${versions.map((v) => versionRow(v, current)).join('')}</div>
    </details>
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
    const bars = draft.criteria
      .filter((c) => c.type !== 'flag' && Number(c.weight) > 0)
      .map((c) => `<span style="flex:${Number(c.weight)} 1 0" title="${esc(c.id)} ${esc(c.name)}: ${c.weight}"></span>`)
      .join('');
    w.innerHTML = `<span>Сумма весов: <b>${sum}</b>${sum === 100 ? '' : '. Итог будет считаться из этой суммы, обычно нужно 100'}</span>
      <span class="weights-mini" role="img" aria-label="Распределение весов по критериям">${bars}</span>`;
    w.style.flex = '1 1 auto';
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
    const fresh = crits.querySelector(`[data-id="${id}"]`);
    fresh?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    fresh?.querySelector('input[data-k="name"]')?.select();
  };

  // ---- several checklists: switch the active one, create a new one ----
  const pick = el.querySelector('#pick');
  pick.onchange = async () => {
    if (dirty && !confirm('Несохранённые изменения пропадут. Переключить чек-лист?')) return (pick.value = current.id);
    try {
      await api.activateChecklist(pick.value);
      dirty = false;
      await render(el);
      el.querySelector('#status').innerHTML = '<span class="saved-note">Чек-лист переключён. Новые оценки используют его.</span>';
    } catch (err) {
      pick.value = current.id;
      el.querySelector('#status').innerHTML = `<span class="error">Не переключено. ${esc(err.message)}</span>`;
    }
  };
  const panel = el.querySelector('#new-panel');
  el.querySelector('#new-open').onclick = () => {
    panel.hidden = false;
    el.querySelector('#new-name').focus();
  };
  el.querySelector('#new-cancel').onclick = () => (panel.hidden = true);
  el.querySelector('#new-create').onclick = async (e) => {
    const name = el.querySelector('#new-name').value.trim();
    if (!name) return el.querySelector('#new-name').focus();
    if (dirty && !confirm('Несохранённые изменения в текущем чек-листе пропадут. Продолжить?')) return;
    e.target.disabled = true;
    try {
      const base = el.querySelector('input[name="new-base"]:checked').value;
      await api.createChecklist(name, base);
      dirty = false;
      await render(el);
      el.querySelector('#status').innerHTML = `<span class="saved-note">Создан чек-лист «${esc(name)}». Он активный: новые оценки используют его.</span>`;
    } catch (err) {
      e.target.disabled = false;
      alertBox(err);
    }
  };
  const alertBox = (err) => (el.querySelector('#status').innerHTML = `<span class="error">Не создано. ${esc(err.message)}</span>`);

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
  el.querySelectorAll('[data-restore]').forEach((b) =>
    b.addEventListener('click', async () => {
      const v = Number(b.dataset.restore);
      if (dirty && !confirm('Несохранённые изменения пропадут. Продолжить?')) return;
      if (!confirm(`Вернуть чек-лист версии ${v}? Он станет новой версией ${current.version + 1}, история сохранится.`)) return;
      b.disabled = true;
      try {
        const saved = await api.restoreChecklist(v);
        dirty = false;
        await render(el);
        el.querySelector('#status').innerHTML = `<span class="saved-note">Версия ${v} восстановлена как версия ${saved.version}. Новые оценки используют её.</span>`;
      } catch (err) {
        b.disabled = false;
        el.querySelector('#status').innerHTML = `<span class="error">Не восстановлено. ${esc(err.message)}</span>`;
      }
    }),
  );
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
      <span class="tag">${c.type === 'scale' && c.scale?.length ? `Шкала ${Math.min(...c.scale.map((s) => s.value))}–${Math.max(...c.scale.map((s) => s.value))}` : TYPES[c.type] || c.type}</span>
      <span><span class="sum-weight">${c.type === 'flag' ? '—' : c.weight}</span></span>
      <span class="tag">${c.na_allowed ? 'можно' : 'нельзя'}</span>
    </summary>
    <div class="body">
      <label class="field">Название<input data-k="name" value="${esc(c.name)}"></label>
      <label class="field">Раздел<select data-k="section">${sections.map((s) => `<option value="${esc(s.id)}" ${s.id === c.section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label class="field">Тип ответа<select data-k="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">Вес${c.type === 'flag' ? ' (у флага баллов нет)' : ''}<input data-k="weight" type="number" min="0" value="${c.weight}" ${c.type === 'flag' ? 'disabled' : ''}></label>
      <label class="field full">${isScale ? 'Что оценивается (баллы за каждую ступень — в шкале ниже)' : c.type === 'flag' ? 'Что считается нарушением (флаг ставится, если это произошло)' : 'Правило оценки: в каких случаях ставится «Да», а в каких — «Нет»'}<textarea data-k="yes_rule" rows="3" placeholder="${isScale ? 'Например: насколько полно и верно оператор ответил на вопросы клиента.' : c.type === 'flag' ? 'Например: оператор оскорбил клиента или предложил услугу в обход компании.' : '«Да» — оператор поздоровался и представился в первой реплике. «Нет» — не поздоровался или не назвал своё имя.'}">${esc(c.yes_rule)}</textarea></label>
      ${
        isScale
          ? `<div class="full"><div class="field" style="margin-bottom:6px">Шкала (верхняя ступень даёт полный вес)</div>${c.scale
              .map((s, j) => `<div class="scale-row"><input data-k="scale_value" data-j="${j}" type="number" value="${s.value}" aria-label="Баллы"><input data-k="scale_desc" data-j="${j}" value="${esc(s.description)}" aria-label="Описание ступени"><button class="link" data-act="del-step" data-j="${j}" title="Удалить ступень">✕</button></div>`)
              .join('')}<button class="link" data-act="add-step">Добавить ступень</button></div>`
          : ''
      }
      <label class="check full"><input type="checkbox" data-k="na_allowed" ${c.na_allowed ? 'checked' : ''}> Разрешить N/A</label>
      ${c.na_allowed ? `<label class="field full">В каких случаях критерий не применяется (N/A)<textarea data-k="na_rule" rows="2" placeholder="Например: клиент ушёл из чата до того, как задал вопрос.">${esc(c.na_rule)}</textarea></label>` : ''}
      <label class="field full">Порядок решения для модели (по шагу на строку). Главный рычаг точности
        <textarea data-k="decision_steps" rows="4">${esc((c.decision_steps || []).join('\n'))}</textarea></label>
      <label class="field full">Примеры (по одному на строку: ответ | реплика | почему)
        <textarea data-k="examples" rows="3">${esc((c.examples || []).map((x) => `${x.answer} | ${x.text} | ${x.why}`).join('\n'))}</textarea></label>
      <div class="full"><button class="danger" data-act="delete">Удалить критерий</button></div>
    </div>
  </details>`;
}

/** One row of the version history: what differs from the current version, and a restore button. */
function versionRow(v, current) {
  const isCurrent = v.version === current.version;
  const weightSum = v.criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const curById = Object.fromEntries(current.criteria.map((c) => [c.id, c]));
  const vIds = new Set(v.criteria.map((c) => c.id));
  const diff = [];
  for (const c of v.criteria) {
    const now = curById[c.id];
    if (!now) diff.push(`есть ${c.id} «${c.name}»`);
    else if (now.name !== c.name || now.weight !== c.weight || now.type !== c.type) {
      diff.push(`${c.id}: ${now.name !== c.name ? `«${c.name}»` : ''}${now.weight !== c.weight ? ` вес ${c.weight}` : ''}${now.type !== c.type ? ` тип ${TYPES[c.type] || c.type}` : ''}`.trim());
    }
  }
  for (const c of current.criteria) if (!vIds.has(c.id)) diff.push(`нет ${c.id} «${c.name}»`);
  const when = v.saved_at ? new Date(v.saved_at).toLocaleString('ru-RU') : '';
  const origin = v.restored_from ? `, копия версии ${v.restored_from}` : '';
  return `<div class="version-row ${isCurrent ? 'current' : ''}">
      <div><b>Версия ${v.version}</b>${isCurrent ? ' <span class="v pass">текущая</span>' : ''}
        <span class="muted">${esc(when)}${origin}, критериев: ${v.criteria.length}, сумма весов: ${weightSum}</span>
        ${!isCurrent ? `<div class="muted version-diff">${diff.length ? `Отличия от текущей: ${esc(diff.join('; '))}` : 'Критерии те же, что в текущей (могли отличаться правила и примеры)'}</div>` : ''}
      </div>
      ${isCurrent ? '' : `<button class="ghost" data-restore="${v.version}">Восстановить</button>`}
    </div>`;
}

const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
function parseExamples(v) {
  return lines(v).map((l) => {
    const [answer, text, why] = l.split('|').map((s) => s.trim());
    return { answer: /^\d+$/.test(answer) ? Number(answer) : answer, text: text || '', why: why || '' };
  });
}
