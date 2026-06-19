// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — INTERNATIONALISATION ENGINE
// File: js/i18n.js
// Version: 1.0.0
//
// SUPPORTED LANGUAGES (20):
//   en  English (default)     es  Español           pt  Português
//   hi  हिन्दी                  id  Indonesia          fr  Français
//   de  Deutsch               it  Italiano           tr  Türkçe
//   pl  Polski                nl  Nederlands         ru  Русский
//   uk  Українська            ja  日本語              ko  한국어
//   ar  العربية (RTL)         he  עברית (RTL)        vi  Tiếng Việt
//   tl  Filipino              th  ไทย
//
// HOW IT WORKS:
//   1. On init(), detects language from: URL ?lang= → localStorage → browser
//   2. Fetches /locales/{lang}.json (and /locales/en.json as fallback)
//   3. Applies lang + dir attributes to <html>
//   4. Scans DOM for data-i18n* attributes and replaces content
//   5. Fires 'languagechange' CustomEvent — app.js listens and re-renders
//      any dynamic content (toasts, ticker items, health insights, etc.)
//
// DOM ATTRIBUTE CONVENTIONS:
//   data-i18n="key"              → el.textContent = t(key)
//   data-i18n-placeholder="key" → el.placeholder  = t(key)
//   data-i18n-title="key"       → el.title         = t(key)
//   data-i18n-aria-label="key"  → el.ariaLabel     = t(key)
//   data-i18n-html="key"        → el.innerHTML     = t(key)  ← trusted only
//
// INTERPOLATION:
//   t('bulk.progress', { done: 3, total: 10 })
//   JSON: "Extracting {{done}}/{{total}}..."
//   Result: "Extracting 3/10..."
//
// EXPORTS:
//   initI18n()               — call once on DOMContentLoaded
//   setLanguage(code)        — switch language programmatically
//   t(key, vars?)            — get translated string
//   translateDOM(root?)      — re-translate a DOM subtree
//   getLanguage()            — current language code
//   getSupportedLanguages()  — array of { code, name, native, rtl }
//   renderLangSelector(el)   — inject language picker into an element
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

const SUPPORTED = [
  'en','es','pt','hi','id','fr','de','it','tr','pl','nl','ru','uk','ja','ko',
  'ar','he','vi','tl','th',
];

const RTL_LANGS   = new Set(['ar', 'he']);
const DEFAULT     = 'en';
const STORAGE_KEY = 'ytspy_lang';
const LOCALES_BASE = '/locales/';

/** Languages that need a supplemental Google Font loaded on demand */
const SPECIAL_FONTS = {
  hi: 'https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;500;600&display=swap',
  ar: 'https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400;500;600&display=swap',
  he: 'https://fonts.googleapis.com/css2?family=Noto+Sans+Hebrew:wght@400;500;600&display=swap',
  ja: 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600&display=swap',
  ko: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600&display=swap',
  th: 'https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;500;600&display=swap',
};

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let currentLang   = DEFAULT;
let strings       = {};   // active locale strings
let fallbackEn    = {};   // English fallback (always loaded when lang ≠ en)
let initialised   = false;

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialise the i18n system.
 * Call once inside DOMContentLoaded — before any t() calls in app.js.
 *
 * @returns {Promise<void>}
 */
export async function initI18n() {
  if (initialised) return;
  initialised = true;

  const lang = detectLanguage();

  // Always load English as fallback for missing keys
  if (lang !== DEFAULT) {
    fallbackEn = await loadLocale(DEFAULT);
  }

  strings     = await loadLocale(lang);
  currentLang = lang;

  applyToDocument(lang);
  translateDOM();
}

/**
 * Switch the active language at runtime.
 * Persists to localStorage. Fires 'languagechange' event.
 *
 * @param {string} code — one of SUPPORTED
 * @returns {Promise<void>}
 */
export async function setLanguage(code) {
  if (!SUPPORTED.includes(code)) return;
  if (code === currentLang)      return;

  // Ensure English fallback is loaded
  if (code !== DEFAULT && Object.keys(fallbackEn).length === 0) {
    fallbackEn = await loadLocale(DEFAULT);
  }

  strings     = await loadLocale(code);
  currentLang = code;

  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* quota or private mode */ }

  applyToDocument(code);
  translateDOM();

  // Notify app.js and any other listeners
  document.dispatchEvent(
    new CustomEvent('languagechange', { detail: { lang: code }, bubbles: false })
  );
}

/**
 * Get a translated string by dot-notation key.
 * Supports {{variable}} interpolation.
 *
 * @param {string} key  — e.g. 'errors.timeout' or 'bulk.hint'
 * @param {object} vars — e.g. { done: 3, total: 10 }
 * @returns {string}
 */
