// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — FRONTEND DATA LAYER
// File: js/parser.js
// Version: 2.0.0  (i18n-aware)
//
// ROLE IN THE SYSTEM:
// parser.js is the single point of contact between the UI (app.js) and the
// backend API (netlify/functions/fetch-yt.js). It is responsible for:
//
//   1. Client-side URL validation — reject bad input before hitting the API
//   2. Request signing — generate FNV-1a signature the backend verifies
//   3. API fetch with timeout + one automatic retry on timeout
//   4. Response unpacking — validates envelope, maps error codes to messages
//   5. Tag statistics — character budget, tail classification, diversity metrics
//   6. Thumbnail availability check — maxresdefault may not exist for all videos
//   7. Display formatters — view counts, dates, durations in human-readable form
//   8. Placement preview builder — 5-context thumbnail preview data objects
//
// WHAT THIS FILE DOES NOT DO:
//   - Touch the DOM (that is app.js's responsibility exclusively)
//   - Store anything (that is storage.js's responsibility)
//   - Calculate health scores (that is health.js's responsibility)
//   - Handle bulk or overlap logic (that is bulk.js and overlap.js)
//
// i18n CONTRACT:
//   All user-facing strings call t() at the point of use (not at module load),
//   so they always reflect whatever language is active when the function
//   runs. NO_TAGS_MESSAGES / ERROR_MESSAGES / PLACEMENT_CONTEXTS are exposed
//   as get*() functions rather than static objects for this reason.
//
//   KNOWN GAP — backend-supplied strings are NOT translated here:
//   `envelope.error` (raw backend error text) and thumbnail `label`/`note`
//   fields (e.g. "Max Resolution") originate from the Netlify function and
//   are passed through unchanged. Localising those requires updating
//   netlify/functions/fetch-yt.js to accept a lang param — out of scope for
//   this frontend-only pass.
//
// ⚠️  SIGNING CONFIGURATION — READ BEFORE DEPLOYING:
// The backend verifies requests using REQUEST_SIGN_SECRET (a Netlify env var).
// The frontend must generate a matching signature using the same value.
//
// TWO OPTIONS:
//
// Option A — No signing (recommended to start):
//   Leave YTSPY_SIGN_KEY = '' below.
//   Leave REQUEST_SIGN_SECRET unset in Netlify.
//   The backend skips signature verification when the env var is absent.
//   Rate limiting and URL validation still protect the endpoint.
//
// Option B — With signing (recommended after launch when bots appear):
//   Set REQUEST_SIGN_SECRET to any long random string in Netlify env vars.
//   Set YTSPY_SIGN_KEY below to the EXACT same string.
//   The obfuscated build makes the key harder (not impossible) to extract.
//   This deters ~95% of casual API probers without a true cryptographic guarantee.
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

import { t, getLanguage } from './i18n.js';

// ─── MODULE CONFIGURATION ────────────────────────────────────────────────────

/** Must match REQUEST_SIGN_SECRET Netlify env var. Leave '' to disable signing. */
const YTSPY_SIGN_KEY = '';

/** API endpoint path — works on Netlify subdomain and custom domain alike */
const API_ENDPOINT = '/.netlify/functions/fetch-yt';

/** Fetch timeout before first attempt is abandoned (ms) */
const FETCH_TIMEOUT_MS = 10_000;

/** Fetch timeout for the automatic retry attempt (ms) */
const RETRY_TIMEOUT_MS = 12_000;

/** YouTube's official tag character budget */
const TAG_CHAR_LIMIT = 500;

/** Thumbnail CDN base */
const THUMB_CDN = 'https://i.ytimg.com/vi';

/** Maps an i18n language code to a BCP-47 tag Intl can reliably resolve. */
const INTL_LOCALE_MAP = { tl: 'fil' };

function resolveIntlTag() {
  const lang = getLanguage();
  return INTL_LOCALE_MAP[lang] || lang;
}

/**
 * Human-readable messages for each noTagsReason value the backend may return.
 * Shown in the tags panel when a video has no extractable tags.
 * Built fresh on every call so it always reflects the active language.
 *
 * @returns {Record<string,string>}
 */
function getNoTagsMessages() {
  return {
    creator_set_no_tags: t('no_tags.creator_set_no_tags'),
    age_restricted:      t('no_tags.age_restricted'),
    private:             t('no_tags.private'),
    live_stream:         t('no_tags.live_stream'),
    members_only:        t('no_tags.members_only'),
    all_layers_failed:   t('no_tags.all_layers_failed'),
  };
}

