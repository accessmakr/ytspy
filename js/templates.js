// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — TEMPLATE LIBRARY LOGIC
// File: js/templates.js
// Version: 2.0.0  (i18n-aware)
//
// ROLE IN THE SYSTEM:
// templates.js is the computation layer for the tag template library feature.
// It bridges storage.js (where templates live) and app.js (which renders them).
//
// It handles all the logic that is more complex than simple CRUD:
//   - Merging template tags with current video tags using 4 strategies
//   - Deduplicating merged tag sets (case-insensitive, order-preserving)
//   - Scoring template relevance against the current video's tags
//   - Suggesting the most relevant templates automatically when results load
//   - Previewing the result of a merge BEFORE the user commits to it
//   - Checking character budget impact before applying
//   - Formatting tag arrays for YouTube Studio clipboard paste
//   - Validating template names before saving
//
// WHAT THIS FILE DOES NOT DO:
//   - Read or write localStorage (that is storage.js exclusively)
//   - Touch the DOM (that is app.js exclusively)
//   - Make any API calls
//   - Import from parser.js, health.js, or any other ytspy module besides i18n.js
//     (it is otherwise self-contained — all other inputs are passed as arguments)
//
// MERGE STRATEGIES:
//   union    — combine current + template, deduplicate, respect budget
//              Most common use case: enriching existing tags
//   replace  — discard current tags, use template only
//              Use when starting from scratch with a proven set
//   append   — add template tags to END of current list
//              Template tags fill remaining budget from the tail
//   prepend  — add template tags to START of current list
//              Template tags take priority positions in the tag order
//
// YOUTUBE TAG CHARACTER LIMIT: 500 characters (tags joined with ", ")
//
// i18n CONTRACT:
//   getMergeStrategies() and buildMergeSummary() map almost 1:1 onto the
//   `templates.*` locale keys already used by app.js's prompt dialogs and
//   toasts. Two simplifications were made to fit the available keys exactly
//   (both flagged inline at point of use):
//     1. buildMergeSummary()'s 'replace' branch always uses `merge_replaced`
//        (even when removedCount is 0) rather than the v1.0.0 distinct
//        "Template applied — tag list replaced" message, since no locale
//        key exists for that exact phrasing.
//     2. prepend/append's positional nuance ("added to the beginning/end")
//        is lost — both now share the generic `merge_added` sentence with
//        union, since no position-specific "added" key exists.
//   Both trade a little English-only precision for full translation coverage
//   across all 20 locales — consistent with this build's general principle.
//
//   KNOWN GAP — three rare, low-traffic strings have no locale key and stay
//   English-only (flagged inline): the "tag(s) too long" warning in
//   validateTemplateTags(), the non-array-input "Empty template" guard in
//   buildTemplatePreview(), and validateTemplateTags()'s "all tags were
//   empty after trimming" message (which reuses `tags_empty` instead, a
//   close-enough semantic match rather than a true gap).
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

import { t } from './i18n.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const TAG_CHAR_LIMIT = 500;

/** Valid merge strategies */
const MERGE_STRATEGIES = Object.freeze(['union', 'replace', 'append', 'prepend']);

/** Minimum Jaccard similarity to show a template as a smart suggestion */
const RELEVANCE_THRESHOLD = 0.08;

/** Maximum number of smart suggestions to return */
const MAX_SUGGESTIONS = 3;

/** Maximum tag name length we accept when saving (YouTube has no stated limit,
 *  but excessively long tags are never useful and waste character budget) */
const MAX_TAG_LENGTH = 100;

/** Template name constraints */
const TEMPLATE_NAME_MIN = 1;
const TEMPLATE_NAME_MAX = 100;

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMARY EXPORT — APPLY TEMPLATE
// The core operation: merge a template's tags with the current video's tags.
// Returns a complete result object app.js can use directly.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply a template to the current tag set using the specified strategy.
 * Returns the merged tags plus budget stats and a YouTube-ready clipboard string.
 *
 * @param {string[]} templateTags  — tags from the saved template
 * @param {string[]} currentTags   — tags currently extracted from the video
 * @param {'union'|'replace'|'append'|'prepend'} strategy
 * @returns {MergeResult}
 */
