// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — BULK EXTRACTION ENGINE
// File: js/bulk.js
// Version: 1.0.0
//
// ROLE IN THE SYSTEM:
// bulk.js orchestrates multi-URL extraction — the feature that processes up to
// 10 YouTube URLs simultaneously and produces aggregated tag intelligence.
//
// It is the only module (besides app.js) that imports from other ytspy modules:
//   - parser.js   → fetchVideoData, extractVideoIdClientSide, computeTagStats
//   - health.js   → computeHealthScore
//
// KEY RESPONSIBILITIES:
//   1. Parse and validate a multi-line URL textarea input
//   2. Deduplicate URLs by video ID (same video pasted twice → counted once)
//   3. Process URLs in controlled batches (3 concurrent) with progress reporting
//   4. Build a frequency table sorted by tag appearance count
//   5. Compute heat-map intensity values for the frequency table rows
//   6. Preserve original tag casing using most-common-casing algorithm
//   7. Build the bulkVideoMap consumed by export.js downloadBulkZip()
//   8. Report per-video errors without stopping the whole batch
//
// CONCURRENCY MODEL:
//   CONCURRENCY = 3 — at most 3 YouTube fetches run simultaneously.
//   This stays well within the backend rate limit (15 req/min per IP).
//   For 10 URLs: 4 batches × ~4s avg = ~16s typical bulk run time.
//
// WHAT THIS FILE DOES NOT DO:
//   - Touch the DOM (app.js handles all rendering)
//   - Write to localStorage (storage.js handles persistence)
//   - Download ZIPs (export.js handles file operations)
//   - Render frequency table rows (app.js handles rendering)
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

import {
  fetchVideoData,
  extractVideoIdClientSide,
  computeTagStats,
} from './parser.js';

import { computeHealthScore } from './health.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

/** Maximum videos per bulk run */
const MAX_URLS = 10;

/** Videos fetched simultaneously per batch */
const CONCURRENCY = 3;

/** Top N rows to include in the rendered frequency table (rest still in data) */
export const FREQUENCY_TABLE_DISPLAY_LIMIT = 50;

// ═══════════════════════════════════════════════════════════════════════════════
// URL LIST PARSER
// Parses and validates a multi-line textarea value.
// Returns structured data that drives both the live counter UI and the
// extraction run itself.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a raw multi-line string from the bulk textarea.
 * Validates each non-empty line, deduplicates by video ID, and caps at MAX_URLS.
 *
 * @param {string} rawText — contents of the bulk textarea
 * @returns {UrlListParseResult}
 */
export function parseUrlList(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return buildEmptyParseResult();
  }

  const lines           = rawText.split('\n');
  const validUrls       = [];    // accepted, deduplicated, capped at MAX_URLS
  const allValidUrls    = [];    // accepted before capping (for showing total)
  const invalidLines    = [];    // non-empty lines that are not YouTube URLs
  const seenVideoIds    = new Set();

  let emptyLines        = 0;
  let duplicatesRemoved = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      emptyLines++;
      continue;
    }

    // Attempt to extract a video ID to validate the line
    const videoId = extractVideoIdClientSide(trimmed);

    if (!videoId) {
      // Not a recognisable YouTube URL or bare video ID
      invalidLines.push(trimmed.slice(0, 200)); // cap length for display
      continue;
    }

    // Deduplicate by video ID — same video pasted twice counts once
    if (seenVideoIds.has(videoId)) {
      duplicatesRemoved++;
      continue;
    }

    seenVideoIds.add(videoId);
    allValidUrls.push(trimmed);

    if (allValidUrls.length <= MAX_URLS) {
      validUrls.push(trimmed);
    }
  }

  const exceedsMax  = allValidUrls.length > MAX_URLS;
  const validCount  = validUrls.length;

  return {
    validUrls,            // URLs to actually process (capped at MAX_URLS)
    allValidUrls,         // all valid URLs found (before cap)
    invalidLines,
    validCount,
    invalidCount:     invalidLines.length,
    emptyLines,
    totalLines:       lines.length,
    duplicatesRemoved,
    exceedsMax,
    overLimitCount:   exceedsMax ? allValidUrls.length - MAX_URLS : 0,
    displayHint:      buildDisplayHint(validCount, invalidLines.length, exceedsMax, duplicatesRemoved),
    isReady:          validCount > 0,
  };
}

