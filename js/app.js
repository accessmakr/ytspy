// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — UI CONTROLLER
// File: js/app.js
// Version: 2.0.0  (i18n-aware)
//
// THE ORCHESTRATOR:
// app.js is the ONLY module that touches the DOM. Every user interaction
// flows through here. It imports all 7 computation modules plus the i18n
// engine and wires their outputs to the interface.
//
//   User action → app.js → computation module → app.js renders result
//
// i18n CONTRACT:
//   - initI18n() is awaited BEFORE any other init function runs, so every
//     t() call below resolves against the correct language from first paint.
//   - translateDOM() (called inside initI18n / setLanguage) handles all
//     static page chrome marked up with data-i18n* attributes in index.html.
//   - Everything in THIS file is JS-generated dynamic content, which
//     translateDOM() cannot see — so app.js calls t() directly wherever it
//     builds strings, and re-renders dynamic sections on 'languagechange'.
//
// DOM CONTRACT:
// app.js expects these IDs in index.html. All other DOM is created dynamically.
//   #main-url            — primary URL input
//   #btn-extract         — primary extract button
//   #btn-paste           — clipboard paste button
//   #mode-toggle         — mode toggle container
//   #results             — results wrapper (hidden until first extraction)
//   #video-meta-card     — video metadata card
//   #tags-panel          — left results column
//   #thumbnails-panel    — right results column
//   #bulk-section        — bulk extraction section
//   #overlap-section     — competitor analysis section
//   #history-section     — history section
//   #templates-section   — template library section
//   #scroll-progress     — top scroll progress bar (4px)
//   #ticker-track        — scrolling ticker content
//   #affiliate-panel     — rotating affiliate/feature panel
//   #toast-container     — toast notification host
//   #seasonal-badge      — seasonal edition badge
//   #lang-selector-container — OPTIONAL. If present, the language picker
//                              widget (globe icon + dropdown) is injected
//                              here via i18n.js's renderLangSelector().
//   .copyright-year      — dynamic copyright year spans
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — IMPORTS
// ═══════════════════════════════════════════════════════════════════════════════

import {
  initI18n, t, getLanguage, translateDOM, renderLangSelector,
} from './i18n.js';

import {
  fetchVideoData, validateYouTubeInput, extractVideoIdClientSide,
  computeTagStats, formatViewCount, formatPublishDate,
  formatDurationDisplay, getBestThumbnail, getThumbnailList,
  buildPlacementPreviews, checkMaxresExists,
} from './parser.js';

import {
  saveExtraction, getHistory, removeHistoryEntry, clearHistory,
  getTemplates, saveTemplate, deleteTemplate, incrementTemplateUsage,
  saveSelectedMode, getSelectedMode, saveSectionState, getSectionState,
  getPreferences, isStorageAvailable,
} from './storage.js';

import {
  computeHealthScore, getScoreLabel, getScoreGrade, getScoreModifier,
} from './health.js';

import {
  applyTemplate, getRelevantTemplates, countExactMatches, countAddableTags,
  buildTemplatePreview, getMergeStrategies, validateTemplateName,
  validateTemplateTags, computeBudget, formatTagsForYouTube,
} from './templates.js';

import {
  computeOverlap, formatMissingTags, getColumnEmptyMessage,
} from './overlap.js';

import {
  COPY_FORMATS, copyTagsInFormat, copySingleTag,
  downloadTagsAsFile, downloadSingleThumbnail, downloadBulkZip,
  downloadBulkCsv, applySuccessFeedback, applyFailureFeedback,
  applyDownloadingState,
} from './export.js';

import {
  parseUrlList, getUrlListStats, bulkExtract,
  buildAllAccordionItems, buildUnionTagSet,
  FREQUENCY_TABLE_DISPLAY_LIMIT,
} from './bulk.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — MODULE STATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Most recently extracted single video data (from fetchVideoData) */
let currentData       = null;

/** Most recent bulk extraction results */
let currentBulkResult = null;

/** Most recent overlap analysis result */
let currentOverlap    = null;

/** Source video data behind the most recent overlap analysis — kept so the
 *  overlap panel can be fully re-rendered (translated) on languagechange. */
let currentOverlapMyData    = null;
let currentOverlapTheirData = null;

/** Whether a single extraction is in progress */
let isExtracting      = false;

/** Whether a bulk extraction is in progress */
let isBulkExtracting  = false;

/** Timer for CTA rotation */
let ctaRotationTimer  = null;

/** Index into the (translated) CTA variants array — module-level so
 *  languagechange can immediately refresh the visible button text. */
let ctaIndex           = 0;

/** Timer for affiliate panel rotation */
let affiliateTimer    = null;