export function applyTemplate(templateTags, currentTags, strategy = 'union') {
  const tTags = sanitizeTagArray(templateTags);
  const cTags = sanitizeTagArray(currentTags);

  if (!MERGE_STRATEGIES.includes(strategy)) {
    strategy = 'union';
  }

  // ── Perform merge ─────────────────────────────────────────────────────────
  let merged;

  switch (strategy) {

    case 'replace':
      // Discard current entirely — use template as the new tag list
      merged = [...tTags];
      break;

    case 'append':
      // Current tags first, template tags appended after
      // Deduplication removes template tags already in current list
      merged = deduplicateTags([...cTags, ...tTags]);
      break;

    case 'prepend':
      // Template tags first, current tags follow
      // Deduplication removes current tags already in template list
      merged = deduplicateTags([...tTags, ...cTags]);
      break;

    case 'union':
    default:
      // Combine both, deduplicate, preserve the order: current first, template additions after
      // This feels most natural — your existing tags stay in place, new ones are added
      merged = deduplicateTags([...cTags, ...tTags]);
      break;
  }

  // ── Budget analysis on merged result ─────────────────────────────────────
  const budgetResult = computeBudget(merged);

  // ── Diff: what was added and what was removed ─────────────────────────────
  const currentSet  = new Set(cTags.map(tg => tg.toLowerCase()));
  const templateSet = new Set(tTags.map(tg => tg.toLowerCase()));

  const addedTags   = merged.filter(tg => !currentSet.has(tg.toLowerCase()));
  const removedTags = strategy === 'replace'
    ? cTags.filter(tg => !templateSet.has(tg.toLowerCase()))
    : [];

  return {
    tags:           merged,
    addedCount:     addedTags.length,
    addedTags,
    removedCount:   removedTags.length,
    removedTags,
    strategy,

    // Budget
    charUsed:       budgetResult.charUsed,
    charRemaining:  budgetResult.charRemaining,
    overLimit:      budgetResult.overLimit,
    truncatedTags:  budgetResult.truncatedTags,

    // Ready-to-paste format for YouTube Studio
    youtubeReady:   formatTagsForYouTube(merged),

    // Summary sentence shown in the UI before confirmation
    summary:        buildMergeSummary(
                      strategy, addedTags.length, removedTags.length,
                      budgetResult.overLimit, budgetResult.charUsed
                    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MERGE PREVIEW
// Show what a merge WOULD produce without committing.
// Identical to applyTemplate but clearly named to signal no side effects.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Preview what the merged tag list would look like without applying it.
 * app.js calls this when the user hovers or selects a strategy in the UI.
 *
 * @param {string[]} templateTags
 * @param {string[]} currentTags
 * @param {'union'|'replace'|'append'|'prepend'} strategy
 * @returns {MergeResult}
 */
export function previewMerge(templateTags, currentTags, strategy = 'union') {
  // Functionally identical to applyTemplate — the distinction is semantic
  // (preview vs apply) and is enforced at the app.js call site.
  return applyTemplate(templateTags, currentTags, strategy);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE RELEVANCE SCORING
// Scores how similar a saved template is to the current video's tags.
// Used to surface "smart suggestions" when a new extraction loads.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute Jaccard similarity between two tag arrays.
 * Jaccard = |intersection| / |union| — returns 0 (no overlap) to 1 (identical).
 *
 * Uses normalised lowercase comparison so "Gaming Tips" and "gaming tips"
 * are treated as the same tag.
 *
 * @param {string[]} tagsA
 * @param {string[]} tagsB
 * @returns {number} — 0.0 to 1.0
 */
export function computeTemplateRelevance(tagsA, tagsB) {
  if (!tagsA.length || !tagsB.length) return 0;

  const setA = new Set(tagsA.map(tg => tg.toLowerCase().trim()));
  const setB = new Set(tagsB.map(tg => tg.toLowerCase().trim()));

  // Intersection: tags in both sets
  let intersectionSize = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersectionSize++;
  }

  // Union: all unique tags across both sets
  const unionSize = setA.size + setB.size - intersectionSize;

  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

/**
 * Also compute word-level overlap for cases where tag text partially matches.
 * "gaming tutorial" and "gaming tips" share the word "gaming".
 * Pure Jaccard misses this — word-level adds a secondary signal.
 *
 * @param {string[]} tagsA
 * @param {string[]} tagsB
 * @returns {number} — 0.0 to 1.0
 */
function computeWordLevelOverlap(tagsA, tagsB) {
  const wordsA = new Set(
    tagsA.flatMap(tg => tg.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  );
  const wordsB = new Set(
    tagsB.flatMap(tg => tg.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  );

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersect = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersect++;
  }

  const unionSize = wordsA.size + wordsB.size - intersect;
  return unionSize > 0 ? intersect / unionSize : 0;
}

/**
 * Combined relevance score using both tag-level and word-level Jaccard.
 * Tag-level weighted more heavily — exact tag matches are stronger signals.
 *
 * @param {string[]} templateTags
 * @param {string[]} videoTags
 * @returns {number} — 0.0 to 1.0
 */
export function computeCombinedRelevance(templateTags, videoTags) {
  const tagScore  = computeTemplateRelevance(templateTags, videoTags);
  const wordScore = computeWordLevelOverlap(templateTags, videoTags);
  // Weighted average: exact tag matches count 70%, word matches 30%
  return (tagScore * 0.70) + (wordScore * 0.30);
}

/**
 * Find the most relevant templates for a given video's tags.
 * Returns up to MAX_SUGGESTIONS templates scored above RELEVANCE_THRESHOLD,
 * sorted by relevance descending.
 *
 * @param {string[]}    videoTags  — current video's extracted tags
 * @param {Template[]}  templates  — all saved templates from storage.getTemplates()
 * @returns {ScoredTemplate[]}     — templates with relevance scores attached
 */
export function getRelevantTemplates(videoTags, templates) {
  if (!videoTags.length || !templates.length) return [];

  const scored = templates
    .map(template => ({
      ...template,
      relevance:     computeCombinedRelevance(template.tags, videoTags),
      exactMatches:  countExactMatches(template.tags, videoTags),
      addableCount:  countAddableTags(template.tags, videoTags),
    }))
    .filter(tpl => tpl.relevance >= RELEVANCE_THRESHOLD || tpl.addableCount > 0)
    .sort((a, b) => {
      // Primary sort: relevance score
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      // Secondary sort: number of new tags it would add
      return b.addableCount - a.addableCount;
    });

  return scored.slice(0, MAX_SUGGESTIONS);
}

/**
 * Count how many tags in templateTags exactly match tags in videoTags.
 * Used for the "X tags already in your list" display label.
 *
 * @param {string[]} templateTags
 * @param {string[]} videoTags
 * @returns {number}
 */
export function countExactMatches(templateTags, videoTags) {
  const videoSet = new Set(videoTags.map(tg => tg.toLowerCase()));
  return templateTags.filter(tg => videoSet.has(tg.toLowerCase())).length;
}

/**
 * Count how many tags from the template are NOT already in the video's tags.
 * These are the "new" tags a template would contribute.
 *
 * @param {string[]} templateTags
 * @param {string[]} videoTags
 * @returns {number}
 */
export function countAddableTags(templateTags, videoTags) {
  const videoSet = new Set(videoTags.map(tg => tg.toLowerCase()));
  return templateTags.filter(tg => !videoSet.has(tg.toLowerCase())).length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAG DEDUPLICATION
// Case-insensitive deduplication that preserves the original casing of the
// FIRST occurrence of each tag and the original ordering of the array.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deduplicate a tag array case-insensitively.
 * The first occurrence of each tag (by lowercase key) is kept.
 * All subsequent duplicates are removed.
 *
 * Example:
 *   ["Gaming", "gaming tips", "GAMING", "tips"]
 *   → ["Gaming", "gaming tips", "tips"]
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
export function deduplicateTags(tags) {
  const seen   = new Set();
  const result = [];

  for (const tag of tags) {
    const key = tag.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(tag.trim());
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// YOUTUBE-READY FORMATTER
// Produces the exact format used when pasting tags into YouTube Studio.
// Multi-word tags are wrapped in double quotes.
// Single-word tags are left bare.
//
// Example output:
//   gaming tutorial "gaming tips" "how to win at chess" chess
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format a tag array for direct paste into YouTube Studio's tag field.
 * YouTube Studio accepts tags separated by spaces, with multi-word tags
 * wrapped in double quotes.
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTagsForYouTube(tags) {
  if (!tags.length) return '';

  return tags
    .map(tag => {
      const trimmed = tag.trim();
      // Multi-word tag: wrap in double quotes
      // Also escape any existing double quotes inside the tag
      if (trimmed.includes(' ')) {
        return `"${trimmed.replace(/"/g, '\\"')}"`;
      }
      return trimmed;
    })
    .join(' ');
}

/**
 * Format a tag array as comma-separated plain text.
 * Used for "Plain text" copy format.
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTagsPlain(tags) {
  return tags.map(tg => tg.trim()).join(', ');
}

/**
 * Format a tag array as a JSON array string.
 * Used for "JSON" copy format.
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTagsJson(tags) {
  return JSON.stringify(tags.map(tg => tg.trim()), null, 2);
}

/**
 * Format a tag array as a CSV row.
 * Multi-word tags containing commas are quoted per RFC 4180.
 * Used for "CSV" copy format and bulk CSV export.
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTagsCsv(tags) {
  return tags
    .map(tag => {
      const tg = tag.trim();
      // RFC 4180: quote if contains comma, double-quote, or newline
      if (tg.includes(',') || tg.includes('"') || tg.includes('\n')) {
        return `"${tg.replace(/"/g, '""')}"`;
      }
      return tg;
    })
    .join(', ');
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUDGET COMPUTATION
// Computes character budget metrics for any tag array.
// Mirrors the logic in parser.js computeTagStats() but self-contained here
// so templates.js has no dependency on parser.js.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute character budget stats for a tag array.
 * YouTube counts characters as: tags.join(', ').length
 *
 * @param {string[]} tags
 * @returns {{ charUsed, charRemaining, overLimit, truncatedTags }}
 */
export function computeBudget(tags) {
  if (!tags.length) {
    return {
      charUsed: 0, charRemaining: TAG_CHAR_LIMIT,
      overLimit: false, truncatedTags: [],
    };
  }

  const charUsed       = tags.join(', ').length;
  const charRemaining  = TAG_CHAR_LIMIT - charUsed;
  const overLimit      = charUsed > TAG_CHAR_LIMIT;
  const truncatedTags  = overLimit ? findTruncatedTags(tags) : [];

  return { charUsed, charRemaining, overLimit, truncatedTags };
}

/**
 * Compute budget for a PROPOSED merge without fully executing it.
 * Lets app.js show a budget warning BEFORE the user confirms the apply.
 *
 * @param {string[]} currentTags
 * @param {string[]} templateTags
 * @param {'union'|'replace'|'append'|'prepend'} strategy
 * @returns {{ charUsed, charRemaining, overLimit, wouldAdd }}
 */
export function previewBudgetImpact(currentTags, templateTags, strategy = 'union') {
  // Run the merge without returning the full result
  const preview  = applyTemplate(templateTags, currentTags, strategy);
  return {
    charUsed:      preview.charUsed,
    charRemaining: preview.charRemaining,
    overLimit:     preview.overLimit,
    wouldAdd:      preview.addedCount,
    wouldRemove:   preview.removedCount,
  };
}

/**
 * Identify tags that push the total character count over the 500-char limit.
 * YouTube processes tags in order and stops at the budget — tags from here
 * onward are silently ignored.
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
function findTruncatedTags(tags) {
  let running     = 0;
  const truncated = [];

  for (let i = 0; i < tags.length; i++) {
    running += i === 0 ? tags[i].length : tags[i].length + 2;
    if (running > TAG_CHAR_LIMIT) {
      truncated.push(tags[i]);
    }
  }

  return truncated;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE VALIDATION
// Used by app.js before calling storage.saveTemplate().
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate a template name before saving.
 *
 * @param {string} name
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateTemplateName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: t('templates.name_required') };
  }

  const trimmed = name.trim();

  if (trimmed.length < TEMPLATE_NAME_MIN) {
    // Reuses name_required — "cannot be empty" and "is required" are the
    // same actionable problem from the user's point of view, and only the
    // latter has a dedicated locale key.
    return { valid: false, error: t('templates.name_required') };
  }

  if (trimmed.length > TEMPLATE_NAME_MAX) {
    return { valid: false, error: t('templates.name_too_long') };
  }

  // Block names that are pure punctuation or whitespace
  if (/^[^a-zA-Z0-9\u0080-\uFFFF]+$/.test(trimmed)) {
    return { valid: false, error: t('templates.name_invalid') };
  }

  return { valid: true };
}

/**
 * Validate a tag array before saving as a template.
 *
 * @param {string[]} tags
 * @returns {{ valid: boolean, error?: string, warnings?: string[] }}
 */
export function validateTemplateTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return { valid: false, error: t('templates.tags_empty') };
  }

  const cleaned  = sanitizeTagArray(tags);
  const warnings = [];

  if (cleaned.length === 0) {
    // Reuses tags_empty — "ended up with zero usable tags" either way.
    return { valid: false, error: t('templates.tags_empty') };
  }

  // Warn if any individual tag is unusually long
  // NOTE: no dedicated locale key for this warning — stays English-only.
  const longTags = cleaned.filter(tg => tg.length > MAX_TAG_LENGTH);
  if (longTags.length > 0) {
    warnings.push(
      `${longTags.length} tag${longTags.length !== 1 ? 's are' : ' is'} very long and may not work well in YouTube.`
    );
  }

  // Warn if saving this template would immediately exceed the budget
  const budget = computeBudget(cleaned);
  if (budget.overLimit) {
    warnings.push(
      t('templates.tags_over_budget', { chars: budget.charUsed, over: Math.abs(budget.charRemaining) })
    );
  }

  return { valid: true, cleanedTags: cleaned, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE PREVIEW BUILDER
// Returns a shortened preview of a template's tags for display in the library.
// Used in the template list to show what a template contains without full detail.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a display preview of a template's tags.
 * Shows the first `limit` tags, with a count of how many are hidden.
 *
 * @param {string[]} tags
 * @param {number}   [limit=6]    — max tags to show before truncating
 * @returns {{ visibleTags: string[], hiddenCount: number, summary: string }}
 */
export function buildTemplatePreview(tags, limit = 6) {
  if (!Array.isArray(tags)) {
    // NOTE: no dedicated locale key for this guard — stays English-only.
    // Unreachable in practice; app.js always passes a real tags array.
    return { visibleTags: [], hiddenCount: 0, summary: 'Empty template' };
  }

  const visibleTags = tags.slice(0, limit);
  const hiddenCount = Math.max(0, tags.length - limit);
  const budget      = computeBudget(tags);

  const tagCountText = tags.length === 1
    ? t('tags_panel.tag_count_one',  { n: tags.length })
    : t('tags_panel.tag_count_many', { n: tags.length });

  const summary = `${tagCountText} · ${budget.charUsed}/500`
                + (budget.overLimit ? ` ⚠ ${t('budget_labels.over_limit')}` : '');

  return { visibleTags, hiddenCount, summary };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MERGE STRATEGY METADATA
// Translated descriptions of each strategy for the UI selection dropdown/buttons.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Return UI metadata for all merge strategies.
 * app.js uses this to render the strategy selector without hardcoding labels.
 * Built fresh on every call so labels/descriptions reflect the active language.
 *
 * @returns {StrategyMeta[]}
 */
export function getMergeStrategies() {
  return [
    {
      id:          'union',
      label:       t('templates.strategy_union'),
      description: t('templates.strategy_union_desc'),
      icon:        '+',
      recommended: true,
    },
    {
      id:          'replace',
      label:       t('templates.strategy_replace'),
      description: t('templates.strategy_replace_desc'),
      icon:        '↻',
      recommended: false,
    },
    {
      id:          'prepend',
      label:       t('templates.strategy_prepend'),
      description: t('templates.strategy_prepend_desc'),
      icon:        '↑',
      recommended: false,
    },
    {
      id:          'append',
      label:       t('templates.strategy_append'),
      description: t('templates.strategy_append_desc'),
      icon:        '↓',
      recommended: false,
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sanitise a tag array: trim whitespace, remove empty strings, enforce max length.
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
function sanitizeTagArray(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map(tg => String(tg).trim())
    .filter(tg => tg.length > 0)
    .map(tg => tg.slice(0, MAX_TAG_LENGTH));
}

/**
 * Build a one-sentence summary of what a merge operation did.
 * Shown as a confirmation message in the UI after applying a template.
 *
 * Restructured from v1.0.0 to map directly onto the available `templates.*`
 * locale sentences — see file header i18n CONTRACT note for the two
 * simplifications this involves (replace-with-zero-removed, and prepend/
 * append sharing the generic "added" sentence with union).
 *
 * @param {string}  strategy
 * @param {number}  addedCount
 * @param {number}  removedCount
 * @param {boolean} overLimit
 * @param {number}  charUsed
 * @returns {string}
 */
function buildMergeSummary(strategy, addedCount, removedCount, overLimit, charUsed) {
  if (overLimit) {
    return t('templates.merge_over_limit', { chars: charUsed });
  }

  if (strategy === 'replace') {
    return t('templates.merge_replaced', { count: removedCount, chars: charUsed });
  }

  if (addedCount > 0) {
    return t('templates.merge_added', { count: addedCount, chars: charUsed });
  }

  return t('templates.merge_no_new');
}
