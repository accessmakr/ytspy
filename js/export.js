// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — EXPORT AND DOWNLOAD LAYER
// File: js/export.js
// Version: 2.0.0  (i18n-aware)
//
// ROLE IN THE SYSTEM:
// export.js handles every operation that moves data OUT of the tool:
//   - Copying tags to clipboard in 4 formats
//   - Downloading single thumbnails as image files
//   - Downloading multiple thumbnails as a ZIP (JSZip, browser-assembled)
//   - Downloading tag lists as text/CSV/JSON files
//   - Generating and downloading bulk research CSV files
//   - Copy button visual feedback utilities
//
// NOTE ON DOM ACCESS:
// Unlike parser.js, storage.js, health.js, templates.js, and overlap.js,
// this module DOES touch the DOM. Clipboard operations and file downloads
// inherently require creating and clicking anchor elements. These are
// infrastructure-level DOM operations, not UI rendering logic.
//
// app.js calls these functions and handles all UI state changes (button
// text, loading indicators) around them. export.js only performs the
// data operation and returns a result object.
//
// JSZIP:
// The ZIP feature loads JSZip dynamically from jsDelivr CDN on first use.
// Falls back gracefully if the CDN is unavailable. JSZip is only loaded
// when the user actually clicks "Download ZIP" — zero cost on initial load.
//
// WHAT THIS FILE DOES NOT DO:
//   - Compute tag statistics (parser.js)
//   - Calculate health scores (health.js)
//   - Merge templates (templates.js)
//   - Handle overlap analysis (overlap.js)
//   - Read or write localStorage (storage.js)
//
// i18n CONTRACT — THIS FILE WAS ORIGINALLY MARKED "NO CHANGES NEEDED" IN THE
// PROJECT MANIFEST. THAT WAS WRONG. The Phase 3 audit found this file has
// some of the HIGHEST-FREQUENCY user-facing strings in the entire app:
//   - COPY_FORMATS.label (shown in every copy-format dropdown/button)
//   - "✓ Copied" / "✕ Failed" button feedback (fires on every single copy
//     click across the whole tool — tags panel, bulk table, overlap columns)
//   - CSV column headers (every bulk research export)
//   - 7 distinct download/ZIP error messages
// All of these ALREADY had locale keys waiting in en.json's `buttons`,
// `csv_export`, and `export_errors` sections — they just weren't wired up
// because this file was never given an i18n pass. They are now.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

import { t } from './i18n.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const TAG_CHAR_LIMIT = 500;

/** JSZip CDN URL — loaded dynamically on first ZIP request */
const JSZIP_CDN = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

/** Blob URL revocation delay after download triggers (ms) */
const BLOB_REVOKE_DELAY_MS = 90_000;   // 90 seconds

/** Maximum filename length for downloaded files */
const MAX_FILENAME_LENGTH = 80;

// ═══════════════════════════════════════════════════════════════════════════════
// COPY FORMAT DEFINITIONS
// The four formats available in the tags panel copy buttons.
// Each entry defines the label, transformation function, MIME type, and
// file extension (used if the user chooses to download rather than copy).
//
// `label` is now a getter so every read reflects the active language —
// COPY_FORMATS itself must stay a plain object (not a function) since
// app.js does `COPY_FORMATS[formatId]` lookups and `.fn(...)` calls on it,
// but object property getters re-evaluate on every access, which gives us
// translation-on-read without changing the call-site shape anywhere.
// ═══════════════════════════════════════════════════════════════════════════════

