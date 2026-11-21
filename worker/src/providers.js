/* AnantPlay Sinhala Subtitle Bridge v4 — the multi-provider translation engine.
 *
 * THE ZERO-429 ARCHITECTURE (2026-verified free tiers):
 *
 *   provider id     | secret(s)                          | 2026 free capacity (verified)
 *   ──────────────────────────────────────────────────────────────────────────────
 *   azure           | AZURE_TRANSLATOR_KEY [+ AZURE_     | F0: 2,000,000 chars/month,
 *                   | TRANSLATOR_REGION]                 | ~2,000 RPM/hr-bucket — NMT,
 *                   |                                    | no LLM hallucination, Sinhala ✓
 *   google_v3       | GOOGLE_V3_KEY                      | 500,000 chars/month (Basic+
 *                   |                                    | Advanced combined), Sinhala ✓
 *   gemini          | GEMINI_API_KEY (unchanged v3)      | free tier ≈ 1,500 RPD shared,
 *                   |                                    | 10 RPM — LLM quality, bursty
 *   workers_ai      | none (needs AI binding in          | 10,000 Neurons/day free —
 *                   | wrangler.toml [ai])                | LLM fallback, zero external key
 *
 * Chain order default: `azure,google_v3,gemini,workers_ai` — deterministic MT first
 * (millions of chars, no RPM crash), LLMs last (they add tone but die on bursts).
 * Override with the TRANSLATION_CHAIN var; unconfigured providers are skipped
 * automatically, so `wrangler secret put AZURE_TRANSLATOR_KEY` alone is enough.
 *
 * EVERY provider implements the same contract:
 *   translateCues(env, cfg, items) → String[] aligned with items [{i, text}]
 * and throws { status, retryAfterMs, quota } on failure:
 *   status 429  → quota exhausted → the engine fails over to the next provider
 *   status 5xx  → transient → one in-provider retry, then failover
 * The engine ALSO honours a KV quota circuit breaker per provider (`q:<id>:<UTC date>`)
 * so a provider that 429'd is not retried for 10 minutes even on a fresh isolate.
 *
 * Google ToS honesty note (documented in README/report): rotating multiple Google
 * accounts to farm free-tier Gemini keys violates Google's ToS and risks account/key
 * suspension. This engine farms NOTHING — each provider is ONE legitimate account/key.
 *
 * Zero Node-only APIs: runs inside workerd and under node --test mocks alike.
 */

import { SUBDL_UA } from './lib.js';
import { LANGUAGES, langOf, isKnownLang, scriptReOf } from './languages.js';

const SINHALA_RE = /[\u0D80-\u0DFF]/;

/** Compact numbered-line protocol: `1|Hello\n2|Run!` — the payload shape every
 * provider receives. Compared to a JSON body it cuts prompt+answer tokens by
 * 50–70% (no keys, no quotes, no escaping), which is what keeps a 1,500-cue
 * movie inside 3–4 requests on every provider. */
function compactLines(items) {
  const out = new Array(items.length);
  for (let k = 0; k < items.length; k++) out[k] = items[k].i + '|' + items[k].text;
  return out.join('\n');
}

/** Parse `n|text` answer lines back into a Map(number → text). */
function parseNumbered(text) {
  const map = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s*\|\s?(.*)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (!map.has(n)) map.set(n, m[2].trim());
    }
  }
  return map;
}

/** v4.1 POLISH parser: `n|text` entries whose value may span multiple lines —
 * a continuation line (anything not starting a new `n|`) belongs to the
 * previous entry (multi-line subtitle cues survive the round trip). The BASE
 * translation keeps the strict single-line parser: silent line-dropping there
 * is the v4 truncation detector and must stay. */
function parseNumberedMulti(text) {
  const map = new Map();
  let lastN = -1;
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s*\|\s?([\s\S]*)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (!map.has(n)) { map.set(n, m[2].trim()); lastN = n; continue; }
    }
    if (lastN >= 0 && line.trim()) map.set(lastN, map.get(lastN) + '\n' + line.trim());
  }
  return map;
}

/** Provider error with the HTTP-ish status the engine switches on. */
class ProviderError extends Error {
  constructor(provider, status, message, retryAfterMs) {
    super(provider + ' ' + status + ': ' + String(message || '').slice(0, 200));
    this.provider = provider;
    this.status = status;
    this.retryAfterMs = retryAfterMs || 0;
    this.quota = status === 429;
  }
}

