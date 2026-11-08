// Call audio: turns the organizers' audio_url into a playable local file. Owner: P2.
//
// Why: the organizers' audio_url does NOT return audio. It returns a small HTML player page
// ("Воспроизведение записи") whose <audio><source src="..."> points to the real mp3 in Dynamics
// file storage, and that inner link EXPIRES after about one hour. So we:
//   1. look for a local copy first (storage/audio/, then the voice pipeline's voice/out/audio/),
//   2. otherwise fetch audio_url; if it is audio, keep it; if it is the HTML page, follow the
//      <source src> link right away and download the mp3,
//   3. save it to storage/audio/<id>.<ext>, so later plays and seeks never touch the expiring link.
// The server then serves the file with Range support (seeking works in the browser).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm' };
const inFlight = new Map(); // conversation_id -> Promise, so parallel requests download once

/** Detect an audio format from the first bytes. Returns an extension or null. */
export function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return ((buf[1] >> 1) & 3) === 0 ? 'aac' : 'mp3';
  const head4 = buf.subarray(0, 4).toString('latin1');
  if (head4 === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';
  if (head4 === 'OggS') return 'ogg';
  if (head4 === 'fLaC') return 'flac';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

const decodeHtml = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** All <source src> / <audio src> links in an HTML page. */
export function mediaLinks(html) {
  const re = /<(?:source|audio)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  return [...html.matchAll(re)].map((m) => decodeHtml(m[1]));
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`audio HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Bytes from audio_url → { buf, ext }. Follows the HTML player page if needed. */
export async function resolveAudio(url) {
  const first = await download(url);
  const ext = sniffAudio(first);
  if (ext) return { buf: first, ext };
  const text = first.toString('utf-8');
  const links = mediaLinks(text);
  if (!links.length) throw new Error(`audio link returned no audio and no player link (starts with: ${text.slice(0, 60).replace(/\s+/g, ' ')})`);
  let lastErr;
  for (const link of links) {
    try {
      const buf = await download(link);
      const e = sniffAudio(buf);
      if (e) return { buf, ext: e };
      lastErr = new Error('player link did not return audio');
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`could not download the recording from the player page (${lastErr?.message}). The inner link expires after ~1 hour; just try again.`);
}

const safe = (id) => String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');

async function findLocal(id) {
  const dirs = [path.join(config.paths.storage, 'audio'), path.join(config.paths.voiceOut, 'audio')];
  for (const dir of dirs) {
    for (const ext of Object.keys(MIME)) {
      const file = path.join(dir, `${safe(id)}.${ext}`);
      try {
        const fh = await fs.open(file, 'r');
        const { buffer } = await fh.read(Buffer.alloc(16), 0, 16, 0);
        await fh.close();
        if (sniffAudio(buffer)) return { file, mime: MIME[ext] };
      } catch {
        /* not there */
      }
    }
  }
  return null;
}

/** Local path + mime of the recording, downloading it once if needed. */
export async function getAudioFile(id, signedUrl) {
  const local = await findLocal(id);
  if (local) return local;
  if (!signedUrl) return null;
  if (!inFlight.has(id)) {
    inFlight.set(
      id,
      (async () => {
        const { buf, ext } = await resolveAudio(signedUrl);
        const dir = path.join(config.paths.storage, 'audio');
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${safe(id)}.${ext}`);
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, buf);
        await fs.rename(tmp, file);
        return { file, mime: MIME[ext] };
      })().finally(() => inFlight.delete(id)),
    );
  }
  return inFlight.get(id);
}
