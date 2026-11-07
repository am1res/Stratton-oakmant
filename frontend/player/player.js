// Audio player for calls. Owner: P4.
// The audio streams through the backend proxy (/api/conversations/:id/audio), so the signed
// link never reaches the browser.
// TODO(P4): check that offset_sec matches the recording. The transcript has
// "Запись и транскрибирование приостановлены" pauses, so the recording may be shorter than
// wall-clock time. If seeks land late, subtract the paused intervals when computing the offset.
import { esc } from '../common/api.js';

export function createPlayer(el, url) {
  el.innerHTML = `<audio controls preload="metadata" src="${esc(url)}" style="width:100%;margin-bottom:8px"></audio>`;
  const audio = el.querySelector('audio');
  return {
    seek(sec) {
      if (!Number.isFinite(sec)) return;
      audio.currentTime = Math.max(0, sec - 1);
      audio.play().catch(() => {});
    },
  };
}