/**
 * Lightweight version of parseUrlList for the real-time input event handler.
 * Called on every keystroke — avoids any heavy processing.
 *
 * @param {string} rawText
 * @returns {{ validCount: number, invalidCount: number, displayHint: string, atLimit: boolean }}
 */
export function getUrlListStats(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { validCount: 0, invalidCount: 0, displayHint: '0 / 10 URLs', atLimit: false };
  }

  let valid   = 0;
  let invalid = 0;
  const seen  = new Set();

  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const videoId = extractVideoIdClientSide(trimmed);
    if (!videoId)              { invalid++; continue; }
    if (seen.has(videoId))     continue; // duplicate
    seen.add(videoId);
    if (valid < MAX_URLS) valid++;
  }

  const atLimit    = valid >= MAX_URLS;
  const displayHint = buildDisplayHint(valid, invalid, valid >= MAX_URLS, 0);

  return { validCount: valid, invalidCount: invalid, displayHint, atLimit };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN BULK EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract tag and thumbnail data for a list of YouTube URLs.
 * Processes in batches of CONCURRENCY with progress reporting.
 * Per-video failures do not stop the batch — they are recorded and returned.
 *
 * @param {string[]}  urls         — validated URL list from parseUrlList()
 * @param {function}  [onProgress] — called as (completed, total, latestResult)
 * @returns {Promise<BulkExtractionResult>}
 */
