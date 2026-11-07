// Hash router. Add a route by importing a screen module that exports render(el, params).
import { api, esc } from './api.js';
import * as conversations from '../conversations/list.js';
import * as card from '../conversations/card.js';
import * as checklist from '../checklist/editor.js';
import * as appeals from '../appeals/reviewer.js';

const routes = [
  [/^#\/conversations\/([^?]+)(?:\?c=(.+))?$/, 'conversations', (m) => card.render(app(), { id: decodeURIComponent(m[1]), focus: m[2] })],
  [/^#\/checklist$/, 'checklist', () => checklist.render(app())],
  [/^#\/appeals$/, 'appeals', () => appeals.render(app())],
  [/^#?\/?(conversations)?$/, 'conversations', () => conversations.render(app())],
];

const app = () => document.getElementById('app');

export async function refreshNav() {
  try {
    const open = await api.appeals('?status=open');
    const n = document.getElementById('appeal-count');
    n.textContent = open.length;
    n.hidden = open.length === 0;
  } catch {}
}

async function route() {
  const hash = location.hash || '#/conversations';
  for (const [re, section, fn] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    document.querySelectorAll('[data-nav]').forEach((a) => a.removeAttribute('aria-current'));
    document.querySelector(`[data-nav="${section}"]`)?.setAttribute('aria-current', 'page');
    app().innerHTML = '<p class="muted">Загружаю…</p>';
    try {
      await fn(m);
    } catch (e) {
      app().innerHTML = `<div class="sheet sheet-pad"><p class="error">Не удалось открыть страницу: ${esc(e.message)}</p><p class="muted">Проверьте, что сервер запущен (npm start), и обновите страницу.</p></div>`;
    }
    refreshNav();
    return;
  }
}

window.addEventListener('hashchange', route);
route();
api
  .meta()
  .then((m) => (document.getElementById('meta').innerHTML = `Модель <b>${esc(m.model)}</b>, набор <b>${esc(m.group_id)}</b>`))
  .catch(() => {});
