import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = process.env;
export const config = {
  port: Number(env.PORT || 3000),
  api: {
    base: env.CQA_API_BASE || '',
    groupId: env.CQA_GROUP_ID || 'DEV',
    dataFile: env.CQA_DATA_FILE || '',
  },
  llm: {
    baseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'gpt-5-mini',
    reasoningEffort: env.LLM_REASONING_EFFORT || '',
    temperature: env.LLM_TEMPERATURE === undefined || env.LLM_TEMPERATURE === '' ? null : Number(env.LLM_TEMPERATURE),
    votes: Math.max(1, Number(env.LLM_VOTES || 1)),
    priceIn: Number(env.LLM_PRICE_IN || 0),
    priceOut: Number(env.LLM_PRICE_OUT || 0),
    strictSchema: env.LLM_STRICT_SCHEMA !== '0',
    mock: env.LLM_MOCK === '1',
    concurrency: Math.max(1, Number(env.LLM_CONCURRENCY || 4)),
    explanationLanguage: env.EXPLANATION_LANGUAGE || 'русском',
  },
  paths: {
    cache: path.join(ROOT, 'data', 'cache'),
    storage: path.join(ROOT, 'storage'),
    defaultChecklist: path.join(ROOT, 'contracts', 'checklist.default.json'),
  },
};
