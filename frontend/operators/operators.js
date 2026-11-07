// Operators: a manager's view. Owner: P3.
// Overview: one row per operator (dialogs, average score, change early → late, weakest criterion,
// gross errors). Detail (#/operators/<name>): weekly average score chart, per-criterion change,
// and the operator's dialogs.
// Operator names and chat dates are DEMO values when the data has none (see backend/data/source.js);
// the page says so in a banner. Scores are the real evaluations.
import { api, esc } from '../common/api.js';
import { currentPath } from '../common/app.js';

const fmt = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : (Math.round(x * 10 ** d) / 10 ** d).toFixed(d).replace('.', ','));
const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '—');
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function weekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Per-criterion share of max points (0..1) for one conversation's latest evaluation. */
function criterionShares(c) {
  const out = {};
  for (const x of c.latest_criteria || []) {
    if (x.type === 'flag' || !(x.effective_weight > 0) || x.points === null || x.points === undefined) continue;
    out[x.id] = { share: x.points / x.effective_weight, name: x.name };
  }
  return out;
}

function stats(convs) {
  const scored = convs.filter((c) => c.latest_score !== null).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const half = Math.floor(scored.length / 2);
  const early = scored.slice(0, half);
  const late = scored.slice(scored.length - half);
  const enough = half >= 2;
  const crit = {};
  for (const c of scored) {
    for (const [id, x] of Object.entries(criterionShares(c))) {
      crit[id] ??= { name: x.name, all: [], early: [], late: [] };
      crit[id].all.push(x.share);
    }
  }
  for (const c of early) for (const [id, x] of Object.entries(criterionShares(c))) crit[id].early.push(x.share);
  for (const c of late) for (const [id, x] of Object.entries(criterionShares(c))) crit[id].late.push(x.share);
  const weakest = Object.entries(crit)
    .filter(([, v]) => v.all.length >= 3) // a 0% from one or two dialogs is noise
    .map(([id, v]) => ({ id, name: v.name, share: mean(v.all), n: v.all.length }))
    .sort((a, b) => a.share - b.share)[0];
  return {
    total: convs.length,
    scored,
    avg: mean(scored.map((c) => c.latest_score)),
    gross: convs.filter((c) => c.gross_error).length,
    early: enough ? mean(early.map((c) => c.latest_score)) : null,
    late: enough ? mean(late.map((c) => c.latest_score)) : null,
    crit,
    weakest: weakest && weakest.share < 0.999 ? weakest : null,
  };
}

function change(early, late) {
  if (early === null || late === null) return '<span class="muted">мало оценок</span>';
  const d = late - early;
  if (Math.abs(d) < 0.5) return `<span class="muted">без изменений</span> <small class="muted">${fmt(early)} → ${fmt(late)}</small>`;
  const up = d > 0;
  return `<span class="${up ? 'trend-up' : 'trend-down'}">${up ? '▲ лучше' : '▼ хуже'} на ${fmt(Math.abs(d))}</span> <small class="muted">${fmt(early)} → ${fmt(late)}</small>`;
}

function demoBanner(list, arr) {
  const op = list.some((c) => c.operator_source === 'demo');
  const date = list.some((c) => c.date_source === 'demo');
  if (!op && !date) return '';
  const what = [op ? 'имён операторов' : '', date ? 'дат чатов' : ''].filter(Boolean).join(' и ');
  const how = arr?.active
    ? `поэтому для демонстрации они <b>расставлены по сценариям</b>: стабильно сильный (Дамир), слабый (Ержан), рост (Айгерим), спад (Мирас), обычные (Алина, Валерия). Звонки сохраняют настоящую дату.`
    : 'поэтому они назначены случайно (у каждого диалога всегда одни и те же).';
  return `<div class="demo-banner" role="note"><b>Демо-данные.</b> В наборе организаторов нет ${what}, ${how} Баллы — настоящие оценки. В Dynamics 365 сюда подставятся реальный агент и дата разговора.</div>`;
}

export async function render(el, { name } = {}) {
  const path = currentPath();
  const [list, arr] = await Promise.all([api.conversations(), api.demoArrangement().catch(() => ({ active: false }))]);
  if (currentPath() !== path) return;
  const withOp = list.filter((c) => c.operator);
  if (!withOp.length) {
    el.innerHTML = `<div class="page-head"><h1 class="grow">Операторы</h1></div>
      <section class="sheet state-box"><h2>Нет данных об операторах</h2>
      <p class="muted">В данных нет поля оператора, а демо-имена выключены (DEMO_OPERATORS=0 в .env).</p></section>`;
    return;
  }
  const groups = {};
  for (const c of withOp) (groups[c.operator] ??= []).push(c);
  if (name && groups[name]) return renderDetail(el, name, groups[name], list, arr);
  return renderOverview(el, groups, list, arr);
}

