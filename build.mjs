#!/usr/bin/env node
// AML has no `import`, so shared code is textually inlined here. Each
// contracts/src/*.aml.in is expanded into contracts/*.aml by resolving
// `// @include lib/<file>` directives (one level, no recursion needed), then
// type-checked through the compiler.
import fs from 'node:fs';
import path from 'node:path';
import './scripts/lib/env.mjs';
import { compile } from './scripts/lib/aml.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, 'contracts', 'src');
const OUT = path.join(ROOT, 'contracts');
const INCLUDE_RE = /^([ \t]*)\/\/ @include\s+(\S+)\s*$/;

export function expand(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(INCLUDE_RE);
    if (!m) { out.push(line); continue; }
    const incPath = path.join(ROOT, 'contracts', m[2]);
    if (!fs.existsSync(incPath)) throw new Error(`${path.basename(file)}: missing include ${m[2]}`);
    const indent = m[1];
    out.push(`${indent}// ===== begin ${m[2]} (generated — edit contracts/${m[2]}) =====`);
    for (const l of fs.readFileSync(incPath, 'utf-8').replace(/\n$/, '').split('\n')) {
      out.push(l.length ? indent + l : l);
    }
    out.push(`${indent}// ===== end ${m[2]} =====`);
  }
  return out.join('\n');
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const check = !process.argv.includes('--no-check');
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.aml.in'))
  .filter((f) => !only.length || only.some((o) => f.includes(o)));
if (!files.length) { console.error(`no .aml.in matched ${only.join(',') || '(any)'}`); process.exit(1); }

let failed = 0;
for (const f of files.sort()) {
  const name = f.replace('.aml.in', '.aml');
  const src = expand(path.join(SRC, f));
  fs.writeFileSync(path.join(OUT, name), src);
  const lines = src.split('\n').length;
  if (!check) { console.log(`  built ${name.padEnd(26)} ${String(lines).padStart(5)} lines`); continue; }
  const r = await compile(src);
  if (r.ok) {
    console.log(`  ok   ${name.padEnd(26)} ${String(lines).padStart(5)} lines -> ${r.bytecode.length} bytes`);
  } else {
    failed++;
    // Report the offending source line, since the compiler only gives a number.
    const ln = Number((r.error.match(/line (\d+)/) || [])[1]);
    const ctx = ln ? '\n' + src.split('\n').slice(Math.max(0, ln - 3), ln + 2)
      .map((l, i) => `        ${String(Math.max(1, ln - 2) + i).padStart(5)} | ${l}`).join('\n') : '';
    console.log(`  FAIL ${name.padEnd(26)} ${r.error}${ctx}`);
  }
}
process.exit(failed ? 1 : 0);