export const COPY_FORMATS = Object.freeze({

  /**
   * Plain text — tags separated by commas and spaces.
   * Best for pasting into documents, spreadsheets, notes.
   * Example: gaming, gaming tips, how to win at chess
   */
  plain: {
    id:   'plain',
    get label() { return t('copy_formats.plain'); },
    fn:   (tags) => tags.map(tg => tg.trim()).join(', '),
    mime: 'text/plain',
    ext:  'txt',
  },

  /**
   * CSV — same as plain text but RFC 4180 compliant.
   * Tags containing commas are quoted. Safe for spreadsheet import.
   * Example: gaming,"gaming, tips",how to win at chess
   */
  csv: {
    id:   'csv',
    get label() { return t('copy_formats.csv'); },
    fn:   (tags) => tags
      .map(tag => {
        const tg = tag.trim();
        return (tg.includes(',') || tg.includes('"') || tg.includes('\n'))
          ? `"${tg.replace(/"/g, '""')}"`
          : tg;
      })
      .join(', '),
    mime: 'text/csv',
    ext:  'csv',
  },

  /**
   * JSON — pretty-printed JSON array of strings.
   * Best for developers, API integrations, programmatic use.
   * Example: ["gaming", "gaming tips", "how to win at chess"]
   */
  json: {
    id:   'json',
    get label() { return t('copy_formats.json'); },
    fn:   (tags) => JSON.stringify(tags.map(tg => tg.trim()), null, 2),
    mime: 'application/json',
    ext:  'json',
  },

  /**
   * YouTube-ready — format for pasting directly into YouTube Studio tag field.
   * Multi-word tags are wrapped in double quotes. Single-word tags are bare.
   * Tags are space-separated (not comma-separated).
   * Example: gaming "gaming tips" "how to win at chess" chess
   */
  yt: {
    id:   'yt',
    get label() { return t('copy_formats.yt'); },
    fn:   (tags) => tags
      .map(tag => {
        const tg = tag.trim();
        return tg.includes(' ') ? `"${tg.replace(/"/g, '\\"')}"` : tg;
      })
      .join(' '),
    mime: 'text/plain',
    ext:  'txt',
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLIPBOARD OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Copy any text string to the clipboard.
 * Uses the modern Clipboard API first, falls back to execCommand for
 * older browsers and iOS Safari quirks.
 *
 * @param {string} text
 * @returns {Promise<{ success: boolean, method: 'modern'|'fallback'|'failed' }>}
 */
export async function copyToClipboard(text) {
  // ── Modern Clipboard API (all current browsers) ───────────────────────────
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { success: true, method: 'modern' };
    } catch {
      // Permission denied or other error — fall through to execCommand
    }
  }

  // ── execCommand fallback (legacy browsers, some iOS contexts) ────────────
  try {
    const textarea        = document.createElement('textarea');
    textarea.value        = text;
    textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);

    return ok
      ? { success: true,  method: 'fallback' }
      : { success: false, method: 'failed'   };

  } catch {
    return { success: false, method: 'failed' };
  }
}

/**
 * Format tags in the specified format and copy to clipboard in one call.
 * Convenience wrapper used by the copy buttons in the tags panel.
 *
 * @param {string[]} tags
 * @param {'plain'|'csv'|'json'|'yt'} formatId
 * @returns {Promise<{ success: boolean, method: string, text: string }>}
 */
export async function copyTagsInFormat(tags, formatId) {
  const format = COPY_FORMATS[formatId];
  if (!format) {
    return { success: false, method: 'invalid_format', text: '' };
  }

  const text   = format.fn(tags);
  const result = await copyToClipboard(text);

  return { ...result, text };
}

/**
 * Copy a single tag (from pill click) to clipboard.
 * Simple wrapper with a clear name for the single-pill use case.
 *
 * @param {string} tag
 * @returns {Promise<{ success: boolean }>}
 */