function renderOverview(el, groups, list, arr) {
  const rows = Object.entries(groups)
    .map(([name, convs]) => ({ name, s: stats(convs) }))
    .sort((a, b) => (a.s.avg ?? 999) - (b.s.avg ?? 999));
  const anyScored = rows.some((r) => r.s.scored.length);
  el.innerHTML = `
    <div class="page-head"><h1 class="grow">Операторы</h1>
      <span class="muted">Сначала операторы с самым низким средним баллом</span>
    </div>
    ${demoBanner(list, arr)}
    <section class="sheet" style="overflow:hidden">
      ${anyScored ? '' : '<p class="sheet-pad muted">Оценок пока нет: запустите «Оценить все» на странице «Диалоги».</p>'}
      <table class="grid">
        <thead><tr><th>Оператор</th><th class="num">Диалогов</th><th class="num">Средний балл</th><th>Изменение: ранние → поздние диалоги</th><th>Слабый критерий</th><th class="num">Грубые ошибки</th></tr></thead>
        <tbody>${rows
          .map(
            ({ name, s }) => `<tr data-name="${esc(name)}" tabindex="0">
              <td><a href="#/operators/${encodeURIComponent(name)}"><b>${esc(name)}</b></a></td>
              <td class="num nowrap">${s.total}${s.scored.length < s.total ? `<small class="muted block">оценено ${s.scored.length}</small>` : ''}</td>
              <td class="num"><b>${fmt(s.avg)}</b></td>
              <td>${change(s.early, s.late)}</td>
              <td>${s.weakest ? `${esc(s.weakest.id)} ${esc(s.weakest.name)} <small class="muted">${Math.round(s.weakest.share * 100)}% от максимума, ${s.weakest.n} диал.</small>` : '<span class="muted">—</span>'}</td>
              <td class="num">${s.gross ? `<span class="flag">${s.gross}</span>` : '0'}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
      <p class="strip-note">«Изменение»: средний балл второй половины диалогов оператора (по дате) минус первой половины. Нужно хотя бы 4 оценённых диалога.</p>
    </section>`;
  el.querySelectorAll('tr[data-name]').forEach((tr) => {
    const go = () => (location.hash = `#/operators/${encodeURIComponent(tr.dataset.name)}`);
    tr.addEventListener('click', (e) => !e.target.closest('a') && go());
    tr.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  });
}

