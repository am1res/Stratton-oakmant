// OpenAI-compatible chat client (OpenAI, NVIDIA NIM, Ollama, OpenRouter...). Owner: P2.
// Switch provider by changing LLM_BASE_URL / LLM_MODEL in .env, no code changes.
import { config } from '../config.js';

export async function chatJson({ messages, schema, model }) {
  const c = config.llm;
  const body = { model: model || c.model, messages };
  if (c.strictSchema) body.response_format = { type: 'json_schema', json_schema: schema };
  else {
    body.response_format = { type: 'json_object' };
    messages = [...messages];
    messages[0] = { ...messages[0], content: `${messages[0].content}\n\nJSON schema ответа:\n${JSON.stringify(schema.schema)}` };
    body.messages = messages;
  }
  if (c.reasoningEffort) body.reasoning_effort = c.reasoningEffort;
  if (c.temperature !== null) body.temperature = c.temperature;

  const headers = { 'Content-Type': 'application/json' };
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;

  const res = await fetch(`${c.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error(`LLM returned no content: ${text.slice(0, 300)}`);
  const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, '');
  return {
    data: JSON.parse(cleaned),
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
    },
  };
}

export function costUsd(usage) {
  return (usage.input_tokens * config.llm.priceIn + usage.output_tokens * config.llm.priceOut) / 1e6;
}