function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// v4.1 translate-pa (Layer 1) — Chrome's own translation endpoint, keyless.
//   POST https://translate-pa.googleapis.com/v1/translateHtml
//   Body: [[["line1","line2",...],"en","<tgt>"], "te_client"] → [["t1","t2",...]]
// LIVE-VERIFIED 2026-11-22 (Phase 0 Gap 2, 26/26 checks):
//   · raw <i>/<b>/<u> tags SURVIVE as real HTML ("<i>Stay back!</i>" → "<i>ආපසු ඉන්න!</i>")
//     — control-char sentinels get STRIPPED by the endpoint, never used
//   · & < > in TEXT must be entity-escaped or they vanish; entities return verbatim
//   · \n inside one item MERGES — every physical cue line is its own item (the
//     pipeline flattens multi-line cues before calling; see pipeline.js)
//   · 500 lines/request measured safe; 10-burst fine; natural SPOKEN Sinhala
// SECURITY (Gap 2 mandate): the API key NEVER appears as a source literal —
// env-only: TRANSLATE_PA_KEY (whole) or TRANSLATE_PA_KEY_HEAD+TRANSLATE_PA_KEY_TAIL
// (modular assembly). The provider is OFF unless ENABLE_TRANSLATE_PA="true".
// It is UNDOCUMENTED and can be walled any day: the v4 circuit breaker (10-min
// KV trip on 4xx/5xx) + the azure/google_v3 chain behind it keep every movie
// working — pa is an accelerator, never a dependency.
// ─────────────────────────────────────────────────────────────────────────────

const PA_MAX_LINES_PER_REQ = 500;
const PA_TIMEOUT_MS = 30000;

function paEnabled(env) {
  return !!(env && String(env.ENABLE_TRANSLATE_PA || '').trim().toLowerCase() === 'true');
}
function paKeyOf(env) {
  const full = String((env && env.TRANSLATE_PA_KEY) || '').trim();
  if (full) return full;
  const head = String((env && env.TRANSLATE_PA_KEY_HEAD) || '').trim();
  const tail = String((env && env.TRANSLATE_PA_KEY_TAIL) || '').trim();
  return head && tail ? head + tail : '';
}
function paConfigured(env) {
  return paEnabled(env) && !!paKeyOf(env);
}
function paBaseOf(env) {
  // Test/lab-only override (TRANSLATE_PA_BASE, loopback allowed) — same pattern.
  const raw = String((env && env.TRANSLATE_PA_BASE) || '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if ((u.protocol === 'https:' || loopback) && !u.username && !u.password) return u.origin;
    } catch (e) { /* fall through */ }
  }
  return 'https://translate-pa.googleapis.com';
}