export async function bulkExtract(urls, onProgress) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return buildEmptyBulkResult();
  }

  const limited     = urls.slice(0, MAX_URLS);
  const total       = limited.length;
  const videoResults = [];
  let completed     = 0;

  // ── Process in batches of CONCURRENCY ─────────────────────────────────────
  for (let batchStart = 0; batchStart < limited.length; batchStart += CONCURRENCY) {
    const batch       = limited.slice(batchStart, batchStart + CONCURRENCY);

    const batchOutcomes = await Promise.allSettled(
      batch.map(url => extractOneVideo(url))
    );

    for (const outcome of batchOutcomes) {
      completed++;

      const result = outcome.status === 'fulfilled'
        ? outcome.value
        : buildFailedVideoResult(batch[batchOutcomes.indexOf(outcome)], 'promise_rejected');

      videoResults.push(result);

      if (onProgress) {
        onProgress(completed, total, result);
      }
    }
  }

  // ── Aggregate results ─────────────────────────────────────────────────────
  const successResults  = videoResults.filter(r => r.success);
  const failedResults   = videoResults.filter(r => !r.success);
  const frequencyTable  = buildFrequencyTable(successResults);
  const bulkVideoMap    = buildBulkVideoMap(successResults);
  const summary         = buildExtractionSummary(successResults, failedResults, frequencyTable);

  return {
    videos:           videoResults,        // all results, success and failed
    successVideos:    successResults,
    failedVideos:     failedResults,
    frequencyTable,
    bulkVideoMap,
    summary,
    successCount:     successResults.length,
    failureCount:     failedResults.length,
    totalProcessed:   videoResults.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE VIDEO EXTRACTION (internal)
// Wraps fetchVideoData and adds bulk-specific post-processing.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract one video and enrich with stats and health score.
 * Returns a BulkVideoResult regardless of success or failure.
 *
 * @param {string} url
 * @returns {Promise<BulkVideoResult>}
 */
async function extractOneVideo(url) {
  let apiResult;

  try {
    apiResult = await fetchVideoData(url);
  } catch (err) {
    return buildFailedVideoResult(url, 'exception', err.message);
  }

  if (!apiResult.success) {
    return buildFailedVideoResult(url, apiResult.errorType || 'api_error', apiResult.error);
  }

  const data = apiResult.data;

  // Compute tag stats and health score for each video
  const tagStats    = data.tagStats || computeTagStats(data.tags || []);
  const healthScore = computeHealthScore(
    data.tags   || [],
    tagStats,
    data.hashtags || []
  );

  return {
    success:    true,
    url,
    videoId:    data.videoId,
    title:      data.title      || '',
    channel:    data.channel    || '',
    tags:       data.tags       || [],
    hashtags:   data.hashtags   || [],
    thumbnails: data.thumbnails || {},
    duration:   data.duration   || '',
    viewCount:  data.viewCount  || 0,
    isShort:    data.isShort    || false,
    tagStats,
    healthScore,
    fromCache:  data.fromCache  || false,
    extractionLayer: data.extractionLayer || 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FREQUENCY TABLE BUILDER
// Produces the sorted, annotated tag frequency table for bulk results.
//
// Algorithm:
//   1. For each successful video, normalise its tags to lowercase
//   2. Count how many VIDEOS each tag appears in (not total occurrences)
//      → Each video contributes at most 1 count per tag
//   3. Track the most-common casing for display
//   4. Sort by count descending, then alphabetically as tiebreaker
//   5. Compute heat-map intensity: most frequent = 1.0, least frequent = 0.0
//   6. Classify each tag as short / mid / long-tail
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a ranked frequency table from successful bulk extraction results.
 *
 * @param {BulkVideoResult[]} successResults
 * @returns {FrequencyEntry[]}
 */
export function buildFrequencyTable(successResults) {
  if (!successResults.length) return [];

  const totalVideos = successResults.length;

  // Map: normalised tag → { count, casingFreq, videoTitles }
  const tagMap = new Map();

  for (const video of successResults) {
    // Use a Set to ensure each tag is counted once per video
    const normTagsThisVideo = new Set(
      (video.tags || []).map(t => t.toLowerCase().trim()).filter(Boolean)
    );

    for (const normTag of normTagsThisVideo) {
      if (!tagMap.has(normTag)) {
        tagMap.set(normTag, {
          count:       0,
          casingFreq:  new Map(),  // original casing → count
          videoTitles: [],
        });
      }

      const entry = tagMap.get(normTag);
      entry.count++;
      entry.videoTitles.push(video.title || video.videoId || '');

      // Track casing frequency to pick the most-common original casing
      const originalCasings = (video.tags || [])
        .filter(t => t.toLowerCase().trim() === normTag);

      for (const casing of originalCasings) {
        const trimmed = casing.trim();
        entry.casingFreq.set(trimmed, (entry.casingFreq.get(trimmed) || 0) + 1);
      }
    }
  }

  if (tagMap.size === 0) return [];

  // ── Convert to array and sort ─────────────────────────────────────────────
  const entries = [...tagMap.entries()].map(([normTag, data]) => ({
    normTag,
    tag:         getMostCommonCasing(data.casingFreq, normTag),
    count:       data.count,
    videoTitles: data.videoTitles.slice(0, 10), // cap for storage
  }));

  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.normTag.localeCompare(b.normTag);
  });

  // ── Compute heat-map intensity ────────────────────────────────────────────
  const maxCount = entries[0]?.count || 1;
  const minCount = entries[entries.length - 1]?.count || 0;
  const countRange = maxCount - minCount || 1;

  return entries.map(entry => {
    const pct           = entry.count / totalVideos;
    const wordCount     = countWords(entry.tag);
    const tagType       = wordCount >= 3 ? 'long-tail'
                        : wordCount === 2 ? 'mid-tail'
                        : 'short-tail';

    // Heat intensity: 0.0 (cool, rare) → 1.0 (hot, very common)
    const heatIntensity = (entry.count - minCount) / countRange;

    return {
      tag:              entry.tag,
      normTag:          entry.normTag,
      count:            entry.count,
      pct,
      pctFormatted:     `${Math.round(pct * 100)}%`,
      pctDisplay:       `${entry.count} / ${totalVideos}`,
      videoTitles:      entry.videoTitles,
      heatIntensity,                          // 0–1 for CSS heat coloring
      heatLevel:        getHeatLevel(heatIntensity), // 'hot'|'warm'|'cool'|'cold'
      tagType,
      wordCount,
      charCount:        entry.tag.length,
      isHighFrequency:  pct >= 0.5,           // appears in majority of videos
      isUniversal:      entry.count === totalVideos, // appears in ALL videos
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BULK VIDEO MAP BUILDER
// Produces the map consumed by export.js downloadBulkZip().
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a video map keyed by videoId for use with downloadBulkZip().
 *
 * @param {BulkVideoResult[]} successResults
 * @returns {BulkVideoMap}
 */
export function buildBulkVideoMap(successResults) {
  const map = {};

  for (const video of successResults) {
    if (!video.videoId) continue;

    map[video.videoId] = {
      title:      video.title      || '',
      channel:    video.channel    || '',
      tags:       video.tags       || [],
      thumbnails: video.thumbnails || {},
    };
  }

  return map;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACTION SUMMARY
// Aggregated statistics across all successfully extracted videos.
// Displayed in the bulk results header panel.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute aggregated statistics across all successful bulk results.
 *
 * @param {BulkVideoResult[]} successes
 * @param {BulkVideoResult[]} failures
 * @param {FrequencyEntry[]}  frequencyTable
 * @returns {BulkSummary}
 */
export function buildExtractionSummary(successes, failures, frequencyTable) {
  const total         = successes.length + failures.length;
  const successCount  = successes.length;

  if (successCount === 0) {
    return {
      total, successCount, failureCount: failures.length,
      totalUniqueTags: 0, avgTagCount: 0, avgHealthScore: 0,
      avgCharUsed: 0, universalTags: [], highFrequencyTags: [],
      summaryText: 'No videos were successfully extracted.',
    };
  }

  const totalUniqueTags   = frequencyTable.length;
  const universalTags     = frequencyTable.filter(e => e.isUniversal).map(e => e.tag);
  const highFrequencyTags = frequencyTable.filter(e => e.isHighFrequency && !e.isUniversal).map(e => e.tag);

  const avgTagCount = Math.round(
    successes.reduce((sum, v) => sum + (v.tags?.length || 0), 0) / successCount
  );

  const avgHealthScore = Math.round(
    successes.reduce((sum, v) => sum + (v.healthScore?.overall || 0), 0) / successCount
  );

  const avgCharUsed = Math.round(
    successes.reduce((sum, v) => sum + (v.tagStats?.charUsed || 0), 0) / successCount
  );

  const summaryText = buildSummaryText(
    successCount, failures.length, totalUniqueTags,
    universalTags.length, avgTagCount, avgHealthScore
  );

  return {
    total,
    successCount,
    failureCount:     failures.length,
    totalUniqueTags,
    avgTagCount,
    avgHealthScore,
    avgCharUsed,
    universalTags:      universalTags.slice(0, 20),
    highFrequencyTags:  highFrequencyTags.slice(0, 20),
    summaryText,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PER-VIDEO ACCORDION DATA
// Produces the structured data each accordion item in app.js needs to render.
// Called by app.js — not called internally.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build display-ready accordion data for a single bulk video result.
 * app.js uses this to render each collapsible video row in bulk results.
 *
 * @param {BulkVideoResult} videoResult
 * @param {number}          index  — 0-based position in results list
 * @returns {AccordionItemData}
 */
export function buildAccordionItem(videoResult, index) {
  if (!videoResult.success) {
    return {
      index,
      success:     false,
      url:         videoResult.url || '',
      videoId:     videoResult.videoId || '',
      title:       videoResult.url || `Video ${index + 1}`,
      errorMessage: videoResult.error || 'Extraction failed',
      errorType:    videoResult.errorType || 'unknown',
    };
  }

  const { healthScore, tagStats } = videoResult;

  return {
    index,
    success:       true,
    url:           videoResult.url,
    videoId:       videoResult.videoId,
    title:         videoResult.title    || `Video ${index + 1}`,
    channel:       videoResult.channel  || '',
    thumbUrl:      videoResult.thumbnails?.hq?.url || '',
    tags:          videoResult.tags     || [],
    tagCount:      (videoResult.tags || []).length,
    charUsed:      tagStats?.charUsed   || 0,
    overLimit:     tagStats?.overLimit  || false,
    healthScore:   healthScore?.overall || 0,
    healthLabel:   healthScore?.label   || 'No tags',
    healthGrade:   healthScore?.grade   || 'N/A',
    duration:      videoResult.duration || '',
    isShort:       videoResult.isShort  || false,
    fromCache:     videoResult.fromCache || false,
  };
}

/**
 * Build accordion items for all videos in a bulk run.
 *
 * @param {BulkVideoResult[]} videoResults — full results array (success + failed)
 * @returns {AccordionItemData[]}
 */
export function buildAllAccordionItems(videoResults) {
  return videoResults.map((result, index) => buildAccordionItem(result, index));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNION TAG SET
// Returns a deduplicated union of all tags across all successful videos.
// Used for "Copy all unique tags" feature in bulk results.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a deduplicated union of all tags from all successfully extracted videos.
 * Case-insensitive deduplication — preserves most-common casing of each tag.
 *
 * @param {BulkVideoResult[]} successResults
 * @returns {string[]}
 */
export function buildUnionTagSet(successResults) {
  const seen    = new Map();   // normalized → { tag, count }

  for (const video of successResults) {
    for (const tag of (video.tags || [])) {
      const norm = tag.toLowerCase().trim();
      if (!norm) continue;

      if (!seen.has(norm)) {
        seen.set(norm, { tag: tag.trim(), count: 1 });
      } else {
        seen.get(norm).count++;
      }
    }
  }

  // Sort by frequency descending (most common across videos first)
  return [...seen.values()]
    .sort((a, b) => b.count - a.count)
    .map(v => v.tag);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a failed BulkVideoResult for error cases.
 */
function buildFailedVideoResult(url, errorType, errorMessage) {
  const videoId = extractVideoIdClientSide(url) || '';
  return {
    success:   false,
    url:       url || '',
    videoId,
    error:     errorMessage || 'Extraction failed',
    errorType: errorType    || 'unknown',
  };
}

/**
 * Determine the original casing to display for a tag by picking the
 * most frequently seen casing across all videos.
 *
 * @param {Map<string,number>} casingFreq — casing → occurrence count
 * @param {string}             fallback   — normalized tag as fallback
 * @returns {string}
 */
function getMostCommonCasing(casingFreq, fallback) {
  if (!casingFreq || casingFreq.size === 0) return fallback;

  let bestCasing = fallback;
  let bestCount  = 0;

  for (const [casing, count] of casingFreq.entries()) {
    if (count > bestCount) {
      bestCount  = count;
      bestCasing = casing;
    }
  }

  return bestCasing;
}

/**
 * Count words in a tag string.
 *
 * @param {string} tag
 * @returns {number}
 */
function countWords(tag) {
  return tag.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Map heat intensity (0–1) to a categorical heat level label.
 *
 * @param {number} intensity — 0.0 to 1.0
 * @returns {'hot'|'warm'|'cool'|'cold'}
 */
function getHeatLevel(intensity) {
  if (intensity >= 0.75) return 'hot';
  if (intensity >= 0.50) return 'warm';
  if (intensity >= 0.25) return 'cool';
  return 'cold';
}

/**
 * Build the display hint text for the textarea character counter.
 *
 * @param {number}  validCount
 * @param {number}  invalidCount
 * @param {boolean} exceedsMax
 * @param {number}  duplicates
 * @returns {string}
 */
function buildDisplayHint(validCount, invalidCount, exceedsMax, duplicates) {
  let hint = `${validCount} / ${MAX_URLS} URLs`;

  if (invalidCount > 0) {
    hint += ` · ${invalidCount} invalid — will be skipped`;
  }
  if (duplicates > 0) {
    hint += ` · ${duplicates} duplicate${duplicates !== 1 ? 's' : ''} removed`;
  }
  if (exceedsMax) {
    hint += ` · Only first ${MAX_URLS} will be processed`;
  }

  return hint;
}

/**
 * Build a one-paragraph summary of the bulk extraction run.
 *
 * @param {number} success
 * @param {number} failed
 * @param {number} uniqueTags
 * @param {number} universalCount
 * @param {number} avgTagCount
 * @param {number} avgHealth
 * @returns {string}
 */
function buildSummaryText(success, failed, uniqueTags, universalCount, avgTagCount, avgHealth) {
  let text = `Analysed ${success} video${success !== 1 ? 's' : ''}`;

  if (failed > 0) {
    text += ` (${failed} failed)`;
  }

  text += `. Found ${uniqueTags} unique tag${uniqueTags !== 1 ? 's' : ''} across all videos`;

  if (universalCount > 0) {
    text += `, with ${universalCount} tag${universalCount !== 1 ? 's' : ''} appearing in every video`;
  }

  text += `. Average: ${avgTagCount} tags per video · Health score ${avgHealth}/100.`;

  return text;
}

/**
 * Build a zero-value UrlListParseResult for empty input.
 *
 * @returns {UrlListParseResult}
 */
function buildEmptyParseResult() {
  return {
    validUrls: [], allValidUrls: [], invalidLines: [],
    validCount: 0, invalidCount: 0, emptyLines: 0,
    totalLines: 0, duplicatesRemoved: 0, exceedsMax: false,
    overLimitCount: 0, displayHint: `0 / ${MAX_URLS} URLs`, isReady: false,
  };
}

/**
 * Build a zero-value BulkExtractionResult for empty input.
 *
 * @returns {BulkExtractionResult}
 */
function buildEmptyBulkResult() {
  return {
    videos: [], successVideos: [], failedVideos: [],
    frequencyTable: [], bulkVideoMap: {},
    summary: {
      total: 0, successCount: 0, failureCount: 0,
      totalUniqueTags: 0, avgTagCount: 0, avgHealthScore: 0,
      avgCharUsed: 0, universalTags: [], highFrequencyTags: [],
      summaryText: 'No URLs were provided.',
    },
    successCount: 0, failureCount: 0, totalProcessed: 0,
  };
}
