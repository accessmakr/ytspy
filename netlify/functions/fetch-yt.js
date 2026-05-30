// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — PRODUCTION DATA EXTRACTION API
// File: netlify/functions/fetch-yt.js
// Version: 1.0.0
//
// WHAT THIS FILE IS:
// This is NOT a simple CORS proxy. It is a complete server-side intelligence
// extraction API. It fetches YouTube pages, extracts all structured data from
// ytInitialPlayerResponse and ytInitialData, and returns clean JSON.
// Raw HTML never reaches the browser. Script tags are NOT stripped — they
// contain the most valuable data (ytInitialData, ytInitialPlayerResponse).
//
// 4-LAYER EXTRACTION FALLBACK CHAIN:
//   Layer 1 → ytInitialPlayerResponse.videoDetails.keywords  (primary, most reliable)
//   Layer 2 → ytInitialData.microformat.playerMicroformatRenderer (secondary path)
//   Layer 3 → <meta name="keywords"> in raw HTML (tertiary fallback)
//   Layer 4 → m.youtube.com mobile page (different server rendering path)
//
// URL FORMATS SUPPORTED (all normalized before processing):
//   youtube.com/watch?v=VIDEO_ID          standard desktop
//   youtu.be/VIDEO_ID                     shared short link
//   youtube.com/shorts/VIDEO_ID           YouTube Shorts
//   m.youtube.com/watch?v=VIDEO_ID        mobile browser
//   youtube.com/embed/VIDEO_ID            embedded player
//   youtube.com/v/VIDEO_ID               legacy format
//   youtube.com/live/VIDEO_ID            live stream
//   youtube.com/watch?v=ID&t=120s        with timestamp (stripped)
//   youtube.com/watch?v=ID&list=PLxxx    from playlist (stripped)
//   VIDEO_ID                              bare 11-character ID
//
// SUPABASE TABLES — RUN THIS SQL IN SUPABASE DASHBOARD → SQL EDITOR:
// ─────────────────────────────────────────────────────────────────────
//
// CREATE TABLE IF NOT EXISTS extraction_cache (
//   video_id          TEXT PRIMARY KEY,
//   title             TEXT    DEFAULT '',
//   channel           TEXT    DEFAULT '',
//   description       TEXT    DEFAULT '',
//   tags              JSONB   DEFAULT '[]',
//   hashtags          JSONB   DEFAULT '[]',
//   view_count        BIGINT  DEFAULT 0,
//   duration          TEXT    DEFAULT '',
//   publish_date      TEXT    DEFAULT '',
//   category          TEXT    DEFAULT '',
//   is_live           BOOLEAN DEFAULT FALSE,
//   is_private        BOOLEAN DEFAULT FALSE,
//   is_age_restricted BOOLEAN DEFAULT FALSE,
//   is_short          BOOLEAN DEFAULT FALSE,
//   health_score      INTEGER DEFAULT NULL,
//   extraction_layer  INTEGER DEFAULT 0,
//   cached_at         TIMESTAMPTZ DEFAULT NOW(),
//   expires_at        TIMESTAMPTZ NOT NULL
// );
// CREATE INDEX IF NOT EXISTS idx_cache_expires
//   ON extraction_cache(expires_at);
//
// CREATE TABLE IF NOT EXISTS tag_intelligence (
//   tag_text         TEXT PRIMARY KEY,
//   appearance_count INTEGER     DEFAULT 1,
//   last_seen        TIMESTAMPTZ DEFAULT NOW()
// );
// CREATE INDEX IF NOT EXISTS idx_tag_count
//   ON tag_intelligence(appearance_count DESC);
//
// CREATE OR REPLACE FUNCTION upsert_tag(p_tag TEXT)
// RETURNS VOID AS $$
// INSERT INTO tag_intelligence (tag_text, appearance_count, last_seen)
// VALUES (p_tag, 1, NOW())
// ON CONFLICT (tag_text) DO UPDATE
//   SET appearance_count = tag_intelligence.appearance_count + 1,
//       last_seen        = NOW();
// $$ LANGUAGE SQL;
//
// CREATE TABLE IF NOT EXISTS extraction_stats (
//   stat_date          DATE PRIMARY KEY DEFAULT CURRENT_DATE,
//   total_extractions  INTEGER DEFAULT 0,
//   cache_hits         INTEGER DEFAULT 0,
//   layer1_successes   INTEGER DEFAULT 0,
//   layer2_successes   INTEGER DEFAULT 0,
//   layer3_successes   INTEGER DEFAULT 0,
//   layer4_successes   INTEGER DEFAULT 0,
//   failures           INTEGER DEFAULT 0
// );
// CREATE OR REPLACE FUNCTION record_extraction(p_layer INTEGER, p_cache_hit BOOLEAN)
// RETURNS VOID AS $$
// INSERT INTO extraction_stats (
//   stat_date, total_extractions, cache_hits,
//   layer1_successes, layer2_successes,
//   layer3_successes, layer4_successes, failures
// )
// VALUES (
//   CURRENT_DATE, 1,
//   CASE WHEN p_cache_hit THEN 1 ELSE 0 END,
//   CASE WHEN p_layer = 1 THEN 1 ELSE 0 END,
//   CASE WHEN p_layer = 2 THEN 1 ELSE 0 END,
//   CASE WHEN p_layer = 3 THEN 1 ELSE 0 END,
//   CASE WHEN p_layer = 4 THEN 1 ELSE 0 END,
//   CASE WHEN p_layer = 0 THEN 1 ELSE 0 END
// )
// ON CONFLICT (stat_date) DO UPDATE SET
//   total_extractions  = extraction_stats.total_extractions  + 1,
//   cache_hits         = extraction_stats.cache_hits         + EXCLUDED.cache_hits,
//   layer1_successes   = extraction_stats.layer1_successes   + EXCLUDED.layer1_successes,
//   layer2_successes   = extraction_stats.layer2_successes   + EXCLUDED.layer2_successes,
//   layer3_successes   = extraction_stats.layer3_successes   + EXCLUDED.layer3_successes,
//   layer4_successes   = extraction_stats.layer4_successes   + EXCLUDED.layer4_successes,
//   failures           = extraction_stats.failures           + EXCLUDED.failures;
// $$ LANGUAGE SQL;
//
// ENVIRONMENT VARIABLES (set in Netlify Dashboard → Site Settings → Env Vars):
//   SUPABASE_URL          https://yourproject.supabase.co
//   SUPABASE_ANON_KEY     your-anon-key-from-supabase-dashboard
//   REQUEST_SIGN_SECRET   any-long-random-string (generate: openssl rand -hex 32)
//   ALLOWED_ORIGIN        https://ytspy.cc (your domain, or * for development)
//
// If SUPABASE_* vars are missing → tool works without caching (graceful degradation).
// If REQUEST_SIGN_SECRET is missing → signature verification skipped (dev mode).
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

