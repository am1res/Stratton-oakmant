// Analytics. Owner: P3.
// Built from the LATEST evaluation of each conversation (after appeals). Answers four questions:
//   where do operators lose points · how are scores distributed · how do languages/channels compare
//   · how accurate is the AI against our reference labels · what changed after a checklist edit.
// Charts follow the dataviz rules: outcome colours validated for colour-blind separation
// (met / partial / not met + hatched N/A), every number also shown as text, hover tooltips.
import { api, esc, CHANNEL } from '../common/api.js';
import { computeScore, normalizeAnswer } from '/shared/scoring.js';
import { verdictClass } from '../common/strip.js';

const GROSS = { insult: 'оскорбление клиента', bypass_service: 'услуга в обход компании', confidential_disclosure: 'раскрытие конфиденциальной информации' };

export async function render(el) {
  const [convs, evals, ref] = await Promise.all([api.conversations(), api.evaluationsAll(), api.reference().catch(() => ({ labels: {} }))]);
  const rows = buildRows(convs, evals);

  if (!rows.length) {
    el.innerHTML = `<div class="page-head"><h1 class="grow">Аналитика</h1></div>
      <section class="sheet state-box"><h2>Пока нечего анализировать</h2>
      <p class="muted">Оцените диалоги на странице «Диалоги», и здесь появятся сводки по критериям, языкам и точности ИИ.</p>
      <p><a class="btn" href="#/conversations">К диалогам</a></p></section>`;
    return;
  }

  const totals = rows.map((r) => r.s.total).filter((x) => x !== null);
  const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
  const gross = rows.filter((r) => r.s.gross_error);
  // ---- where points are lost (criteria of the newest checklist version) ----
  const newest = rows.reduce((a, r) => (r.e.checklist_version > a.e.checklist_version ? r : a)).cl;
  const critStats = newest.criteria
    .filter((c) => c.type !== 'flag')
    .map((c) => {
      const st = { c, pass: 0, partial: 0, fail: 0, na: 0, n: 0, lost: 0, lostN: 0 };
      for (const r of rows) {
        if (!(c.id in r.answers)) continue;
        const x = r.s.criteria[c.id];
        const cls = verdictClass(c.type, r.answers[c.id], x.points, x.effective_weight);
        st[cls === 'gross' ? 'fail' : cls]++;
        st.n++;
        if (x.applicable) {
          st.lost += x.effective_weight - x.points;
          st.lostN++;
        }
      }
      st.avgLost = st.lostN ? st.lost / st.lostN : 0;
      return st;
    })
    .filter((st) => st.n)
    .sort((a, b) => b.avgLost - a.avgLost);

  // ---- score distribution ----
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, n: 0 }));
  for (const t of totals) bins[Math.min(9, Math.floor(t / 10))].n++;
  const binMax = Math.max(1, ...bins.map((b) => b.n));

  // ---- by language / channel ----
  const groups = {};
  for (const r of rows) {
    for (const key of [`Язык ${r.lang}`, `Канал: ${CHANNEL[r.channel] || r.channel}`]) {
      const g = (groups[key] ||= { key, n: 0, sum: 0, scored: 0, gross: 0 });
      g.n++;
      if (r.s.total !== null) {
        g.sum += r.s.total;
        g.scored++;
      }
      if (r.s.gross_error) g.gross++;
    }
  }
  const groupList = Object.values(groups).map((g) => ({ ...g, avg: g.scored ? g.sum / g.scored : null }));

  // ---- AI accuracy vs reference labels ----
  const acc = accuracy(rows, ref.labels || {});

  // ---- checklist version changes ----
  const changes = versionChanges(evals);

  el.innerHTML = `
    <div class="page-head">
      <div class="grow"><h1>Аналитика</h1>
        <p class="muted">По последней оценке каждого диалога, с учётом апелляций.</p></div>
      <button class="ghost" id="csv">Скачать CSV</button>
    </div>

    <section class="sheet"><div class="stats">
      <div class="stat"><b>${rows.length}<small class="muted" style="font-size:14px;font-weight:400"> из ${convs.length}</small></b><span>диалогов оценено</span></div>
      <div class="stat"><b>${fmt(avg, 1)}</b><span>средний балл</span></div>
      <div class="stat ${gross.length ? 'alert' : ''}"><b>${gross.length}</b><span>с грубыми ошибками</span></div>
      <div class="stat"><b>${convs.filter((c) => c.has_open_appeal).length}</b><span>открытых апелляций</span></div>
    </div></section>

    <div class="dash-grid">
      <section class="sheet dash-wide" aria-labelledby="h-lost">
        <div class="dash-head"><h2 id="h-lost">Где операторы теряют баллы</h2>
          <div class="legend" aria-hidden="true">
            <span><i class="sw pass"></i>Выполнено</span><span><i class="sw partial"></i>Частично</span><span><i class="sw fail"></i>Не выполнено</span><span><i class="sw na"></i>N/A</span>
          </div></div>
        <p class="muted dash-sub">Критерии отсортированы по среднему числу потерянных баллов в применимых диалогах.</p>
        <div class="lost-list">${critStats
          .map(
            (st) => `<div class="lost-row">
              <div class="lost-name">${esc(st.c.name)}</div>
              <div class="stack" role="img" aria-label="${esc(`${st.c.name}: выполнено ${st.pass}, частично ${st.partial}, не выполнено ${st.fail}, N/A ${st.na} из ${st.n}`)}">
                ${seg('pass', st.pass, st.n, `Выполнено: ${st.pass} из ${st.n}`)}${seg('partial', st.partial, st.n, `Частично: ${st.partial} из ${st.n}`)}${seg('fail', st.fail, st.n, `Не выполнено: ${st.fail} из ${st.n}`)}${seg('na', st.na, st.n, `N/A: ${st.na} из ${st.n}`)}
              </div>
              <div class="lost-num"><b>${st.avgLost >= 0.05 ? '−' + fmt(st.avgLost, 1) : '0'}</b><small>баллов в среднем</small></div>
              <div class="lost-fail">${st.fail ? `<b>${Math.round((st.fail / st.n) * 100)}%</b><small>не выполнено</small>` : '<small class="muted">нарушений нет</small>'}</div>
            </div>`,
          )
          .join('')}</div>
      </section>

      <section class="sheet" aria-labelledby="h-dist">
        <div class="dash-head"><h2 id="h-dist">Распределение итоговых баллов</h2></div>
        <p class="muted dash-sub">${totals.length} диалогов с рассчитанным итогом, медиана ${fmt(median(totals), 1)}.</p>
        <div class="hist" role="img" aria-label="Гистограмма итоговых баллов по десяткам">
          ${bins
            .map(
              (b) => `<div class="hist-col" data-tip="${b.from}–${b.to}: ${b.n} ${plural(b.n, 'диалог', 'диалога', 'диалогов')}" tabindex="0">
                <span class="hist-n">${b.n || ''}</span>
                <span class="hist-bar" style="height:${(b.n / binMax) * 100}%"></span>
              </div>`,
            )
            .join('')}
        </div>
        <div class="hist-axis" aria-hidden="true">${bins.map((b) => `<span>${b.from}</span>`).join('')}<span>100</span></div>
      </section>

      <section class="sheet" aria-labelledby="h-groups">
        <div class="dash-head"><h2 id="h-groups">Языки и каналы</h2></div>
        <table class="grid compact">
          <thead><tr><th>Группа</th><th class="r">Диалогов</th><th>Средний балл</th><th class="r">Грубых</th></tr></thead>
          <tbody>${groupList
            .map(
              (g) => `<tr><td>${esc(g.key)}</td><td class="r">${g.n}</td>
                <td><div class="mini"><span class="mini-bar" style="width:${g.avg ?? 0}%"></span><b>${fmt(g.avg, 1)}</b></div></td>
                <td class="r ${g.gross ? 'error' : ''}">${g.gross}</td></tr>`,
            )
            .join('')}</tbody>
        </table>
      </section>

      <section class="sheet" aria-labelledby="h-gross">
        <div class="dash-head"><h2 id="h-gross">Грубые ошибки</h2></div>
        ${
          gross.length
            ? `<ul class="plain">${gross
                .map((r) => {
                  const flag = r.e.criteria.find((x) => r.cl.criteria.find((c) => c.id === x.criterion_id)?.type === 'flag' && r.answers[x.criterion_id] === 'yes');
                  return `<li><a href="#/conversations/${encodeURIComponent(r.e.conversation_id)}?c=${encodeURIComponent(flag?.criterion_id || '')}">${esc(r.e.conversation_id)}</a>
                    <span class="flag">${esc(GROSS[flag?.gross_error_type] || 'нарушение')}</span><br><span class="muted">${esc(trim(flag?.explanation, 140))}</span></li>`;
                })
                .join('')}</ul>`
            : '<p class="muted dash-sub">Грубых ошибок не найдено.</p>'
        }
      </section>

      <section class="sheet" aria-labelledby="h-acc">
        <div class="dash-head"><h2 id="h-acc">Точность ИИ на эталонной разметке</h2></div>
        ${
          acc.n
            ? `<p class="dash-sub"><span class="big">${fmt(acc.overall * 100, 0)}%</span> совпадений по ${acc.cells} оценкам критериев в ${acc.n} диалогах.
                Средняя разница итога ${fmt(acc.mae, 1)} балла. Грубые ошибки: найдено ${acc.gross.tp}, пропущено ${acc.gross.fn}, ложных ${acc.gross.fp}.</p>
               <div class="acc-list">${acc.per
                 .map((p) => `<div class="acc-row" data-tip="${esc(`${p.name}: ${p.ok} из ${p.n}`)}" tabindex="0"><span>${esc(p.name)}</span><span class="mini"><span class="mini-bar" style="width:${p.rate * 100}%"></span></span><b>${fmt(p.rate * 100, 0)}%</b></div>`)
                 .join('')}</div>
               ${judgeBlock(acc)}
               ${acc.misses.length ? `<details class="dash-sub"><summary>Расхождения (${acc.misses.length})</summary><ul class="plain">${acc.misses
                 .slice(0, 30)
                 .map((m) => `<li><a href="#/conversations/${encodeURIComponent(m.id)}?c=${encodeURIComponent(m.c)}">${esc(m.id)}, ${esc(m.name)}</a>: оценка ${esc(String(m.pred))}, эталон ${esc(String(m.truth))}</li>`)
                 .join('')}</ul></details>` : ''}`
            : `<p class="muted dash-sub">Нет диалогов с эталонной разметкой среди оценённых${acc.testSkipped ? ` (тестовые оценки без ИИ не учитываются: ${acc.testSkipped})` : ''}. Разметьте диалоги на странице <a href="#/labeling">Разметка</a>.</p>`
        }
        <p class="muted dash-sub">${labelSource(ref)}</p>
      </section>

      ${changes.length ? `<section class="sheet dash-wide" aria-labelledby="h-ver">
        <div class="dash-head"><h2 id="h-ver">Как изменились баллы</h2></div>
        <table class="grid compact"><thead><tr><th>Диалог</th><th>Было</th><th>Стало</th><th class="r">Изменение</th><th>Критерии</th></tr></thead><tbody>${changes
          .map(
            (ch) => `<tr><td><a href="#/conversations/${encodeURIComponent(ch.id)}">${esc(ch.id)}</a></td>
              <td>${fmt(ch.from.total, 2)}</td><td>${fmt(ch.to.total, 2)}</td>
              <td class="r ${ch.delta < 0 ? 'error' : ch.delta > 0 ? 'good' : ''}">${ch.delta > 0 ? '+' : ''}${fmt(ch.delta, 2)}</td>
              <td class="muted">${esc(ch.diff)}</td></tr>`,
          )
          .join('')}</tbody></table>
      </section>` : ''}
    </div>
    <div class="tooltip" id="tip" role="tooltip" hidden></div>`;

  // hover / focus tooltips
  const tip = el.querySelector('#tip');
  const show = (t, x, y) => {
    tip.textContent = t;
    tip.hidden = false;
    tip.style.left = `${x + 12}px`;
    tip.style.top = `${y + 12}px`;
  };
  el.querySelectorAll('[data-tip]').forEach((n) => {
    n.addEventListener('mousemove', (e) => show(n.dataset.tip, e.clientX, e.clientY));
    n.addEventListener('mouseleave', () => (tip.hidden = true));
    n.addEventListener('focus', () => {
      const r = n.getBoundingClientRect();
      show(n.dataset.tip, r.left, r.top);
    });
    n.addEventListener('blur', () => (tip.hidden = true));
  });

  el.querySelector('#csv').onclick = () => downloadCsv(rows);
}