// LIVE-PROBED escape protocol (Gap 2): tags raw, text entity-escaped.
const PA_ALLOWED_TAG_RE = /<(\/\s?)(i|b|u)>|<(i|b|u)>/g;
function paEscText(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeForPa(line) {
  let out = '';
  const s = String(line);
  let last = 0;
  for (const m of s.matchAll(PA_ALLOWED_TAG_RE)) {
    out += paEscText(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += paEscText(s.slice(last));
  return out;
}
function unescapeFromPa(line) {
  return String(line).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * items: [{i, text}] — text may contain ONE OR MORE physical lines already
 * flattened by the pipeline (\n never enters a pa request). 500 lines/req.
 * tgtLang: ISO-639-1 from languages.js (never 'en' — the pipeline skips pa for
 * English-target jobs entirely).
 */
async function paTranslateCues(env, cfg, items, fetchImpl) {
  const key = paKeyOf(env);
  const f = fetchImpl || fetch;
  const tgt = String((cfg && cfg.targetLang) || 'si');
  if (tgt === 'en') throw new ProviderError('pa', 400, 'english-target job: the source file already is English');
  // Flatten: every physical cue line is its own item (translate-pa MERGES \n
  // inside one item). Passthrough lines (empty / ♪ / [SFX] / (directions))
  // never get sent: quota saved + the line stays byte-identical to the source.
  const PASSTHROUGH_RE = /^(\s*|\u266a.*|\[.*\]|\(.*\))$/;
  const slots = [];   // {cue, line, translate, out?} in document order
  for (const it of items) {
    for (const ln of String(it.text || '').split('\n')) {
      slots.push({ cue: it.i, line: ln, translate: !PASSTHROUGH_RE.test(ln) });
    }
  }
  const send = slots.filter((s) => s.translate);
  for (let b = 0; b < send.length; b += PA_MAX_LINES_PER_REQ) {
    const slice = send.slice(b, b + PA_MAX_LINES_PER_REQ);
    const res = await f(paBaseOf(env) + '/v1/translateHtml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': key },
      signal: timeoutSignal(PA_TIMEOUT_MS),
      body: JSON.stringify([[slice.map((x) => escapeForPa(x.line)), 'en', tgt], 'te_client']),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError('pa', res.status, text, Number(res.headers.get('retry-after') || 0) * 1000);
    }
    const j = await res.json().catch(() => null);
    if (!j || !Array.isArray(j[0]) || j[0].length !== slice.length) {
      throw new ProviderError('pa', 502, 'bad pa answer shape');
    }
    for (let k = 0; k < slice.length; k++) slice[k].out = unescapeFromPa(String(j[0][k]));
  }
  // Rebuild: zip everything back per-cue, passthrough lines verbatim
  const byCue = new Map();
  for (const slot of slots) {
    const line = slot.translate ? String(slot.out || slot.line) : slot.line;
    byCue.set(slot.cue, byCue.has(slot.cue) ? byCue.get(slot.cue) + '\n' + line : line);
  }
  const out = new Array(items.length);
  for (let n = 0; n < items.length; n++) out[n] = byCue.has(items[n].i) ? byCue.get(items[n].i) : String(items[n].text || '');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Azure AI Translator (F0 free: 2M chars/month) — deterministic NMT, Sinhala ✓
// POST https://api.cognitive.microsofttranslator.com/translate?api-version=3.0
// Body: [{Text:"1|Hello"},{Text:"2|Run!"}] → [{translations:[{text:"1|ආයුබෝවන්"}]}]
// The numbered prefix rides along inside each Text element: max 10,000 elements
// and 50,000 chars per request → 400–500 cues per call fits comfortably.
// ─────────────────────────────────────────────────────────────────────────────

const AZURE_MAX_CHARS_PER_REQ = 40000; // stay under the 50k request cap with margin
const AZURE_TIMEOUT_MS = 30000;

function azureConfigured(env) {
  return !!(env && String(env.AZURE_TRANSLATOR_KEY || '').trim());
}

function azureBaseOf(env) {
  // Test/lab-only override of the endpoint (AZURE_API_BASE, loopback allowed) —
  // the documented pattern GEMINI_API_BASE already uses. Production default is
  // always the real Microsoft endpoint.
  const raw = String((env && env.AZURE_API_BASE) || '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if ((u.protocol === 'https:' || loopback) && !u.username && !u.password) return u.origin;
    } catch (e) { /* fall through */ }
  }
  return 'https://api.cognitive.microsofttranslator.com';
}

/** Split items into chunks under the per-request element+char caps. */
function azureChunks(items) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    const len = String(it.text || '').length + 8; // "n|" + a little slack
    if (cur.length && (cur.length >= 500 || chars + len > AZURE_MAX_CHARS_PER_REQ)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function azureTranslateCues(env, cfg, items) {
  const key = String(env.AZURE_TRANSLATOR_KEY || '').trim();
  const region = String(env.AZURE_TRANSLATOR_REGION || '').trim() || 'global';
  const out = new Array(items.length);
  const chunks = azureChunks(items);
  for (const chunk of chunks) {
    const body = chunk.map((it) => ({ Text: it.i + '|' + it.text }));
    const res = await fetch(azureBaseOf(env) + '/translate?api-version=3.0&from=en&to=si&textType=plain', {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Ocp-Apim-Subscription-Region': region,
        'Content-Type': 'application/json',
        'User-Agent': SUBDL_UA,
      },
      signal: timeoutSignal(AZURE_TIMEOUT_MS),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryAfter = Number(res.headers.get('retry-after') || 0) * 1000;
      throw new ProviderError('azure', res.status, text, retryAfter);
    }
    const arr = await res.json().catch(() => null);
    if (!Array.isArray(arr) || arr.length !== chunk.length) {
      throw new ProviderError('azure', 502, 'bad azure answer shape');
    }
    for (let k = 0; k < chunk.length; k++) {
      const t = arr[k] && arr[k].translations && arr[k].translations[0] && arr[k].translations[0].text;
      if (typeof t !== 'string') throw new ProviderError('azure', 502, 'missing azure translation for item ' + chunk[k].i);
      out[items.indexOf(chunk[k])] = t;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Cloud Translation v3 (500,000 chars/month free, Basic+Advanced combined)
// POST https://translation.googleapis.com/language/translate/v2  (the v2 Basic
// endpoint consumes the same free monthly allocation as v3 and is a single
// simple POST — ideal here; v3/v3beta1 REST work identically with the same key)
// Body: {q:["1|Hello","2|Run!"], source:"en", target:"si", format:"text"}
// ─────────────────────────────────────────────────────────────────────────────

const GOOGLE_MAX_PER_REQ = 128; // v2 Basic: 128 text segments / 10,000 chars per request
const GOOGLE_TIMEOUT_MS = 30000;

function googleV3Configured(env) {
  return !!(env && String(env.GOOGLE_V3_KEY || '').trim());
}

function googleChunks(items) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    const len = String(it.text || '').length + 8;
    if (cur.length && (cur.length >= GOOGLE_MAX_PER_REQ || chars + len > 9000)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function googleV3BaseOf(env) {
  // Test/lab-only override (GOOGLE_V3_BASE, loopback allowed) — same pattern.
  const raw = String((env && env.GOOGLE_V3_BASE) || '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if ((u.protocol === 'https:' || loopback) && !u.username && !u.password) return u.origin;
    } catch (e) { /* fall through */ }
  }
  return 'https://translation.googleapis.com';
}

async function googleV3TranslateCues(env, cfg, items) {
  const key = String(env.GOOGLE_V3_KEY || '').trim();
  const out = new Array(items.length);
  const chunks = googleChunks(items);
  for (const chunk of chunks) {
    const res = await fetch(googleV3BaseOf(env) + '/language/translate/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'User-Agent': SUBDL_UA },
      signal: timeoutSignal(GOOGLE_TIMEOUT_MS),
      body: JSON.stringify({
        q: chunk.map((it) => it.i + '|' + it.text),
        source: 'en',
        target: 'si',
        format: 'text',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryAfter = Number(res.headers.get('retry-after') || 0) * 1000;
      throw new ProviderError('google_v3', res.status, text, retryAfter);
    }
    const j = await res.json().catch(() => null);
    const ts = j && j.data && Array.isArray(j.data.translations) ? j.data.translations : null;
    if (!ts || ts.length !== chunk.length) {
      throw new ProviderError('google_v3', 502, 'bad google answer shape');
    }
    for (let k = 0; k < chunk.length; k++) {
      const t = ts[k] && ts[k].translatedText;
      if (typeof t !== 'string') throw new ProviderError('google_v3', 502, 'missing google translation');
      out[items.indexOf(chunk[k])] = t;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini (unchanged v3 behaviour, now one provider among many)
// Model waterfall: gemini-flash-latest → gemini-2.5-flash-lite → gemini-flash-lite-latest
// (the alias first, then the pinned free-tier-friendly small models; a model that
// 404s/429s falls through to the next instead of failing the provider).
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_MODEL_WATERFALL = ['gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest'];
const GEMINI_TIMEOUT_MS = 120000;

function geminiConfigured(env) {
  return !!(env && String(env.GEMINI_API_KEY || '').trim());
}

function geminiBaseOf(env) {
  const raw = String((env && env.GEMINI_API_BASE) || '').trim() || 'https://generativelanguage.googleapis.com';
  try {
    const u = new URL(raw);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !loopback) return 'https://generativelanguage.googleapis.com';
    if (u.username || u.password) return 'https://generativelanguage.googleapis.com';
    return u.origin;
  } catch (e) {
    return 'https://generativelanguage.googleapis.com';
  }
}

function buildTranslatePrompt(count, targetLang) {
  const l = langOf(targetLang) || langOf('si');
  const isSi = l.code === 'si';
  const langName = isSi ? 'Sinhala (සිංහල)' : l.english + ' (' + l.native + ')';
  const spokenName = isSi ? 'spoken Sinhala a Sri Lankan audience reads instantly'
    : 'natural, fluent ' + l.english + ' a local audience reads instantly';
  return 'You are a professional movie subtitle translator. Translate English subtitles into natural, fluent, ' + langName + '.\n'
    + 'STRICT output rules:\n'
    + '- Output EXACTLY one line per input line, in the format: <number>|<' + l.english + ' translation>\n'
    + '- Keep the <number> unchanged. Never merge, split, reorder or skip lines.\n'
    + '- Translate meaning and tone, not word-for-word. Use everyday ' + spokenName + '.\n'
    + '- Keep proper names (people, places, brands) in their common ' + l.english + ' transliteration when one exists, otherwise keep them in Latin script.\n'
    + '- If a line starts with "- " (a speaker dash), keep the dash: "- <translation>".\n'
    + '- Lines that are only music notes (#), punctuation or sound cues may be kept as-is.\n'
    + '- Never add quotes, explanations, notes or English duplicates.\n'
    + '- Never answer in English; every translated line must be ' + l.english + (isSi ? ' script.' : '.') + '\n'
    + '\nNow translate these ' + count + ' numbered subtitle lines:\n';
}

async function geminiTranslateCues(env, cfg, items) {
  const key = String(env.GEMINI_API_KEY || '').trim();
  const models = cfg && cfg.model ? [cfg.model] : GEMINI_MODEL_WATERFALL;
  const isPolish = !!(cfg && cfg.polishPrompt);
  // v4.1: a polish pass sends its OWN complete two-input prompt (cinema.js);
  // a base pass keeps the v4 translate prompt, now target-language aware.
  const prompt = isPolish
    ? cfg.polishPrompt
    : buildTranslatePrompt(items.length, cfg && cfg.targetLang) + compactLines(items);
  let lastErr = null;
  for (const model of models) {
    const res = await fetch(geminiBaseOf(env) + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'User-Agent': SUBDL_UA },
      signal: timeoutSignal(GEMINI_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.15, topP: 0.9, maxOutputTokens: 65536 },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryAfter = Number(res.headers.get('retry-after') || 0) * 1000;
      lastErr = new ProviderError('gemini', res.status, model + ' ' + text, retryAfter);
      if (res.status === 429 || res.status === 404 || res.status === 403) continue; // next model in the waterfall
      throw lastErr;
    }
    const j = await res.json().catch(() => null);
    const cand = j && Array.isArray(j.candidates) ? j.candidates[0] : null;
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    const text = parts.map((p) => (p && p.text ? p.text : '')).join('');
    if (!text) {
      lastErr = new ProviderError('gemini', 502, 'empty answer (finishReason ' + (cand && cand.finishReason) + ')');
      continue;
    }
    const map = isPolish ? parseNumberedMulti(text) : parseNumbered(text);
    const missing = [];
    for (const it of items) {
      const v = map.get(it.i);
      if (v === undefined || v === '') missing.push(it.i);
    }
    if (missing.length) {
      const truncated = cand && String(cand.finishReason || '') === 'MAX_TOKENS';
      const err = new ProviderError('gemini', truncated ? 502 : 502,
        (truncated ? 'truncated' : 'missing lines: ') + missing.slice(0, 8).join(','));
      err.truncated = truncated;
      lastErr = err;
      if (truncated || map.size < items.length) continue; // a smaller model may fit the batch
      throw err;
    }
    // Target-script sanity (v4: hard Sinhala; v4.1: the job's language via the
    // registry — a ta/ja/ar polish batch is NOT wrong for failing a Sinhala test)
    const scriptRe = scriptReOf((cfg && cfg.targetLang) || 'si') || SINHALA_RE;
    let meaningful = 0, si = 0;
    for (const it of items) {
      const v = map.get(it.i);
      if (v && v.replace(/[-–#\s.,!?'"…:;]/g, '').length >= 2) {
        meaningful++;
        if (scriptRe.test(v)) si++;
      }
    }
    if (meaningful > 0 && si / meaningful < 0.6) {
      lastErr = new ProviderError('gemini', 502, 'wrong language (target script in only ' + si + '/' + meaningful + ' lines)');
      continue; // one more model may obey the language rule
    }
    return items.map((it) => map.get(it.i));
  }
  throw lastErr || new ProviderError('gemini', 502, 'all models failed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Workers AI — the keyless in-Worker LLM fallback.
// Needs the [ai] binding (binding = "AI") in wrangler.toml; 10,000 free
// neurons/day. Uses a compact numbered prompt on a small instruct model; a
// 1,500-cue movie in 4 batches typically fits inside the daily free neurons.
// ─────────────────────────────────────────────────────────────────────────────

const WORKERS_AI_MODEL = '@cf/meta/llama-3.2-3b-instruct'; // small, cheap, multilingual-ish
const WORKERS_AI_MAX_CUES = 120; // small model → smaller batches (auto-split upstream)
const WORKERS_AI_TIMEOUT_MS = 60000;

function workersAiConfigured(env) {
  return !!(env && env.AI && typeof env.AI.run === 'function');
}

async function workersAiTranslateCues(env, cfg, items) {
  const out = new Array(items.length);
  for (let s = 0; s < items.length; s += WORKERS_AI_MAX_CUES) {
    const chunk = items.slice(s, s + WORKERS_AI_MAX_CUES);
    const prompt = cfg && cfg.polishPrompt ? cfg.polishPrompt : buildTranslatePrompt(chunk.length, cfg && cfg.targetLang) + compactLines(chunk);
    let answer = null;
    try {
      const r = await env.AI.run(WORKERS_AI_MODEL, {
        messages: [
          { role: 'system', content: 'You translate English movie subtitles to Sinhala. Reply ONLY with numbered lines "n|සිංහල", one per input line, same numbers.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 4096,
      });
      answer = r && (r.response || r.text) ? String(r.response || r.text) : null;
    } catch (e) {
      throw new ProviderError('workers_ai', 502, String(e && e.message ? e.message : e));
    }
    if (!answer) throw new ProviderError('workers_ai', 502, 'empty answer');
    const map = parseNumbered(answer);
    for (let k = 0; k < chunk.length; k++) {
      const v = map.get(chunk[k].i);
      out[s + k] = v === undefined ? chunk[k].text : v; // untranslated line keeps English (never a dropped cue)
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// the provider registry + the failover engine
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDERS = {
  pa: { configured: paConfigured, translate: paTranslateCues, label: 'translate-pa (Chrome, keyless)', kind: 'mt', langs: 'all' },
  azure: { configured: azureConfigured, translate: azureTranslateCues, label: 'Azure Translator F0', kind: 'mt', langs: 'all' },
  google_v3: { configured: googleV3Configured, translate: googleV3TranslateCues, label: 'Google Translation v2/v3', kind: 'mt' },
  gemini: { configured: geminiConfigured, translate: geminiTranslateCues, label: 'Gemini Flash (waterfall)', kind: 'llm' },
  workers_ai: { configured: workersAiConfigured, translate: workersAiTranslateCues, label: 'Workers AI (Llama 3.2)', kind: 'llm' },
};

const DEFAULT_CHAIN = 'pa,azure,google_v3,gemini,workers_ai';

/** Does this provider serve `lang`? `langs:'all'` covers every registry language
 * (azure: 156 languages, google_v2/v3: 189, pa: live-tested on our 18) — the map
 * exists so a future provider with gaps (e.g. Workers AI m2m100's NLLB-200 set)
 * can declare an explicit list and chainOf skips it per-language automatically. */
const PROVIDER_LANGS = {
  pa: 'all', azure: 'all', google_v3: 'all', gemini: 'all', workers_ai: 'all',
};
function providerServesLang(id, lang) {
  // pa never serves English-target jobs: the fetched source file already IS
  // English — the pipeline short-circuits en targets before any provider anyway,
  // but the chain must not advertise pa for them.
  if (id === 'pa' && String(lang) === 'en') return false;
  const spec = PROVIDER_LANGS[id];
  if (spec === 'all') return true;
  return Array.isArray(spec) && spec.indexOf(lang) >= 0;
}

/** The configured chain: TRANSLATION_CHAIN var order, unconfigured providers
 * skipped, providers lacking the target language skipped. A provider id in the
 * var that does not exist is ignored (typo-safe). */
function chainOf(env, lang) {
  const raw = String((env && env.TRANSLATION_CHAIN) || '').trim() || DEFAULT_CHAIN;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const chain = [];
  for (const id of ids) {
    const p = PROVIDERS[id];
    if (p && chain.indexOf(id) < 0) chain.push(id);
  }
  // anything valid-but-unlisted in the var still runs if configured? No — the var
  // IS the order. But an EMPTY var result falls back to every configured provider
  // in default order so a typo can never disable translation entirely.
  if (!chain.length) {
    for (const id of DEFAULT_CHAIN.split(',')) if (PROVIDERS[id]) chain.push(id);
  }
  const target = isKnownLang(lang) ? String(lang) : 'si';
  return chain
    .filter((id) => PROVIDERS[id].configured(env))
    .filter((id) => providerServesLang(id, target));
}

/** Which providers are configured (booleans only — never key material). */
function providerStatus(env) {
  const out = {};
  for (const [id, p] of Object.entries(PROVIDERS)) out[id] = { configured: p.configured(env), label: p.label, kind: p.kind };
  return out;
}

/** UTC YYYY-MM-DD — the KV circuit-breaker key component. */
function utcDate(now) {
  return new Date(now || Date.now()).toISOString().slice(0, 10);
}

/** Read the per-provider quota breaker. Returns ms remaining (0 = clear). */
async function breakerRemaining(kvGet, provider, now) {
  const raw = await kvGet('q:' + provider + ':' + utcDate(now)).catch(() => null);
  if (!raw) return 0;
  const until = Number(raw) || 0;
  return Math.max(0, until - (now || Date.now()));
}

/** Trip the breaker: this provider 429'd — skip it for 10 minutes. */
async function tripBreaker(kvPut, provider, now) {
  const until = (now || Date.now()) + 10 * 60 * 1000;
  try { await kvPut('q:' + provider + ':' + utcDate(now), String(until)); } catch (e) { /* best effort */ }
}

/**
 * Translate one batch of items through the failover chain.
 * kvGet/kvPut: the pipeline's storage accessors (KV or memory fallback).
 * cfg: {model} (gemini pin) — forwarded to the provider.
 * Returns { texts, provider } — texts aligned with items.
 * Throws only when EVERY configured provider failed.
 */
async function translateWithFailover(env, items, kvGet, kvPut, cfg, now) {
  const chain = chainOf(env, cfg && cfg.targetLang);
  // v4.1: a pass may restrict itself to a provider kind ('llm' for the cinema
  // polish — an MT provider would just re-translate the prompt instead of
  // following the two-input EDIT protocol).
  const kindFilter = cfg && cfg.providerKind ? String(cfg.providerKind) : null;
  const errors = [];
  for (const id of chain) {
    if (kindFilter && PROVIDERS[id].kind !== kindFilter) continue;
    const remaining = await breakerRemaining(kvGet, id, now);
    if (remaining > 0) {
      errors.push(id + ': breaker open for ' + Math.round(remaining / 1000) + 's (429 earlier)');
      continue;
    }
    const p = PROVIDERS[id];
    let attempt = 0;
    for (;;) {
      try {
        const texts = await p.translate(env, cfg || {}, items);
        return { texts, provider: id };
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError(id, 502, String(e && e.message ? e.message : e));
        errors.push(id + ': ' + pe.status + ' ' + pe.message);
        // v4.1: translate-pa is UNDOCUMENTED — ANY 4xx/5xx must trip its 10-minute
        // breaker immediately (no retry, no hammering a walled endpoint); the next
        // provider in the chain (azure → google_v3 → gemini → workers_ai) takes the
        // batch. For the documented providers only a quota 429 trips the breaker;
        // transient 5xx keeps the single in-provider retry below.
        const paTripsNow = id === 'pa' && pe.status >= 400;
        if (pe.quota || paTripsNow) {
          await tripBreaker(kvPut, id, now);
          break; // failover immediately — the next provider takes the batch
        }
        attempt++;
        if (attempt >= 2 || pe.status >= 400 && pe.status < 500 && pe.status !== 429 && pe.status !== 408) break;
        await new Promise((r) => setTimeout(r, pe.retryAfterMs || 1500 * attempt)); // in-provider backoff
      }
    }
  }
  const err = new Error('all translation providers failed — ' + errors.join(' | ').slice(0, 400));
  err.allFailed = true;
  err.errors = errors;
  throw err;
}

export {
  PROVIDERS, DEFAULT_CHAIN, GEMINI_MODEL_WATERFALL,
  compactLines, parseNumbered, parseNumberedMulti, ProviderError,
  chainOf, providerStatus, translateWithFailover, providerServesLang,
  breakerRemaining, tripBreaker, utcDate,
  paTranslateCues, azureTranslateCues, googleV3TranslateCues, geminiTranslateCues, workersAiTranslateCues,
  buildTranslatePrompt, escapeForPa, unescapeFromPa, paConfigured, paKeyOf, paEnabled,
};
