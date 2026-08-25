// Minimal .env loader — the repo has no dotenv dependency and we don't want
// to add one just to read three keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — rely on the ambient environment */ }

// Which deployment record the tooling reads and writes.
//
// Defaults to the canonical file. Pointing DEPLOYMENTS_FILE at another one lets a
// throwaway stack be deployed and exercised end to end without touching the
// addresses the interface and the indexer are configured against — the scripts
// rewrite this file as they go, so sharing it between a real deployment and a
// test run would silently repoint the interface at test contracts.
export function deploymentsPath() {
  return path.resolve(root, process.env.DEPLOYMENTS_FILE || 'deployments-cl.json');
}
