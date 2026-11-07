// Thin API client. Every screen talks to the backend only through this file.
async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.details ? `${data.error}: ${data.details.join('; ')}` : data.error || res.statusText);
  return data;
}

export const api = {
  meta: () => req('GET', '/api/meta'),
  conversations: () => req('GET', '/api/conversations'),
  conversation: (id) => req('GET', `/api/conversations/${encodeURIComponent(id)}`),
  upload: (json) => req('POST', '/api/conversations/upload', json),
  reloadData: (group_id) => req('POST', '/api/data/reload', { group_id }),
  checklist: () => req('GET', '/api/checklists/current'),
  checklistVersions: () => req('GET', '/api/checklists'),
  saveChecklist: (cl) => req('PUT', '/api/checklists/current', cl),
  resetChecklist: () => req('POST', '/api/checklists/reset'),
  evaluate: (conversation_id) => req('POST', '/api/evaluate', { conversation_id }),
  evaluateBatch: (conversation_ids) => req('POST', '/api/evaluate/batch', { conversation_ids }),
  job: (id) => req('GET', `/api/jobs/${id}`),
  evaluations: (conversation_id) => req('GET', `/api/evaluations?conversation_id=${encodeURIComponent(conversation_id)}`),
  evaluation: (id) => req('GET', `/api/evaluations/${id}`),
  appeals: (q = '') => req('GET', `/api/appeals${q}`),
  createAppeal: (evaluation_id, criterion_id, comment) => req('POST', '/api/appeals', { evaluation_id, criterion_id, comment }),
  suggest: (id) => req('POST', `/api/appeals/${id}/suggest`),
  decide: (id, answer, reason) => req('POST', `/api/appeals/${id}/decide`, { answer, reason }),
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Turn backend/LLM errors into a sentence that says what to do. */
export function humanError(err) {
  const m = String(err?.message || err);
  if (err instanceof TypeError) return 'Нет связи с сервером. Запустите npm start и повторите.';
  if (/LLM HTTP 401/.test(m)) return 'Ключ ИИ не принят (401). Проверьте LLM_API_KEY в .env и перезапустите сервер.';
  if (/LLM HTTP 429/.test(m)) return 'Слишком много запросов к ИИ или закончился баланс (429). Подождите минуту или проверьте баланс.';
  if (/LLM HTTP 404|model_not_found|does not exist/.test(m)) return 'Модель не найдена. Проверьте LLM_MODEL в .env.';
  if (/reasoning_effort/.test(m)) return 'Эта модель не поддерживает reasoning_effort. Оставьте LLM_REASONING_EFFORT пустым в .env.';
  if (/response_format|json_schema/.test(m)) return 'Модель не поддерживает строгий JSON. Поставьте LLM_STRICT_SCHEMA=0 в .env.';
  if (/LLM HTTP 5\d\d|ECONNRESET|fetch failed/.test(m)) return 'Сервис ИИ временно недоступен. Повторите через минуту.';
  if (/model skipped criteria|is not one of|expected yes\/no/.test(m)) return `Модель вернула неполный ответ даже после повторов: ${m}`;
  return m;
}

export const APPEAL_STATUS = { open: 'Ждёт решения', confirmed: 'Оценка подтверждена', changed: 'Оценка изменена' };
export const CHANNEL = { 'agent chat': 'чат', 'voice call': 'звонок' };
export const SPEAKER = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

export function fmtAnswer(a) {
  if (a === 'yes') return 'Да';
  if (a === 'no') return 'Нет';
  if (a === 'na') return 'N/A';
  return String(a);
}
