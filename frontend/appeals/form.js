// Inline appeal form, opened from a criterion row. Owner: P4.
import { api, esc } from '../common/api.js';

export function renderAppealInline(slot, ev, criterionId, onDone) {
  slot.innerHTML = `
    <div class="appeal-inline">
      <label class="field">Почему оценка по этому критерию неверна?
        <textarea rows="3" placeholder="Например: оператор ответил на второй вопрос в реплике #14"></textarea>
      </label>
      <div class="row">
        <button data-send>Отправить на проверку</button>
        <button class="ghost" data-cancel>Отмена</button>
        <span class="muted" data-msg aria-live="polite"></span>
      </div>
    </div>`;
  const ta = slot.querySelector('textarea');
  ta.focus();
  slot.querySelector('[data-cancel]').onclick = () => (slot.innerHTML = '');
  slot.querySelector('[data-send]').onclick = async (e) => {
    if (!ta.value.trim()) {
      slot.querySelector('[data-msg]').textContent = 'Опишите, с чем вы не согласны.';
      return ta.focus();
    }
    e.target.disabled = true;
    try {
      await api.createAppeal(ev.id, criterionId, ta.value);
      slot.innerHTML = `<p class="saved-note">Апелляция отправлена. Проверяющий увидит её в разделе <a href="#/appeals">Апелляции</a>.</p>`;
      onDone?.();
    } catch (err) {
      slot.querySelector('[data-msg]').textContent = `Не отправлено: ${esc(err.message)}`;
      e.target.disabled = false;
    }
  };
}