function renderDetail(el, name, convs, list, arr) {
  const s = stats(convs);
  const weeks = {};
  for (const c of s.scored) if (c.date) (weeks[weekStart(c.date)] ??= []).push(c.latest_score);
  const points = Object.entries(weeks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([w, xs]) => ({ week: w, avg: mean(xs), n: xs.length }));
  const critRows = Object.entries(s.crit)
    .map(([id, v]) => ({ id, name: v.name, all: mean(v.all), early: s.early !== null ? mean(v.early) : null, late: s.late !== null ? mean(v.late) : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const sorted = [...convs].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  el.innerHTML = `
    <a class="crumb" href="#/operators">← Все операторы</a>
    <div class="page-head"><h1 class="grow">${esc(name)}${convs[0].operator_source === 'demo' ? ' <span class="tag">демо-имя</span>' : ''}</h1></div>
    ${demoBanner(list, arr)}
    <section class="sheet">
      <div class="stats">
        <div class="stat"><b>${s.total}</b><span>диалогов</span></div>
        <div class="stat"><b>${fmt(s.avg)}</b><span>средний балл</span></div>
        <div class="stat ${s.gross ? 'alert' : ''}"><b>${s.gross}</b><span>с грубыми ошибками</span></div>
        <div class="stat"><b style="font-size:15px">${change(s.early, s.late)}</b><span>ранние → поздние</span></div>
      </div>
    </section>
    <section class="sheet sheet-pad" style="margin-top:16px">
      <h2>Средний балл по неделям</h2>
      <p class="muted" style="font-size:12px;margin:2px 0 8px">Неделя с понедельника; наведите на точку, чтобы увидеть число диалогов.</p>
      ${points.length ? '<div class="chart-wrap" id="chart"></div>' : '<p class="muted">Нет оценённых диалогов с датой.</p>'}
    </section>
    <section class="sheet" style="margin-top:16px;overflow:hidden">
      <div class="sheet-pad"><h2>По критериям</h2><p class="muted" style="font-size:12px">Доля от максимума баллов критерия (N/A не учитываются).</p></div>
      <table class="grid">
        <thead><tr><th>Критерий</th><th class="num">В среднем</th><th class="num">Ранние диалоги</th><th class="num">Поздние диалоги</th><th>Изменение</th></tr></thead>
        <tbody>${critRows
          .map(
            (r) => `<tr><td>${esc(r.id)} ${esc(r.name)}</td><td class="num">${pct(r.all)}</td><td class="num">${pct(r.early)}</td><td class="num">${pct(r.late)}</td>
              <td>${r.early !== null && r.late !== null ? (Math.abs(r.late - r.early) < 0.005 ? '<span class="muted">без изменений</span>' : `<span class="${r.late > r.early ? 'trend-up' : 'trend-down'}">${r.late > r.early ? '▲' : '▼'} ${Math.round(Math.abs(r.late - r.early) * 100)} п.п.</span>`) : '<span class="muted">—</span>'}</td></tr>`,
          )
          .join('')}</tbody>
      </table>
    </section>
    <section class="sheet" style="margin-top:16px;overflow:hidden">
      <div class="sheet-pad"><h2>Диалоги оператора</h2></div>
      <table class="grid">
        <thead><tr><th>Дата</th><th>Диалог</th><th>Язык и канал</th><th class="num">Итог</th><th>Внимание</th></tr></thead>
        <tbody>${sorted
          .map(
            (c) => `<tr><td>${fmtDate(c.date)}${c.date_source === 'demo' ? ' <small class="muted">демо</small>' : ''}</td>
              <td class="id"><a href="#/conversations/${encodeURIComponent(c.conversation_id)}">${esc(c.conversation_id)}</a></td>
              <td><span class="lang">${esc(c.language)}</span> ${c.channel === 'voice call' ? 'звонок' : 'чат'}</td>
              <td class="num">${c.latest_score ?? '<span class="muted">не оценён</span>'}</td>
              <td>${[c.gross_error ? '<span class="flag">Грубая ошибка</span>' : '', c.has_open_appeal ? '<span class="flag appeal">Апелляция</span>' : ''].filter(Boolean).join(' ')}</td></tr>`,
          )
          .join('')}</tbody>
      </table>
    </section>`;
  const box = el.querySelector('#chart');
  if (box) {
    box.innerHTML = chartSvg(points, Math.max(320, box.clientWidth));
    bindChart(el);
  }
}

const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

/** Single-series line chart drawn at the container's real pixel width (text stays 11px).
 * y is fixed 0–100 (the score scale); x is the real date, so a week without dialogs leaves a gap. */
function chartSvg(points, W) {
  const H = 240, L = 36, R = 20, T = 14, B = 30;
  const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
  const d0 = day(points[0].week);
  const span = Math.max(7, day(points.at(-1).week) - d0);
  const x = (p) => (points.length === 1 ? L + (W - L - R) / 2 : L + ((day(p.week) - d0) * (W - L - R)) / span);
  const y = (v) => T + ((100 - v) * (H - T - B)) / 100;
  const grid = [0, 25, 50, 75, 100]
    .map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="ch-grid"/><text x="${L - 8}" y="${y(v) + 4}" class="ch-axis" text-anchor="end">${v}</text>`)
    .join('');
  const minGap = 48; // px between x labels
  let lastX = -Infinity;
  const xLabels = points
    .map((p) => {
      const px = x(p);
      if (px - lastX < minGap) return '';
      lastX = px;
      return `<text x="${px}" y="${H - 8}" class="ch-axis" text-anchor="middle">${fmtDate(p.week)}</text>`;
    })
    .join('');
  // break the line where a week has no dialogs (a gap of more than 7 days)
  const line = points
    .map((p, i) => `${i && day(p.week) - day(points[i - 1].week) <= 7 ? 'L' : 'M'}${x(p).toFixed(1)},${y(p.avg).toFixed(1)}`)
    .join(' ');
  const dots = points
    .map(
      (p) => `<g class="ch-pt" data-tip="Неделя с ${fmtDate(p.week)}: средний балл ${fmt(p.avg)}, диалогов: ${p.n}">
        <circle cx="${x(p)}" cy="${y(p.avg)}" r="14" class="ch-hit"/><circle cx="${x(p)}" cy="${y(p.avg)}" r="4" class="ch-dot"/></g>`,
    )
    .join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Средний балл по неделям">
      ${grid}${xLabels}<path d="${line}" class="ch-line"/>${dots}</svg><div class="ch-tip" hidden></div>`;
}

function bindChart(el) {
  const wrap = el.querySelector('.chart-wrap');
  if (!wrap) return;
  const tip = wrap.querySelector('.ch-tip');
  wrap.querySelectorAll('.ch-pt').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      const dot = g.querySelector('.ch-dot').getBoundingClientRect();
      const box = wrap.getBoundingClientRect();
      tip.textContent = g.dataset.tip;
      tip.hidden = false;
      tip.style.left = `${dot.left - box.left + dot.width / 2}px`;
      tip.style.top = `${dot.top - box.top - 8}px`;
      g.classList.add('on');
    });
    g.addEventListener('mouseleave', () => {
      tip.hidden = true;
      g.classList.remove('on');
    });
  });
}
