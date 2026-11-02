import { TR } from './tr.js';

// Interface language. UI text is written in English in the source and wrapped in
// t(); other languages map the English text to a translation (missing ones fall
// back to English). The language the agents answer in is separate: replyLanguage().

export const LANGUAGES = ['en', 'tr'];
const NAMES = { en: 'English', tr: 'Turkish' };
const DICTS = { tr: TR };

let ui = 'en';
let reply = null; // null: the system language

/** The system's language code ("tr", "en", …) from the locale settings. */
export function systemLanguage(env = process.env, locale = safeLocale()) {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || locale || 'en';
  const code = String(raw).toLowerCase().split(/[-_.]/)[0];
  return /^[a-z]{2,3}$/.test(code) && code !== 'c' ? code : 'en';
}

function safeLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en';
  }
}

/** `lang`: "en", "tr" or "auto" (the system language when it has a translation). */
export function setLanguage(lang = 'en') {
  const want = lang === 'auto' ? systemLanguage() : lang;
  ui = LANGUAGES.includes(want) ? want : 'en';
  return ui;
}

export const getLanguage = () => ui;

/** `lang`: a code ("tr"), a language name ("German") or "auto" for the system language. */
export function setReplyLanguage(lang = 'auto') {
  reply = !lang || lang === 'auto' ? null : lang;
}

/** The language agents write their answers in, as an English name for prompts. */
export function replyLanguage() {
  const code = reply || systemLanguage();
  if (NAMES[code]) return NAMES[code];
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

/** Translate UI text. `{name}` placeholders are filled from `vars`. */
export function t(text, vars) {
  const out = DICTS[ui]?.[text] ?? text;
  return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : out;
}

/**
 * A table of English UI text that reads translated: every string value (also in
 * nested objects and lists) goes through t() when it is accessed.
 */
export function localized(obj) {
  return new Proxy(obj, {
    get(target, key) {
      const v = target[key];
      if (typeof v === 'string') return t(v);
      return v && typeof v === 'object' ? localized(v) : v;
    },
  });
}

/** "1 file" / "3 files": picks the singular or plural English text, then translates. */
export function tn(n, one, many, vars = {}) {
  return t(n === 1 ? one : many, { n, ...vars });
}
