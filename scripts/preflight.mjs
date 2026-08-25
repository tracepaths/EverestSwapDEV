#!/usr/bin/env node
// Compiles every built contract and reports whether the node will accept it.
// A program that declares too many functions is refused for defining a jump label
// twice, which the compiler itself does not warn about, so this runs before any
// deploy. See scripts/lib/jdest.mjs for how the limit was measured.
import './lib/env.mjs';
import fs from 'node:fs';
import { compileFile } from './lib/aml.mjs';
import { labelReport } from './lib/jdest.mjs';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = fs.readdirSync('contracts').filter((f) => f.endsWith('.aml'))
  .filter((f) => !only.length || only.some((o) => f.includes(o))).sort();

let bad = 0;
for (const f of files) {
  const r = await compileFile(`contracts/${f}`);
  if (!r.ok) { console.log(`  FAIL   ${f.padEnd(26)} ${r.error.slice(0, 70)}`); bad++; continue; }
  const l = labelReport(r);
  if (l.willReject) bad++;
  const verdict = l.willReject ? `REJECT ${l.functions}/${l.limit} fns` : `ok  ${String(l.headroom).padStart(3)} fns spare`;
  console.log(`  ${verdict.padEnd(20)} ${f.padEnd(26)} ${String(r.bytecode.length).padStart(6)} bytes  ${String(r.raw.instructions).padStart(5)} instr`);
}
process.exit(bad ? 1 : 0);
