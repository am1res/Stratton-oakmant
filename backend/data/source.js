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

export function normalizeRecord(r) {
  const abs = r.transcript.map((t) => parseTimestamp(t.timestamp));
  const first = abs.find((x) => x !== null) ?? 0;
  const transcript = r.transcript.map((t, i) => ({
    msg_index: i,
    timestamp: t.timestamp,
    offset_sec: abs[i] === null ? null : Math.round((abs[i] - first) * 10) / 10,
    speaker: t.speaker,
    text: t.text,
  }));
  if (r.audio_url && /^https?:/.test(r.audio_url)) signedAudio.set(r.conversation_id, r.audio_url);
  return {
    conversation_id: r.conversation_id,
    channel: r.channel,
    language: r.language,
    audio_url: r.audio_url ? `/api/conversations/${encodeURIComponent(r.conversation_id)}/audio` : null,
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
