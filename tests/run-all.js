// Unified runner: every Node test file, zero skipped, zero 404 tolerance.
// Run: node tests/run-all.js
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = join(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(TESTS).filter(f => f.endsWith('.test.js')).sort();

let passTotal = 0, failTotal = 0, ran = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [join(TESTS, f)], { encoding: 'utf8' });
  ran++;
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /— (\d+) PASS \/ (\d+) FAIL/.exec(out);
  if (m) {
    passTotal += Number(m[1]);
    failTotal += Number(m[2]);
    console.log(`${f}: ${m[1]} PASS / ${m[2]} FAIL ${Number(m[2]) === 0 ? '✅' : '❌'}`);
  } else {
    failTotal += 1;
    console.log(`${f}: NO-SUMMARY (exit ${r.status}) ❌`);
    console.log(out.split('\n').slice(-8).join('\n'));
  }
}

console.log('──────────────────────────────────────────');
console.log(`run-all.js — ${ran} files · ${passTotal} PASS / ${failTotal} FAIL`);
if (failTotal > 0) process.exit(1);
