// Loads conversations from the organizers' API (or a local file) and normalises them.
// Owner: P1.
//
// - Always decodes the response as UTF-8 (the API sends no charset; browsers show mojibake).
// - Adds msg_index and offset_sec to every transcript line; keeps the original timestamp.
// - Keeps signed audio links server-side only: the frontend gets /api/conversations/:id/audio.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT } from '../config.js';

const signedAudio = new Map(); // conversation_id -> real audio_url (never sent to the browser)

export function parseTimestamp(ts) {
  if (/^\d{1,3}:\d{2}$/.test(ts)) {
    const [m, s] = ts.split(':').map(Number);
    return m * 60 + s;
  }
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t / 1000;
}

// System events that control the call recording (RU / EN / KZ wording seen in the data).
const REC_EVENT = /запис|record|жазу|транскрипц/i;
const REC_START = /запущен|started|басталды/i;
const REC_PAUSE = /приостановлен|paused|тоқтатыл/i;
const REC_RESUME = /возобновлен|resumed|жалғас/i;

/**
 * Seconds into the AUDIO FILE for each line.
 * Calls: counted from the "recording started" event, and paused parts ("Запись ... приостановлены"
 * → "возобновлены") are cut out, because the audio file does not contain them (checked on the DEV
 * calls: real file lengths match this, not the wall-clock length). Lines said while recording was
 * paused get recorded=false and are pinned to the moment the pause began.
 * Chats: seconds since the first line, as before.
 */
export function audioOffsets(transcript) {
  const abs = transcript.map((t) => parseTimestamp(t.timestamp));
  const isCall = transcript.some((t) => /T\d{2}:\d{2}/.test(t.timestamp || ''));
  let start = abs.find((x) => x !== null) ?? 0;
  if (isCall) {
    const i = transcript.findIndex((t) => t.speaker === 'system' && REC_EVENT.test(t.text) && REC_START.test(t.text));
    if (i >= 0 && abs[i] !== null) start = abs[i];
  }
  let pausedTotal = 0;
  let pausedSince = null;
  return transcript.map((t, i) => {
    const a = abs[i];
    if (a === null) return { offset_sec: null, recorded: pausedSince === null };
    if (isCall && t.speaker === 'system' && REC_EVENT.test(t.text)) {
      if (REC_PAUSE.test(t.text) && pausedSince === null) pausedSince = a;
      else if (REC_RESUME.test(t.text) && pausedSince !== null) {
        pausedTotal += a - pausedSince;
        pausedSince = null;
      }
    }
    const current = pausedSince !== null ? a - pausedSince : 0;
    const sec = Math.max(0, a - start - pausedTotal - current);
    return { offset_sec: Math.round(sec * 10) / 10, recorded: pausedSince === null };
  });
}

// ---- operator + date for the "Операторы" page ----
// The organizers' data has no operator and no date (chats only have MM:SS). Until it does, each
// conversation gets a DEMO operator name and date, picked deterministically from its id (same
// answer on every run, new datasets get them automatically). Real fields always win:
// operator_id / operator_name / agent in the record, a date field, or the call's real timestamp.
// DEMO_OPERATORS=0 in .env turns the demo values off. Scores are never touched.
export const DEMO_OPERATOR_NAMES = ['Дамир', 'Мирас', 'Айгерим', 'Алина', 'Ержан', 'Валерия'];
const DEMO_START = Date.UTC(2026, 8, 14); // Monday 14 Sep 2026: an 8-week demo period ending 8 Nov
const DEMO_DAYS = 56;

function fnv(s) {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h;
}

// Optional "scenario" arrangement (button on the Операторы page): conversation_id → {operator, date},
// computed from real scores and saved in storage/demo_operators.json. Overrides the random demo
// values only; real fields still win. Conversations not in it keep the random demo values.
let arranged = {};
export function setDemoArrangement(map) {
  arranged = map || {};
}

export function operatorAndDate(r) {
  const realOp = r.operator_name || r.operator_id || r.agent_name || r.agent_id || r.agent || null;
  const realDate = r.date || r.created_at || null;
  const isoTs = (r.transcript || []).map((t) => t.timestamp).find((t) => /^\d{4}-\d{2}-\d{2}T/.test(t || ''));
  const demo = config.demo.operators;
  const id = String(r.conversation_id);
  const a = demo ? arranged[id] : null;
  const op = realOp
    ? { operator: String(realOp), operator_source: 'data' }
    : demo
      ? { operator: a?.operator || DEMO_OPERATOR_NAMES[fnv(`op:${id}`) % DEMO_OPERATOR_NAMES.length], operator_source: 'demo' }
      : { operator: null, operator_source: 'none' };
  let date = null;
  let date_source = 'none';
  if (realDate && !Number.isNaN(Date.parse(realDate))) [date, date_source] = [new Date(realDate).toISOString().slice(0, 10), 'data'];
  else if (isoTs) [date, date_source] = [isoTs.slice(0, 10), 'call'];
  else if (demo) [date, date_source] = [a?.date || new Date(DEMO_START + (fnv(`date:${id}`) % DEMO_DAYS) * 86400000).toISOString().slice(0, 10), 'demo'];
  return { ...op, date, date_source };
}

/**
 * Scenario arrangement from real scores. items: [{id, score, isCall, gross}] (scored conversations).
 * A dialog with a gross error counts as weak when choosing groups (a "consistently strong" operator
 * must not have one), whatever its score.
 * Calls keep their real date, so they go to the "ordinary" operators and never shape a trend.
 *   Дамир   — consistently strong: the top scores, spread over the whole period
 *   Ержан   — consistently weak: the bottom scores, spread over the period
 *   Айгерим — improving: her dialogs sorted by score, low ones early, high ones late
 *   Мирас   — declining: high ones early, low ones late
 *   Алина, Валерия — ordinary: the rest, in random order, + all calls
 */
