/* AnantPlay Sinhala Subtitle Bridge v4.1 — cinema.js
 * THE CINEMA-GRADE POLISH ENGINE (Phase-0 Gap-1 verified prototype, 19/20):
 *
 *   1. cinemetaContext()      — movie title/year/genres/cast/plot from Cinemeta,
 *                                KV-cached per imdb id (ctx:<imdb>), ~800 tokens
 *   2. registerForGenres()    — Action/Comedy/Sci-Fi/Horror/Thriller → 'spoken'
 *                                (කථන සිංහල); History/Epic/War/Period → 'formal'
 *                                (the Odyssey rule); overridable per request
 *   3. flagCuesForPolish()    — DETERMINISTIC literalness/stiffness flagger:
 *                                EN idiom/slang/phrasal-verb/sarcasm patterns +
 *                                si stiff-literary markers (spoken register only)
 *                                + structural signals + Latin leakage; budget
 *                                ~20%, strong idioms (score≥3) always kept
 *   4. buildPolishPrompt()    — the TWO-INPUT protocol: EN source + NMT draft
 *                                side by side (the model EDITS the draft, it
 *                                never retranslates — that was the 4/20 mistake)
 *   5. validPolishedCue()     — per-cue fallback validator: non-empty, target
 *                                script, no leaked English, length sanity,
 *                                dash/tag preservation. A garbled cue falls
 *                                back to its clean NMT draft — the batch never
 *                                fails as a whole
 *
 * Engine-agnostic: polish runs through translateWithFailover with kind 'llm'
 * providers (gemini → workers_ai in the default chain); the prompt builder is
 * the same for every LLM provider (the numbered n| protocol).
 */

import { langOf, isKnownLang, scriptReOf } from './languages.js';

// ── 1. Cinemeta context (KV-cached) ─────────────────────────────────────────

const CTX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // a movie's metadata never changes
const FORMAL_GENRES = ['history', 'epic', 'war', 'period', 'biography', 'documentary'];

