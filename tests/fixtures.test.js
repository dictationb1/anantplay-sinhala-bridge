// Fixture-driven tests: the shipped synthetic Sinhala fixtures flow through the worker's
// shared pipeline exactly like real files would (upload leg). Run: node tests/fixtures.test.js
import { toCleanSrt, parseSrtCues, reassembleSrt, isGzip, isZip, unzipBest, sha256Hex } from '../worker/src/index.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 120) : '')); }
}

// si.srt — the plain Sinhala fixture
{
  const raw = readFileSync(join(FX, 'si.srt'), 'utf8');
  const clean = toCleanSrt(raw);
  check('si.srt cleans to 3 cues', parseSrtCues(clean.text).length === 3);
  check('si.srt round-trips through reassemble', reassembleSrt(parseSrtCues(clean.text)).includes('ආයුබෝවන්'));
}

// si_bom_crlf.srt — BOM + CRLF normalization
{
  const raw = readFileSync(join(FX, 'si_bom_crlf.srt'), 'utf8');
  const clean = toCleanSrt(raw);
  check('BOM stripped', !clean.text.startsWith('\ufeff'));
  check('CRLF unified', !clean.text.includes('\r'));
  check('BOM/CRLF fixture parses to 3 cues', parseSrtCues(clean.text).length === 3);
  check('BOM/CRLF content equals plain fixture after cleaning', clean.text === toCleanSrt(readFileSync(join(FX, 'si.srt'), 'utf8')).text);
}

// si.srt.gz — gzip detection + decompression
{
  const gz = new Uint8Array(readFileSync(join(FX, 'si.srt.gz')));
  check('fixture .gz detected as gzip', isGzip(gz));
  check('fixture .gz not mistaken for zip', !isZip(gz));
  const ds = new DecompressionStream('gzip');
  const out = new Uint8Array(await new Response(new Response(gz).body.pipeThrough(ds)).arrayBuffer());
  const text = new TextDecoder().decode(out);
  check('.gz inflates to the Sinhala fixture', toCleanSrt(text).text === toCleanSrt(readFileSync(join(FX, 'si.srt'), 'utf8')).text);
}

// pack.zip — best-entry extraction from the mixed archive
{
  const zip = new Uint8Array(readFileSync(join(FX, 'pack.zip')));
  check('fixture pack.zip detected as zip', isZip(zip));
  const best = await unzipBest(zip);
  check('best entry picked (not null)', best !== null);
  const text = new TextDecoder().decode(best.bytes);
  check('best entry is the Sinhala .srt (nested, si-named)', best.name === 'Subs/Nested/Synthetic.si.srt', best.name);
  check('best entry content is the Sinhala fixture', toCleanSrt(text).text === toCleanSrt(readFileSync(join(FX, 'si.srt'), 'utf8')).text);
  check('__MACOSX junk never picked', !text.includes('junkjunkjunk'));
}

// en.srt — the English source fixture (the translation input side)
{
  const raw = readFileSync(join(FX, 'en.srt'), 'utf8');
  const cues = parseSrtCues(toCleanSrt(raw).text);
  check('en.srt parses to 3 cues (translation input)', cues.length === 3);
  check('en timestamps are exactly the si timestamps (the lock-step pair)',
    cues.map(c => c.ts).join('|') === parseSrtCues(toCleanSrt(readFileSync(join(FX, 'si.srt'), 'utf8')).text).map(c => c.ts).join('|'));
}

// hash stability — the dedupe identity
{
  const a = await sha256Hex(readFileSync(join(FX, 'si.srt'), 'utf8'));
  const b = await sha256Hex(readFileSync(join(FX, 'si.srt'), 'utf8'));
  check('fixture sha256 stable', a === b);
  check('token-length slice', a.slice(0, 16).length === 16);
}

console.log(`fixtures.test.js — ${pass} PASS / ${fail} FAIL`);
if (fails.length) fails.forEach(f => console.log('FAIL ' + f));
process.exit(fail ? 1 : 0);