export function t(key, vars = {}) {
  // Look up in active locale, then English fallback, then return key as-is
  const raw = getPath(strings, key)
           ?? getPath(fallbackEn, key)
           ?? key;

  // Interpolate {{varName}} placeholders
  return String(raw).replace(/\{\{(\w+)\}\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{{${k}}}`
  );
}

/**
 * Translate all data-i18n* elements within a DOM root.
 * Call after dynamic content is injected into the DOM.
 *
 * @param {Document|Element} root — defaults to document
 */
export function translateDOM(root = document) {
  // textContent
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const val = t(el.getAttribute('data-i18n'));
    if (val !== el.getAttribute('data-i18n')) el.textContent = val;
  });

  // placeholder
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const val = t(el.getAttribute('data-i18n-placeholder'));
    if (val !== el.getAttribute('data-i18n-placeholder')) el.placeholder = val;
  });

  // title attribute
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const val = t(el.getAttribute('data-i18n-title'));
    if (val !== el.getAttribute('data-i18n-title')) el.title = val;
  });

  // aria-label
  root.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const val = t(el.getAttribute('data-i18n-aria-label'));
    if (val !== el.getAttribute('data-i18n-aria-label')) el.setAttribute('aria-label', val);
  });

  // innerHTML — use sparingly, only for trusted static content
  root.querySelectorAll('[data-i18n-html]').forEach(el => {
    const val = t(el.getAttribute('data-i18n-html'));
    if (val !== el.getAttribute('data-i18n-html')) el.innerHTML = val;
  });
}

/**
 * Return the current language code.
 *
 * @returns {string}
 */
export function getLanguage() {
  return currentLang;
}

/**
 * Return the full list of supported languages with metadata.
 *
 * @returns {LangEntry[]}
 */
export function getSupportedLanguages() {
  return [
    { code: 'en', name: 'English',    native: 'English',    rtl: false },
    { code: 'es', name: 'Spanish',    native: 'Español',    rtl: false },
    { code: 'pt', name: 'Portuguese', native: 'Português',  rtl: false },
    { code: 'hi', name: 'Hindi',      native: 'हिन्दी',      rtl: false },
    { code: 'id', name: 'Indonesian', native: 'Indonesia',  rtl: false },
    { code: 'fr', name: 'French',     native: 'Français',   rtl: false },
    { code: 'de', name: 'German',     native: 'Deutsch',    rtl: false },
    { code: 'it', name: 'Italian',    native: 'Italiano',   rtl: false },
    { code: 'tr', name: 'Turkish',    native: 'Türkçe',     rtl: false },
    { code: 'pl', name: 'Polish',     native: 'Polski',     rtl: false },
    { code: 'nl', name: 'Dutch',      native: 'Nederlands', rtl: false },
    { code: 'ru', name: 'Russian',    native: 'Русский',    rtl: false },
    { code: 'uk', name: 'Ukrainian',  native: 'Українська', rtl: false },
    { code: 'ja', name: 'Japanese',   native: '日本語',      rtl: false },
    { code: 'ko', name: 'Korean',     native: '한국어',      rtl: false },
    { code: 'ar', name: 'Arabic',     native: 'العربية',    rtl: true  },
    { code: 'he', name: 'Hebrew',     native: 'עברית',      rtl: true  },
    { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', rtl: false },
    { code: 'tl', name: 'Filipino',   native: 'Filipino',   rtl: false },
    { code: 'th', name: 'Thai',       native: 'ไทย',        rtl: false },
  ];
}

/**
 * Inject a fully functional language selector widget into a container element.
 * The widget renders a button + dropdown panel.
 *
 * @param {HTMLElement} containerEl — target element to inject into
 */
export function renderLangSelector(containerEl) {
  if (!containerEl) return;

  const langs  = getSupportedLanguages();
  const wrap   = document.createElement('div');
  wrap.className = 'lang-selector-wrap';

  wrap.innerHTML = `
    <button class="lang-selector" aria-haspopup="listbox" aria-expanded="false"
            aria-label="${t('lang.select')}">
      <span class="lang-selector-globe" aria-hidden="true">🌐</span>
      <span class="lang-selector-current">${langs.find(l => l.code === currentLang)?.native || 'EN'}</span>
    </button>
    <div class="lang-dropdown" role="listbox" aria-label="${t('lang.select')}">
      ${langs.map(lang => `
        <button class="lang-option ${lang.code === currentLang ? 'active' : ''}"
                role="option"
                aria-selected="${lang.code === currentLang}"
                data-lang="${lang.code}">
          <span class="lang-option-name">${lang.name}</span>
          <span class="lang-option-native">${lang.native}</span>
        </button>`).join('')}
    </div>`;

  const btn      = wrap.querySelector('.lang-selector');
  const dropdown = wrap.querySelector('.lang-dropdown');

  // Toggle dropdown
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = dropdown.classList.toggle('open');
    btn.setAttribute('aria-expanded', isOpen);
  });

  // Select language
  dropdown.addEventListener('click', async e => {
    const opt = e.target.closest('.lang-option[data-lang]');
    if (!opt) return;

    const code = opt.dataset.lang;
    dropdown.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');

    await setLanguage(code);

    // Update selector label + active state
    const currentNative = langs.find(l => l.code === code)?.native || code.toUpperCase();
    btn.querySelector('.lang-selector-current').textContent = currentNative;
    dropdown.querySelectorAll('.lang-option').forEach(o => {
      const isActive = o.dataset.lang === code;
      o.classList.toggle('active', isActive);
      o.setAttribute('aria-selected', isActive);
    });
  });

  // Close on outside click
  document.addEventListener('click', () => {
    dropdown.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });

  // Keyboard: Escape closes
  dropdown.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      btn.focus();
    }
  });

  containerEl.appendChild(wrap);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect the language to use on page load.
 * Priority: URL param → localStorage → browser Accept-Language → 'en'
 *
 * @returns {string} — validated language code
 */
function detectLanguage() {
  const urlParam  = new URLSearchParams(window.location.search).get('lang');
  const stored    = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } })();
  const browserLang = (navigator.languages?.[0] || navigator.language || '')
                        .toLowerCase()
                        .slice(0, 2);

  const candidates = [urlParam, stored, browserLang].filter(Boolean);

  for (const c of candidates) {
    if (SUPPORTED.includes(c)) return c;
  }

  return DEFAULT;
}

/**
 * Fetch and parse a locale JSON file.
 * Returns empty object on any failure — t() falls back gracefully.
 *
 * @param {string} lang
 * @returns {Promise<object>}
 */
async function loadLocale(lang) {
  try {
    const res = await fetch(`${LOCALES_BASE}${lang}.json`, {
      // Cache aggressively — locale files only change with deployments
      cache: 'force-cache',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * Apply language code to the document element and load any needed fonts.
 *
 * @param {string} lang
 */
function applyToDocument(lang) {
  const html = document.documentElement;

  // lang and data-lang attributes
  html.setAttribute('lang',      lang);
  html.setAttribute('data-lang', lang);

  // RTL / LTR direction
  if (RTL_LANGS.has(lang)) {
    html.setAttribute('dir', 'rtl');
  } else {
    html.removeAttribute('dir');
  }

  // Load supplemental font if needed (fires once per language per session)
  const fontUrl = SPECIAL_FONTS[lang];
  if (fontUrl) {
    const linkId = `i18n-font-${lang}`;
    if (!document.getElementById(linkId)) {
      const link  = document.createElement('link');
      link.id     = linkId;
      link.rel    = 'stylesheet';
      link.href   = fontUrl;
      document.head.appendChild(link);
    }
  }

  // Update URL ?lang= param without triggering a page reload
  // (Allows bookmarking and sharing in a specific language)
  try {
    const url = new URL(window.location.href);
    if (lang === DEFAULT) {
      url.searchParams.delete('lang');
    } else {
      url.searchParams.set('lang', lang);
    }
    window.history.replaceState(null, '', url.toString());
  } catch { /* non-critical */ }

  // Update hreflang alternate links in <head>
  updateHreflangTags(lang);

  // Update <meta name="description"> if a translation exists
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    const translated = t('meta.description');
    if (translated !== 'meta.description') {
      metaDesc.setAttribute('content', translated);
    }
  }

  // Update <title>
  const titleTranslated = t('meta.title');
  if (titleTranslated !== 'meta.title') {
    document.title = titleTranslated;
  }
}

/**
 * Update hreflang alternate <link> tags to reflect the current canonical language.
 *
 * @param {string} activeLang
 */
function updateHreflangTags(activeLang) {
  const base = window.location.origin + window.location.pathname;

  SUPPORTED.forEach(code => {
    const existing = document.querySelector(`link[hreflang="${code}"]`);
    const href = code === DEFAULT ? base : `${base}?lang=${code}`;

    if (existing) {
      existing.setAttribute('href', href);
    } else {
      const link = document.createElement('link');
      link.setAttribute('rel',      'alternate');
      link.setAttribute('hreflang', code);
      link.setAttribute('href',     href);
      document.head.appendChild(link);
    }
  });

  // x-default always points to the unparameterised base URL
  let xDefault = document.querySelector('link[hreflang="x-default"]');
  if (!xDefault) {
    xDefault = document.createElement('link');
    xDefault.setAttribute('rel',      'alternate');
    xDefault.setAttribute('hreflang', 'x-default');
    document.head.appendChild(xDefault);
  }
  xDefault.setAttribute('href', base);
}

/**
 * Navigate a nested object by a dot-separated key path.
 * Returns null if any segment is missing.
 *
 * @param {object} obj
 * @param {string} key  — e.g. 'errors.timeout'
 * @returns {*|null}
 */
function getPath(obj, key) {
  if (!obj || !key) return null;
  const result = key.split('.').reduce(
    (acc, segment) => (acc != null && typeof acc === 'object' ? acc[segment] : null),
    obj
  );
  return result != null ? result : null;
}