/** Index of current affiliate item being displayed */
let affiliateIndex    = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — CONTENT DATA (translated — built fresh from t() on every call,
// so they always reflect the currently active language)
// Move AFFILIATE_PRODUCTS to js/config.js and import when you have affiliate
// links. Names/URLs/CTAs for real affiliates are usually NOT translated
// (brand names, tracking links) — only translate the surrounding sentence.
// ═══════════════════════════════════════════════════════════════════════════════

/** Affiliate products — add entries when links are available */
const AFFILIATE_PRODUCTS = [
  // Example entry (uncomment and fill when you have links):
  // {
  //   id: 'tubebuddy',
  //   name: 'TubeBuddy',
  //   description: 'Browser extension for advanced YouTube channel management.',
  //   cta: 'Try free →',
  //   url: 'https://www.tubebuddy.com/pricing?a=YOUR_AFFILIATE_ID',
  //   active: true,
  // },
];

/** Feature highlights shown when no affiliate products are active */
function getFeatureHighlights() {
  return [
    { text: t('affiliate.feature_placement'), sub: t('affiliate.feature_placement_sub') },
    { text: t('affiliate.feature_health'),     sub: t('affiliate.feature_health_sub')     },
    { text: t('affiliate.feature_steal'),      sub: t('affiliate.feature_steal_sub')      },
    { text: t('affiliate.feature_zip'),        sub: t('affiliate.feature_zip_sub')        },
    { text: t('affiliate.feature_shorts'),     sub: t('affiliate.feature_shorts_sub')     },
    { text: t('affiliate.feature_templates'),  sub: t('affiliate.feature_templates_sub')  },
    { text: t('affiliate.feature_free'),       sub: t('affiliate.feature_free_sub')       },
    { text: t('affiliate.feature_char'),       sub: t('affiliate.feature_char_sub')       },
  ];
}

/** CTA button text variants (cycles when idle) */
function getCtaVariants() {
  return [t('cta.v1'), t('cta.v2'), t('cta.v3'), t('cta.v4'), t('cta.v5'), t('cta.v6')];
}

/** Telemetry ticker content — anchor segment + status + feature pairs */
function getTickerItems() {
  return [
    { type: 'anchor', label: t('ticker.anchor_label'), value: '' },
    { type: 'status',  label: t('ticker.engine_label'),    value: t('ticker.engine_value')    },
    { type: 'status',  label: t('ticker.proxy_label'),     value: t('ticker.proxy_value')     },
    { type: 'status',  label: t('ticker.fallback_label'),  value: t('ticker.fallback_value')  },
    { type: 'status',  label: t('ticker.cdn_label'),       value: t('ticker.cdn_value')       },
    { type: 'status',  label: t('ticker.bulk_label'),      value: t('ticker.bulk_value')      },
    { type: 'status',  label: t('ticker.cache_label'),     value: t('ticker.cache_value')     },
    { type: 'status',  label: t('ticker.sw_label'),        value: t('ticker.sw_value')        },
    { type: 'status',  label: t('ticker.supabase_label'),  value: t('ticker.supabase_value')  },
    { type: 'feature', label: t('ticker.f_placement_label'), value: t('ticker.f_placement_value') },
    { type: 'feature', label: t('ticker.f_health_label'),    value: t('ticker.f_health_value')    },
    { type: 'feature', label: t('ticker.f_steal_label'),     value: t('ticker.f_steal_value')     },
    { type: 'feature', label: t('ticker.f_zip_label'),       value: t('ticker.f_zip_value')       },
    { type: 'feature', label: t('ticker.f_shorts_label'),    value: t('ticker.f_shorts_value')    },
    { type: 'feature', label: t('ticker.f_char_label'),      value: t('ticker.f_char_value')      },
    { type: 'feature', label: t('ticker.f_templates_label'), value: t('ticker.f_templates_value') },
    { type: 'feature', label: t('ticker.f_urls_label'),      value: t('ticker.f_urls_value')      },
    { type: 'feature', label: t('ticker.f_free_label'),      value: t('ticker.f_free_value')      },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — HEALTH SCORE RING CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const RING_RADIUS        = 54;
const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);   // 339.29

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — INITIALISATION
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // i18n MUST be ready before anything else renders text.
  await initI18n();

  initDynamicContent();
  initLangSelector();
  initScrollProgress();
  initTicker();
  initAffiliatePanel();
  initMainExtraction();
  initModeToggle();
  initCopyButtons();
  initBulkSection();
  initOverlapSection();
  initTemplatesSection();
  initHistorySection();
  initSectionToggles();
  restorePersistedState();
  renderHistoryList();
  initClipboardCheck();
  initCtaRotation();
  initLanguageChangeListener();
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — DYNAMIC CONTENT
// ═══════════════════════════════════════════════════════════════════════════════

function initDynamicContent() {
  const year = new Date().getFullYear();
  document.querySelectorAll('.copyright-year').forEach(el => {
    el.textContent = year;
  });

  const badge = qs('#seasonal-badge');
  if (badge) badge.textContent = getSeasonLabel();

  updateSchemaDateModified();
}

function getSeasonLabel() {
  const m = new Date().getMonth();
  if (m >= 2 && m <= 4)  return t('hero.seasonal_spring');
  if (m >= 5 && m <= 7)  return t('hero.seasonal_summer');
  if (m >= 8 && m <= 10) return t('hero.seasonal_fall');
  return t('hero.seasonal_winter');
}

function updateSchemaDateModified() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  const monday  = getLastMonday().toISOString().split('T')[0];

  scripts.forEach(script => {
    try {
      const data = JSON.parse(script.textContent);
      if (data.dateModified !== undefined) {
        data.dateModified = monday;
        script.textContent = JSON.stringify(data);
      }
    } catch { /* ignore malformed schema */ }
  });
}

function getLastMonday() {
  const d   = new Date();
  const day = d.getDay();                   // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day;   // days back to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6B — LANGUAGE SELECTOR
// ═══════════════════════════════════════════════════════════════════════════════

function initLangSelector() {
  const container = qs('#lang-selector-container');
  if (!container || container.dataset.langSelectorMounted) return;
  renderLangSelector(container);
  container.dataset.langSelectorMounted = 'true';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — SCROLL PROGRESS BAR
// ═══════════════════════════════════════════════════════════════════════════════

function initScrollProgress() {
  const bar = qs('#scroll-progress');
  if (!bar) return;

  window.addEventListener('scroll', () => {
    const scrolled = document.documentElement.scrollTop;
    const total    = document.documentElement.scrollHeight
                   - document.documentElement.clientHeight;
    bar.style.width = total > 0 ? `${(scrolled / total) * 100}%` : '0%';
  }, { passive: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — TELEMETRY TICKER (fixed bottom bar)
// ═══════════════════════════════════════════════════════════════════════════════

function initTicker() {
  renderTicker();
}

function renderTicker() {
  const track = qs('#ticker-track');
  if (!track) return;

  const baseItems = getTickerItems();
  // Build ticker content — doubled for seamless loop
  const items = [...baseItems, ...baseItems];
  track.innerHTML = items.map(item => {
    if (item.type === 'anchor') {
      return `<span class="ticker-anchor">${escHtml(item.label)}</span>`;
    }
    const cls  = item.type === 'status' ? 'ticker-status' : 'ticker-feature';
    const sep  = '<span class="ticker-sep"> ··· </span>';
    return `<span class="${cls}"><span class="ticker-label">${escHtml(item.label)}</span>`
         + `<span class="ticker-value">${escHtml(item.value)}</span></span>${sep}`;
  }).join('');

  // Pause on hover
  track.addEventListener('mouseenter', () => track.style.animationPlayState = 'paused');
  track.addEventListener('mouseleave', () => track.style.animationPlayState = 'running');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — AFFILIATE / FEATURE ROTATION PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function initAffiliatePanel() {
  const panel = qs('#affiliate-panel');
  if (!panel) return;

  renderAffiliateSlide();
  affiliateTimer = setInterval(advanceAffiliateSlide, 5 * 60 * 1000); // 5 minutes
}

function renderAffiliateSlide() {
  const panel = qs('#affiliate-panel');
  if (!panel) return;

  const activeAffiliates = AFFILIATE_PRODUCTS.filter(p => p.active);
  const items            = activeAffiliates.length > 0
    ? activeAffiliates
    : null;

  if (items) {
    const item     = items[affiliateIndex % items.length];
    panel.innerHTML = `
      <div class="affiliate-inner">
        <span class="affiliate-label">${escHtml(t('affiliate.label'))}</span>
        <span class="affiliate-name">${escHtml(item.name)}</span>
        <span class="affiliate-desc">${escHtml(item.description)}</span>
        <a href="${escHtml(item.url)}" target="_blank" rel="noopener sponsored"
           class="btn-ghost affiliate-cta">${escHtml(item.cta)}</a>
      </div>`;
  } else {
    // No affiliates yet — show feature highlight
    const highlights = getFeatureHighlights();
    const feature     = highlights[affiliateIndex % highlights.length];
    panel.innerHTML = `
      <div class="affiliate-inner affiliate-inner--feature">
        <span class="affiliate-label">${escHtml(t('affiliate.feature_label'))}</span>
        <span class="affiliate-feature-text">${escHtml(feature.text)}</span>
        <span class="affiliate-feature-sub">${escHtml(feature.sub)}</span>
      </div>`;
  }
}

function advanceAffiliateSlide() {
  const panel = qs('#affiliate-panel');
  if (!panel) return;
  panel.style.opacity = '0';
  setTimeout(() => {
    affiliateIndex++;
    renderAffiliateSlide();
    panel.style.opacity = '1';
  }, 400);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

function showToast(message, type = 'success', durationMs = 2500) {
  const container = qs('#toast-container');
  if (!container) return;

  const toast       = document.createElement('div');
  toast.className   = `toast toast--${type}`;
  toast.textContent = message;
  toast.setAttribute('role', 'alert');
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('toast--visible');
    setTimeout(() => {
      toast.classList.remove('toast--visible');
      setTimeout(() => {
        if (container.contains(toast)) container.removeChild(toast);
      }, 400);
    }, durationMs);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — CLIPBOARD PASTE DETECTION (page load)
// ═══════════════════════════════════════════════════════════════════════════════

function initClipboardCheck() {
  setTimeout(async () => {
    if (!navigator.clipboard?.readText) return;
    try {
      const text    = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (!trimmed) return;

      const videoId = extractVideoIdClientSide(trimmed);
      if (!videoId) return;

      const input = qs('#main-url');
      if (input && !input.value.trim()) {
        input.value = trimmed;
        showToast(t('input.clipboard_detected'), 'info', 4000);
        input.focus();
      }
    } catch { /* permission denied or unavailable — silent */ }
  }, 500);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — CTA ROTATION
// ═══════════════════════════════════════════════════════════════════════════════

function initCtaRotation() {
  ctaIndex  = 0;
  const btn = qs('#btn-extract');
  if (!btn) return;

  ctaRotationTimer = setInterval(() => {
    if (isExtracting) return;
    const variants = getCtaVariants();
    ctaIndex = (ctaIndex + 1) % variants.length;
    btn.textContent = variants[ctaIndex];
  }, 5000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — MAIN EXTRACTION FLOW
// ═══════════════════════════════════════════════════════════════════════════════

function initMainExtraction() {
  const input   = qs('#main-url');
  const btnEx   = qs('#btn-extract');
  const btnPaste = qs('#btn-paste');

  if (!input || !btnEx) return;

  // Enter key
  input.addEventListener('keydown', e => { if (e.key === 'Enter') handleExtract(); });

  // Extract button
  btnEx.addEventListener('click', handleExtract);

  // Paste button
  if (btnPaste) {
    btnPaste.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text.trim()) {
          input.value = text.trim();
          handleExtract();
        } else {
          input.focus();
        }
      } catch {
        input.focus();
      }
    });
  }

  // Auto-extract on paste into input
  input.addEventListener('paste', () => {
    setTimeout(() => {
      const val = input.value.trim();
      if (extractVideoIdClientSide(val)) handleExtract();
    }, 60);
  });
}

async function handleExtract(urlOverride) {
  if (isExtracting) return;

  const input  = qs('#main-url');
  const rawUrl = urlOverride || (input?.value?.trim() ?? '');

  const validation = validateYouTubeInput(rawUrl);
  if (!validation.valid) {
    showInputError(input);
    showToast(t('input.invalid_url_toast'), 'error');
    return;
  }

  if (urlOverride && input) input.value = urlOverride;

  setExtracting(true);
  clearResultsSection();

  try {
    const result = await fetchVideoData(rawUrl);

    if (!result.success) {
      renderExtractError(result.error, result.errorType, rawUrl);
      return;
    }

    const data         = result.data;
    const healthResult = computeHealthScore(
      data.tags    || [],
      data.tagStats,
      data.hashtags || []
    );

    data.healthScore = healthResult;
    currentData      = data;

    renderVideoMeta(data);
    renderTagsPanel(data, healthResult);
    renderThumbnailsPanel(data);
    showResultsSection();
    applyModeToggle(getSelectedMode());
    saveExtraction(data);
    renderHistoryList();
    renderTemplateSuggestions(data.tags || []);
    advanceAffiliateSlide();

    if (result.retried) {
      showToast(t('errors.retried_toast'), 'info');
    }

  } catch (err) {
    renderExtractError(err.message, 'unknown', rawUrl);
  } finally {
    setExtracting(false);
  }
}

function setExtracting(active) {
  isExtracting = active;
  const btn    = qs('#btn-extract');
  const input  = qs('#main-url');
  if (!btn) return;

  btn.disabled    = active;
  btn.textContent = active ? `${t('cta.v1')}…` : getCtaVariants()[ctaIndex];
  qs('#main-input-wrapper')?.classList.toggle('loading', active);

  if (input) input.disabled = active;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — VIDEO META CARD
// ═══════════════════════════════════════════════════════════════════════════════

function renderVideoMeta(data) {
  setText('#meta-title',   data.title   || t('meta_card.title_unavailable'));
  setText('#meta-channel', data.channel || '');
  setText('#meta-views',   data.displayViewCount || '');
  setText('#meta-date',    data.displayDate      || '');
  setText('#meta-duration',formatDurationDisplay(data.duration, data.durationSeconds));

  const thumb = qs('#meta-thumb-sm');
  if (thumb && data.thumbnails?.hq?.url) {
    thumb.src = data.thumbnails.hq.url;
    thumb.alt = data.title || data.videoId || '';
  }

  if (data.isLive)          addBadge('#video-meta-card', t('meta_card.badge_live'),       'badge--live');
  if (data.isShort)         addBadge('#video-meta-card', t('meta_card.badge_short'),      'badge--short');
  if (data.isAgeRestricted) addBadge('#video-meta-card', t('meta_card.badge_restricted'), 'badge--restricted');
  if (data.fromCache)       addBadge('#video-meta-card', t('meta_card.badge_cached'),     'badge--cache');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 15 — TAGS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function renderTagsPanel(data, healthResult) {
  const stats = data.tagStats;

  // ── Tag count badge ───────────────────────────────────────────────────────
  const total = stats.total;
  setText('#tag-count-badge',
    total === 1 ? t('tags_panel.tag_count_one', { n: total }) : t('tags_panel.tag_count_many', { n: total })
  );

  // ── Character counter ─────────────────────────────────────────────────────
  setText('#char-used',      stats.charUsed);
  setText('#char-remaining',
    stats.charRemaining >= 0
      ? t('tags_panel.remaining',  { n: stats.charRemaining })
      : t('tags_panel.over_limit', { n: Math.abs(stats.charRemaining) })
  );

  const fill = qs('#char-bar-fill');
  if (fill) {
    const pct = Math.min(stats.charPct * 100, 120);   // allow overflow to show
    fill.style.width = `${pct}%`;
    fill.className   = 'char-bar-fill'
      + (stats.overLimit     ? ' danger'
        : stats.charPct > 0.80 ? ' warn'
        : '');

    // Accessibility
    const bar = qs('.char-bar-track');
    if (bar) {
      bar.setAttribute('role',          'progressbar');
      bar.setAttribute('aria-valuenow', stats.charUsed);
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '500');
    }
  }

  setText('#char-hint', stats.budgetHint);

  // ── Tail breakdown ────────────────────────────────────────────────────────
  setText('#count-short', stats.shortTailCount);
  setText('#count-mid',   stats.midTailCount);
  setText('#count-long',  stats.longTailCount);

  // ── Tag pills ─────────────────────────────────────────────────────────────
  renderTagPills(data.tags || [], stats, data.noTagsMessage);

  // ── Hashtags ──────────────────────────────────────────────────────────────
  renderHashtags(data.hashtags || []);

  // ── Health score card ─────────────────────────────────────────────────────
  renderHealthScore(healthResult);
}

function renderTagPills(tags, stats, noTagsMessage) {
  const container = qs('#tag-pills-output');
  if (!container) return;
  container.innerHTML = '';

  if (!tags.length) {
    const msg  = document.createElement('p');
    msg.className   = 'no-tags-message';
    msg.textContent = noTagsMessage || t('tags_panel.no_tags_default');
    container.appendChild(msg);
    return;
  }

  const truncatedSet = new Set(
    (stats.truncatedTags || []).map(t => t.toLowerCase())
  );

  tags.forEach((tag, i) => {
    const norm      = tag.toLowerCase();
    const typeClass = stats.typeMap?.get(norm) || '';
    const isTrunc   = truncatedSet.has(norm);

    const pill = document.createElement('span');
    pill.className = [
      'tag-pill',
      typeClass,
      isTrunc ? 'tag-pill--truncated' : '',
    ].filter(Boolean).join(' ');

    pill.textContent          = tag;
    pill.style.animationDelay = `${i * 18}ms`;
    pill.setAttribute('role',  'listitem');
    pill.setAttribute('title',
      (typeClass ? typeClass.replace('-', ' ') : '')
      + (isTrunc ? ` — ${t('tags_panel.truncated_title')}` : '')
    );

    // Click-to-copy individual pill
    pill.style.cursor = 'pointer';
    pill.addEventListener('click', async () => {
      const result = await copySingleTag(tag);
      if (result.success) {
        const orig = pill.style.background;
        pill.style.background = 'var(--bg-hover)';
        pill.style.color      = 'var(--accent-green)';
        setTimeout(() => {
          pill.style.background = orig;
          pill.style.color      = '';
        }, 800);
      }
    });

    container.appendChild(pill);
  });
}

function renderHashtags(hashtags) {
  const section   = qs('#hashtag-section');
  const container = qs('#hashtag-output');
  if (!section || !container) return;

  if (!hashtags.length) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  container.innerHTML = '';

  hashtags.forEach(tag => {
    const pill       = document.createElement('span');
    pill.className   = 'tag-pill hashtag-pill';
    pill.textContent = tag;
    pill.style.cursor = 'pointer';
    pill.addEventListener('click', () => copySingleTag(tag));
    container.appendChild(pill);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 16 — HEALTH SCORE PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function renderHealthScore(healthResult) {
  const card = qs('#health-score-card');
  if (!card) return;

  const score    = healthResult.overall;
  const modifier = getScoreModifier(score);

  // ── Score ring (SVG) ──────────────────────────────────────────────────────
  const ringContainer = qs('#health-ring-container');
  if (ringContainer) {
    const offset = +(RING_CIRCUMFERENCE * (1 - score / 100)).toFixed(2);
    ringContainer.innerHTML = `
      <svg class="score-ring score-ring--${modifier}"
           viewBox="0 0 120 120"
           aria-label="${escHtml(t('health.panel_title'))} ${score} ${escHtml(t('health.out_of'))}">
        <circle class="score-ring__track"
          cx="60" cy="60" r="${RING_RADIUS}"
          fill="none" stroke-width="8" />
        <circle class="score-ring__fill"
          cx="60" cy="60" r="${RING_RADIUS}"
          fill="none" stroke-width="8"
          stroke-dasharray="${RING_CIRCUMFERENCE}"
          stroke-dashoffset="${RING_CIRCUMFERENCE}"
          data-target-offset="${offset}"
          style="transform:rotate(-90deg);transform-origin:center;" />
      </svg>
      <div class="score-ring__center">
        <span class="score-ring__number">${score}</span>
        <span class="score-ring__grade">${healthResult.grade}</span>
      </div>`;

    // Animate ring fill after paint
    requestAnimationFrame(() => {
      setTimeout(() => {
        const fill = ringContainer.querySelector('.score-ring__fill');
        if (fill) fill.style.strokeDashoffset = offset;
      }, 80);
    });
  }

  setText('#health-score-label', healthResult.label);
  setText('#health-score-summary', healthResult.summary);

  // ── Component bars ────────────────────────────────────────────────────────
  const components = healthResult.components;
  renderComponentBar('#health-comp-budget',
    components.budget, t('health.comp_budget'));
  renderComponentBar('#health-comp-tail',
    components.tailDistribution, t('health.comp_tail'));
  renderComponentBar('#health-comp-diversity',
    components.diversity, t('health.comp_diversity'));
  renderComponentBar('#health-comp-hashtag',
    components.hashtagAlignment, t('health.comp_hashtag'));

  // ── Suggestions ───────────────────────────────────────────────────────────
  const sugContainer = qs('#health-suggestions');
  if (sugContainer && healthResult.suggestions?.length) {
    sugContainer.innerHTML = healthResult.suggestions.slice(0, 4).map(sug => `
      <div class="health-suggestion health-suggestion--${sug.priority}">
        <span class="sug-gain">${escHtml(t('health.potential_gain', { n: sug.potentialGain }))}</span>
        <span class="sug-text">${escHtml(sug.text)}</span>
      </div>`).join('');
  }
}

function renderComponentBar(selector, component, label) {
  const el = qs(selector);
  if (!el) return;

  const pct   = Math.round(component.pct * 100);
  const score = component.score;
  const max   = component.maxScore;

  el.innerHTML = `
    <div class="comp-bar-header">
      <span class="comp-label">${escHtml(label)}</span>
      <span class="comp-score">${score} / ${max}</span>
    </div>
    <div class="comp-bar-track">
      <div class="comp-bar-fill" style="width:${pct}%"></div>
    </div>
    <p class="comp-insight">${escHtml(component.insight || '')}</p>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 17 — THUMBNAILS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function renderThumbnailsPanel(data) {
  renderYouTubePreviewCard(data);
  renderThumbnailDownloadGrid(data);
  renderPlacementPreviews(data);
  renderCanvaLink(data.videoId);
}

function renderYouTubePreviewCard(data) {
  const thumb = qs('#yt-preview-thumb');
  if (thumb) {
    thumb.src = data.thumbnails?.hq?.url || '';
    thumb.alt = data.title || data.videoId || '';
  }
  setText('#yt-preview-title',   data.title   || '');
  setText('#yt-preview-channel', data.channel || '');
  setText('#yt-preview-views',   data.displayViewCount || '');
  setText('#yt-duration-badge',
    formatDurationDisplay(data.duration, data.durationSeconds));
}

function renderThumbnailDownloadGrid(data) {
  const grid = qs('#thumb-download-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Optimistically render all resolutions
  // maxresExistsPromise will update the maxres button when resolved
  const list = getThumbnailList(data.thumbnails, data.isShort, true);

  list.forEach(thumb => {
    const row       = document.createElement('div');
    row.className   = 'thumb-download-row';
    row.dataset.res = thumb.resolution;

    const noteHtml = thumb.note
      ? `<span class="thumb-note">${escHtml(thumb.note)}</span>` : '';
    const unavailHtml = thumb.unavailable
      ? `<span class="thumb-unavailable">${escHtml(thumb.unavailableReason || t('thumbnails.unavailable_reason'))}</span>` : '';

    row.innerHTML = `
      <div class="thumb-preview-mini">
        <img src="${escHtml(thumb.url)}"
             alt="${escHtml(thumb.label)}"
             loading="lazy"
             onerror="this.closest('.thumb-download-row').classList.add('thumb-row--missing')">
      </div>
      <div class="thumb-info">
        <span class="thumb-res">${escHtml(thumb.label)}</span>
        <span class="thumb-fmt">${escHtml(thumb.format)}</span>
        ${noteHtml}${unavailHtml}
      </div>
      <button class="btn-ghost btn-download"
              ${thumb.unavailable ? 'disabled' : ''}
              aria-label="${escHtml(t('thumbnails.download_btn'))} ${escHtml(thumb.label)}">
        ${escHtml(t('thumbnails.download_btn'))}
      </button>`;

    if (!thumb.unavailable) {
      const btn = row.querySelector('.btn-download');
      btn.addEventListener('click', async () => {
        const restoreBtn = applyDownloadingState(btn, t('thumbnails.downloading'));
        try {
          await downloadSingleThumbnail(
            thumb.url, data.videoId, thumb.resolution, thumb.format.toLowerCase()
          );
        } finally {
          restoreBtn();
        }
      });
    }

    grid.appendChild(row);
  });

  // Async maxres check — update the maxres row once resolved
  if (data.maxresExistsPromise) {
    data.maxresExistsPromise.then(exists => {
      if (!exists) {
        const maxresRow = grid.querySelector('[data-res="maxres"]');
        if (maxresRow) maxresRow.classList.add('thumb-row--missing');
      }
    });
  }
}

function renderPlacementPreviews(data) {
  const container = qs('#placement-previews');
  if (!container) return;

  const previews  = data.placementPreviews || buildPlacementPreviews(data.thumbnails, data.isShort);
  const thumbUrl  = data.thumbnails?.hq?.url || '';

  container.innerHTML = previews.map(ctx => `
    <div class="placement-preview">
      <div class="placement-thumb-wrap"
           style="width:${ctx.width}px;height:${ctx.height}px;${ctx.isCropped ? 'overflow:hidden;' : ''}">
        <img src="${escHtml(thumbUrl)}"
             alt="${escHtml(ctx.label)}"
             loading="lazy"
             style="width:100%;height:100%;object-fit:cover;">
      </div>
      <span class="placement-label">${escHtml(ctx.label)}</span>
      <span class="placement-desc">${escHtml(ctx.description)}</span>
    </div>`).join('');
}

function renderCanvaLink(videoId) {
  const link = qs('#canva-link');
  if (!link) return;
  link.href = 'https://www.canva.com/design/new?category=TACDE3SXUQQ&width=1280&height=720';
  link.setAttribute('rel', 'noopener noreferrer');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 18 — COPY BUTTONS
// ═══════════════════════════════════════════════════════════════════════════════

function initCopyButtons() {
  document.addEventListener('click', async e => {
    const btn = e.target.closest('.btn-copy[data-format]');
    if (!btn || !currentData?.tags) return;

    const format = btn.dataset.format;
    const result = await copyTagsInFormat(currentData.tags, format);

    if (result.success) {
      applySuccessFeedback(btn);
      showToast(t('copy_success', { format: COPY_FORMATS[format]?.label || format }));
    } else {
      applyFailureFeedback(btn);
      showToast(t('copy_failed'), 'error');
    }
  });

  // Download tags as file
  document.addEventListener('click', e => {
    const btn = e.target.closest('.btn-download-tags[data-format]');
    if (!btn || !currentData?.tags) return;

    const format   = btn.dataset.format;
    const baseName = `ytspy_${currentData.videoId || 'tags'}`;
    downloadTagsAsFile(currentData.tags, format, baseName);
    showToast(t('tags_file_downloaded'));
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 19 — MODE TOGGLE
// ═══════════════════════════════════════════════════════════════════════════════

function initModeToggle() {
  const group = qs('#mode-toggle');
  if (!group) return;

  group.addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn[data-mode]');
    if (!btn) return;

    group.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const mode = btn.dataset.mode;
    applyModeToggle(mode);
    saveSelectedMode(mode);
  });
}

function applyModeToggle(mode) {
  const tagsPanel  = qs('#tags-panel');
  const thumbPanel = qs('#thumbnails-panel');
  if (!tagsPanel || !thumbPanel) return;

  tagsPanel.classList.toggle('hidden',  mode === 'thumbnails');
  thumbPanel.classList.toggle('hidden', mode === 'tags');

  // Sync button states
  document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 20 — BULK SECTION
// ═══════════════════════════════════════════════════════════════════════════════

function initBulkSection() {
  const textarea = qs('#bulk-urls');
  const btnBulk  = qs('#btn-bulk-extract');
  const btnZip   = qs('#btn-bulk-zip');
  const btnCsv   = qs('#btn-bulk-csv');

  if (!textarea) return;

  // Live URL counter
  textarea.addEventListener('input', () => {
    const stats = getUrlListStats(textarea.value);
    setText('#bulk-hint', stats.displayHint);
    const hint = qs('#bulk-hint');
    if (hint) hint.style.color = stats.atLimit ? 'var(--accent-amber)' : '';
  });

  // Extract all
  if (btnBulk) {
    btnBulk.addEventListener('click', handleBulkExtract);
  }

  // Download ZIP
  if (btnZip) {
    btnZip.addEventListener('click', async () => {
      if (!currentBulkResult?.bulkVideoMap) return;
      const restore = applyDownloadingState(btnZip, t('bulk.zipping', { done: 0, total: 0 }));
      try {
        const result = await downloadBulkZip(
          currentBulkResult.bulkVideoMap,
          'hq',
          (done, total) => {
            btnZip.textContent = t('bulk.zipping', { done, total });
          }
        );
        if (result.success) {
          showToast(t('bulk.zip_success', { count: result.count }));
        } else {
          showToast(result.error || t('bulk.zip_failed'), 'error');
        }
      } finally {
        restore();
      }
    });
  }

  // Download CSV
  if (btnCsv) {
    btnCsv.addEventListener('click', () => {
      if (!currentBulkResult?.frequencyTable) return;
      const total = currentBulkResult.successCount;
      downloadBulkCsv(currentBulkResult.frequencyTable, total);
      showToast(t('bulk.csv_downloaded'));
    });
  }

  // Copy all unique tags
  document.addEventListener('click', async e => {
    if (!e.target.closest('#btn-bulk-copy-union')) return;
    if (!currentBulkResult?.successVideos) return;

    const union  = buildUnionTagSet(currentBulkResult.successVideos);
    const text   = formatTagsForYouTube(union);
    const result = await copyTagsInFormat(union, 'yt');

    if (result.success) {
      showToast(t('bulk.union_copied', { count: union.length }));
    }
  });
}

async function handleBulkExtract() {
  if (isBulkExtracting) return;

  const textarea = qs('#bulk-urls');
  const btnBulk  = qs('#btn-bulk-extract');
  if (!textarea) return;

  const parsed = parseUrlList(textarea.value);

  if (!parsed.isReady) {
    showToast(t('bulk.no_urls_error'), 'error');
    return;
  }

  isBulkExtracting = true;
  if (btnBulk) {
    btnBulk.disabled    = true;
    btnBulk.textContent = t('bulk.extracting', { done: 0, total: parsed.validCount });
  }

  try {
    const result = await bulkExtract(parsed.validUrls, (done, total) => {
      if (btnBulk) btnBulk.textContent = t('bulk.extracting', { done, total });
    });

    currentBulkResult = result;
    renderBulkResults(result);

  } finally {
    isBulkExtracting = false;
    if (btnBulk) {
      btnBulk.disabled    = false;
      btnBulk.textContent = t('bulk.extract_btn');
    }
  }
}

function renderBulkResults(result) {
  const wrapper = qs('#bulk-results');
  if (!wrapper) return;
  wrapper.classList.remove('hidden');

  // ── Summary ───────────────────────────────────────────────────────────────
  setText('#bulk-summary-text', result.summary.summaryText);

  // ── Frequency table ───────────────────────────────────────────────────────
  renderFrequencyTable(result.frequencyTable, result.successCount);

  // ── Per-video accordion ───────────────────────────────────────────────────
  renderBulkAccordion(buildAllAccordionItems(result.videos));

  // Show/hide action buttons
  qs('#btn-bulk-zip')?.classList.remove('hidden');
  if (result.frequencyTable.length > 0) {
    qs('#btn-bulk-csv')?.classList.remove('hidden');
    qs('#btn-bulk-copy-union')?.classList.remove('hidden');
  }
}

function renderFrequencyTable(table, totalVideos) {
  const tbody = qs('#freq-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const displayRows = table.slice(0, FREQUENCY_TABLE_DISPLAY_LIMIT);

  displayRows.forEach(entry => {
    const tr = document.createElement('tr');

    const heatColor = `rgba(255,59,59,${(entry.heatIntensity * 0.6 + 0.1).toFixed(2)})`;

    tr.innerHTML = `
      <td class="freq-tag">
        <span class="tag-pill tag-pill--${entry.tagType}">${escHtml(entry.tag)}</span>
      </td>
      <td class="freq-count">${entry.pctDisplay}</td>
      <td class="freq-bar">
        <div style="width:${Math.round(entry.pct * 100)}%;
                    height:3px;
                    background:${heatColor};
                    border-radius:2px;"></div>
      </td>
      <td class="freq-type">${escHtml(entry.tagType)}</td>
      <td>
        <button class="btn-ghost btn-sm freq-copy-btn"
                data-tag="${escHtml(entry.tag)}"
                aria-label="${escHtml(entry.tag)}">
          ${escHtml(t('tags_panel.copy_action'))}
        </button>
      </td>`;

    tbody.appendChild(tr);
  });

  // Event delegation for copy buttons in table
  tbody.addEventListener('click', async e => {
    const btn = e.target.closest('.freq-copy-btn[data-tag]');
    if (!btn) return;
    const result = await copySingleTag(btn.dataset.tag);
    if (result.success) applySuccessFeedback(btn, 800);
  });
}

function renderBulkAccordion(items) {
  const container = qs('#bulk-per-video');
  if (!container) return;
  container.innerHTML = '';

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = `bulk-video-row ${item.success ? '' : 'bulk-video-row--error'}`;

    if (!item.success) {
      div.innerHTML = `
        <div class="bulk-video-header">
          <span class="bulk-video-title bulk-video-title--error">
            ${escHtml(t('bulk.video_failed', { n: item.index + 1 }))} — ${escHtml(item.errorMessage)}
          </span>
        </div>`;
      container.appendChild(div);
      return;
    }

    const tagCountText = item.tagCount === 1
      ? t('tags_panel.tag_count_one',  { n: item.tagCount })
      : t('tags_panel.tag_count_many', { n: item.tagCount });

    div.innerHTML = `
      <div class="bulk-video-header">
        <img src="${escHtml(item.thumbUrl)}" width="56" height="32" loading="lazy" alt="">
        <div class="bulk-video-info">
          <span class="bulk-video-title">${escHtml(item.title)}</span>
          <span class="bulk-video-meta">
            ${escHtml(tagCountText)} ·
            ${item.charUsed}/500 ·
            ${escHtml(t('health.panel_title'))} ${item.healthScore}${escHtml(t('health.out_of'))} ${escHtml(item.healthLabel)}
          </span>
        </div>
        <button class="btn-ghost btn-sm bulk-toggle-btn" aria-expanded="false">
          ${escHtml(t('bulk.show_tags_btn'))}
        </button>
      </div>
      <div class="bulk-video-tags hidden" role="list"></div>`;

    // Populate tag pills lazily on expand
    const toggleBtn = div.querySelector('.bulk-toggle-btn');
    const tagsDiv   = div.querySelector('.bulk-video-tags');
    let   rendered  = false;

    toggleBtn.addEventListener('click', () => {
      const isHidden = tagsDiv.classList.toggle('hidden');
      toggleBtn.textContent = isHidden ? t('bulk.show_tags_btn') : t('bulk.hide_tags_btn');
      toggleBtn.setAttribute('aria-expanded', !isHidden);

      if (!rendered && !isHidden) {
        rendered = true;
        // Get tags from currentBulkResult
        const videoData = currentBulkResult?.successVideos
          ?.find(v => v.videoId === item.videoId);
        if (videoData?.tags) {
          videoData.tags.forEach(tag => {
            const pill = document.createElement('span');
            pill.className   = 'tag-pill';
            pill.textContent = tag;
            pill.setAttribute('role', 'listitem');
            tagsDiv.appendChild(pill);
          });
        }
      }
    });

    container.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 21 — OVERLAP ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

function initOverlapSection() {
  const btnAnalyze = qs('#btn-overlap-analyze');
  if (!btnAnalyze) return;

  btnAnalyze.addEventListener('click', handleOverlapAnalysis);
}

async function handleOverlapAnalysis() {
  const myUrl    = qs('#overlap-my-url')?.value?.trim()    || '';
  const theirUrl = qs('#overlap-their-url')?.value?.trim() || '';

  if (!validateYouTubeInput(myUrl).valid) {
    showToast(t('overlap.error_need_my'), 'error');
    return;
  }
  if (!validateYouTubeInput(theirUrl).valid) {
    showToast(t('overlap.error_need_their'), 'error');
    return;
  }

  const btn = qs('#btn-overlap-analyze');
  const restore = applyDownloadingState(btn, t('overlap.analyzing'));

  try {
    const [myResult, theirResult] = await Promise.all([
      fetchVideoData(myUrl),
      fetchVideoData(theirUrl),
    ]);

    if (!myResult.success) {
      showToast(t('overlap.error_my_failed', { error: myResult.error }), 'error');
      return;
    }
    if (!theirResult.success) {
      showToast(t('overlap.error_their_failed', { error: theirResult.error }), 'error');
      return;
    }

    const myTags    = myResult.data.tags    || [];
    const theirTags = theirResult.data.tags || [];
    const myCharUsed = myResult.data.tagStats?.charUsed || 0;

    currentOverlap         = computeOverlap(myTags, theirTags, myCharUsed);
    currentOverlapMyData    = myResult.data;
    currentOverlapTheirData = theirResult.data;
    renderOverlapResults(currentOverlap, myResult.data, theirResult.data);

  } finally {
    restore();
  }
}

function renderOverlapResults(overlap, myData, theirData) {
  const wrapper = qs('#overlap-results');
  if (!wrapper) return;
  wrapper.classList.remove('hidden');

  // Score and label
  setText('#overlap-score-val',  overlap.overlapScore);
  setText('#overlap-score-label', overlap.overlapLabel);
  setText('#overlap-interpretation', overlap.interpretation);
  setText('#overlap-recommendation', overlap.recommendation);

  // Column counts
  setText('#shared-count',  overlap.sharedCount);
  setText('#missing-count', overlap.missingCount);
  setText('#unique-count',  overlap.uniqueCount);

  // Column content
  const ctx = {
    myHasTags:    (myData?.tags?.length   || 0) > 0,
    theirHasTags: (theirData?.tags?.length || 0) > 0,
  };

  renderOverlapColumn('#shared-tags',  overlap.shared,         'shared',  ctx);
  renderOverlapColumn('#missing-tags', overlap.rankedMissing,  'missing', ctx);
  renderOverlapColumn('#unique-tags',  overlap.unique,         'unique',  ctx);

  // Steal-tags button
  const stealBtn = qs('#btn-steal-tags');
  if (stealBtn && overlap.missingCount > 0) {
    stealBtn.classList.remove('hidden');
    stealBtn.onclick = async () => {
      const result = await copyTagsInFormat(overlap.rankedMissing, 'yt');
      if (result.success) {
        applySuccessFeedback(stealBtn);
        showToast(t('overlap.steal_success', { count: overlap.missingCount }));
      }
    };
  }

  // Save competitor research as template
  const saveBtn = qs('#btn-save-competitor-template');
  if (saveBtn && overlap.missingCount > 0) {
    saveBtn.classList.remove('hidden');
    saveBtn.onclick = () => openSaveTemplateModal(
      overlap.rankedMissing,
      overlap.templatePayload?.suggestedName || t('overlap.title')
    );
  }
}

function renderOverlapColumn(selector, tags, type, ctx) {
  const container = qs(selector);
  if (!container) return;
  container.innerHTML = '';

  if (!tags.length) {
    const msg       = document.createElement('p');
    msg.className   = 'overlap-empty';
    msg.textContent = getColumnEmptyMessage(type, ctx);
    container.appendChild(msg);
    return;
  }

  tags.forEach(tag => {
    const pill     = document.createElement('span');
    pill.className = `tag-pill overlap-pill overlap-pill--${type}`;
    pill.textContent = tag;
    pill.style.cursor = 'pointer';
    pill.addEventListener('click', () => copySingleTag(tag));
    container.appendChild(pill);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 22 — TEMPLATE LIBRARY
// ═══════════════════════════════════════════════════════════════════════════════

function initTemplatesSection() {
  // Save current tags as template button
  document.addEventListener('click', e => {
    if (!e.target.closest('#btn-save-template')) return;
    if (!currentData?.tags?.length) {
      showToast(t('templates.extract_first_toast'), 'error');
      return;
    }
    openSaveTemplateModal(currentData.tags, currentData.title?.slice(0, 50) || '');
  });

  // Apply template (delegated from template cards)
  document.addEventListener('click', async e => {
    const applyBtn = e.target.closest('.btn-apply-template[data-template-id]');
    if (!applyBtn) return;

    const id       = applyBtn.dataset.templateId;
    const template = getTemplates().find(tpl => tpl.id === id);
    if (!template) return;

    const strategy = qs('#template-strategy-select')?.value || 'union';
    const result   = applyTemplate(template.tags, currentData?.tags || [], strategy);

    incrementTemplateUsage(id);

    const copyResult = await copyTagsInFormat(result.tags, 'yt');
    if (copyResult.success) {
      showToast(result.summary);
    }
  });

  // Delete template
  document.addEventListener('click', e => {
    const delBtn = e.target.closest('.btn-delete-template[data-template-id]');
    if (!delBtn) return;
    if (!confirm(t('templates.confirm_delete'))) return;

    deleteTemplate(delBtn.dataset.templateId);
    renderTemplateLibrary();
    showToast(t('templates.deleted_toast'));
  });
}

function openSaveTemplateModal(tags, suggestedName = '') {
  const preview = tags.slice(0, 5).join(', ')
    + (tags.length > 5 ? ` … +${tags.length - 5}` : '');

  const name = prompt(
    `${t('templates.save_prompt_title', { count: tags.length })}\n\n`
    + t('templates.save_prompt_preview', { n: Math.min(5, tags.length), preview }),
    suggestedName
  );

  if (!name) return;

  const nameValid = validateTemplateName(name);
  if (!nameValid.valid) {
    showToast(nameValid.error, 'error');
    return;
  }

  const result = saveTemplate(name, tags, {
    sourceVideoId: currentData?.videoId || null,
    sourceTitle:   currentData?.title   || '',
  });

  if (result.success) {
    showToast(t('templates.saved_toast', { name }));
    renderTemplateLibrary();
    // Expand template section if collapsed
    const body = qs('#templates-body');
    if (body?.classList.contains('hidden')) {
      body.classList.remove('hidden');
      saveSectionState('templates', true);
    }
  } else {
    showToast(result.error || t('templates.save_failed_toast'), 'error');
  }
}

function renderTemplateLibrary() {
  const container = qs('#templates-list');
  if (!container) return;

  const templates = getTemplates();

  if (!templates.length) {
    container.innerHTML = `<p class="templates-empty">${t('templates.empty')}</p>`;
    return;
  }

  container.innerHTML = templates.map(tpl => {
    const preview = buildTemplatePreview(tpl.tags, 5);
    return `
      <div class="template-card">
        <div class="template-card__header">
          <span class="template-card__name">${escHtml(tpl.name)}</span>
          <span class="template-card__meta">${escHtml(preview.summary)}</span>
        </div>
        <div class="template-card__preview">
          ${preview.visibleTags.map(tag =>
            `<span class="tag-pill tag-pill--sm">${escHtml(tag)}</span>`
          ).join('')}
          ${preview.hiddenCount > 0
            ? `<span class="template-more">+${preview.hiddenCount}</span>`
            : ''}
        </div>
        <div class="template-card__actions">
          <button class="btn-primary btn-sm btn-apply-template"
                  data-template-id="${escHtml(tpl.id)}"
                  title="${escHtml(t('templates.apply_btn'))}">
            ${escHtml(t('templates.apply_btn'))}
          </button>
          <button class="btn-ghost btn-sm btn-delete-template"
                  data-template-id="${escHtml(tpl.id)}"
                  title="${escHtml(t('templates.delete_btn'))}">
            ${escHtml(t('templates.delete_btn'))}
          </button>
        </div>
      </div>`;
  }).join('');
}

function renderTemplateSuggestions(videoTags) {
  const container = qs('#template-suggestions');
  if (!container) return;

  const templates   = getTemplates();
  const suggestions = getRelevantTemplates(videoTags, templates);

  if (!suggestions.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="template-suggestions-header">
      <span>${escHtml(t('templates.suggestions_heading'))}</span>
    </div>
    ${suggestions.map(tpl => `
      <div class="template-suggestion-chip">
        <span class="chip-name">${escHtml(tpl.name)}</span>
        <span class="chip-meta">${escHtml(t('templates.new_tags_label', { count: tpl.addableCount }))}</span>
        <button class="btn-ghost btn-xs btn-apply-template"
                data-template-id="${escHtml(tpl.id)}">
          ${escHtml(t('templates.apply_btn'))}
        </button>
      </div>`).join('')}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 23 — HISTORY SECTION
// ═══════════════════════════════════════════════════════════════════════════════

function initHistorySection() {
  const clearBtn = qs('#history-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!confirm(t('history.confirm_clear'))) return;
      clearHistory();
      renderHistoryList();
      showToast(t('history.cleared_toast'));
    });
  }
}

function renderHistoryList() {
  const list = qs('#history-list');
  if (!list) return;

  const history = getHistory();

  if (!history.length) {
    list.innerHTML = `<p class="history-empty">${t('history.empty')}</p>`;
    return;
  }

  list.innerHTML = '';

  history.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'history-row';

    const tagCountText = entry.tagCount === 1
      ? t('tags_panel.tag_count_one',  { n: entry.tagCount })
      : t('tags_panel.tag_count_many', { n: entry.tagCount });

    div.innerHTML = `
      <img src="${escHtml(entry.thumbUrl)}"
           width="56" height="32" loading="lazy"
           alt="" class="history-thumb">
      <div class="history-info">
        <span class="history-title">${escHtml(entry.title || entry.id)}</span>
        <span class="history-meta">
          ${escHtml(tagCountText)} ·
          ${entry.channel ? escHtml(entry.channel) + ' · ' : ''}
          ${escHtml(formatRelativeTime(entry.extractedAt))}
        </span>
      </div>
      <button class="btn-ghost btn-sm history-reextract"
              data-url="https://youtube.com/watch?v=${escHtml(entry.id)}"
              aria-label="${escHtml(t('history.reextract_btn'))} ${escHtml(entry.title || entry.id)}">
        ${escHtml(t('history.reextract_btn'))}
      </button>
      <button class="btn-ghost btn-sm btn-danger history-remove"
              data-id="${escHtml(entry.id)}"
              aria-label="${escHtml(t('history.remove_btn'))} ${escHtml(entry.title || entry.id)}">
        ${escHtml(t('history.remove_btn'))}
      </button>`;

    div.querySelector('.history-reextract').addEventListener('click', e => {
      const url = e.currentTarget.dataset.url;
      const input = qs('#main-url');
      if (input) input.value = url;
      handleExtract(url);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    div.querySelector('.history-remove').addEventListener('click', e => {
      removeHistoryEntry(e.currentTarget.dataset.id);
      renderHistoryList();
    });

    list.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 24 — SECTION EXPAND / COLLAPSE
// ═══════════════════════════════════════════════════════════════════════════════

function initSectionToggles() {
  document.querySelectorAll('.expand-btn[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sectionId = btn.dataset.section;
      const body      = qs(`#${sectionId}-body`);
      if (!body) return;

      const isExpanded = btn.getAttribute('aria-expanded') === 'true';
      const nowOpen    = !isExpanded;

      body.classList.toggle('hidden', !nowOpen);
      btn.setAttribute('aria-expanded', nowOpen);
      btn.textContent = nowOpen ? t('bulk.collapse') : t('bulk.expand');

      saveSectionState(sectionId, nowOpen);

      // Lazy-render templates list when section opens
      if (sectionId === 'templates' && nowOpen) renderTemplateLibrary();
    });
  });
}

/** Re-apply Expand/Collapse text to all section toggles WITHOUT changing
 *  their current open/closed state — used on languagechange. */
function refreshSectionToggleLabels() {
  document.querySelectorAll('.expand-btn[data-section]').forEach(btn => {
    const isExpanded = btn.getAttribute('aria-expanded') === 'true';
    btn.textContent  = isExpanded ? t('bulk.collapse') : t('bulk.expand');
  });
}

function restorePersistedState() {
  // Restore mode toggle
  const savedMode = getSelectedMode();
  applyModeToggle(savedMode);

  // Restore section expand/collapse states
  ['bulk', 'overlap', 'history', 'templates'].forEach(sectionId => {
    const isExpanded = getSectionState(sectionId);
    const body       = qs(`#${sectionId}-body`);
    const btn        = qs(`.expand-btn[data-section="${sectionId}"]`);

    if (body) body.classList.toggle('hidden', !isExpanded);
    if (btn) {
      btn.setAttribute('aria-expanded', isExpanded);
      btn.textContent = isExpanded ? t('bulk.collapse') : t('bulk.expand');
    }

    // Render templates if section is already open
    if (sectionId === 'templates' && isExpanded) {
      renderTemplateLibrary();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 25 — ERROR STATE RENDERERS
// ═══════════════════════════════════════════════════════════════════════════════

function renderExtractError(message, errorType, originalUrl) {
  const results = qs('#results');
  if (!results) return;

  results.classList.remove('hidden');

  const recoveryHtml = buildRecoveryAction(errorType, originalUrl);

  results.innerHTML = `
    <div class="error-panel panel" role="alert">
      <div class="error-icon">⚠</div>
      <h3 class="error-heading">${escHtml(t('errors.extraction_failed_title'))}</h3>
      <p class="error-message">${escHtml(message || t('errors.unknown'))}</p>
      ${recoveryHtml}
      <p class="error-hint">
        ${escHtml(t('errors.public_video_hint'))}
      </p>
    </div>`;
}

function buildRecoveryAction(errorType, originalUrl) {
  switch (errorType) {
    case 'timeout':
      return `<button class="btn-primary btn-sm error-retry"
                onclick="window._ytspyRetry('${escHtml(originalUrl)}')">
                ${escHtml(t('errors.retry_btn'))}
              </button>`;

    case 'offline':
      return `<p class="error-recovery">
                ${escHtml(t('errors.recovery_offline'))}
              </p>`;

    case 'rate_limited':
      return `<p class="error-recovery">
                ${escHtml(t('errors.recovery_rate_limited'))}
              </p>`;

    case 'not_found':
      return `<p class="error-recovery">
                ${escHtml(t('errors.recovery_not_found'))}
              </p>`;

    case 'age_restricted':
      return `<p class="error-recovery">
                ${escHtml(t('errors.recovery_age_restricted'))}
              </p>`;

    default:
      return '';
  }
}

// Expose retry function on window for the inline onclick
window._ytspyRetry = (url) => {
  if (url) handleExtract(url);
};

function showInputError(inputEl) {
  if (!inputEl) return;
  inputEl.style.borderColor = 'var(--accent-red)';
  inputEl.focus();
  setTimeout(() => { inputEl.style.borderColor = ''; }, 2500);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 26 — RESULTS SECTION VISIBILITY
// ═══════════════════════════════════════════════════════════════════════════════

function showResultsSection() {
  const results = qs('#results');
  if (!results) return;
  results.classList.remove('hidden');
  results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearResultsSection() {
  const pills = qs('#tag-pills-output');
  const grid  = qs('#thumb-download-grid');
  const placements = qs('#placement-previews');
  if (pills)     pills.innerHTML = '';
  if (grid)      grid.innerHTML  = '';
  if (placements) placements.innerHTML = '';
  qs('#health-suggestions')?.replaceChildren();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 27 — LANGUAGE CHANGE — RE-RENDER DYNAMIC CONTENT
// ═══════════════════════════════════════════════════════════════════════════════
//
// translateDOM() (fired internally by i18n.js on setLanguage) already
// retranslates every static data-i18n* element in index.html. Everything
// below is JS-generated dynamic content app.js itself built with t() at an
// earlier point in time, so it needs an explicit re-render to pick up the
// new language.

function initLanguageChangeListener() {
  document.addEventListener('languagechange', () => {
    // Page chrome built entirely in JS
    getSeasonLabel() && (qs('#seasonal-badge') && (qs('#seasonal-badge').textContent = getSeasonLabel()));
    renderTicker();
    renderAffiliateSlide();
    if (!isExtracting) {
      const btn = qs('#btn-extract');
      if (btn) btn.textContent = getCtaVariants()[ctaIndex];
    }

    // Currently loaded single-video results
    if (currentData) {
      const healthResult = computeHealthScore(
        currentData.tags     || [],
        currentData.tagStats,
        currentData.hashtags || []
      );
      currentData.healthScore = healthResult;
      renderVideoMeta(currentData);
      renderTagsPanel(currentData, healthResult);
      renderThumbnailsPanel(currentData);
      renderTemplateSuggestions(currentData.tags || []);
    }

    // Currently loaded bulk results
    if (currentBulkResult) {
      renderBulkResults(currentBulkResult);
    }

    // Currently loaded overlap results
    if (currentOverlap && currentOverlapMyData && currentOverlapTheirData) {
      renderOverlapResults(currentOverlap, currentOverlapMyData, currentOverlapTheirData);
    }

    // Template library + history (always rebuildable from storage)
    renderTemplateLibrary();
    renderHistoryList();

    // Section expand/collapse button labels
    refreshSectionToggleLabels();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 28 — DOM UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Shorthand querySelector */
function qs(selector) {
  return document.querySelector(selector);
}

/** Set element textContent safely */
function setText(selector, value) {
  const el = qs(selector);
  if (el) el.textContent = String(value ?? '');
}

/** Add a status badge to a container */
function addBadge(containerSelector, label, className) {
  const container = qs(containerSelector);
  if (!container) return;
  const badges = container.querySelector('.meta-badges') || (() => {
    const b = document.createElement('div');
    b.className = 'meta-badges';
    container.appendChild(b);
    return b;
  })();

  const badge       = document.createElement('span');
  badge.className   = `meta-badge ${className}`;
  badge.textContent = label;
  badges.appendChild(badge);
}

/** Escape HTML for safe DOM insertion */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/** Maps an i18n language code to a BCP-47 tag Intl can reliably resolve.
 *  Only needed where our code ≠ the expected Intl subtag (Filipino: 'tl' → 'fil'). */
const INTL_LOCALE_MAP = { tl: 'fil' };

/** Format a Unix timestamp as a relative time string, in the active language */
function formatRelativeTime(ts) {
  const diff = Date.now() - (ts || 0);
  const min  = Math.floor(diff / 60_000);
  const hr   = Math.floor(diff / 3_600_000);
  const day  = Math.floor(diff / 86_400_000);

  if (min  < 1)  return t('history.just_now');
  if (min  < 60) return t('history.minutes_ago', { n: min });
  if (hr   < 24) return t('history.hours_ago',   { n: hr  });
  if (day  < 7)  return t('history.days_ago',    { n: day });

  const lang = getLanguage();
  const intlTag = INTL_LOCALE_MAP[lang] || lang;
  try {
    return new Date(ts).toLocaleDateString(intlTag, { month: 'short', day: 'numeric' });
  } catch {
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}