export function arrangeScenarios(items) {
  const rank = (x) => (x.gross ? x.score - 1000 : x.score);
  const chats = items.filter((x) => !x.isCall).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const calls = items.filter((x) => x.isCall);
  const k = Math.max(3, Math.round(chats.length / 6));
  const weak = chats.slice(0, k);
  const strong = chats.slice(-k);
  const middle = chats.slice(k, chats.length - k);
  // the middle pool is dealt out in score order, so both trend operators get low AND high scores
  const up = [];
  const down = [];
  const rest = [];
  middle.forEach((x, i) => (i % 4 === 0 ? up : i % 4 === 1 ? down : rest).push(x));
  // make the trends visible: each trend operator also gets one weak and one strong dialog
  // (sorting by score below puts them at the right end of the period)
  if (weak.length >= 4 && strong.length >= 4) {
    up.push(weak.pop(), strong.shift());
    down.push(weak.pop(), strong.shift());
  }
  const spread = (list, order) => {
    const sorted = order === 'asc' ? [...list].sort((a, b) => a.score - b.score) : order === 'desc' ? [...list].sort((a, b) => b.score - a.score) : [...list].sort((a, b) => fnv(a.id) - fnv(b.id));
    return sorted.map((x, i) => {
      const day = sorted.length === 1 ? DEMO_DAYS / 2 : Math.round((i * (DEMO_DAYS - 3)) / (sorted.length - 1)) + (fnv(`j:${x.id}`) % 3);
      return [x.id, new Date(DEMO_START + day * 86400000).toISOString().slice(0, 10)];
    });
  };
  const out = {};
  const put = (name, list, order) => spread(list, order).forEach(([id, date]) => (out[id] = { operator: name, date }));
  put('Дамир', strong, 'mix');
  put('Ержан', weak, 'mix');
  put('Айгерим', up, 'asc');
  put('Мирас', down, 'desc');
  const r = [...rest].sort((a, b) => fnv(a.id) - fnv(b.id));
  put('Алина', r.filter((_, i) => i % 2 === 0), 'mix');
  put('Валерия', r.filter((_, i) => i % 2 === 1), 'mix');
  calls.forEach((x, i) => (out[x.id] = { operator: i % 2 ? 'Валерия' : 'Алина', date: null }));
  return out;
}

export function normalizeRecord(r) {
  const offsets = audioOffsets(r.transcript);
  const transcript = r.transcript.map((t, i) => ({
    msg_index: i,
    timestamp: t.timestamp,
    offset_sec: offsets[i].offset_sec,
    recorded: offsets[i].recorded,
    speaker: t.speaker,
    text: t.text,
  }));
  if (r.audio_url && /^https?:/.test(r.audio_url)) signedAudio.set(r.conversation_id, r.audio_url);
  return {
    conversation_id: r.conversation_id,
    channel: r.channel,
    language: r.language,
    audio_url: r.audio_url ? `/api/conversations/${encodeURIComponent(r.conversation_id)}/audio` : null,
    ...operatorAndDate(r),
    transcript,
    source: r.source || 'api',
  };
}

export function getSignedAudioUrl(id) {
  return signedAudio.get(id) || null;
}

function parsePayload(text) {
  const json = JSON.parse(text.replace(/^﻿/, ''));
  if (Array.isArray(json)) return json;
  if (json.isSuccess === false) throw new Error(`API error: ${json.error || 'isSuccess=false'}`);
  const records = json.data?.records ?? json.records;
  if (!Array.isArray(records)) throw new Error('Unexpected payload: no data.records');
  return records;
}

export async function fetchFromApi(groupId = config.api.groupId) {
  if (!config.api.base) throw new Error('CQA_API_BASE is not set in .env');
  const url = `${config.api.base}${config.api.base.includes('?') ? '&' : '?'}group_id=${encodeURIComponent(groupId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const text = Buffer.from(await res.arrayBuffer()).toString('utf-8');
  const records = parsePayload(text);
  await fs.mkdir(config.paths.cache, { recursive: true });
  await fs.writeFile(path.join(config.paths.cache, `${groupId}.json`), JSON.stringify(records, null, 1), 'utf-8');
  return records;
}

/** Load records: CQA_DATA_FILE > API > cached copy. Returns normalised conversations. */
export async function loadConversations({ groupId = config.api.groupId, refresh = false } = {}) {
  let records;
  if (config.api.dataFile && !refresh) {
    records = parsePayload(await fs.readFile(path.resolve(ROOT, config.api.dataFile), 'utf-8'));
  } else {
    try {
      records = refresh || !(await cacheExists(groupId)) ? await fetchFromApi(groupId) : await readCache(groupId);
    } catch (e) {
      if (await cacheExists(groupId)) {
        console.warn(`[data] API failed (${e.message}), using cached ${groupId}`);
        records = await readCache(groupId);
      } else throw e;
    }
  }
  return records.map((r) => ({ ...normalizeRecord(r), group_id: groupId }));
}

async function cacheExists(groupId) {
  try {
    await fs.access(path.join(config.paths.cache, `${groupId}.json`));
    return true;
  } catch {
    return false;
  }
}

async function readCache(groupId) {
  return JSON.parse(await fs.readFile(path.join(config.paths.cache, `${groupId}.json`), 'utf-8'));
}