function seg(cls, n, total, tip) {
  if (!n) return '';
  return `<span class="stack-seg ${cls}" style="flex:${n} 1 0" data-tip="${esc(tip)}" tabindex="0">${n / total >= 0.12 ? n : ''}</span>`;
}

function accuracy(rows, labels) {
  const per = {};
  let ok = 0, cells = 0, maeSum = 0, maeN = 0;
  const gross = { tp: 0, fp: 0, fn: 0 };
  const misses = [];
  let n = 0;
  const judge = { judge_a: { ok: 0, n: 0 }, judge_b: { ok: 0, n: 0 }, final: { ok: 0, n: 0 } };
  const adj = { disagreements: 0, finalRight: 0, aRight: 0, bRight: 0, sharedWrong: 0 };
  let testSkipped = 0;
  for (const r of rows) {
    const lab = labels[r.e.conversation_id];
    if (!lab) continue;
    if (r.e.provenance?.mock) {
      testSkipped++; // test evaluations without a model say nothing about accuracy
      continue;
    }
    n++;
    const truth = {};
    for (const c of r.cl.criteria) {
      if (!(c.id in lab.answers)) continue;
      let t;
      try {
        t = normalizeAnswer(c, lab.answers[c.id]);
      } catch {
        continue;
      }
      truth[c.id] = t;
      const res = r.e.criteria.find((x) => x.criterion_id === c.id);
      const p = res?.answer; // AI's own answer, before appeals
      // Per-judge comparison on the same cells: was the second judge + arbiter worth it?
      const ja = res?.judge_answers;
      const norm = (v) => {
        try {
          return v === undefined ? undefined : normalizeAnswer(c, v);
        } catch {
          return undefined;
        }
      };
      const a = norm(ja?.judge_a);
      const b = norm(ja?.judge_b);
      if (a !== undefined && b !== undefined) {
        for (const [role, v] of [['judge_a', a], ['judge_b', b], ['final', p]]) {
          judge[role].n++;
          if (v === t) judge[role].ok++;
        }
        if (a !== b) {
          adj.disagreements++;
          if (p === t) adj.finalRight++;
          if (a === t) adj.aRight++;
          if (b === t) adj.bRight++;
        } else if (a !== t) adj.sharedWrong++;
      }
      const hit = p === t;
      (per[c.id] ||= { id: c.id, name: c.name, ok: 0, n: 0 }).n++;
      if (hit) per[c.id].ok++, ok++;
      else misses.push({ id: r.e.conversation_id, c: c.id, name: c.name, pred: p, truth: t });
      cells++;
      if (c.type === 'flag') {
        if (t === 'yes' && p === 'yes') gross.tp++;
        else if (t === 'no' && p === 'yes') gross.fp++;
        else if (t === 'yes' && p !== 'yes') gross.fn++;
      }
    }
    if (Object.keys(truth).length === r.cl.criteria.length) {
      const ts = computeScore(r.cl, truth).total;
      const ps = r.e.score.total;
      if (ts !== null && ps !== null) {
        maeSum += Math.abs(ts - ps);
        maeN++;
      }
    }
  }
  return {
    n,
    cells,
    overall: cells ? ok / cells : 0,
    mae: maeN ? maeSum / maeN : null,
    gross,
    misses,
    per: Object.values(per).map((p) => ({ ...p, rate: p.ok / p.n })),
    judge,
    adj,
    testSkipped,
  };
}

