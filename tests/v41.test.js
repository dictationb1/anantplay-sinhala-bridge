/* v4.1 unit tests — languages.js + cinema.js + the pa provider + multi-language
 * pipeline behaviours. Runs under `node tests/run-all.js` alongside the v4 suite.
 * Zero network: the pa provider tests use a mock fetch via TRANSLATE_PA_BASE. */
import assert from 'node:assert/strict';

// the v4-suite harness style: named checks with a summary footer the runner greps
let pass = 0, fail = 0;
const queue = [];
const fails = [];
function test(name, fn) { queue.push([name, fn]); }

import {
  LANGUAGES, DEFAULT_LANG, CHIP_LANGS, langOf, isKnownLang, isRtl, scriptReOf, maxCharsOf,
} from '../worker/src/languages.js';
import {
  registerForGenres, flagCuesForPolish, buildPolishPrompt, validPolishedCue, FORMAL_GENRES,
} from '../worker/src/cinema.js';
import {
  chainOf, providerServesLang, escapeForPa, unescapeFromPa, paConfigured, paKeyOf, paEnabled,
  paTranslateCues, buildTranslatePrompt, DEFAULT_CHAIN, translateWithFailover,
} from '../worker/src/providers.js';
import { langJobIdOf, parseLangOf } from '../worker/src/pipeline.js';

// ── languages.js ─────────────────────────────────────────────────────────────

test('registry: 18 languages, si default, chip row of 8', () => {
  assert.equal(Object.keys(LANGUAGES).length, 18);
  assert.equal(DEFAULT_LANG, 'si');
  assert.equal(CHIP_LANGS.length, 8);
  assert.equal(CHIP_LANGS[0], 'si');
  assert.equal(CHIP_LANGS[7], 'ar');
});

test('registry: OpenSubtitles ISO-639-2B codes correct', () => {
  const expect = { si: 'sin', ta: 'tam', hi: 'hin', en: 'eng', es: 'spa', fr: 'fre', ja: 'jpn', ko: 'kor', ar: 'ara', ur: 'urd', de: 'ger', ru: 'rus', pt: 'por', th: 'tha', id: 'ind', tr: 'tur', vi: 'vie' };
  for (const [c, os] of Object.entries(expect)) assert.equal(LANGUAGES[c].osCode, os, c);
  assert.equal(LANGUAGES['zh-CN'].osCode, 'chi');
});

test('registry: script/RTL/char budgets', () => {
  assert.equal(LANGUAGES.si.script, 'sinhala');
  assert.ok(isRtl('ar') && isRtl('ur'));
  assert.ok(!isRtl('si') && !isRtl('en') && !isRtl('xx'));
  assert.equal(maxCharsOf('ja'), 18);
  assert.equal(maxCharsOf('si'), 42);
  assert.equal(maxCharsOf('unknown-lang'), 42); // safe default
  // Cyrillic is its own script class — Russian output must validate, Latin must not
  assert.equal(LANGUAGES.ru.script, 'cyrillic');
  assert.ok(scriptReOf('ru').test('Привет мир') && !scriptReOf('ru').test('hello'));
  assert.ok(scriptReOf('si').test('ඔයා') && !scriptReOf('si').test('hello'));
  assert.ok(scriptReOf('ta').test('என்ன'));
  assert.ok(scriptReOf('ja').test('何してるの'));
  assert.ok(scriptReOf('ar').test('مرحبا'));
  assert.equal(isKnownLang('xx'), false);
  assert.ok(langOf('ta'));
});

// ── cinema.js ────────────────────────────────────────────────────────────────

