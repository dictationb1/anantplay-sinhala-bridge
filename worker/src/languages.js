/* AnantPlay Sinhala Subtitle Bridge v4.1 — the universal multi-language registry.
 * Shipped 2026-11-22 from the Phase-0 Gap-4 verified prototype (12/12 checks).
 * One source of truth for every layer:
 *   · code        ISO-639-1 (job ids, KV keys, NMT APIs, translate-pa)
 *   · osCode      OpenSubtitles ISO-639-2B (human-subs search)
 *   · subdlCode   SubDL language code (human-subs fallback)
 *   · native      the label shown on the player's language chips
 *   · english     English name (status/labels)
 *   · script      sinhala | latin | indic | cjk | thaat | arabic (rendering)
 *   · rtl         right-to-left layout flag (ar, ur — fa/he if ever added)
 *   · maxChars    subtitle line budget: 38–42 latin/sinhala/indic, 16–20 CJK
 *   · wrap        text-wrap discipline for the validator's line-length check
 * The Android Langs.java is a 1:1 mirror (verified by the Player lab).
 */
const LANGUAGES = {
  si: { code: 'si', osCode: 'sin', subdlCode: 'SI', native: 'සිංහල', english: 'Sinhala', script: 'sinhala', rtl: false, maxChars: 42 },
  ta: { code: 'ta', osCode: 'tam', subdlCode: 'TA', native: 'தமிழ்', english: 'Tamil', script: 'indic', rtl: false, maxChars: 38 },
  hi: { code: 'hi', osCode: 'hin', subdlCode: 'HI', native: 'हिन्दी', english: 'Hindi', script: 'indic', rtl: false, maxChars: 38 },
  en: { code: 'en', osCode: 'eng', subdlCode: 'EN', native: 'English', english: 'English', script: 'latin', rtl: false, maxChars: 42 },
  es: { code: 'es', osCode: 'spa', subdlCode: 'ES', native: 'Español', english: 'Spanish', script: 'latin', rtl: false, maxChars: 42 },
  fr: { code: 'fr', osCode: 'fre', subdlCode: 'FR', native: 'Français', english: 'French', script: 'latin', rtl: false, maxChars: 42 },
  ja: { code: 'ja', osCode: 'jpn', subdlCode: 'JA', native: '日本語', english: 'Japanese', script: 'cjk', rtl: false, maxChars: 18 },
  ko: { code: 'ko', osCode: 'kor', subdlCode: 'KO', native: '한국어', english: 'Korean', script: 'cjk', rtl: false, maxChars: 18 },
  'zh-CN': { code: 'zh-CN', osCode: 'chi', subdlCode: 'ZH', native: '中文', english: 'Chinese (Simplified)', script: 'cjk', rtl: false, maxChars: 18 },
  ar: { code: 'ar', osCode: 'ara', subdlCode: 'AR', native: 'العربية', english: 'Arabic', script: 'arabic', rtl: true, maxChars: 38 },
  ur: { code: 'ur', osCode: 'urd', subdlCode: 'UR', native: 'اردو', english: 'Urdu', script: 'arabic', rtl: true, maxChars: 38 },
  de: { code: 'de', osCode: 'ger', subdlCode: 'DE', native: 'Deutsch', english: 'German', script: 'latin', rtl: false, maxChars: 42 },
  ru: { code: 'ru', osCode: 'rus', subdlCode: 'RU', native: 'Русский', english: 'Russian', script: 'cyrillic', rtl: false, maxChars: 40 },
  pt: { code: 'pt', osCode: 'por', subdlCode: 'PT', native: 'Português', english: 'Portuguese', script: 'latin', rtl: false, maxChars: 42 },
  th: { code: 'th', osCode: 'tha', subdlCode: 'TH', native: 'ไทย', english: 'Thai', script: 'thaat', rtl: false, maxChars: 24 },
  id: { code: 'id', osCode: 'ind', subdlCode: 'ID', native: 'Bahasa Indonesia', english: 'Indonesian', script: 'latin', rtl: false, maxChars: 42 },
  tr: { code: 'tr', osCode: 'tur', subdlCode: 'TR', native: 'Türkçe', english: 'Turkish', script: 'latin', rtl: false, maxChars: 42 },
  vi: { code: 'vi', osCode: 'vie', subdlCode: 'VI', native: 'Tiếng Việt', english: 'Vietnamese', script: 'latin', rtl: false, maxChars: 42 },
};

const DEFAULT_LANG = 'si';
/** the 8 first-class chips on the player + "+ More" opens the full list */
const CHIP_LANGS = ['si', 'ta', 'hi', 'en', 'es', 'ja', 'ko', 'ar'];

function langOf(code) {
  const c = String(code || '').trim();
  return LANGUAGES[c] || null;
}
function isKnownLang(code) { return !!langOf(code); }
function isRtl(code) { const l = langOf(code); return !!(l && l.rtl); }
/** per-language validator script check (Sinhala block, Tamil block, CJK…) */
const SCRIPT_RES = {
  sinhala: /[\u0D80-\u0DFF]/, indic: /[\u0900-\u097F\u0B80-\u0BFF]/, cjk: /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/,
  latin: /[A-Za-zÀ-ÿ]/, arabic: /[\u0600-\u06FF]/, thaat: /[\u0E00-\u0E7F]/,
  cyrillic: /[\u0400-\u04FF]/,
};
function scriptReOf(code) { const l = langOf(code); return l ? (SCRIPT_RES[l.script] || SCRIPT_RES.latin) : null; }
/** max subtitle chars/line for the validator's length hygiene */
function maxCharsOf(code) { const l = langOf(code || DEFAULT_LANG); return l ? l.maxChars : 42; }

export { LANGUAGES, DEFAULT_LANG, CHIP_LANGS, langOf, isKnownLang, isRtl, scriptReOf, maxCharsOf, SCRIPT_RES };
