// Hash router. Add a route by importing a screen module that exports render(el, params).
import { api, esc } from './api.js';
import * as conversations from '../conversations/list.js';
import * as card from '../conversations/card.js';
import * as checklist from '../checklist/editor.js';
import * as appeals from '../appeals/reviewer.js';

const routes = [
  [/^#\/conversations\/(.+)$/, (m) => card.render(app(), { id: decodeURIComponent(m[1]) })],
  [/^#\/checklist$/, () => checklist.render(app())],
  [/^#\/appeals$/, () => appeals.render(app())],
  [/^#?\/?(conversations)?$/, () => conversations.render(app())],
];

const app = () => document.getElementById('app');

async function route() {
  const hash = location.hash || '#/conversations';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      app().innerHTML = '<p class="muted">Загрузка…</p>';
      try {
        await fn(m);
      } catch (e) {
        app().innerHTML = `<p class="error">${esc(e.message)}</p>`;
      }
      return;
    }
  }
}

window.addEventListener('hashchange', route);
route();
api.meta().then((m) => (document.getElementById('meta').textContent = `модель: ${m.model} · набор: ${m.group_id}`)).catch(() => {});