test('flagger: deterministic, budget-capped, strong idioms kept', () => {
  const EN = ['What are you doing?', 'He came yesterday.', '- You gotta be kidding me.', '- Not in a million years, pal.',
    "We're gonna need a bigger boat.", 'I\'m just saying, maybe don\'t poke the bear.', 'You had me at hello.',
    "That's gonna leave a mark.", 'Well, well, well. Look what the cat dragged in.', 'Say hello to my little friend!'];
  const PA = ['ඔයා කරන්නේ කුමක් ද?', 'එයා ඊයේ ආවා.', '- ඔයා මට විහිළු කරනවා.', '- අවුරුදු මිලියනයකින් නොවේ, මිත්\u200dරයා.',
    'අපට විශාල බෝට්ටුවක් අවශ්\u200dය වේ.', 'මම නිකමට කියන්නේ, සමහර විට වලහාට ගහන්න එපා.', 'ඔයා මාව හලෝ කියලා තිබ්බා.',
    'එය ලකුණක් ඉතිරි කරයි.', 'හොඳයි, හොඳයි, හොඳයි. බලන්න පූසා ඇදගෙන ආපු දේ.', 'මගේ කුඩා මිතුරාට ආයුබෝවන් කියන්න!'];
  const f1 = flagCuesForPolish(EN, PA, 'si', 'spoken', 100);
  for (const i of [0, 2, 3, 4, 5, 6, 7, 8, 9]) assert.ok(f1.has(i), 'cue ' + (i + 1) + ' flagged');
  assert.ok(!f1.has(1), 'clean natural cue 2 NOT flagged');
  // determinism
  const f2 = flagCuesForPolish(EN, PA, 'si', 'spoken', 100);
  assert.deepEqual([...f1.keys()], [...f2.keys()]);
  // budget at scale: 1500 cues → ~300 flags
  const bigEN = Array.from({ length: 1500 }, (_, i) => i % 5 === 0 ? 'you gotta be kidding me pal' : 'ordinary dialogue here');
  const bigPA = bigEN.map(() => 'සාමාන්\u200dය සංවාදය');
  const big = flagCuesForPolish(bigEN, bigPA, 'si', 'spoken', 20);
  assert.ok(big.size >= 290 && big.size <= 320, 'budget ~20%: ' + big.size);
});

test('flagger: SFX/♪/empty never flagged; formal register skips si-stiffness', () => {
  const f = flagCuesForPolish(['[GUNS COCKING]', '♪ ominous music ♪', ''], ['x', 'y', ''], 'si', 'spoken', 100);
  assert.equal(f.size, 0);
  const formal = flagCuesForPolish(['What are you doing?'], ['ඔයා කරන්නේ කුමක් ද?'], 'si', 'formal', 100);
  assert.equal(formal.size, 0, 'stiffness markers are CORRECT in formal register');
});

test('registerForGenres: spoken default, formal for History/Epic/War, override wins', () => {
  assert.equal(registerForGenres(['Action', 'Thriller']), 'spoken');
  assert.equal(registerForGenres(['Horror', 'Sci-Fi']), 'spoken');
  assert.equal(registerForGenres(['History', 'Drama']), 'formal');
  assert.equal(registerForGenres(['War']), 'formal');
  assert.equal(registerForGenres(['History'], 'spoken'), 'spoken');
  assert.equal(registerForGenres([], 'formal'), 'formal');
  assert.ok(FORMAL_GENRES.includes('epic'));
});

test('buildPolishPrompt: two-input lines, context, recent cues, register', () => {
  const p = buildPolishPrompt(
    [{ i: 1, en: 'What are you doing?', draft: 'ඔයා කරන්නේ කුමක් ද?' }],
    { title: 'Clayface', year: '2026', genres: ['Horror'], cast: ['Tom Rhys Harries'], plot: 'A star descends.' },
    'si', 'spoken', ['කලින් පේළිය'],
  );
  assert.ok(p.includes('1|EN: What are you doing? | DRAFT: ඔයා කරන්නේ කුමක් ද?'));
  assert.ok(p.includes('Clayface'));
  assert.ok(p.includes('Tom Rhys Harries'));
  assert.ok(p.includes('කලින් පේළිය'));
  assert.ok(p.includes('NATURAL SPOKEN'));
  const pf = buildPolishPrompt([{ i: 1, en: 'x', draft: 'y' }], { title: 'T', genres: ['History'] }, 'si', 'formal', []);
  assert.ok(pf.includes('FORMAL LITERARY'));
});

test('validPolishedCue: accepts good, rejects empty/echo/runaway/dash-drop', () => {
  assert.ok(validPolishedCue('What are you doing?', 'ඔයා මොකක්ද කරන්නේ?', 'draft', 'si'));
  assert.ok(!validPolishedCue('What are you doing?', '', 'draft', 'si'));
  assert.ok(!validPolishedCue('What are you doing?', 'What are you doing now friend', 'draft', 'si'));
  assert.ok(!validPolishedCue('short', 'x'.repeat(400), 'draft', 'si'));
  assert.ok(!validPolishedCue('- hi there pal', 'ආයුබෝවන්', 'draft', 'si'));
  assert.ok(!validPolishedCue('<i>hi</i>', 'ආයුබෝවන්', 'draft', 'si'));
  assert.ok(validPolishedCue('hello', 'hola amigos', 'draft', 'es'));
  assert.ok(validPolishedCue('hello', 'any clean text', 'draft', 'en'));
});