const CONFIG = {
  // Rate limiting — per IP address
  RATE_LIMIT_WINDOW_MS:   60_000,   // 60-second rolling window
  RATE_LIMIT_MAX:         15,       // max extractions per IP per window
  RATE_LIMIT_PURGE_EVERY: 5_000,    // purge expired entries every 5000 requests

  // Caching
  CDN_CACHE_SECONDS:      300,      // 5-minute Netlify CDN cache per video
  BROWSER_CACHE_SECONDS:  60,       // 1-minute browser cache
  SUPABASE_CACHE_HOURS:   24,       // Supabase cache TTL

  // Fetch behaviour
  FETCH_TIMEOUT_MS:       8_000,    // 8 seconds before aborting YouTube fetch
  MOBILE_FETCH_TIMEOUT:   6_000,    // shorter timeout for Layer 4 mobile fallback

  // Request signing
  SIGN_WINDOW_MS:         45_000,   // 45-second timestamp tolerance

  // User agent rotation pool — realistic browser agents
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  ],

  // Mobile user agent for Layer 4
  MOBILE_USER_AGENT: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
};

// ─── IN-MEMORY RATE LIMIT STORE ───────────────────────────────────────────────
// Resets on Netlify function cold start. Sufficient for MVP-scale bot deterrence.
// For high-traffic production: replace with Upstash Redis (free tier available).

const rateLimitStore  = new Map();   // ip → { count, windowStart }
let   requestsSinceLastPurge = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