async function cinemetaContext(env, type, imdb, kvGet, kvPut, fetchImpl) {
  const f = fetchImpl || fetch;
  const key = 'ctx:' + type + ':' + imdb;
  const cached = await kvGet(key).catch(() => null);
  if (cached) {
    try {
      const j = JSON.parse(cached);
      if (j && j.fetchedAt && Date.now() - j.fetchedAt < CTX_TTL_MS) return j;
    } catch (e) { /* refetch */ }
  }
  let meta = null;
  try {
    const res = await f('https://v3-cinemeta.strem.io/meta/' + type + '/' + imdb + '.json', {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
    if (res.ok) meta = (await res.json()).meta || null;
  } catch (e) { /* context is best-effort — polish proceeds generic */ }
  const ctx = {
    fetchedAt: Date.now(),
    title: meta ? String(meta.name || '') : '',
    year: meta ? String(meta.releaseInfo || '').slice(0, 4) : '',
    genres: meta && Array.isArray(meta.genres) ? meta.genres.slice(0, 3) : [],
    cast: meta && Array.isArray(meta.cast)
      ? meta.cast.slice(0, 6).map((c) => (typeof c === 'string' ? c : c.name || '')).filter(Boolean)
      : [],
    plot: meta ? String(meta.description || '').slice(0, 220) : '',
  };
  if (kvPut) await kvPut(key, JSON.stringify(ctx)).catch(() => {});
  return ctx;
}

// ── 2. genre → register ─────────────────────────────────────────────────────

function registerForGenres(genres, override) {
  if (override === 'spoken' || override === 'formal') return override;
  const gs = (genres || []).map((g) => String(g).toLowerCase());
  if (gs.some((g) => FORMAL_GENRES.some((f) => g.indexOf(f) >= 0))) return 'formal';
  return 'spoken';
}

// ── 3. the deterministic flagger (Gap-1 verified, 12/12 semantics) ──────────

const EN_PATTERNS = [
  { re: /\bbreak a leg\b/i, w: 3 }, { re: /\bpiece of cake\b/i, w: 3 },
  { re: /\bhad me at\b/i, w: 3 }, { re: /\bmillion years\b/i, w: 3 },
  { re: /\bpoke the bear\b/i, w: 3 }, { re: /\bleave a mark\b/i, w: 3 },
  { re: /\bcat dragged in\b/i, w: 3 }, { re: /\bspill the (beans|tea)\b/i, w: 3 },
  { re: /\bunder the weather\b/i, w: 3 }, { re: /\bbeat around the bush\b/i, w: 3 },
  { re: /\bhit the (road|sack|hay|fan)\b/i, w: 3 }, { re: /\bcall it a day\b/i, w: 3 },
  { re: /\bbite the bullet\b/i, w: 3 }, { re: /\bback to square one\b/i, w: 3 },
  { re: /\bon the (same )?page\b/i, w: 2 }, { re: /\bhold your horses\b/i, w: 3 },
  { re: /\bcut me some slack\b/i, w: 3 }, { re: /\bget out of (here|town)\b/i, w: 2 },
  { re: /\bthe coast is clear\b/i, w: 3 }, { re: /\bwhat the (hell|heck)\b/i, w: 2 },
  { re: /\boh (come on|cmon|c'mon)\b/i, w: 2 },
  { re: /\b(pal|buddy|mate|dude|bro|man|sonny|kiddo)\b/i, w: 2 },
  { re: /\b(hell|damn|heck)\b/i, w: 1 }, { re: /\b(freaking|frigging|friggin|flipping)\b/i, w: 1 },
  { re: /\b(a-hole|ass|bastard|jerk)\b/i, w: 2 }, { re: /\bbadass\b/i, w: 2 },
  { re: /\bfigure out\b/i, w: 2 }, { re: /\bgive up\b/i, w: 2 },
  { re: /\bscrew(ed)? up\b/i, w: 2 }, { re: /\bmess(ed)? up\b/i, w: 1 },
  { re: /\bchill (out|off)\b/i, w: 2 }, { re: /\bscrew (it|this|you)\b/i, w: 2 },
  { re: /\bhang in (there|on)\b/i, w: 2 }, { re: /\bhurry up\b/i, w: 1 },
  { re: /\bshut up\b/i, w: 2 }, { re: /\bcome on\b/i, w: 1 },
  { re: /\bfreak out\b/i, w: 2 }, { re: /\bshow up\b/i, w: 2 },
  { re: /\bput up with\b/i, w: 2 }, { re: /\blook out\b/i, w: 2 },
  { re: /\b(kidding|joking) me\b/i, w: 3 }, { re: /\bno way\b/i, w: 2 },
  { re: /\byou wish\b/i, w: 2 }, { re: /\b(sure|yeah), (right|ok)\b/i, w: 2 },
  { re: /\btell me about it\b/i, w: 2 }, { re: /\b(big deal|whatever)\b/i, w: 1 },
  { re: /\blike (hell|crazy)\b/i, w: 2 }, { re: /\bdream on\b/i, w: 2 },
  { re: /\b(gonna|wanna|gotta|kinda|sorta|lemme|gimme|ain't|y'all)\b/i, w: 2 },
  { re: /^(well,? )?(well ){2,}/i, w: 1 },
  { re: /\b(little|small) friend\b/i, w: 3 }, { re: /\bsay hello to\b/i, w: 2 },
];

// stiff literary Sinhala markers (SPOKEN register only — in formal register
// these words are correct; the flagger never applies them there)
const SI_STIFF = [
  /\u0d9a\u0dd4\u0db8\u0d9a\u0dca/,            // කුමක් → මොකක්ද
  /\u0d94\u0dc4\u0dd4/,                        // ඔහු → එයා
  /\u0d87\u0dba/,                              // ඇය → ඇයයි/එයා
  /\u0d94\u0dc0\u0dd4\u0db1\u0dca\u0db1/,      // ඔවුන් → අය
  /\u0db4\u0dd0\u0db8\u0dd2\u0dab\u0dd2/,      // පැමිණි → ආවා
  /\u0d9a\u0dbb\u0db1\u0dca\u0db1\u0dda\u0daf/,    // කරන්නේද
  /\u0d9a\u0dd2\u0dba\u0db1\u0dca\u0db1\u0dda\u0daf/, // කියන්නේද
  /\u0dc3\u0dd2\u0da7\u0dd2\u0db1\u0dca\u0db1\u0dda\u0daf/, // සිටින්නේද
  /\u0db4\u0dd0\u0db8\u0dd2\u0dab\u0dd2\u0dba\u0dda\u0dba/, // පැමිණියේය
  /\u0db8\u0dcf\u0d9c\u0dda/,                  // මාගේ → මගේ
  /\u0d94\u0db6\u0d9c\u0dda/,                  // ඔබගේ → ඔයාගේ
  /\u0d91\u0dc3\u0dda\u0dba/,                  // එසේය
  /\u0db1\u0ddc\u0dc4\u0dd0\u0d9a\u0dd2\u0dba\u0dd2/,    // නොහැකියි → බෑ
  /\u0d94\u0db6[ \u0d9a\u0dd2\u0dba]/,         // ඔබ (address) → ඔයා
  /\u0d9a\u0dd4\u0db8\u0db1\u0dca\u0db1/,      // කුමන්න
  /\u0db4\u0dc3\u0dd4\u0dc0\u0dd2\u0dba\u0dd2/, // පසුවයි → ඊට පස්සේ
];

const PA_PASSTHROUGH_RE = /^(\s*|♪.*|\[.*\]|\(.*\))$/;
const LATIN_RE = /[A-Za-z]{2,}/;

function structuralScore(en) {
  let s = 0;
  if (/^[^a-z]*[A-Z]{4,}[^a-z]*$/.test(en.trim())) s += 1;
  if (/\?!|!\?/.test(en)) s += 1;
  if (/\.{3,}\s*$/.test(en)) s += 1;
  if (/[!]\s*$/.test(en) && en.length < 30) s += 1;
  return s;
}

/** flags: Map<cueIndex, score> — deterministic, testable, budget-capped. */
function flagCuesForPolish(enCues, nmtCues, lang, register, budgetPct) {
  const flags = new Map();
  const spokenSi = lang === 'si' && (register || 'spoken') === 'spoken';
  const budget = Math.max(2, Math.round(enCues.length * (budgetPct || 20) / 100));
  for (let i = 0; i < enCues.length; i++) {
    const en = String((enCues && enCues[i]) || '');
    const nmt = String((nmtCues && nmtCues[i]) || '');
    if (!en.trim() || PA_PASSTHROUGH_RE.test(en.trim())) continue;
    if (/^[♪\[\(]/.test(en.trim())) continue;
    let score = 0;
    for (const p of EN_PATTERNS) if (p.re.test(en)) score += p.w;
    score += structuralScore(en);
    if (spokenSi) {
      for (const m of SI_STIFF) if (m.test(nmt)) score += 2;
      if (LATIN_RE.test(nmt) && !/\b(OK|TV|CD|DNA|SOS)\b/.test(nmt)) score += 2;
    }
    if (score >= 2) flags.set(i, score);
  }
  if (flags.size > Math.max(budget, [...flags.values()].filter((s) => s >= 3).length)) {
    const keepStrong = [...flags.entries()].filter(([, s]) => s >= 3);
    const rest = [...flags.entries()].filter(([, s]) => s < 3)
      .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
      .slice(0, Math.max(0, budget - keepStrong.length));
    return new Map([...keepStrong, ...rest].sort((a, b) => a[0] - b[0]));
  }
  return flags;
}

// ── 4. the two-input polish prompt (the 19/20 protocol) ─────────────────────

const STIFF_RULES_SPOKEN = [
  '"කුමක් ද" → "මොකක්ද"', '"ඔහු/ඇය" → "එයා"', '"පැමිණියේය" → "ආවා"',
  '"මාගේ" → "මගේ"', '"ඔබගේ" → "ඔයාගේ"', '"ඔබ" → "ඔයා"', '"මිත්\u200dරයා" → "මචං/යාළුවා" (context)',
  '"ආයුබෝවන්" (wrong in tense scenes) → natural equivalent',
].join('; ');

function buildPolishPrompt(batch, ctx, lang, register, recentCues) {
  const l = langOf(lang) || langOf('si');
  const isSi = String(lang) === 'si';
  const recent = (recentCues || []).filter(Boolean).slice(-5);
  const g = (ctx && Array.isArray(ctx.genres)) ? ctx.genres : [];
  const cast = (ctx && Array.isArray(ctx.cast)) ? ctx.cast : [];
  const title = (ctx && ctx.title) || '';
  const year = (ctx && ctx.year) || '';
  const plot = (ctx && ctx.plot) || '';
  const regLine = register === 'formal'
    ? 'FORMAL LITERARY register (epic/period film): keep elevated, literary wording — this movie is NOT colloquial.'
    : 'NATURAL SPOKEN register (කථන සිංහල for si) — the way people actually talk in movies.';
  const rules = [
    'You are a professional cinema subtitle EDITOR. You are polishing a MACHINE-TRANSLATED draft, NOT retranslating.',
    'MOVIE: "' + (title || 'unknown') + '" (' + year + ')' + (g.length ? ' — ' + g.join('/') : '') + '.',
    cast.length ? 'Characters/names: ' + cast.join(', ') + '.' : '',
    plot ? 'Plot: ' + plot : '',
    regLine,
    'For EACH cue you get the ENGLISH source and the DRAFT. Edit the DRAFT: fix stiffness and literal idioms; keep meaning, names, and 90% of the wording.',
    isSi && register !== 'formal' ? 'Stiff forms to replace: ' + STIFF_RULES_SPOKEN : '',
    'Translate idiom MEANING, never word-for-word.',
    'Keep "- " speaker dashes EXACTLY. Keep <i> tags. Max ~' + l.maxChars + ' chars/line.',
    'OUTPUT: one line per cue, EXACTLY "n|polished" — nothing else, no numbering changes.',
    recent.length ? 'Recent context (read-only, for continuity — do NOT retranslate): ' + recent.join(' / ') : '',
  ].filter(Boolean).join('\n');
  const lines = batch.map((b) => b.i + '|EN: ' + b.en + ' | DRAFT: ' + b.draft);
  return rules + '\n\n' + lines.join('\n');
}

// ── 5. per-cue fallback validator (Gap-1 contract) ──────────────────────────

const EN_LEAK_RE = /\b(you|the|and|what|that|with|this|not|are)\b/i;

function validPolishedCue(en, out, draft, lang) {
  if (!out || !out.trim()) return false;
  const scriptRe = scriptReOf(lang) || scriptReOf('si');
  if (!scriptRe.test(out)) return false;                       // no target script
  if (String(lang) === 'en') return out.trim().length > 0;     // en target: any clean text
  if (EN_LEAK_RE.test(out) && /[A-Za-z]{3,}\s[A-Za-z]{3,}/.test(out)) return false; // English echo
  if (out.length > Math.max(60, String(en).length * 4)) return false;  // runaway
  if (/^- /.test(en) && !/^- /.test(out)) return false;        // dropped dash
  if (/<i>/.test(en) && !/<i>/.test(out)) return false;        // dropped italic
  // multi-line cue integrity: the polish must keep the cue's line count
  // (an LLM collapsing "- A\n- B" into one line breaks subtitle display —
  // the fallback keeps the NMT draft instead)
  const enLines = String(en).split('\n').length;
  const outLines = String(out).split('\n').length;
  const draftLines = String(draft || '').split('\n').length;
  if (enLines > 1 && outLines !== draftLines) return false;
  return true;
}

export {
  cinemetaContext, registerForGenres, flagCuesForPolish, buildPolishPrompt,
  validPolishedCue, EN_PATTERNS, SI_STIFF, FORMAL_GENRES,
};
