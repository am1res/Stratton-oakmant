// App shell + hash router. Owner: P3.
// Routes: #/analytics, #/conversations, #/conversations/<id>?c=<criterion>&m=<msg_index>, #/appeals, #/checklist.
// Add a route by importing a screen module that exports render(el, params).
import { api, esc } from './api.js';
import * as conversations from '../conversations/list.js';
import * as card from '../conversations/card.js';
import * as checklist from '../checklist/editor.js';
import * as appeals from '../appeals/reviewer.js';
import * as analytics from '../analytics/dashboard.js';
import * as operators from '../operators/operators.js';

const routes = [
  [/^#\/conversations\/([^?]+)$/, 'conversations', (m, q) => card.render(app(), { id: decodeURIComponent(m[1]), focus: q.get('c'), msg: q.get('m') })],
  [/^#\/checklist$/, 'checklist', () => checklist.render(app())],
  [/^#\/appeals$/, 'appeals', () => appeals.render(app())],
  [/^#\/analytics$/, 'analytics', () => analytics.render(app())],
  [/^#\/operators\/([^?]+)$/, 'operators', (m) => operators.render(app(), { name: decodeURIComponent(m[1]) })],
  [/^#\/operators$/, 'operators', () => operators.render(app())],
  [/^#?\/?(conversations)?$/, 'conversations', () => conversations.render(app())],
];

const app = () => document.getElementById('app');

/** Current route path without query, e.g. "#/conversations/p1-ru-001". Screens use it to drop stale async renders. */
export function currentPath() {
  return (location.hash || '#/conversations').split('?')[0];
}

export async function refreshNav() {
  try {
    const open = await api.appeals('?status=open');
    const n = document.getElementById('appeal-count');
    n.textContent = open.length;
    n.hidden = open.length === 0;
  } catch {}
}

const SKELETON = `<div class="skeleton" aria-busy="true" aria-label="Загружаю">
  <div class="sk-line" style="width:180px;height:22px;margin-bottom:16px"></div>
  <div class="sheet sheet-pad"><div class="sk-line" style="width:60%"></div><div class="sk-line" style="width:85%"></div><div class="sk-line" style="width:72%"></div><div class="sk-line" style="width:40%"></div></div>
</div>`;

async function route() {
  const hash = location.hash || '#/conversations';
  const [path, query] = hash.split('?');
  const q = new URLSearchParams(query || '');
  for (const [re, section, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    document.querySelectorAll('[data-nav]').forEach((a) => a.removeAttribute('aria-current'));
    document.querySelector(`[data-nav="${section}"]`)?.setAttribute('aria-current', 'page');
    app().innerHTML = SKELETON;
    try {
      await fn(m, q);
    } catch (e) {
      if (currentPath() !== path) return; // user already navigated elsewhere
      const offline = e instanceof TypeError; // fetch failed: server not running
      app().innerHTML = `<div class="sheet state-box">
        <h2>${offline ? 'Нет связи с сервером' : 'Не удалось открыть страницу'}</h2>
        <p class="muted">${offline ? 'Запустите сервер командой npm start в папке проекта и повторите.' : esc(e.message)}</p>
        <p><button id="retry">Повторить</button> <a class="btn ghost" href="#/conversations">К списку диалогов</a></p>
      </div>`;
      app().querySelector('#retry').onclick = route;
    }
    refreshNav();
    return;
  }
  app().innerHTML = `<div class="sheet state-box"><h2>Такой страницы нет</h2><p><a class="btn" href="#/conversations">К списку диалогов</a></p></div>`;
}

window.addEventListener('hashchange', route);
route();
api
  .meta()
  .then((m) => (document.getElementById('meta').innerHTML = `Модель <b>${esc(m.model)}</b>${m.mode === 'ensemble' ? ' (A+B+арбитр)' : ''}, набор <b>${esc(m.group_id)}</b>`))
  .catch(() => {});
