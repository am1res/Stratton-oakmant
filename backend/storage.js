// Tiny JSON-file storage: storage/<collection>/<id>.json. Owner: P1.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const dir = (collection) => path.join(config.paths.storage, collection);
const safe = (id) => String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');

export async function put(collection, id, obj) {
  await fs.mkdir(dir(collection), { recursive: true });
  const file = path.join(dir(collection), `${safe(id)}.json`);
  // Unique temp name: parallel writes of the same id (e.g. 4 batch workers saving the default
  // checklist at once) used to collide on one ".tmp" file and fail with ENOENT.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  await fs.rename(tmp, file);
  return obj;
}

export async function get(collection, id) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir(collection), `${safe(id)}.json`), 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function list(collection) {
  let files;
  try {
    files = await fs.readdir(dir(collection));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    out.push(JSON.parse(await fs.readFile(path.join(dir(collection), f), 'utf-8')));
  }
  return out;
}