/**
 * Error type → user-facing message map.
 * Returned by fetchVideoData when the API call fails.
 * Built fresh on every call so it always reflects the active language.
 *
 * @returns {Record<string,string>}
 */
function getErrorMessages() {
  return {
    invalid_url:    t('errors.invalid_url'),
    not_found:      t('errors.not_found'),
    rate_limited:   t('errors.rate_limited'),
    timeout:        t('errors.timeout'),
    network:        t('errors.network'),
    offline:        t('errors.offline'),
    members_only:   t('errors.members_only'),
    age_restricted: t('errors.age_restricted'),
    unknown:        t('errors.unknown'),
  };
}

/**
 * The 5 YouTube placement contexts where thumbnails are displayed.
 * Built fresh on every call so labels/descriptions reflect the active language.
 * Populated by buildPlacementPreviews() and consumed by app.js for rendering.
 *
 * @returns {Array<object>}
 */
function getPlacementContexts() {
  return [
    {
      id:          'desktop_home',
      label:       t('thumbnails.placement_desktop_home'),
      width:       320,
      height:      180,
      description: t('thumbnails.placement_desc_desktop_home'),
      isCropped:   false,
    },
    {
      id:          'desktop_search',
      label:       t('thumbnails.placement_desktop_search'),
      width:       246,
      height:      138,
      description: t('thumbnails.placement_desc_desktop_search'),
      isCropped:   false,
    },
    {
      id:          'mobile_search',
      label:       t('thumbnails.placement_mobile_search'),
      width:       168,
      height:      94,
      description: t('thumbnails.placement_desc_mobile_search'),
      isCropped:   false,
    },
    {
      id:          'suggested',
      label:       t('thumbnails.placement_suggested'),
      width:       168,
      height:      94,
      description: t('thumbnails.placement_desc_suggested'),
      isCropped:   false,
    },
    {
      id:          'notification',
      label:       t('thumbnails.placement_notification'),
      width:       48,
      height:      48,
      description: t('thumbnails.placement_desc_notification'),
      isCropped:   true,   // Center-cropped to square — text-heavy thumbnails fail here
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMARY EXPORT — MAIN API CALL
// Called by app.js with raw user input (any supported URL format or bare ID).
// Returns a fully-enriched data object ready for the UI to render.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch and parse video data for any YouTube URL or video ID.
 *
 * @param {string} rawInput — whatever the user typed or pasted
 * @returns {Promise<{
 *   success: boolean,
 *   data?: EnrichedVideoData,
 *   error?: string,
 *   errorType?: string,
 *   retried?: boolean
 * }>}
 */
export async function fetchVideoData(rawInput) {

  // ── 1. Client-side validation (free, instant, no network cost) ───────────
  const validation = validateYouTubeInput(rawInput);
  if (!validation.valid) {
    return {
      success:   false,
      error:     getErrorMessages().invalid_url,
      errorType: 'invalid_url',
    };
  }

  const { videoId } = validation;

  // ── 2. Build signed API URL ───────────────────────────────────────────────
  const apiUrl = buildApiUrl(rawInput, videoId);

  // ── 3. First attempt ──────────────────────────────────────────────────────
  let apiResult = await callApi(apiUrl, FETCH_TIMEOUT_MS);

  // ── 4. Auto-retry once on timeout ────────────────────────────────────────
  let retried = false;
  if (!apiResult.ok && apiResult.timedOut) {
    retried   = true;
    apiResult = await callApi(apiUrl, RETRY_TIMEOUT_MS);
  }

  // ── 5. Handle network/server errors ──────────────────────────────────────
  if (!apiResult.ok) {
    return {
      success:   false,
      error:     resolveErrorMessage(apiResult),
      errorType: apiResult.errorType || 'unknown',
      retried,
    };
  }

  // ── 6. Parse response envelope ───────────────────────────────────════────
  const envelope = apiResult.data;

  if (!envelope.success) {
    return {
      success:   false,
      error:     envelope.error || getErrorMessages().unknown,
      errorType: resolveErrorTypeFromMessage(envelope.error),
      retried,
    };
  }

  const raw = envelope.data;

  // ── 7. Enrich with computed statistics ───────────────────────────────────
  const tagStats         = computeTagStats(raw.tags || []);
  const displayViewCount = formatViewCount(raw.viewCount);
  const displayDate      = formatPublishDate(raw.publishDate);
  const noTagsMessages   = getNoTagsMessages();
  const noTagsMessage    = raw.noTagsReason
    ? (noTagsMessages[raw.noTagsReason] || noTagsMessages.all_layers_failed)
    : null;

  const placementPreviews = buildPlacementPreviews(
    raw.thumbnails,
    raw.isShort || false
  );

  // ── 8. Thumbnail existence check (async, non-blocking) ───────────────────
  // We fire this check and return the result attached to the data object.
  // app.js must handle the case where maxresExists is a Promise.
  // Pattern: const resolved = await data.maxresExistsPromise;
  const maxresExistsPromise = checkMaxresExists(videoId);

  // ── 9. Assemble final enriched object ─────────────────────────────────────
  return {
    success: true,
    retried,
    data: {
      // ── Raw backend fields (pass through unchanged) ──────────────────────
      videoId:         raw.videoId,
      tags:            raw.tags             || [],
      title:           raw.title            || '',
      channel:         raw.channel          || '',
      description:     raw.description      || '',
      viewCount:       raw.viewCount        || 0,
      duration:        raw.duration         || '',
      durationSeconds: raw.durationSeconds  || 0,
      publishDate:     raw.publishDate      || '',
      category:        raw.category         || '',
      isLive:          raw.isLive           || false,
      isPrivate:       raw.isPrivate        || false,
      isAgeRestricted: raw.isAgeRestricted  || false,
      isShort:         raw.isShort          || false,
      hashtags:        raw.hashtags         || [],
      thumbnails:      raw.thumbnails       || {},
      noTagsReason:    raw.noTagsReason     || null,
      extractionLayer: raw.extractionLayer  || 0,
      partialSuccess:  raw.partialSuccess   || false,
      fromCache:       raw.fromCache        || false,

      // ── Computed by parser.js ─────────────────────────────────────────────
      tagStats,
      displayViewCount,
      displayDate,
      noTagsMessage,
      placementPreviews,
      maxresExistsPromise,  // Promise<boolean> — awaited by app.js when needed
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// URL VALIDATION — CLIENT-SIDE
// Mirrors the backend normalizeToVideoId() to give instant feedback.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate any YouTube input and extract the video ID.
 * Called before any network request — zero latency.
 *
 * @param {string} input
 * @returns {{ valid: boolean, videoId?: string, reason?: string }}
 */
export function validateYouTubeInput(input) {
  if (!input || typeof input !== 'string') {
    return { valid: false, reason: 'empty' };
  }

  const videoId = extractVideoIdClientSide(input.trim());

  if (!videoId) {
    return { valid: false, reason: 'no_video_id' };
  }

  return { valid: true, videoId };
}

/**
 * Client-side video ID extractor — handles all YouTube URL formats.
 * Must accept the same inputs as the backend normalizeToVideoId().
 *
 * @param {string} str — trimmed user input
 * @returns {string|null} — 11-character video ID or null
 */
export function extractVideoIdClientSide(str) {
  if (!str) return null;

  // ── Bare 11-character video ID ───────────────────────────────────────────
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;

  // ── Parse as URL ──────────────────────────────────────────────────────────
  let url;
  try {
    const withProto = /^https?:\/\//i.test(str) ? str : `https://${str}`;
    url = new URL(withProto);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  // ── youtu.be short links ──────────────────────────────────────────────────
  if (host === 'youtu.be') {
    const id = path.slice(1).split(/[/?#]/)[0];
    return isValidId(id) ? id : null;
  }

  // ── All youtube.com domains ───────────────────────────────────────────────
  if (host === 'www.youtube.com' || host === 'youtube.com' ||
      host === 'm.youtube.com'   || host === 'music.youtube.com') {

    const v = url.searchParams.get('v');
    if (v && isValidId(v)) return v;

    const shorts = path.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shorts) return shorts[1];

    const embed = path.match(/^\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embed) return embed[1];

    const vPath = path.match(/^\/v\/([a-zA-Z0-9_-]{11})/);
    if (vPath) return vPath[1];

    const live = path.match(/^\/live\/([a-zA-Z0-9_-]{11})/);
    if (live) return live[1];

    const ePath = path.match(/^\/e\/([a-zA-Z0-9_-]{11})/);
    if (ePath) return ePath[1];

    // Attribution links
    const attrU = url.searchParams.get('u');
    if (attrU) {
      try {
        const inner = new URL(`https://youtube.com${decodeURIComponent(attrU)}`);
        const innerV = inner.searchParams.get('v');
        if (innerV && isValidId(innerV)) return innerV;
      } catch { /* ignore */ }
    }
  }

  return null;
}

/** Quick 11-char alphanumeric + hyphen + underscore check */
function isValidId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST SIGNING
// FNV-1a hash — must be identical to the backend's fnv1aHash() implementation.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a { sig, ts } pair for request authentication.
 * If YTSPY_SIGN_KEY is empty, sig is still generated but the backend will
 * skip verification when REQUEST_SIGN_SECRET is also unset.
 *
 * @param {string} videoId — validated 11-character ID
 * @returns {{ sig: string, ts: string }}
 */
function generateSignature(videoId) {
  const ts      = Date.now().toString();
  const payload = YTSPY_SIGN_KEY
    ? `${videoId}:${ts}:${YTSPY_SIGN_KEY}`
    : `${videoId}:${ts}`;
  return { sig: fnv1aHash(payload), ts };
}

/**
 * FNV-1a 32-bit hash.
 * CRITICAL: This function must be byte-for-byte identical to the backend version
 * in netlify/functions/fetch-yt.js. Any change here must be mirrored there.
 *
 * @param {string} str
 * @returns {string} — base-36 encoded hash
 */
export function fnv1aHash(str) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash  = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

// ═══════════════════════════════════════════════════════════════════════════════
// API URL BUILDER AND CALLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the complete signed API URL.
 * Passes the original rawInput so the backend can detect Shorts URLs etc.
 *
 * @param {string} rawInput — original user input (for backend context)
 * @param {string} videoId  — validated video ID (for signing)
 * @returns {string}
 */
function buildApiUrl(rawInput, videoId) {
  const { sig, ts } = generateSignature(videoId);
  const params      = new URLSearchParams({
    url: rawInput,
    sig,
    ts,
  });
  return `${API_ENDPOINT}?${params.toString()}`;
}

/**
 * Execute one API call with a timeout.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{
 *   ok: boolean,
 *   data?: object,
 *   timedOut?: boolean,
 *   errorType?: string,
 *   status?: number
 * }>}
 */
async function callApi(url, timeoutMs) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method:  'GET',
      headers: { 'Accept': 'application/json' },
      signal:  controller.signal,
    });

    clearTimeout(timer);

    // ── HTTP-level errors ────────────────────────────────────────────────
    if (response.status === 429) {
      return { ok: false, errorType: 'rate_limited', status: 429 };
    }
    if (response.status === 403) {
      return { ok: false, errorType: 'forbidden', status: 403 };
    }
    if (response.status === 404) {
      return { ok: false, errorType: 'not_found', status: 404 };
    }

    // ── Parse JSON body ──────────────────────────────────────────────────
    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: false, errorType: 'parse_error', status: response.status };
    }

    return { ok: true, data, status: response.status };

  } catch (err) {
    clearTimeout(timer);

    if (err.name === 'AbortError') {
      return { ok: false, timedOut: true, errorType: 'timeout' };
    }

    // Offline or DNS failure
    return {
      ok:        false,
      errorType: !navigator.onLine ? 'offline' : 'network',
    };
  }
}

/**
 * Map an API result object to a user-facing error message string.
 *
 * @param {{ errorType?: string, timedOut?: boolean, status?: number }} result
 * @returns {string}
 */
function resolveErrorMessage(result) {
  const messages = getErrorMessages();
  if (result.timedOut)                     return messages.timeout;
  if (result.errorType === 'offline')      return messages.offline;
  if (result.errorType === 'network')      return messages.network;
  if (result.errorType === 'rate_limited')  return messages.rate_limited;
  if (result.errorType === 'not_found')    return messages.not_found;
  return messages.unknown;
}

/**
 * Guess errorType from an API error message string.
 * Used when the backend returns success:false with a message but no type.
 *
 * @param {string} message
 * @returns {string}
 */
function resolveErrorTypeFromMessage(message) {
  if (!message) return 'unknown';
  const m = message.toLowerCase();
  if (m.includes('not found') || m.includes('deleted'))     return 'not_found';
  if (m.includes('age-restrict') || m.includes('age restr')) return 'age_restricted';
  if (m.includes('private'))                                 return 'not_found';
  if (m.includes('members'))                                 return 'members_only';
  if (m.includes('rate limit') || m.includes('too many'))   return 'rate_limited';
  if (m.includes('timeout') || m.includes('timed out'))     return 'timeout';
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAG STATISTICS ENGINE
// The most computation-intensive part of parser.js.
// Consumes: string[] of tags
// Produces: complete stats object consumed by health.js, app.js, export.js
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute comprehensive tag statistics from a tag array.
 * The result is the single source of truth for all tag analytics in the app.
 *
 * YouTube counts characters as: tags.join(', ').length
 * This means every tag after the first costs (tag.length + 2) characters
 * due to the ", " separator. This function applies that exact counting method.
 *
 * @param {string[]} tags
 * @returns {TagStats}
 */
export function computeTagStats(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return buildEmptyTagStats();
  }

  // ── Character budget (YouTube's exact counting method) ───────────────────
  // YouTube joins tags with ", " when counting — including separators
  const charUsed      = tags.join(', ').length;
  const charRemaining = TAG_CHAR_LIMIT - charUsed;
  const charPct       = Math.min(charUsed / TAG_CHAR_LIMIT, 1.2); // allow overflow to show
  const overLimit     = charUsed > TAG_CHAR_LIMIT;

  // ── Identify which tags are truncated (shown in red in the UI) ───────────
  // YouTube truncates from the END of the tag list when over budget
  const truncatedTags = overLimit ? identifyTruncatedTags(tags) : [];

  // ── Tail length classification ────────────────────────────────────────────
  const shortTail = [];   // 1 word
  const midTail   = [];   // 2 words
  const longTail  = [];   // 3+ words

  for (const tag of tags) {
    const wordCount = countWords(tag);
    if (wordCount === 1)      shortTail.push(tag);
    else if (wordCount === 2) midTail.push(tag);
    else                      longTail.push(tag);
  }

  const total = tags.length;

  // ── Word-level diversity metrics (for health.js scoring) ─────────────────
  const allWords    = tags.flatMap(tg => tg.toLowerCase().split(/\s+/).filter(Boolean));
  const uniqueWords = new Set(allWords);
  const totalWords  = allWords.length;

  // Diversity ratio: 1.0 = every word is unique, 0.0 = all words repeated
  const wordDiversityRatio = totalWords > 0
    ? uniqueWords.size / totalWords
    : 0;

  // ── Per-tag character lengths ─────────────────────────────────────────────
  const tagLengths    = tags.map(tg => tg.length);
  const avgCharPerTag = tagLengths.reduce((a, b) => a + b, 0) / total;

  // ── Longest and shortest tags ─────────────────────────────────────────────
  const sortedByLength = [...tags].sort((a, b) => a.length - b.length);
  const shortestTag    = sortedByLength[0]    || '';
  const longestTag     = sortedByLength[total - 1] || '';

  // ── Average word count per tag ────────────────────────────────────────────
  const avgTagWordCount = totalWords / total;

  // ── Character budget status label ─────────────────────────────────────────
  const budgetStatus = overLimit            ? 'danger'
                     : charPct >= 0.80      ? 'warn'
                     : charPct >= 0.50      ? 'good'
                     : 'low';

  // ── Budget hint text (displayed below the character bar) ─────────────────
  const budgetHint = buildBudgetHint(charUsed, charRemaining, charPct, overLimit, truncatedTags);

  return {
    // ── Core budget ───────────────────────────────────────────────────────
    total,
    charUsed,
    charLimit:     TAG_CHAR_LIMIT,
    charRemaining,
    charPct,
    overLimit,
    budgetStatus,  // 'danger' | 'warn' | 'good' | 'low'
    budgetHint,
    truncatedTags, // tags that YouTube silently ignores due to budget overflow

    // ── Tail classification ───────────────────────────────────────────────
    shortTail,
    midTail,
    longTail,
    shortTailCount: shortTail.length,
    midTailCount:   midTail.length,
    longTailCount:  longTail.length,
    shortTailPct:   total > 0 ? shortTail.length / total : 0,
    midTailPct:     total > 0 ? midTail.length   / total : 0,
    longTailPct:    total > 0 ? longTail.length  / total : 0,

    // ── Diversity metrics (consumed by health.js) ─────────────────────────
    uniqueWordCount:   uniqueWords.size,
    totalWordCount:    totalWords,
    wordDiversityRatio,
    avgTagWordCount,
    avgCharPerTag,
    shortestTag,
    longestTag,

    // ── Type lookup map for pill rendering (tag → class suffix) ──────────
    // Used by app.js to assign CSS classes to each pill without re-classifying
    typeMap: buildTypeMap(shortTail, midTail, longTail),
  };
}

/** Zero-value TagStats object for empty tag arrays */
function buildEmptyTagStats() {
  return {
    total: 0, charUsed: 0, charLimit: TAG_CHAR_LIMIT,
    charRemaining: TAG_CHAR_LIMIT, charPct: 0, overLimit: false,
    budgetStatus: 'low', budgetHint: t('tags_panel.no_tags_default'),
    truncatedTags: [],
    shortTail: [], midTail: [], longTail: [],
    shortTailCount: 0, midTailCount: 0, longTailCount: 0,
    shortTailPct: 0, midTailPct: 0, longTailPct: 0,
    uniqueWordCount: 0, totalWordCount: 0, wordDiversityRatio: 0,
    avgTagWordCount: 0, avgCharPerTag: 0,
    shortestTag: '', longestTag: '',
    typeMap: new Map(),
  };
}

/**
 * Identify which tags at the end of the list push the total over the 500-char limit.
 * YouTube processes tags in order and stops counting when the budget is exhausted.
 *
 * @param {string[]} tags
 * @returns {string[]} tags that are effectively invisible to YouTube's algorithm
 */
function identifyTruncatedTags(tags) {
  let running     = 0;
  const truncated = [];

  for (let i = 0; i < tags.length; i++) {
    // ", " separator added before every tag except the first
    const addedChars = i === 0 ? tags[i].length : tags[i].length + 2;
    running         += addedChars;

    if (running > TAG_CHAR_LIMIT) {
      truncated.push(tags[i]);
    }
  }

  return truncated;
}

/**
 * Count meaningful words in a tag (handles multi-space, trimming).
 *
 * @param {string} tag
 * @returns {number}
 */
function countWords(tag) {
  return tag.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Build a tag text → tail type Map for O(1) CSS class lookups in app.js.
 * Keys are lowercased tag text. Values are 'short-tail' | 'mid-tail' | 'long-tail'.
 *
 * @param {string[]} shortTail
 * @param {string[]} midTail
 * @param {string[]} longTail
 * @returns {Map<string, string>}
 */
function buildTypeMap(shortTail, midTail, longTail) {
  const map = new Map();
  shortTail.forEach(tg => map.set(tg.toLowerCase(), 'short-tail'));
  midTail.forEach(tg =>   map.set(tg.toLowerCase(), 'mid-tail'));
  longTail.forEach(tg =>  map.set(tg.toLowerCase(), 'long-tail'));
  return map;
}

/**
 * Generate the hint text shown below the character budget bar.
 * Varies based on budget consumption level and truncation state.
 * Routes through the six `char_hints.*` locale keys, ordered from most to
 * least urgent.
 *
 * @param {number}   charUsed
 * @param {number}   charRemaining
 * @param {number}   charPct
 * @param {boolean}  overLimit
 * @param {string[]} truncatedTags
 * @returns {string}
 */
function buildBudgetHint(charUsed, charRemaining, charPct, overLimit, truncatedTags) {
  if (overLimit) {
    return t('char_hints.over_limit', {
      over:  Math.abs(charRemaining),
      count: truncatedTags.length,
    });
  }

  if (charRemaining <= 50) {
    return t('char_hints.near_limit', { remaining: charRemaining });
  }

  if (charRemaining <= 150) {
    return t('char_hints.getting_close', { remaining: charRemaining });
  }

  // Severely under-tagged: less than 30% of the budget used
  if (charPct < 0.30) {
    return t('char_hints.under_tagged_severe', { pct: Math.round(charPct * 100) });
  }

  // Moderately under-tagged: 30–65% of the budget used
  if (charPct < 0.65) {
    const estimatedRoom = Math.max(1, Math.floor(charRemaining / 25));
    return t('char_hints.under_tagged_moderate', {
      remaining: charRemaining,
      n:         estimatedRoom,
    });
  }

  return t('char_hints.optimal', { remaining: charRemaining });
}

// ═══════════════════════════════════════════════════════════════════════════════
// THUMBNAIL AVAILABILITY CHECK
// YouTube's maxresdefault.jpg (1280×720) does not exist for all videos.
// Older videos, videos without custom thumbnails, and some Shorts return 404.
// This check lets app.js show a fallback gracefully.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check whether maxresdefault.jpg actually exists for a given video.
 * Returns a Promise so app.js can await it asynchronously after rendering
 * the initial UI — avoiding any delay to the primary render.
 *
 * Resolution logic:
 *   → If maxresdefault returns 200 with dimensions > 120×90: exists = true
 *   → If maxresdefault returns 404 or 120×90 placeholder: exists = false
 *   → If check fails (network): optimistically return true (frontend handles gracefully)
 *
 * The 120×90 "no thumbnail" image is YouTube's default placeholder served
 * with a 200 status when the requested resolution doesn't exist. We detect it
 * by size — a genuine maxresdefault is always ≥ 15KB; the placeholder is ~2KB.
 *
 * @param {string} videoId
 * @returns {Promise<boolean>}
 */
export async function checkMaxresExists(videoId) {
  const url = `${THUMB_CDN}/${videoId}/maxresdefault.jpg`;

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) return false;

    // Content-Length check: YouTube's no-thumbnail placeholder is ~1084 bytes
    // A genuine 1280×720 JPEG is always larger than 5000 bytes
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > 0 && contentLength < 2000) return false;

    return true;

  } catch {
    // Network failure, CORS issue, or timeout — assume it exists
    // App.js handles 404s gracefully via onerror on <img> tags
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLACEMENT PREVIEW BUILDER
// Generates the 5-context thumbnail preview data objects for app.js to render.
// Keeps data construction here (parser.js) and rendering in app.js.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build placement preview data for the 5 YouTube display contexts.
 * For Shorts, replaces desktop-context previews with Shorts-specific ones.
 *
 * @param {{ hq: { url: string }, maxres: { url: string }, ... }} thumbnails
 * @param {boolean} isShort
 * @returns {PlacementPreview[]}
 */
export function buildPlacementPreviews(thumbnails, isShort) {
  // Choose the best available thumbnail URL for previews
  // Prefer hq (480×360) for previews — it loads quickly and exists for all videos
  const previewUrl = thumbnails?.hq?.url
    || thumbnails?.mq?.url
    || thumbnails?.default?.url
    || '';

  if (isShort) {
    // YouTube Shorts appear in a vertical feed, not standard search
    return [
      {
        id:          'shorts_feed',
        label:       t('thumbnails.placement_shorts_feed'),
        width:       180,
        height:      320,
        description: t('thumbnails.placement_desc_shorts_feed'),
        isCropped:   false,
        isVertical:  true,
        thumbUrl:    thumbnails?.shorts_vertical?.url || previewUrl,
      },
      {
        id:          'mobile_search',
        label:       t('thumbnails.placement_mobile_search'),
        width:       168,
        height:      94,
        description: t('thumbnails.placement_desc_mobile_search'),
        isCropped:   false,
        isVertical:  false,
        thumbUrl:    previewUrl,
      },
      {
        id:          'notification',
        label:       t('thumbnails.placement_notification'),
        width:       48,
        height:      48,
        description: t('thumbnails.placement_desc_notification'),
        isCropped:   true,
        isVertical:  false,
        thumbUrl:    previewUrl,
      },
    ];
  }

  // Standard video — all 5 placement contexts
  return getPlacementContexts().map(ctx => ({
    ...ctx,
    thumbUrl: previewUrl,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISPLAY FORMATTERS
// Convert raw numeric/string values from the backend into human-readable display.
// Pure functions — no side effects.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format a raw view count number into a compact human-readable string.
 *
 * Examples:
 *   847        → "847 views"
 *   42_300     → "42.3K views"
 *   1_240_000  → "1.2M views"
 *   3_400_000_000 → "3.4B views"
 *   0 or null  → "" (empty — not shown in UI when unavailable)
 *
 * The "views"/"view" word now routes through meta_card.views / meta_card.view
 * (added during the Phase 3 audit — net-new keys, still pending translation
 * into the 19 non-English locale files). The numeric compact notation itself
 * stays locale-independent (always Western digits + K/M/B) to avoid
 * unexpected numbering systems in some locales.
 *
 * @param {number|null} count
 * @returns {string}
 */
export function formatViewCount(count) {
  if (!count || count <= 0) return '';

  const viewsWord = t('meta_card.views');
  const viewWord  = t('meta_card.view');

  if (count >= 1_000_000_000) {
    return `${(count / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B ${viewsWord}`;
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ${viewsWord}`;
  }
  if (count >= 10_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K ${viewsWord}`;
  }
  if (count >= 1_000) {
    return `${count.toLocaleString()} ${viewsWord}`;
  }
  return `${count} ${count !== 1 ? viewsWord : viewWord}`;
}

/**
 * Format a YouTube publish date string into a clean display format.
 *
 * YouTube returns dates in multiple formats depending on the data source:
 *   ISO 8601:    "2023-11-15" or "2023-11-15T00:00:00+00:00"
 *   US informal: "Nov 15, 2023"
 *   Relative:    "3 years ago" (from initialData, already human-readable)
 *
 * Strategy: if the string already looks human-readable, return it directly.
 * If it's ISO format, convert to a long localized date using the active
 * language (falls back to en-US if Intl rejects the locale tag).
 *
 * @param {string|null} dateStr
 * @returns {string}
 */
export function formatPublishDate(dateStr) {
  if (!dateStr) return '';

  // Already human-readable (relative or US format)
  if (/ago|ago|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(dateStr)) {
    return dateStr;
  }

  // ISO 8601 date
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      try {
        return d.toLocaleDateString(resolveIntlTag(), {
          year:  'numeric',
          month: 'long',
          day:   'numeric',
        });
      } catch {
        return d.toLocaleDateString('en-US', {
          year:  'numeric',
          month: 'long',
          day:   'numeric',
        });
      }
    } catch {
      return dateStr;
    }
  }

  // Unknown format — return as-is
  return dateStr;
}

/**
 * Format a duration string or seconds count for the YouTube preview mockup.
 * The preview displays duration exactly as YouTube does: M:SS or H:MM:SS.
 * Digits-only — no localization needed (universal notation).
 *
 * @param {string} durationStr — already-formatted string from backend (e.g. "4:32")
 * @param {number} [durationSeconds] — raw seconds, used as fallback
 * @returns {string}
 */
export function formatDurationDisplay(durationStr, durationSeconds) {
  if (durationStr && durationStr !== '0:00') return durationStr;

  if (durationSeconds && durationSeconds > 0) {
    const h = Math.floor(durationSeconds / 3600);
    const m = Math.floor((durationSeconds % 3600) / 60);
    const s = durationSeconds % 60;

    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// HASHTAG UTILITIES
// Hashtags in YouTube descriptions appear separately from tags in the UI.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deduplicate and sort hashtags from the backend array.
 * The backend already extracts them; this just normalises for display.
 *
 * @param {string[]} hashtags
 * @returns {string[]}
 */
export function normalizeHashtags(hashtags) {
  if (!Array.isArray(hashtags)) return [];
  // Deduplicate case-insensitively, preserve original casing of first occurrence
  const seen = new Set();
  return hashtags.filter(h => {
    const key = h.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// THUMBNAIL URL HELPERS
// Utility functions used by app.js and export.js when working with thumbnails.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Return the best-quality existing thumbnail URL, with automatic fallback chain.
 * Pass `maxresExists` (result of checkMaxresExists) for accurate resolution.
 *
 * Fallback order: maxres → sd → hq → mq → default
 *
 * @param {{ maxres, sd, hq, mq, default: def }} thumbnails
 * @param {boolean} [maxresExists=true]
 * @returns {{ url: string, resolution: string, label: string }}
 */
export function getBestThumbnail(thumbnails, maxresExists = true) {
  if (!thumbnails) return { url: '', resolution: 'none', label: t('thumbnails.unavailable') };

  if (maxresExists && thumbnails.maxres?.url) return thumbnails.maxres;
  if (thumbnails.sd?.url)                     return thumbnails.sd;
  if (thumbnails.hq?.url)                     return thumbnails.hq;
  if (thumbnails.mq?.url)                     return thumbnails.mq;
  if (thumbnails.default?.url)                return thumbnails.default;

  return { url: '', resolution: 'none', label: t('thumbnails.unavailable') };
}

/**
 * Return all thumbnail resolutions as a flat ordered array for rendering
 * the download button grid. Excludes shorts_vertical for non-Short videos.
 *
 * @param {{ [key: string]: { url, label, format, width, height, resolution, note? } }} thumbnails
 * @param {boolean} isShort
 * @param {boolean} maxresExists
 * @returns {ThumbnailEntry[]}
 */
export function getThumbnailList(thumbnails, isShort, maxresExists) {
  if (!thumbnails) return [];

  const ORDER = isShort
    ? ['shorts_vertical', 'hq', 'mq', 'default']
    : ['maxres', 'sd', 'hq', 'mq', 'webp'];

  return ORDER
    .map(key => {
      const entry = thumbnails[key];
      if (!entry) return null;

      // Suppress maxres download button when it doesn't exist
      if (key === 'maxres' && !maxresExists) {
        return {
          ...entry,
          unavailable:  true,
          unavailableReason: t('thumbnails.unavailable_reason'),
        };
      }

      return entry;
    })
    .filter(Boolean);
}
