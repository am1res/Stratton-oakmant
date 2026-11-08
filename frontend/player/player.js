// Audio player for calls. Owner: P3.
// The audio streams through the backend proxy (/api/conversations/:id/audio), so the signed
// link never reaches the browser. If the recording can't be played inline, we say so and offer
// to open it in a new tab.
// offset_sec = seconds into the audio file (calls: from "recording started", with paused parts cut
// out; see backend/data/source.js). On the DEV calls speech starts ~1-1.5 s after offset_sec, and
// seek() starts 1 s early, so the start of the phrase is always heard. Adjust OFFSET_SHIFT if needed.
import { esc } from '../common/api.js';

const OFFSET_SHIFT = 0;

export function createPlayer(el, url, { onTime } = {}) {
  el.innerHTML = `<div class="player">
    <audio controls preload="metadata" src="${esc(url)}"></audio>
    <div class="player-row">
      <label class="check"><input type="checkbox" data-follow checked> Прокручивать транскрипт за записью</label>
      <span class="muted" data-status aria-live="polite"></span>
    </div>
  </div>`;
  const audio = el.querySelector('audio');
  const status = el.querySelector('[data-status]');
  const follow = el.querySelector('[data-follow]');

  audio.addEventListener('timeupdate', () => onTime?.(audio.currentTime - OFFSET_SHIFT));
  audio.addEventListener('loadedmetadata', () => (status.textContent = `Запись ${fmt(audio.duration)}`));
  audio.addEventListener('error', () => {
    status.innerHTML = `Запись не воспроизводится здесь. <a href="${esc(url)}" target="_blank" rel="noopener">Открыть в новой вкладке</a>`;
  });

  return {
    seek(sec) {
      if (!Number.isFinite(sec)) return;
      audio.currentTime = Math.max(0, sec + OFFSET_SHIFT - 1);
      audio.play().catch(() => {});
    },
    following: () => follow.checked && !audio.paused,
  };
}

const fmt = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
