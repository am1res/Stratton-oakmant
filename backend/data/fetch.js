// CLI: npm run fetch-data [-- GROUP_ID]
// Downloads a dataset into data/cache/<GROUP_ID>.json (git-ignored) and prints a summary.
import { fetchFromApi } from './source.js';
import { config } from '../config.js';

const groupId = process.argv[2] || config.api.groupId;
const records = await fetchFromApi(groupId);
const count = {};
for (const r of records) count[`${r.channel} ${r.language}`] = (count[`${r.channel} ${r.language}`] || 0) + 1;
console.log(`Fetched ${records.length} records for group_id=${groupId}`);
console.table(count);
