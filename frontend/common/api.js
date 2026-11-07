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

export const APPEAL_STATUS = { open: 'Ждёт решения', confirmed: 'Оценка подтверждена', changed: 'Оценка изменена' };
export const CHANNEL = { 'agent chat': 'чат', 'voice call': 'звонок' };
export const SPEAKER = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

export function fmtAnswer(a) {
  if (a === 'yes') return 'Да';
  if (a === 'no') return 'Нет';
  if (a === 'na') return 'N/A';
  return String(a);
}
