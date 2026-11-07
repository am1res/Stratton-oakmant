// Checklist editor. Owner: P3.
// Starter version: a form per criterion for the common fields + raw JSON for everything else.
// Saving creates a new version; new evaluations use it immediately.
// TODO(P3): add/delete criterion buttons, scale step editor, decision_steps & examples editors,
//           version history view. Keep it working through the demo "replace a criterion" step!
import { api, esc } from '../common/api.js';

export async function render(el) {
  const cl = await api.checklist();
  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center">
      <h2 style="margin:0 auto 0 0">${esc(cl.name)} <span class="muted">v${cl.version}</span></h2>
      <button class="secondary" id="reset">Сбросить к исходному</button>
      <button id="save">Сохранить новую версию</button>
    </div>
    <p id="msg" class="muted"></p>
    <table id="form">
      <thead><tr><th>ID</th><th>Название</th><th>Тип</th><th>Вес</th><th>N/A</th><th>Правило «Да» / что оценивается</th><th>Условие N/A</th></tr></thead>
      <tbody>${cl.criteria
        .map(
          (c, i) => `<tr data-i="${i}">
            <td>${esc(c.id)}</td>
            <td><input data-k="name" value="${esc(c.name)}"></td>
            <td><select data-k="type">${['binary', 'scale', 'flag'].map((t) => `<option ${t === c.type ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
            <td><input data-k="weight" type="number" value="${c.weight}" style="width:60px"></td>
            <td><input data-k="na_allowed" type="checkbox" ${c.na_allowed ? 'checked' : ''}></td>
            <td><textarea data-k="yes_rule" rows="2" style="width:100%">${esc(c.yes_rule)}</textarea></td>
            <td><textarea data-k="na_rule" rows="2" style="width:100%">${esc(c.na_rule)}</textarea></td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>
    <details style="margin-top:12px"><summary>JSON (полная конфигурация: шкалы, шаги решения, примеры, новые критерии)</summary>
      <textarea id="json" rows="30" style="width:100%;font-family:monospace;font-size:12px">${esc(JSON.stringify(cl, null, 2))}</textarea>
    </details>`;

  const jsonBox = el.querySelector('#json');
  // Form edits → JSON
  el.querySelectorAll('#form [data-k]').forEach((input) =>
    input.addEventListener('input', () => {
      const obj = JSON.parse(jsonBox.value);
      const c = obj.criteria[Number(input.closest('tr').dataset.i)];
      const k = input.dataset.k;
      c[k] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
      jsonBox.value = JSON.stringify(obj, null, 2);
    }),
  );

  el.querySelector('#save').onclick = async () => {
    try {
      const saved = await api.saveChecklist(JSON.parse(jsonBox.value));
      el.querySelector('#msg').textContent = `Сохранено как v${saved.version}. Новые оценки используют эту версию.`;
      setTimeout(() => render(el), 800);
    } catch (e) {
      el.querySelector('#msg').textContent = e.message;
    }
  };
  el.querySelector('#reset').onclick = async () => {
    await api.resetChecklist();
    render(el);
  };
}