// ── providers: pa hardening + chains ─────────────────────────────────────────

test('pa: env gating + key assembly + NO AIza literal in source', async () => {
  assert.equal(paEnabled({}), false);
  assert.equal(paEnabled({ ENABLE_TRANSLATE_PA: 'true' }), true);
  assert.equal(paEnabled({ ENABLE_TRANSLATE_PA: 'yes' }), false);
  assert.equal(paConfigured({ ENABLE_TRANSLATE_PA: 'true' }), false); // key missing
  assert.ok(paConfigured({ ENABLE_TRANSLATE_PA: 'true', TRANSLATE_PA_KEY: 'k' }));
  assert.equal(paKeyOf({ TRANSLATE_PA_KEY_HEAD: 'AAA', TRANSLATE_PA_KEY_TAIL: 'BBB' }), 'AAABBB');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../worker/src/providers.js', import.meta.url), 'utf8');
  assert.ok(!/AIza[A-Za-z0-9_-]{30,}/.test(src), 'no raw Google key literal in git-tracked source');
});

test('pa: escape/unescape protocol (tags raw, text entity-escaped)', () => {
  assert.equal(escapeForPa('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.equal(escapeForPa('<i>A & B</i>'), '<i>A &amp; B</i>');
  assert.equal(escapeForPa('5 < 10'), '5 &lt; 10');
  assert.equal(unescapeFromPa('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(unescapeFromPa('<i>ආපසු ඉන්න!</i>'), '<i>ආපසු ඉන්න!</i>');
  const roundTrips = ['Tom & Jerry', '5 < 10 and 3 > 1', '<i>Stay back!</i>', 'Q: "What?" & why', 'R&D < 100%'];
  for (const c of roundTrips) assert.equal(unescapeFromPa(escapeForPa(c)), c);
});

test('pa provider: multi-line cues flattened, 500-line batches, rebuild aligned', async () => {
  // mock pa endpoint on loopback via TRANSLATE_PA_BASE
  let seenBodies = [];
  const mock = async (url, init) => {
    const body = JSON.parse(init.body);
    seenBodies.push(body);
    assert.equal(url, 'http://127.0.0.1:9914/v1/translateHtml');
    assert.equal(body[1], 'te_client');
    assert.equal(body[0][1], 'en');
    assert.equal(body[0][2], 'si');
    // echo-with-mark: proves per-line alignment + escaping reached the wire
    return {
      ok: true,
      json: async () => [body[0][0].map((l) => l.replace(/&amp;/g, '&').length + ':' + l.slice(0, 3))],
    };
  };
  const env = { ENABLE_TRANSLATE_PA: 'true', TRANSLATE_PA_KEY: 'test-key', TRANSLATE_PA_BASE: 'http://127.0.0.1:9914' };
  const items = [];
  for (let i = 0; i < 3; i++) items.push({ i: i + 1, text: 'line one ' + i + '\nline two ' + i });   // multi-line cues
  const out = await paTranslateCues(env, {}, items, mock);
  assert.equal(out.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(String(out[i]).includes('\n'), 'cue ' + i + ' reassembled as 2 lines');
    const [a, b] = String(out[i]).split('\n');
    assert.ok(/^[0-9]+:lin/.test(a) && /^[0-9]+:lin/.test(b));
  }
  assert.ok(seenBodies.length >= 1);
  assert.ok(seenBodies.every((b) => b[0][0].length <= 500));
});

test('pa provider: multi-line flatten respects 500-line batch cap', async () => {
  let batches = [];
  const mock = async (url, init) => {
    const body = JSON.parse(init.body);
    batches.push(body[0][0].length);
    return { ok: true, json: async () => [body[0][0].map(() => 'සිංහල')] };
  };
  const env = { ENABLE_TRANSLATE_PA: 'true', TRANSLATE_PA_KEY: 'k', TRANSLATE_PA_BASE: 'http://127.0.0.1:9914' };
  // 300 cues × 2 lines = 600 lines → 2 batches (500 + 100)
  const items = Array.from({ length: 300 }, (_, i) => ({ i: i + 1, text: 'a' + i + '\nb' + i }));
  const out = await paTranslateCues(env, {}, items, mock);
  assert.equal(out.length, 300);
  assert.deepEqual(batches, [500, 100]);
  assert.ok(out.every((t) => t === 'සිංහල\nසිංහල'));
});

test('pa: ANY 4xx/5xx trips the 10-minute breaker immediately (no retry), azure takes over', async () => {
  const store = new Map();
  const kvGet = async (k) => (store.has(k) ? store.get(k) : null);
  const kvPut = async (k, v) => { store.set(k, v); };
  const orig = globalThis.fetch;
  let paCalls = 0, azureCalls = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.indexOf('translate-pa.googleapis.com') >= 0) {
      paCalls++;
      return new Response(JSON.stringify({ error: 'walled' }), { status: 403 });
    }
    if (u.indexOf('api.cognitive.microsofttranslator.com') >= 0) {
      azureCalls++;
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify(body.map((el) => ({ translations: [{ text: el.Text }] }))), { status: 200 });
    }
    throw new Error('unexpected fetch ' + u);
  };
  try {
    const env = { ENABLE_TRANSLATE_PA: 'true', TRANSLATE_PA_KEY: 'k', AZURE_TRANSLATOR_KEY: 'a' };
    const r = await translateWithFailover(env, [{ i: 0, text: 'Hello there' }], kvGet, kvPut, { targetLang: 'si' });
    assert.equal(r.provider, 'azure');
    assert.equal(paCalls, 1, 'a 403 is never retried — the breaker trips on the first answer');
    assert.ok(azureCalls >= 1);
    const key = 'q:pa:' + new Date().toISOString().slice(0, 10);
    assert.ok(Number(store.get(key)) > Date.now() + 9 * 60 * 1000, 'breaker is set ~10 minutes ahead');
  } finally {
    globalThis.fetch = orig;
  }
});

test('chains: pa first when enabled, excluded for en target, lang filter', () => {
  const envOn = { ENABLE_TRANSLATE_PA: 'true', TRANSLATE_PA_KEY: 'k', AZURE_TRANSLATOR_KEY: 'a', GEMINI_API_KEY: 'g' };
  const envOff = { AZURE_TRANSLATOR_KEY: 'a', GEMINI_API_KEY: 'g' };
  assert.equal(chainOf(envOn, 'si')[0], 'pa');
  assert.ok(!chainOf(envOn, 'en').includes('pa'));
  assert.equal(chainOf(envOff, 'si')[0], 'azure');
  assert.equal(DEFAULT_CHAIN.split(',')[0], 'pa');
  assert.ok(providerServesLang('pa', 'ta') && !providerServesLang('pa', 'en'));
});

test('buildTranslatePrompt: si wording v4-identical, other languages named', () => {
  const p = buildTranslatePrompt(5);
  assert.ok(p.includes('natural, fluent, Sinhala (සිංහල)'));
  assert.ok(p.includes('everyday spoken Sinhala a Sri Lankan audience reads instantly'));
  const pt = buildTranslatePrompt(5, 'ta');
  assert.ok(pt.includes('Tamil (தமிழ்)'));
  assert.ok(pt.includes('<number>|<Tamil translation>'));
});

// ── pipeline: lang job ids ───────────────────────────────────────────────────

test('langJobIdOf: si = v4 bare id (back-compat), others suffixed, parse round-trips', () => {
  assert.equal(langJobIdOf('movie', 'tt123', 0, 0, 'si'), 'movie:tt123:0:0');
  assert.equal(langJobIdOf('movie', 'tt123', 0, 0, 'ta'), 'movie:tt123:0:0:ta');
  assert.equal(langJobIdOf('movie', 'tt123', 0, 0, 'xx'), 'movie:tt123:0:0'); // unknown → si
  assert.equal(langJobIdOf('series', 'tt1', 2, 3, 'ja'), 'series:tt1:2:3:ja');
  assert.equal(parseLangOf('movie:tt123:0:0'), 'si');
  assert.equal(parseLangOf('movie:tt123:0:0:ta'), 'ta');
  assert.equal(parseLangOf('direct:abc123:ja'), 'ja');
  assert.equal(parseLangOf('direct:abc123'), 'si');
});

;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ✔ ' + name); }
    catch (e) {
      fail++;
      const msg = String((e && e.message) || e).slice(0, 160);
      fails.push(name + ' :: ' + msg);
      console.log('  ✘ ' + name + ' :: ' + msg);
    }
  }
  console.log(`v41.test.js — ${pass} PASS / ${fail} FAIL`);
  if (fails.length) process.exit(1);
})();
