import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(ROOT, 'ai_eval/.env') });

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
    // "ai_eval" (default, Python module) | "single" | "ensemble" (JS A/B/arbiter)
    mode: env.LLM_MODE === 'ensemble' ? 'ensemble' : env.LLM_MODE === 'single' ? 'single' : 'ai_eval',
    modelB: env.LLM_MODEL_B || '', // optional: a different model for evaluator B (less correlated mistakes)
    modelArbiter: env.LLM_MODEL_ARBITER || '',
    priceIn: Number(env.LLM_PRICE_IN || 0),
    priceOut: Number(env.LLM_PRICE_OUT || 0),
    strictSchema: env.LLM_STRICT_SCHEMA !== '0',
    mock: env.LLM_MOCK === '1',
    concurrency: Math.max(1, Number(env.LLM_CONCURRENCY || 4)),
    explanationLanguage: env.EXPLANATION_LANGUAGE || 'русском',
    judges: {
      a: env.AI_EVAL_JUDGE_A_MODEL || '',
      b: env.AI_EVAL_JUDGE_B_MODEL || '',
      adjudicator: env.AI_EVAL_ADJUDICATOR_MODEL || '',
    },
  },
  // Demo operator names + dates when the data has none (see backend/data/source.js). 0 = off.
  demo: { operators: env.DEMO_OPERATORS !== '0' },
  paths: {
    cache: path.join(ROOT, 'data', 'cache'),
    storage: path.resolve(ROOT, env.STORAGE_DIR || 'storage'),
    defaultChecklist: path.join(ROOT, 'contracts', 'checklist.default.json'),
    // Output folder of the voice pipeline (voice/to_gemini.py --out ...): voice/<id>.json and audio/<id>.mp3
    voiceOut: path.resolve(ROOT, env.VOICE_OUT_DIR || 'voice/out'),
  },
};
