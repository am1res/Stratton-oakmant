// Builds the evaluation prompt FROM THE CHECKLIST CONFIG. Owner: P2.
//
// Nothing about specific criteria is hardcoded here. A criterion added or replaced in the UI
// gets the same treatment as the original eight: its yes_rule, na_rule, scale,
// decision_steps and examples all come from the config.
import { parseTimestamp } from '../data/source.js';

const HANDOVER = /эскалация на оператора|transferred to an agent|операторға жіберілді|агент присоединился|agent joined/i;

/** Facts we can compute exactly, so the model doesn't have to guess them. */
export function conversationFacts(conv, thresholdSec = 180) {
  const t = conv.transcript;
  const handover = t.find((m) => m.speaker === 'system' && HANDOVER.test(m.text));
  const firstOp = t.find((m) => m.speaker === 'operator');
  const lastOp = [...t].reverse().find((m) => m.speaker === 'operator');
  const systemEvents = t.filter((m) => m.speaker === 'system').map((m) => `#${m.msg_index} ${m.text}`);

  // Operator response delays over the threshold (after handover)
  const start = handover ? handover.msg_index : firstOp ? firstOp.msg_index : 0;
  const slow = [];
  let waitingSince = handover || null;
  for (const m of t) {
    if (m.msg_index < start) continue;
    if (m.speaker === 'client' && !waitingSince) waitingSince = m;
    if (m.speaker === 'operator') {
      if (waitingSince) {
        const a = parseTimestamp(waitingSince.timestamp);
        const b = parseTimestamp(m.timestamp);
        if (a !== null && b !== null && b - a > thresholdSec) {
          slow.push(`#${waitingSince.msg_index}→#${m.msg_index}: ${Math.round(b - a)} с`);
        }
      }
      waitingSince = null;
    }
  }

  return [
    `Канал: ${conv.channel}. Язык: ${conv.language}.`,
    handover ? `Передача оператору: #${handover.msg_index} (${handover.text}).` : 'Явного события передачи оператору нет.',
    firstOp ? `Первая реплика оператора: #${firstOp.msg_index}.` : 'Реплик оператора нет.',
    lastOp ? `Последняя реплика оператора: #${lastOp.msg_index}. Последнее сообщение диалога: #${t.at(-1).msg_index} (${t.at(-1).speaker}).` : '',
    `Системные события: ${systemEvents.length ? systemEvents.join('; ') : 'нет'}`,
    `Ожидание ответа оператора дольше ${thresholdSec} с: ${slow.length ? slow.join('; ') : 'нет'}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function answerFormat(c) {
  if (c.type === 'scale') {
    const vals = c.scale.map((s) => s.value).join(' | ');
    return c.na_allowed ? `${vals} | "na"` : vals;
  }
  if (c.type === 'flag') return '"yes" (нарушение есть) | "no"';
  return c.na_allowed ? '"yes" | "no" | "na"' : '"yes" | "no"';
}

function criterionBlock(c) {
  const lines = [`### ${c.id} — ${c.name}`, `Тип: ${c.type}. Ответ: ${answerFormat(c)}.`];
  if (c.yes_rule) lines.push(c.type === 'scale' ? `Что оценивается: ${c.yes_rule}` : `Правило оценки («Да» / «Нет»): ${c.yes_rule}`);
  if (c.type === 'scale') lines.push('Шкала:', ...c.scale.map((s) => `  ${s.value} — ${s.description}`));
  lines.push(c.na_allowed ? `N/A разрешён ТОЛЬКО если: ${c.na_rule}` : 'N/A для этого критерия НЕ разрешён.');
  if (c.decision_steps?.length) lines.push('Порядок решения:', ...c.decision_steps.map((s, i) => `  ${i + 1}. ${s}`));
  if (c.examples?.length) {
    lines.push('Примеры:', ...c.examples.map((e) => `  - «${e.text}» → ${JSON.stringify(e.answer)}: ${e.why}`));
  }
  return lines.join('\n');
}

// Ensemble mode (LLM_MODE=ensemble), ported from the Django branch: two evaluators use different
// methods so their mistakes are less alike; an arbiter decides only the criteria they disagree on.
export const ROLE_INSTRUCTIONS = {
  A: '## Метод оценщика A: от правила\nИди по критериям по очереди. Разбей правило критерия на отдельные условия и проверь каждое условие по транскрипту, прежде чем выбрать ответ.',
  B: '## Метод оценщика B: от доказательств\nСначала прочитай весь транскрипт и выпиши для себя все значимые действия оператора: приветствие и представление, уточняющие вопросы, проверку личности, ответы, предупреждения об ожидании, завершение, всё рискованное. Затем реши каждый критерий только по этим заметкам. Действие засчитывается, только если оно видно в транскрипте.',
  ARBITER: '## Ты — решающий оценщик\nДва независимых оценщика разошлись по критериям из раздела «Дополнительно». Перечитай транскрипт сам, проверь позицию каждого по правилу и по репликам, на которые они ссылаются, и прими решение. Можно выбрать ответ, который не выбрал ни один из них, если этого требует правило. В "explanation" скажи, чья позиция верна и почему.',
};

export function formatTranscript(conv) {
  return conv.transcript.map((m) => `#${m.msg_index} [${m.timestamp}] ${m.speaker}: ${m.text}`).join('\n');
}

/**
 * @param opts.criteriaIds  evaluate only these criteria (used for the appeal second opinion)
 * @param opts.extraNote    extra context appended to the user message (e.g. the appeal comment)
 */
export function buildMessages(checklist, conv, opts = {}) { // opts.role: 'A' | 'B' | 'ARBITER' (ensemble mode)
  const criteria = opts.criteriaIds ? checklist.criteria.filter((c) => opts.criteriaIds.includes(c.id)) : checklist.criteria;
  const lang = opts.explanationLanguage || 'русском';

  const system = [
    'Ты — эксперт контроля качества клиентской поддержки брокерской компании. Ты оцениваешь работу ОПЕРАТОРА в диалоге строго по чек-листу.',
    'Диалоги бывают на русском, казахском и английском. Оценивай одинаково строго на любом языке.',
    '',
    '## Общие правила',
    ...(checklist.general_rules || []).map((r) => `- ${r}`),
    '',
    '## Критерии',
    ...criteria.map(criterionBlock),
    '',
    '## Как отвечать',
    '- Для КАЖДОГО критерия сначала кратко рассуждай в поле "reasoning" по шагам «Порядок решения», затем дай "answer".',
    '- "answer": строго одно из допустимых значений критерия (для шкалы — число строкой, например "15").',
    '- "evidence_msg_indices": номера реплик (#), которые подтверждают ответ. Для N/A — реплики, показывающие условие неприменимости.',
    '- "evidence": для каждой реплики из evidence_msg_indices — {"msg_index", "quote": короткая точная цитата из этой реплики на языке оригинала, "proves": что она доказывает, 3–8 слов}.',
    '- "checked_range": если действие ПРОПУЩЕНО, укажи [с, по] — участок, где оно ожидалось; иначе null.',
    '- "na_reason": для N/A — какое условие неприменимости выполнено; иначе null.',
    '- "gross_error_type": только для критерия типа flag при ответе "yes": "insult" | "bypass_service" | "confidential_disclosure"; иначе null.',
    `- "explanation": 1–2 предложения на ${lang} языке в стиле: «Завершение — Нет. После ответа оператор закрыл чат без прощания. Основание — #12 и #13.»`,
    '- Не выдумывай реплики. Ссылайся только на существующие номера #.',
    ...(opts.role && ROLE_INSTRUCTIONS[opts.role] ? ['', ROLE_INSTRUCTIONS[opts.role]] : []),
  ].join('\n');

  const user = [
    '## Факты о диалоге (вычислены автоматически, им можно доверять)',
    conversationFacts(conv, checklist.first_response_threshold_sec || 180),
    '',
    '## Транскрипт',
    formatTranscript(conv),
    opts.extraNote ? `\n## Дополнительно\n${opts.extraNote}` : '',
    '',
    `Оцени критерии: ${criteria.map((c) => c.id).join(', ')}. Верни JSON строго по схеме.`,
  ].join('\n');

  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], criteria };
}

/** JSON schema for Structured Outputs (strict mode: all fields required, nullable via type unions). */
export function responseSchema(criteria) {
  return {
    name: 'cqa_evaluation',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['criteria'],
      properties: {
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['criterion_id', 'reasoning', 'answer', 'evidence_msg_indices', 'evidence', 'checked_range', 'na_reason', 'gross_error_type', 'explanation'],
            properties: {
              criterion_id: { type: 'string', enum: criteria.map((c) => c.id) },
              reasoning: { type: 'string' },
              answer: { type: 'string' },
              evidence_msg_indices: { type: 'array', items: { type: 'integer' } },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['msg_index', 'quote', 'proves'],
                  properties: { msg_index: { type: 'integer' }, quote: { type: 'string' }, proves: { type: 'string' } },
                },
              },
              checked_range: { type: ['array', 'null'], items: { type: 'integer' } },
              na_reason: { type: ['string', 'null'] },
              gross_error_type: { type: ['string', 'null'], enum: ['insult', 'bypass_service', 'confidential_disclosure', null] },
              explanation: { type: 'string' },
            },
          },
        },
      },
    },
  };
}