exports.handler = async (event, context) => {

  // ── CORS Preflight ───────────────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return buildCorsPreflightResponse();
  }

  // ── Method guard ─────────────────────────────────────────────────────────
  if (event.httpMethod !== 'GET') {
    return buildErrorResponse(405, 'Method not allowed');
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const clientIP = extractClientIP(event);
  const rateCheck = enforceRateLimit(clientIP);
  if (!rateCheck.allowed) {
    return buildErrorResponse(429, 'Too many requests — please wait a moment before trying again.', {
      'Retry-After':          '60',
      'X-RateLimit-Limit':    String(CONFIG.RATE_LIMIT_MAX),
      'X-RateLimit-Remaining':'0',
    });
  }

  // ── Request signature verification ────────────────────────────────────────
  const sigCheck = verifyRequestSignature(event);
  if (!sigCheck.valid) {
    return buildErrorResponse(403, 'Invalid or expired request signature');
  }

  // ── Extract and normalize video ID from any URL format ───────────────────
  const rawInput = (
    event.queryStringParameters?.url ||
    event.queryStringParameters?.v   ||
    ''
  ).trim();

  if (!rawInput) {
    return buildErrorResponse(400, 'Missing url parameter. Provide a YouTube URL or video ID.');
  }

  const videoId = normalizeToVideoId(rawInput);

  if (!videoId) {
    return buildErrorResponse(400, [
      'Could not find a valid YouTube video ID in the provided input.',
      'Accepted formats: youtube.com/watch?v=ID, youtu.be/ID,',
      'youtube.com/shorts/ID, m.youtube.com/watch?v=ID,',
      'or a bare 11-character video ID.',
    ].join(' '));
  }

  // ── Supabase cache check ──────────────────────────────────────────────────
  const cached = await getFromSupabaseCache(videoId);
  if (cached) {
    // Record cache hit stat (fire-and-forget)
    recordExtractionStat(0, true).catch(() => {});
    return buildSuccessResponse(cached, {
      'X-Cache':    'HIT',
      'X-Video-Id': videoId,
    });
  }

  // ── 4-Layer extraction chain ──────────────────────────────────────────────
  const result = await runExtractionChain(videoId, rawInput);

  // ── Fatal errors (video not found, private, etc.) ─────────────────────────
  if (result.fatalError) {
    return buildErrorResponse(
      result.statusCode || 500,
      result.error,
      { 'X-Error-Type': result.errorType || 'unknown' }
    );
  }

  // ── Cache successful result ───────────────────────────────────────────────
  // Fire-and-forget — do not block response waiting for cache writes
  if (result.extractionLayer > 0 || result.title) {
    saveToSupabaseCache(videoId, result).catch(() => {});
    recordTagIntelligence(result.tags || []).catch(() => {});
    recordExtractionStat(result.extractionLayer || 0, false).catch(() => {});
  }

  return buildSuccessResponse(result, {
    'X-Cache':            'MISS',
    'X-Video-Id':         videoId,
    'X-Extraction-Layer': String(result.extractionLayer || 0),
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// URL NORMALIZATION — ALL YOUTUBE URL FORMATS → 11-CHARACTER VIDEO ID
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeToVideoId(input) {
  if (!input || typeof input !== 'string') return null;

  const str = input.trim();

  // ── Direct 11-character video ID (bare, no URL wrapper) ─────────────────
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
    return str;
  }

  // ── Attempt to parse as URL ───────────────────────────────────────────────
  let url;
  try {
    // Add protocol if missing so URL parsing works
    const candidate = /^https?:\/\//i.test(str) ? str : `https://${str}`;
    url = new URL(candidate);
  } catch {
    // Not a parseable URL and not a bare ID
    return null;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  // ── youtu.be/VIDEO_ID ─────────────────────────────────────────────────────
  if (host === 'youtu.be') {
    const id = path.slice(1).split(/[/?#]/)[0];
    return isValidVideoId(id) ? id : null;
  }

  // ── All youtube.com variants ──────────────────────────────────────────────
  if (host === 'www.youtube.com' ||
      host === 'youtube.com'     ||
      host === 'm.youtube.com'   ||
      host === 'music.youtube.com') {

    // /watch?v=VIDEO_ID  (most common)
    const vParam = url.searchParams.get('v');
    if (vParam && isValidVideoId(vParam)) return vParam;

    // /shorts/VIDEO_ID
    const shortsMatch = path.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];

    // /embed/VIDEO_ID
    const embedMatch = path.match(/^\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];

    // /v/VIDEO_ID  (legacy)
    const vPathMatch = path.match(/^\/v\/([a-zA-Z0-9_-]{11})/);
    if (vPathMatch) return vPathMatch[1];

    // /live/VIDEO_ID  (live streams)
    const liveMatch = path.match(/^\/live\/([a-zA-Z0-9_-]{11})/);
    if (liveMatch) return liveMatch[1];

    // /e/VIDEO_ID  (very old format)
    const eMatch = path.match(/^\/e\/([a-zA-Z0-9_-]{11})/);
    if (eMatch) return eMatch[1];

    // Attribution links: /attribution_link?...u=%2Fwatch%3Fv%3DVIDEO_ID
    const attrLink = url.searchParams.get('u');
    if (attrLink) {
      try {
        const inner = new URL(`https://youtube.com${decodeURIComponent(attrLink)}`);
        const innerV = inner.searchParams.get('v');
        if (innerV && isValidVideoId(innerV)) return innerV;
      } catch { /* ignore */ }
    }
  }

  return null;
}

function isValidVideoId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4-LAYER EXTRACTION CHAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function runExtractionChain(videoId, originalInput) {
  const isShort = originalInput.includes('/shorts/');

  // ── LAYER 1 + 2 + 3: Desktop watch page ──────────────────────────────────
  const desktopUrl   = `https://www.youtube.com/watch?v=${videoId}`;
  const desktopFetch = await fetchYouTubePage(desktopUrl, CONFIG.FETCH_TIMEOUT_MS);

  if (desktopFetch.ok && desktopFetch.html) {
    const { html } = desktopFetch;

    // Detect bot/challenge pages before parsing
    if (isBotDetectionPage(html)) {
      // Try Layer 4 immediately when bot detection fires on desktop
      return runLayer4(videoId, isShort, 'bot_detection_on_desktop');
    }

    // Detect hard error states
    const hardError = detectHardError(html, desktopFetch.status);
    if (hardError) return hardError;

    // Parse both embedded data objects
    const playerResponse = extractJsonObject(html, [
      'ytInitialPlayerResponse',
      'window["ytInitialPlayerResponse"]',
    ]);
    const initialData = extractJsonObject(html, [
      'ytInitialData',
      'window["ytInitialData"]',
    ]);

    // ── Layer 1: ytInitialPlayerResponse.videoDetails.keywords ─────────────
    if (playerResponse) {
      const l1 = buildResultFromPlayerResponse(playerResponse, initialData, videoId, isShort, 1);
      if (l1.tags && l1.tags.length > 0) {
        return l1; // Layer 1 success — tags found
      }

      // ── Layer 2: microformat path ─────────────────────────────────────────
      const microformatTags = extractMicroformatTags(playerResponse, initialData);
      if (microformatTags.length > 0) {
        return {
          ...buildResultFromPlayerResponse(playerResponse, initialData, videoId, isShort, 2),
          tags: microformatTags,
          extractionLayer: 2,
        };
      }

      // ── Layer 3: <meta name="keywords"> HTML fallback ──────────────────────
      const metaTags = extractMetaKeywordTags(html);
      if (metaTags.length > 0) {
        return {
          ...buildResultFromPlayerResponse(playerResponse, initialData, videoId, isShort, 3),
          tags: metaTags,
          extractionLayer: 3,
        };
      }

      // Partial success: metadata extracted but creator has no tags
      // This is a valid state — not an error
      const partial = buildResultFromPlayerResponse(playerResponse, initialData, videoId, isShort, 3);
      if (partial.title || partial.channel) {
        return {
          ...partial,
          tags:          [],
          noTagsReason:  partial.isPrivate        ? 'private'
                       : partial.isAgeRestricted  ? 'age_restricted'
                       : partial.isLive           ? 'live_stream'
                       : 'creator_set_no_tags',
          extractionLayer: 3,
        };
      }
    }

    // playerResponse missing but page loaded — try Layer 3 on raw HTML
    const metaTagsFallback = extractMetaKeywordTags(html);
    const metaTitle        = extractMetaOgContent(html, 'og:title');
    const metaChannel      = extractMetaItempropContent(html, 'name');

    if (metaTitle || metaTagsFallback.length > 0) {
      return {
        videoId,
        tags:            metaTagsFallback,
        title:           metaTitle,
        channel:         metaChannel,
        description:     extractMetaOgContent(html, 'og:description'),
        viewCount:       0,
        duration:        '',
        publishDate:     '',
        category:        '',
        isLive:          false,
        isPrivate:       false,
        isAgeRestricted: false,
        isShort,
        hashtags:        extractHashtagsFromText(extractMetaOgContent(html, 'og:description')),
        thumbnails:      buildThumbnailUrls(videoId),
        noTagsReason:    metaTagsFallback.length === 0 ? 'creator_set_no_tags' : undefined,
        extractionLayer: 3,
      };
    }
  }

  // ── LAYER 4: Mobile page — different server rendering path ─────────────────
  return runLayer4(videoId, isShort, 'desktop_parse_failed');
}

async function runLayer4(videoId, isShort, reason) {
  const mobileUrl   = `https://m.youtube.com/watch?v=${videoId}`;
  const mobileFetch = await fetchYouTubePage(
    mobileUrl,
    CONFIG.MOBILE_FETCH_TIMEOUT,
    CONFIG.MOBILE_USER_AGENT
  );

  if (mobileFetch.ok && mobileFetch.html) {
    const { html } = mobileFetch;

    if (!isBotDetectionPage(html)) {
      const playerResponse = extractJsonObject(html, ['ytInitialPlayerResponse', 'window["ytInitialPlayerResponse"]']);
      const initialData    = extractJsonObject(html, ['ytInitialData', 'window["ytInitialData"]']);

      if (playerResponse) {
        const l4 = buildResultFromPlayerResponse(playerResponse, initialData, videoId, isShort, 4);
        return l4;
      }

      // Final meta fallback from mobile page
      const metaTags  = extractMetaKeywordTags(html);
      const metaTitle = extractMetaOgContent(html, 'og:title');
      if (metaTitle || metaTags.length > 0) {
        return {
          videoId,
          tags:            metaTags,
          title:           metaTitle,
          channel:         extractMetaItempropContent(html, 'name'),
          description:     extractMetaOgContent(html, 'og:description'),
          viewCount:       0,
          duration:        '',
          publishDate:     '',
          category:        '',
          isLive:          false,
          isPrivate:       false,
          isAgeRestricted: false,
          isShort,
          hashtags:        extractHashtagsFromText(extractMetaOgContent(html, 'og:description')),
          thumbnails:      buildThumbnailUrls(videoId),
          noTagsReason:    metaTags.length === 0 ? 'creator_set_no_tags' : undefined,
          extractionLayer: 4,
        };
      }
    }
  }

  // ── All 4 layers exhausted ────────────────────────────────────────────────
  // Thumbnails are always constructable from the video ID — return a minimal
  // response so the thumbnail panel still works for the user.
  if (mobileFetch.status === 404 || mobileFetch.notFound) {
    return {
      fatalError:  true,
      error:       'This video was not found. It may have been deleted, made private, or never existed.',
      errorType:   'not_found',
      statusCode:  404,
    };
  }

  // Graceful minimum — thumbnails still functional
  return {
    videoId,
    tags:            [],
    title:           '',
    channel:         '',
    description:     '',
    viewCount:       0,
    duration:        '',
    publishDate:     '',
    category:        '',
    isLive:          false,
    isPrivate:       false,
    isAgeRestricted: false,
    isShort,
    hashtags:        [],
    thumbnails:      buildThumbnailUrls(videoId),
    noTagsReason:    `all_layers_failed:${reason}`,
    partialSuccess:  true,
    extractionLayer: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE FETCHER WITH ABORT CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchYouTubePage(url, timeoutMs, userAgentOverride) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  const ua = userAgentOverride
    || CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':                ua,
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language':           'en-US,en;q=0.9',
        'Accept-Encoding':           'gzip, deflate, br',
        'Cache-Control':             'no-cache',
        'Pragma':                    'no-cache',
        'DNT':                       '1',
        'Sec-Fetch-Dest':            'document',
        'Sec-Fetch-Mode':            'navigate',
        'Sec-Fetch-Site':            'none',
        'Sec-Fetch-User':            '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
      signal:   controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return { ok: false, status: response.status, html: null, notFound: response.status === 404 };
    }

    const html = await response.text();
    return { ok: true, status: 200, html };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { ok: false, status: 408, html: null, timedOut: true };
    }
    return { ok: false, status: 502, html: null, networkError: true };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON OBJECT EXTRACTION — BRACE-MATCHING ALGORITHM
// More reliable than regex for large nested JSON objects.
// ═══════════════════════════════════════════════════════════════════════════════

function extractJsonObject(html, variableNames) {
  for (const varName of variableNames) {
    // Find the variable assignment in the HTML
    const markers = [
      `var ${varName} = `,
      `${varName} = `,
      `${varName}=`,
    ];

    for (const marker of markers) {
      const markerIndex = html.indexOf(marker);
      if (markerIndex === -1) continue;

      // Find the opening brace
      const startIndex = html.indexOf('{', markerIndex + marker.length);
      if (startIndex === -1) continue;

      // Walk forward using brace-depth counting to find the matching close brace
      // Handle strings to avoid counting braces inside quoted values
      let depth         = 0;
      let inString      = false;
      let escapeNext    = false;
      let stringChar    = '';
      let endIndex      = -1;

      for (let i = startIndex; i < html.length; i++) {
        const ch = html[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (ch === '\\' && inString) {
          escapeNext = true;
          continue;
        }

        if (!inString && (ch === '"' || ch === "'")) {
          inString   = true;
          stringChar = ch;
          continue;
        }

        if (inString && ch === stringChar) {
          inString = false;
          continue;
        }

        if (!inString) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              endIndex = i;
              break;
            }
          }
        }
      }

      if (endIndex === -1) continue;

      const jsonStr = html.slice(startIndex, endIndex + 1);
      try {
        return JSON.parse(jsonStr);
      } catch {
        // Malformed JSON for this marker — try next
        continue;
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT BUILDER — ASSEMBLES FULL DATA OBJECT FROM ytInitialPlayerResponse
// ═══════════════════════════════════════════════════════════════════════════════

function buildResultFromPlayerResponse(playerResponse, initialData, videoId, isShort, layer) {
  const vd = playerResponse?.videoDetails || {};

  const tags           = extractTagsFromPlayerResponse(vd);
  const title          = vd.title                 || extractTitleFromInitialData(initialData) || '';
  const channel        = vd.author                || extractChannelFromInitialData(initialData) || '';
  const description    = vd.shortDescription      || '';
  const viewCount      = parseInt(vd.viewCount, 10) || extractViewCountFromInitialData(initialData) || 0;
  const durationSecs   = parseInt(vd.lengthSeconds, 10) || 0;
  const isLive         = vd.isLive === true         || vd.isLive === 'true';
  const isPrivate      = vd.isPrivate === true      || vd.isPrivate === 'true';
  const isCrawlable    = vd.isCrawlable !== false   && vd.isCrawlable !== 'false';
  const isAgeRestricted = !isCrawlable              || detectAgeRestrictionInResponse(playerResponse);
  const publishDate    = extractPublishDate(playerResponse, initialData);
  const category       = extractCategory(playerResponse);

  return {
    videoId,
    tags,
    title,
    channel,
    description,
    viewCount,
    duration:        durationSecs > 0 ? secondsToTimestamp(durationSecs) : '',
    durationSeconds: durationSecs,
    publishDate,
    category,
    isLive,
    isPrivate,
    isAgeRestricted,
    isShort,
    hashtags:        extractHashtagsFromText(description),
    thumbnails:      buildThumbnailUrls(videoId),
    noTagsReason:    tags.length === 0
                       ? (isAgeRestricted ? 'age_restricted'
                         : isPrivate      ? 'private'
                         : isLive         ? 'live_stream'
                         : 'creator_set_no_tags')
                       : undefined,
    extractionLayer: layer,
  };
}

// ─── Individual data extractors ───────────────────────────────────────────────

function extractTagsFromPlayerResponse(videoDetails) {
  const kw = videoDetails?.keywords;
  if (!Array.isArray(kw)) return [];
  return kw
    .filter(t => typeof t === 'string' && t.trim().length > 0)
    .map(t => t.trim());
}

function extractMicroformatTags(playerResponse, initialData) {
  // Try playerResponse microformat first
  const pMicro = playerResponse?.microformat?.playerMicroformatRenderer;
  if (pMicro?.keywords && Array.isArray(pMicro.keywords) && pMicro.keywords.length > 0) {
    return pMicro.keywords.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim());
  }
  // Try initialData microformat
  const iMicro = initialData?.microformat?.playerMicroformatRenderer;
  if (iMicro?.keywords && Array.isArray(iMicro.keywords) && iMicro.keywords.length > 0) {
    return iMicro.keywords.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim());
  }
  return [];
}

function extractTitleFromInitialData(initialData) {
  try {
    const contents = initialData?.contents?.twoColumnWatchNextResults
      ?.results?.results?.contents || [];
    for (const item of contents) {
      const runs = item?.videoPrimaryInfoRenderer?.title?.runs;
      if (runs?.[0]?.text) return runs[0].text;
    }
  } catch { /* ignore */ }
  return '';
}

function extractChannelFromInitialData(initialData) {
  try {
    const contents = initialData?.contents?.twoColumnWatchNextResults
      ?.results?.results?.contents || [];
    for (const item of contents) {
      const name = item?.videoSecondaryInfoRenderer?.owner
        ?.videoOwnerRenderer?.title?.runs?.[0]?.text;
      if (name) return name;
    }
  } catch { /* ignore */ }
  return '';
}

function extractViewCountFromInitialData(initialData) {
  try {
    const contents = initialData?.contents?.twoColumnWatchNextResults
      ?.results?.results?.contents || [];
    for (const item of contents) {
      const text = item?.videoPrimaryInfoRenderer?.viewCount
        ?.videoViewCountRenderer?.viewCount?.simpleText;
      if (text) {
        const n = parseInt(text.replace(/[^0-9]/g, ''), 10);
        if (!isNaN(n)) return n;
      }
    }
  } catch { /* ignore */ }
  return 0;
}

function extractPublishDate(playerResponse, initialData) {
  // microformat has the best date format
  const micro = playerResponse?.microformat?.playerMicroformatRenderer;
  if (micro?.publishDate) return micro.publishDate;
  if (micro?.uploadDate)  return micro.uploadDate;

  // initialData secondary info
  try {
    const contents = initialData?.contents?.twoColumnWatchNextResults
      ?.results?.results?.contents || [];
    for (const item of contents) {
      const dt = item?.videoPrimaryInfoRenderer?.dateText?.simpleText;
      if (dt) return dt;
    }
  } catch { /* ignore */ }

  return '';
}

function extractCategory(playerResponse) {
  return playerResponse?.microformat?.playerMicroformatRenderer?.category || '';
}

function detectAgeRestrictionInResponse(playerResponse) {
  const reason = playerResponse?.playabilityStatus?.reason || '';
  const status = playerResponse?.playabilityStatus?.status || '';
  return (
    status === 'LOGIN_REQUIRED'      ||
    reason.toLowerCase().includes('age')   ||
    reason.toLowerCase().includes('sign in') ||
    !!playerResponse?.playabilityStatus?.errorScreen
       ?.playerErrorMessageRenderer?.reason
       ?.simpleText?.toLowerCase().includes('age')
  );
}

// ─── Meta tag fallback extractors (Layer 3) ───────────────────────────────────

function extractMetaKeywordTags(html) {
  // Try name="keywords" first
  const m = html.match(/<meta\s+[^>]*name=["']keywords["'][^>]*content=["']([^"']+)["']/i)
         || html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']keywords["']/i);
  if (!m?.[1]) return [];
  return m[1].split(',').map(t => t.trim()).filter(t => t.length > 0);
}

function extractMetaOgContent(html, property) {
  const m = html.match(new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'
  )) || html.match(new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'
  ));
  return m?.[1] ? decodeHtmlEntities(m[1]) : '';
}

function extractMetaItempropContent(html, prop) {
  const m = html.match(new RegExp(
    `<[^>]+itemprop=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'
  ));
  return m?.[1] || '';
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'");
}

// ─── Hashtag extractor ────────────────────────────────────────────────────────

function extractHashtagsFromText(text) {
  if (!text) return [];
  const matches = text.match(/#[\w\u0080-\uFFFF]+/g);
  if (!matches) return [];
  return [...new Set(matches)]; // deduplicate
}

// ─── Error detectors ─────────────────────────────────────────────────────────

function isBotDetectionPage(html) {
  if (!html || html.length < 10_000) return true; // suspiciously small page
  return (
    html.includes('Our systems have detected unusual traffic')  ||
    html.includes('EnableJavaScript')                          ||
    html.includes('g-recaptcha')                               ||
    html.includes('recaptcha')                                 ||
    (html.includes('youtube.com') && !html.includes('ytInitialData') && !html.includes('og:title'))
  );
}

function detectHardError(html, status) {
  if (status === 404 || html.includes('"status":"ERROR"') || html.includes('"NOT_FOUND"')) {
    return {
      fatalError: true,
      error:      'This video was not found. It may have been deleted or never existed.',
      errorType:  'not_found',
      statusCode: 404,
    };
  }

  if (html.includes('"status":"UNPLAYABLE"') && html.includes('members-only')) {
    return {
      fatalError: true,
      error:      'This video is for channel members only and cannot be analyzed.',
      errorType:  'members_only',
      statusCode: 403,
    };
  }

  return null; // no hard error detected
}

// ═══════════════════════════════════════════════════════════════════════════════
// THUMBNAIL URL BUILDER
// Thumbnails are always deterministic from the video ID — no fetching required.
// ═══════════════════════════════════════════════════════════════════════════════

function buildThumbnailUrls(videoId) {
  const base = `https://i.ytimg.com/vi/${videoId}`;
  return {
    maxres: {
      url:        `${base}/maxresdefault.jpg`,
      label:      '1280 × 720',
      format:     'JPG',
      width:      1280,
      height:     720,
      resolution: 'maxres',
      // Note: maxresdefault may not exist for older/short videos — frontend checks
    },
    sd: {
      url:        `${base}/sddefault.jpg`,
      label:      '640 × 480',
      format:     'JPG',
      width:      640,
      height:     480,
      resolution: 'sd',
    },
    hq: {
      url:        `${base}/hqdefault.jpg`,
      label:      '480 × 360',
      format:     'JPG',
      width:      480,
      height:     360,
      resolution: 'hq',
    },
    mq: {
      url:        `${base}/mqdefault.jpg`,
      label:      '320 × 180',
      format:     'JPG',
      width:      320,
      height:     180,
      resolution: 'mq',
    },
    default: {
      url:        `${base}/default.jpg`,
      label:      '120 × 90',
      format:     'JPG',
      width:      120,
      height:     90,
      resolution: 'default',
    },
    webp: {
      url:        `${base}/maxresdefault.webp`,
      label:      '1280 × 720',
      format:     'WebP',
      width:      1280,
      height:     720,
      resolution: 'webp',
      note:       'Newer format — may not open in all image editing apps',
    },
    // Shorts use vertical thumbnails
    shorts_vertical: {
      url:        `https://i.ytimg.com/vi/${videoId}/oardefault.jpg`,
      label:      '480 × 270',
      format:     'JPG',
      width:      480,
      height:     270,
      resolution: 'shorts',
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function secondsToTimestamp(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return '0:00';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPABASE INTEGRATION (gracefully disabled if env vars not set)
// ═══════════════════════════════════════════════════════════════════════════════

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return {
    url,
    headers: {
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
    },
  };
}

async function getFromSupabaseCache(videoId) {
  const sb = getSupabaseConfig();
  if (!sb) return null;

  try {
    const now      = new Date().toISOString();
    const endpoint = `${sb.url}/rest/v1/extraction_cache`
      + `?video_id=eq.${encodeURIComponent(videoId)}`
      + `&expires_at=gt.${encodeURIComponent(now)}`
      + `&limit=1&select=*`;

    const res = await fetch(endpoint, {
      headers: { ...sb.headers, 'Prefer': 'return=representation' },
      signal:  AbortSignal.timeout(3000),
    });

    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows.length) return null;

    const r = rows[0];
    return {
      videoId:         r.video_id,
      tags:            r.tags             || [],
      title:           r.title            || '',
      channel:         r.channel          || '',
      description:     r.description      || '',
      viewCount:       r.view_count       || 0,
      duration:        r.duration         || '',
      publishDate:     r.publish_date     || '',
      category:        r.category         || '',
      isLive:          r.is_live          || false,
      isPrivate:       r.is_private       || false,
      isAgeRestricted: r.is_age_restricted || false,
      isShort:         r.is_short         || false,
      hashtags:        r.hashtags         || [],
      thumbnails:      buildThumbnailUrls(r.video_id),
      healthScore:     r.health_score     || null,
      extractionLayer: r.extraction_layer || 0,
      noTagsReason:    r.tags?.length === 0 ? 'creator_set_no_tags' : undefined,
      fromCache:       true,
    };
  } catch {
    return null; // Cache unavailable — proceed without it
  }
}

async function saveToSupabaseCache(videoId, data) {
  const sb = getSupabaseConfig();
  if (!sb) return;

  const expiresAt = new Date(
    Date.now() + CONFIG.SUPABASE_CACHE_HOURS * 3_600_000
  ).toISOString();

  const record = {
    video_id:          videoId,
    title:             data.title            || '',
    channel:           data.channel          || '',
    description:       (data.description || '').slice(0, 2000),
    tags:              data.tags             || [],
    hashtags:          data.hashtags         || [],
    view_count:        data.viewCount        || 0,
    duration:          data.duration         || '',
    publish_date:      data.publishDate      || '',
    category:          data.category         || '',
    is_live:           data.isLive           || false,
    is_private:        data.isPrivate        || false,
    is_age_restricted: data.isAgeRestricted  || false,
    is_short:          data.isShort          || false,
    health_score:      data.healthScore      || null,
    extraction_layer:  data.extractionLayer  || 0,
    cached_at:         new Date().toISOString(),
    expires_at:        expiresAt,
  };

  try {
    await fetch(`${sb.url}/rest/v1/extraction_cache`, {
      method:  'POST',
      headers: { ...sb.headers, 'Prefer': 'resolution=merge-duplicates' },
      body:    JSON.stringify(record),
      signal:  AbortSignal.timeout(4000),
    });
  } catch { /* Cache write failure is non-fatal */ }
}

async function recordTagIntelligence(tags) {
  const sb = getSupabaseConfig();
  if (!sb || !tags.length) return;

  // Use the upsert_tag RPC to atomically increment counts
  // Fire one RPC call per tag — Supabase handles concurrent upserts
  const calls = tags.slice(0, 100).map(tag => // cap at 100 tags per video
    fetch(`${sb.url}/rest/v1/rpc/upsert_tag`, {
      method:  'POST',
      headers: sb.headers,
      body:    JSON.stringify({ p_tag: tag.toLowerCase().trim() }),
      signal:  AbortSignal.timeout(3000),
    }).catch(() => {}) // individual tag failures are non-fatal
  );

  await Promise.allSettled(calls);
}

async function recordExtractionStat(layer, isCacheHit) {
  const sb = getSupabaseConfig();
  if (!sb) return;

  try {
    await fetch(`${sb.url}/rest/v1/rpc/record_extraction`, {
      method:  'POST',
      headers: sb.headers,
      body:    JSON.stringify({ p_layer: layer, p_cache_hit: isCacheHit }),
      signal:  AbortSignal.timeout(2000),
    });
  } catch { /* Stat recording is non-fatal */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING (in-memory, per-IP, rolling window)
// ═══════════════════════════════════════════════════════════════════════════════

function enforceRateLimit(ip) {
  const now         = Date.now();
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;

  // Periodic garbage collection of expired entries
  requestsSinceLastPurge++;
  if (requestsSinceLastPurge >= CONFIG.RATE_LIMIT_PURGE_EVERY) {
    requestsSinceLastPurge = 0;
    for (const [key, data] of rateLimitStore.entries()) {
      if (data.windowStart < windowStart) rateLimitStore.delete(key);
    }
  }

  const existing = rateLimitStore.get(ip);

  if (!existing || existing.windowStart < windowStart) {
    // New window for this IP
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return { allowed: true, remaining: CONFIG.RATE_LIMIT_MAX - 1 };
  }

  existing.count++;

  if (existing.count > CONFIG.RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: CONFIG.RATE_LIMIT_MAX - existing.count };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST SIGNATURE VERIFICATION
// Prevents direct API probing from bots that bypass the frontend.
// The frontend generates a matching signature using the same algorithm
// (embedded in obfuscated JS — not a true cryptographic secret for MVP).
// ═══════════════════════════════════════════════════════════════════════════════

function verifyRequestSignature(event) {
  const secret = process.env.REQUEST_SIGN_SECRET;

  // Dev mode: if no secret configured, skip verification
  if (!secret) return { valid: true };

  const params  = event.queryStringParameters || {};
  const sig     = params.sig;
  const ts      = params.ts;
  const rawUrl  = params.url || params.v || '';

  if (!sig || !ts) return { valid: false };

  // Validate timestamp is within the tolerance window
  const timestamp = parseInt(ts, 10);
  if (isNaN(timestamp)) return { valid: false };
  if (Math.abs(Date.now() - timestamp) > CONFIG.SIGN_WINDOW_MS) {
    return { valid: false }; // Expired signature
  }

  const videoId       = normalizeToVideoId(rawUrl);
  if (!videoId)       return { valid: false };

  // Compute expected signature: FNV-1a hash of (videoId + timestamp + secret)
  const expectedSig   = fnv1aHash(`${videoId}:${ts}:${secret}`);

  return { valid: sig === expectedSig };
}

// FNV-1a 32-bit hash — fast, deterministic
function fnv1aHash(str) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash  = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36); // base36 for compact string representation
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT IP EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

function extractClientIP(event) {
  return (
    event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers?.['x-real-ip']                              ||
    event.headers?.['cf-connecting-ip']                       || // Cloudflare
    event.requestContext?.identity?.sourceIp                  ||
    'unknown'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const SECURITY_HEADERS = {
  'Content-Type':              'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  'X-Content-Type-Options':    'nosniff',
  'X-Frame-Options':           'DENY',
  'Referrer-Policy':           'strict-origin-when-cross-origin',
};

function buildCorsPreflightResponse() {
  return {
    statusCode: 204,
    headers:    {
      ...SECURITY_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
    body: '',
  };
}

function buildSuccessResponse(data, extraHeaders = {}) {
  return {
    statusCode: 200,
    headers:    {
      ...SECURITY_HEADERS,
      'Cache-Control': `public, s-maxage=${CONFIG.CDN_CACHE_SECONDS}, max-age=${CONFIG.BROWSER_CACHE_SECONDS}`,
      ...extraHeaders,
    },
    body: JSON.stringify({ success: true, data }),
  };
}

function buildErrorResponse(statusCode, message, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store, no-cache',
      ...extraHeaders,
    },
    body: JSON.stringify({ success: false, error: message }),
  };
}
