// Score strip: each weighted criterion is a segment, width = effective weight, fill = points earned.
// N/A criteria drop out (their weight is redistributed, so the others widen) and appear as hatched
// ticks at the end. Gross-error flags are not segments: they carry no points.
import { esc, fmtAnswer } from './api.js';

/** Classify a criterion result for colour: pass | partial | fail | na. */
export function verdictClass(type, answer, points, effectiveWeight) {
  if (answer === 'na') return 'na';
  if (type === 'flag') return answer === 'yes' ? 'gross' : 'pass';
  if (type === 'binary') return answer === 'yes' ? 'pass' : 'fail';
  if (!effectiveWeight) return 'na';
  const share = points / effectiveWeight;
  return share >= 0.999 ? 'pass' : share <= 0.001 ? 'fail' : 'partial';
}

/**
 * @param items [{id, name, type, answer, points, effective_weight}]
 * @param opts.large  bigger strip with a legend of criterion ids (for the card)
 */
export function stripHtml(items, { large = false } = {}) {
  const weighted = items.filter((c) => c.type !== 'flag');
  const applicable = weighted.filter((c) => c.answer !== 'na');
  const na = weighted.filter((c) => c.answer === 'na');
  const seg = (c) => {
    const cls = verdictClass(c.type, c.answer, c.points, c.effective_weight);
    const fill = c.effective_weight ? Math.max(0, Math.min(1, c.points / c.effective_weight)) * 100 : 0;
    const label = `${c.id} ${c.name}: ${fmtAnswer(c.answer)}, ${round(c.points)} из ${round(c.effective_weight)}`;
    return `<span class="seg-w ${cls}" data-crit="${esc(c.id)}" style="flex:${c.effective_weight} 1 0" title="${esc(label)}" aria-label="${esc(label)}"><i style="width:${fill}%"></i></span>`;
  };
  const strip = `<div class="strip${large ? ' lg' : ''}" role="img" aria-label="Структура оценки">${applicable.map(seg).join('')}${
    na.length ? `<span class="na-group">${na.map((c) => `<span class="na-tick" data-crit="${esc(c.id)}" title="${esc(`${c.id} ${c.name}: N/A, вес перераспределён`)}"></span>`).join('')}</span>` : ''
  }</div>`;
  if (!large) return strip;
  const legend = `<div class="strip-legend" aria-hidden="true">${applicable
    .map((c) => `<span style="flex:${c.effective_weight} 1 0">${esc(c.id)}</span>`)
    .join('')}${na.length ? `<span style="flex:0 0 auto;margin-left:6px">N/A: ${na.map((c) => esc(c.id)).join(', ')}</span>` : ''}</div>`;
  return strip + legend;
}

const round = (x) => (x === null || x === undefined ? 0 : Math.round(x * 100) / 100);