function versionChanges(evals) {
  const byConv = {};
  for (const e of evals) (byConv[e.conversation_id] ||= []).push(e);
  const out = [];
  for (const [id, list] of Object.entries(byConv)) {
    const newestPerVersion = {};
    for (const e of list) if (!newestPerVersion[e.checklist_version]) newestPerVersion[e.checklist_version] = e; // list is newest first
    const vs = Object.keys(newestPerVersion).map(Number).sort((a, b) => a - b);
    if (vs.length < 2) continue;
    const a = newestPerVersion[vs[vs.length - 2]];
    const b = newestPerVersion[vs[vs.length - 1]];
    const ta = (a.final ?? a.score).total;
    const tb = (b.final ?? b.score).total;
    const ida = new Set(a.checklist_snapshot.criteria.map((c) => c.id));
    const idb = new Set(b.checklist_snapshot.criteria.map((c) => c.id));
    const added = [...idb].filter((x) => !ida.has(x));
    const removed = [...ida].filter((x) => !idb.has(x));
    const diff = [added.length ? `добавлены ${added.join(', ')}` : '', removed.length ? `удалены ${removed.join(', ')}` : ''].filter(Boolean).join('; ') || 'изменены формулировки или веса';
    out.push({ id, from: { v: a.checklist_version, total: ta }, to: { v: b.checklist_version, total: tb }, delta: (tb ?? 0) - (ta ?? 0), diff });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/** Latest evaluation per conversation, with appeal decisions applied. */
function buildRows(convs, evals) {
  const latest = new Map();
  for (const e of evals) if (!latest.has(e.conversation_id)) latest.set(e.conversation_id, e); // evals are newest first
  const convById = Object.fromEntries(convs.map((c) => [c.conversation_id, c]));
  return [...latest.values()].map((e) => {
    const cl = e.checklist_snapshot;
    const answers = Object.fromEntries(e.criteria.map((r) => [r.criterion_id, e.final?.overrides?.[r.criterion_id]?.answer ?? r.answer]));
    const conv = convById[e.conversation_id] || {};
    return { e, cl, answers, s: computeScore(cl, answers), lang: conv.language || '?', channel: conv.channel || '?' };
  });
}

/** Used by the list page's "Скачать CSV" button. */
export async function exportAllCsv() {
  const [convs, evals] = await Promise.all([api.conversations(), api.evaluationsAll()]);
  const rows = buildRows(convs, evals);
  if (!rows.length) throw new Error('Нет оценённых диалогов для выгрузки');
  downloadCsv(rows);
}

// Spreadsheet formula injection: a cell starting with = + - @ (or a tab/CR) is run as a formula by
// Excel. Such cells are prefixed with an apostrophe so they stay text.
const cell = (v) => {
  const t = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
};

function downloadCsv(rows) {
  const ids = [...new Set(rows.flatMap((r) => r.cl.criteria.map((c) => c.id)))];
  // *_ai = the system's original automatic answer; *_final = after reviewer decisions on appeals.
  const head = [
    'conversation_id', 'language', 'channel', 'checklist_version', 'is_test',
    'total_ai', 'total_final', 'gross_error_ai', 'gross_error_final',
    ...ids.flatMap((id) => [`${id}_ai`, `${id}_final`]),
    'appeals_changed', 'evaluated_at', 'model', 'transcript_hash', 'checklist_hash',
  ];
  const lines = [head.join(';')];
  for (const r of rows) {
    const orig = Object.fromEntries(r.e.criteria.map((x) => [x.criterion_id, x.answer]));
    const changed = Object.keys(r.e.final?.overrides || {}).length;
    lines.push(
      [
        r.e.conversation_id, r.lang, r.channel, r.e.checklist_version, r.e.provenance?.mock ? 'yes' : 'no',
        r.e.score.total ?? '', r.s.total ?? '', r.e.score.gross_error ? 'yes' : 'no', r.s.gross_error ? 'yes' : 'no',
        ...ids.flatMap((id) => [orig[id] ?? '', r.answers[id] ?? '']),
        changed, r.e.created_at, r.e.model, r.e.provenance?.transcript_hash ?? '', r.e.provenance?.checklist_hash ?? '',
      ]
        .map(cell)
        .join(';'),
    );
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }); // BOM so Excel reads Cyrillic
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cqa-results-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Judge A alone vs judge B alone vs the final answer, on the same labelled cells. */
function judgeBlock(acc) {
  const { judge, adj } = acc;
  if (!judge.final.n) {
    return '<p class="muted dash-sub">Сравнение судей появится для оценок, сделанных двумя судьями (режимы ai_eval или ensemble).</p>';
  }
  const pct = (x) => (x.n ? fmt((x.ok / x.n) * 100, 0) + '%' : '—');
  return `<table class="grid compact judge-table">
      <thead><tr><th>Кто отвечал</th><th class="r">Совпадений с эталоном</th></tr></thead>
      <tbody>
        <tr><td>Только судья A</td><td class="r">${pct(judge.judge_a)}</td></tr>
        <tr><td>Только судья B</td><td class="r">${pct(judge.judge_b)}</td></tr>
        <tr><td><b>Итог: два судьи и арбитр</b></td><td class="r"><b>${pct(judge.final)}</b></td></tr>
      </tbody></table>
    <p class="muted dash-sub">${judge.final.n} оценок критериев. Судьи разошлись в ${adj.disagreements}: итог верен в ${adj.finalRight}, судья A был прав в ${adj.aRight}, судья B в ${adj.bRight}.
      Оба судьи согласились, но ошиблись: ${adj.sharedWrong}.</p>`;
}

function labelSource(ref) {
  if (ref.status === 'human') {
    return `Эталон: разметка проверяющих вслепую (${(ref.reviewers || []).length} чел., ${Object.keys(ref.labels || {}).length} диалогов). Спорных ячеек, исключённых из расчёта: ${(ref.disputed || []).length}.`;
  }
  if (ref.status === 'draft') return 'Эталон: черновая разметка, подготовленная с помощью ИИ и не проверенная людьми. Для честной оценки разметьте диалоги вслепую на странице «Разметка».';
  return 'Эталонной разметки пока нет.';
}

const fmt = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : String(Math.round(x * 10 ** d) / 10 ** d).replace('.', ','));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const trim = (s, n) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);