export async function copySingleTag(tag) {
  const result = await copyToClipboard(tag.trim());
  return { success: result.success };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAG FILE DOWNLOAD
// Download tag lists as files (text / CSV / JSON).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Download a tag array as a file in the specified format.
 *
 * @param {string[]} tags
 * @param {'plain'|'csv'|'json'|'yt'} formatId
 * @param {string}   [filenameBase]  — base name without extension
 * @returns {{ success: boolean, filename?: string }}
 */
export function downloadTagsAsFile(tags, formatId, filenameBase = 'ytspy_tags') {
  const format = COPY_FORMATS[formatId];
  if (!format || !tags.length) return { success: false };

  const text     = format.fn(tags);
  const filename = `${sanitizeFilename(filenameBase)}.${format.ext}`;

  return downloadTextFile(text, filename, format.mime);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE THUMBNAIL DOWNLOAD
// Downloads one thumbnail image file.
//
// Strategy:
//   1. Fetch the image as a Blob (works for cross-origin i.ytimg.com URLs)
//   2. Create a temporary blob URL
//   3. Trigger <a download> with the blob URL
//   4. Clean up the blob URL after 90 seconds
//
// Fallback: if fetch fails, open the URL in a new tab so the user can
// right-click → Save image. This always works regardless of CORS.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Download a single YouTube thumbnail as an image file.
 *
 * @param {string} url          — full thumbnail URL (from thumbnails object)
 * @param {string} videoId      — 11-character video ID (used in filename)
 * @param {string} resolution   — 'maxres'|'sd'|'hq'|'mq'|'default'|'webp'
 * @param {string} [format]     — 'jpg' or 'webp' (inferred from URL if not provided)
 * @returns {Promise<{ success: boolean, fallback?: boolean, error?: string, message?: string }>}
 */
export async function downloadSingleThumbnail(url, videoId, resolution, format) {
  if (!url || !videoId) {
    return { success: false, error: t('export_errors.missing_url_or_id') };
  }

  // Infer format from URL if not specified
  const ext = format || (url.endsWith('.webp') ? 'webp' : 'jpg');
  const filename = `${sanitizeFilename(videoId)}_${resolution}.${ext}`;

  // ── Primary: fetch as blob for reliable cross-origin download ────────────
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (!response.ok) {
      throw new Error(`Thumbnail returned HTTP ${response.status}`);
    }

    const blob      = await response.blob();
    const objectUrl = URL.createObjectURL(blob);

    triggerAnchorDownload(objectUrl, filename);

    // Revoke the object URL after download starts
    setTimeout(() => URL.revokeObjectURL(objectUrl), BLOB_REVOKE_DELAY_MS);

    return { success: true };

  } catch (err) {
    // ── Fallback: open in new tab for manual save ─────────────────────────
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
      return {
        success:  false,
        fallback: true,
        message:  t('export_errors.save_image_fallback'),
      };
    } catch {
      return { success: false, error: t('export_errors.download_failed_no_tab') };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BULK THUMBNAIL ZIP DOWNLOAD
// Assembles a ZIP file in the browser from multiple thumbnail URLs.
// Zero server upload — JSZip runs entirely client-side.
//
// Performance notes:
//   - Thumbnails are fetched in parallel (Promise.allSettled)
//   - Failed thumbnails are skipped silently — partial ZIP is still delivered
//   - Compression level 3 (DEFLATE) — fast; JPEGs are already compressed
//   - JSZip is loaded from CDN on first call only (cached in module scope)
// ═══════════════════════════════════════════════════════════════════════════════

/** Module-level JSZip reference — loaded once and reused */
let _JSZip = null;

/**
 * Download all thumbnails from a bulk extraction as a single ZIP file.
 *
 * @param {BulkVideoMap}  videoMap    — keyed by videoId, each has { title, thumbnails }
 * @param {'maxres'|'sd'|'hq'|'mq'} [resolution='hq'] — which resolution to include
 * @param {function}      [onProgress] — called with (completed, total) during fetch
 * @returns {Promise<{ success: boolean, count: number, skipped: number, error?: string }>}
 *
 * @typedef {{ [videoId: string]: { title: string, thumbnails: object } }} BulkVideoMap
 */
export async function downloadBulkZip(videoMap, resolution = 'hq', onProgress) {
  const entries = Object.entries(videoMap || {});

  if (entries.length === 0) {
    return { success: false, count: 0, skipped: 0, error: t('export_errors.no_videos_to_download') };
  }

  // ── Load JSZip from CDN (once only) ──────────────────────────────────────
  try {
    _JSZip = _JSZip || await loadJSZip();
  } catch {
    return {
      success: false, count: 0, skipped: 0,
      error:   t('export_errors.zip_library_load_failed'),
    };
  }

  // ── Set up ZIP structure ──────────────────────────────────────────────────
  const zip    = new _JSZip();
  const folder = zip.folder('ytspy_thumbnails');

  let completed = 0;
  let skipped   = 0;

  // ── Fetch all thumbnails in parallel ─────────────────────────────────────
  const fetchResults = await Promise.allSettled(
    entries.map(async ([videoId, data]) => {
      const thumbData = data.thumbnails?.[resolution] || data.thumbnails?.hq;

      if (!thumbData?.url) {
        skipped++;
        return null;
      }

      try {
        const response = await fetch(thumbData.url, {
          signal: AbortSignal.timeout(12_000),
        });

        if (!response.ok) {
          skipped++;
          return null;
        }

        const blob     = await response.blob();
        const safeName = buildZipFilename(data.title || videoId, videoId);

        folder.file(safeName, blob);
        completed++;

        if (onProgress) onProgress(completed + skipped, entries.length);

        return { videoId, safeName };

      } catch {
        skipped++;
        if (onProgress) onProgress(completed + skipped, entries.length);
        return null;
      }
    })
  );

  // ── Guard: nothing was downloaded ─────────────────────────────────────────
  const successCount = fetchResults.filter(r => r.status === 'fulfilled' && r.value).length;

  if (successCount === 0) {
    return {
      success: false, count: 0, skipped,
      error:   t('export_errors.zip_all_failed'),
    };
  }

  // ── Generate ZIP and trigger download ─────────────────────────────────────
  try {
    const zipBlob = await zip.generateAsync({
      type:               'blob',
      compression:        'DEFLATE',
      compressionOptions: { level: 3 },   // fast — JPEGs don't compress further
    });

    const filename  = `ytspy_thumbnails_${Date.now()}.zip`;
    const objectUrl = URL.createObjectURL(zipBlob);

    triggerAnchorDownload(objectUrl, filename);
    setTimeout(() => URL.revokeObjectURL(objectUrl), BLOB_REVOKE_DELAY_MS);

    return { success: true, count: successCount, skipped };

  } catch (err) {
    return {
      success: false, count: 0, skipped,
      error:   t('export_errors.zip_create_failed'),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BULK RESEARCH CSV EXPORT
// Generates a downloadable CSV research deliverable from bulk extraction results.
// One row per tag, with frequency counts and video appearances.
//
// Column structure:
//   Tag | Appears In (count) | Frequency (%) | Tag Length | Word Count | Type | Source Videos
//
// NOTE: CSV column headers and Long-tail/Mid-tail/Short-tail type values are
// now translated via `csv_export.*` and `tags_panel.*_tail_label` keys.
// Unlike most UI text, this is a judgment call worth flagging: translating
// column headers means a CSV opened in, say, Japanese will have Japanese
// headers, which is correct for the end user but means the literal header
// string is no longer a stable machine-readable key if anyone scripts
// against this export. Accepted trade-off — this is a human research
// deliverable, not an API contract.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a CSV string from bulk extraction frequency table data.
 *
 * @param {FrequencyEntry[]} frequencyTable — from bulk.js buildFrequencyTable()
 * @param {number}           totalVideos    — how many videos were in the bulk run
 * @returns {string}                        — complete CSV string with header row
 *
 * @typedef {{ tag: string, count: number, pct: number, videoTitles: string[] }} FrequencyEntry
 */
export function buildBulkCsv(frequencyTable, totalVideos) {
  if (!frequencyTable || !frequencyTable.length) {
    return `${t('csv_export.no_data')}\n`;
  }

  const header = [
    t('csv_export.col_tag'),
    t('csv_export.col_appears_in', { total: totalVideos }),
    t('csv_export.col_frequency'),
    t('csv_export.col_tag_length'),
    t('csv_export.col_word_count'),
    t('csv_export.col_type'),
    t('csv_export.col_source_videos'),
  ].map(csvCell).join(',');

  const longTailLabel  = t('tags_panel.long_tail_label');
  const midTailLabel   = t('tags_panel.mid_tail_label');
  const shortTailLabel = t('tags_panel.short_tail_label');

  const rows = frequencyTable.map(entry => {
    const tag       = entry.tag || '';
    const count     = entry.count || 0;
    const pct       = Math.round((entry.pct || 0) * 100);
    const charLen   = tag.length;
    const wordCount = tag.trim().split(/\s+/).filter(Boolean).length;
    const type      = wordCount >= 3 ? longTailLabel : wordCount === 2 ? midTailLabel : shortTailLabel;

    // Truncate source video titles for CSV readability
    const sources = (entry.videoTitles || [])
      .slice(0, 5)
      .join(' | ')
      .slice(0, 200);

    return [
      csvCell(tag),
      count,
      `${pct}%`,
      charLen,
      wordCount,
      csvCell(type),
      csvCell(sources),
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

/**
 * Download the bulk research CSV as a file.
 *
 * @param {FrequencyEntry[]} frequencyTable
 * @param {number}           totalVideos
 * @param {string}           [filenameBase]
 * @returns {{ success: boolean, filename?: string }}
 */
export function downloadBulkCsv(frequencyTable, totalVideos, filenameBase = 'ytspy_research') {
  const csv      = buildBulkCsv(frequencyTable, totalVideos);
  const filename = `${sanitizeFilename(filenameBase)}_${formatDateForFilename()}.csv`;
  return downloadTextFile(csv, filename, 'text/csv');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COPY BUTTON FEEDBACK
// Visual feedback utilities for copy button state changes.
// These update button appearance — the only intentional UI logic in export.js.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply "copied" visual feedback to a button element.
 * Stores original text, changes to the translated "✓ Copied" label, reverts
 * after delay.
 *
 * @param {HTMLElement} buttonEl
 * @param {number}      [durationMs=1200]
 */
export function applySuccessFeedback(buttonEl, durationMs = 1200) {
  if (!buttonEl) return;

  const originalText  = buttonEl.textContent;
  const originalColor = buttonEl.style.color;

  buttonEl.textContent = t('buttons.copied');
  buttonEl.style.color = 'var(--accent-green)';
  buttonEl.setAttribute('disabled', 'true');

  setTimeout(() => {
    buttonEl.textContent = originalText;
    buttonEl.style.color = originalColor;
    buttonEl.removeAttribute('disabled');
  }, durationMs);
}

/**
 * Apply "failed" visual feedback to a button element.
 * Brief red flash, then reverts.
 *
 * @param {HTMLElement} buttonEl
 * @param {number}      [durationMs=2000]
 */
export function applyFailureFeedback(buttonEl, durationMs = 2000) {
  if (!buttonEl) return;

  const originalText  = buttonEl.textContent;
  const originalColor = buttonEl.style.color;

  buttonEl.textContent = t('buttons.failed');
  buttonEl.style.color = 'var(--accent-red)';

  setTimeout(() => {
    buttonEl.textContent = originalText;
    buttonEl.style.color = originalColor;
  }, durationMs);
}

/**
 * Apply "downloading" state to a download button.
 * Returns a function to call when the download completes (restores original state).
 *
 * @param {HTMLElement} buttonEl
 * @param {string}      [loadingText] — defaults to the translated buttons.downloading
 * @returns {function}  — call to restore original state
 */
export function applyDownloadingState(buttonEl, loadingText) {
  if (!buttonEl) return () => {};

  const text = loadingText ?? t('buttons.downloading');

  const originalText     = buttonEl.textContent;
  const originalDisabled = buttonEl.disabled;

  buttonEl.textContent = text;
  buttonEl.disabled    = true;

  return () => {
    buttonEl.textContent = originalText;
    buttonEl.disabled    = originalDisabled;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSZIP LOADER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load JSZip from CDN (or return the cached module-level reference).
 * Checks window.JSZip first in case JSZip was loaded via a <script> tag.
 *
 * @returns {Promise<JSZipConstructor>}
 */
async function loadJSZip() {
  // Return cached instance
  if (_JSZip) return _JSZip;

  // Check for global (loaded via HTML <script> tag)
  if (typeof window !== 'undefined' && window.JSZip) {
    _JSZip = window.JSZip;
    return _JSZip;
  }

  // Dynamic import from CDN
  try {
    // JSZip is a UMD module — dynamic import returns it as default or the module itself
    const module = await import(/* @vite-ignore */ JSZIP_CDN);
    _JSZip = module.default || module;

    if (typeof _JSZip !== 'function') {
      throw new Error('JSZip constructor not found in loaded module');
    }

    return _JSZip;

  } catch (err) {
    // Internal/developer-facing error (caught and replaced with a translated
    // message by downloadBulkZip's caller) — intentionally not translated.
    _JSZip = null;
    throw new Error(`Failed to load JSZip from CDN: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Trigger a browser download by creating and clicking a hidden anchor element.
 * Cleans up the anchor element immediately after clicking.
 *
 * @param {string} href      — blob URL or data URL
 * @param {string} filename  — downloaded file name
 */
function triggerAnchorDownload(href, filename) {
  const anchor          = document.createElement('a');
  anchor.href           = href;
  anchor.download       = filename;
  anchor.style.cssText  = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * Download a text string as a file.
 *
 * @param {string} content
 * @param {string} filename
 * @param {string} [mimeType='text/plain']
 * @returns {{ success: boolean, filename: string }}
 */
function downloadTextFile(content, filename, mimeType = 'text/plain') {
  try {
    const blob      = new Blob([content], { type: `${mimeType};charset=utf-8;` });
    const objectUrl = URL.createObjectURL(blob);

    triggerAnchorDownload(objectUrl, filename);
    setTimeout(() => URL.revokeObjectURL(objectUrl), BLOB_REVOKE_DELAY_MS);

    return { success: true, filename };

  } catch {
    return { success: false, filename };
  }
}

/**
 * Sanitise a string for use as a filename.
 * Replaces characters that are illegal on Windows/macOS/Linux with underscores.
 * Trims to MAX_FILENAME_LENGTH.
 *
 * NOT translated — filenames stay in Latin-safe form regardless of UI
 * language deliberately, to avoid filesystem encoding issues on older
 * Windows filesystems and ZIP archive compatibility edge cases.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')   // illegal filename characters
    .replace(/\s+/g, '_')            // spaces → underscores
    .replace(/__+/g, '_')            // collapse multiple underscores
    .replace(/^_+|_+$/g, '')         // trim leading/trailing underscores
    .slice(0, MAX_FILENAME_LENGTH)
    || 'ytspy_download';
}

/**
 * Build a filename for a thumbnail inside the ZIP archive.
 * Format: {safe_title}_{videoId}.jpg
 * Example: How_to_Win_at_Chess_dQw4w9WgXcQ.jpg
 *
 * @param {string} title
 * @param {string} videoId
 * @returns {string}
 */
function buildZipFilename(title, videoId) {
  const safeTitle = sanitizeFilename(title).slice(0, 50);
  return `${safeTitle}_${videoId}.jpg`;
}

/**
 * Format today's date as YYYY-MM-DD for use in filenames.
 *
 * @returns {string}
 */
function formatDateForFilename() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Wrap a value for safe inclusion in a CSV cell.
 * Quotes the value if it contains commas, quotes, or newlines.
 *
 * @param {string} value
 * @returns {string}
 */
function csvCell(value) {
  const str = String(value || '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
