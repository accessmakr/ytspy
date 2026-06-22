// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — COMPETITOR TAG ANALYSIS ENGINE
// File: js/overlap.js
// Version: 2.0.0  (i18n-aware)
//
// ROLE IN THE SYSTEM:
// overlap.js takes two extracted tag arrays — the user's video and a competitor's
// video — and produces the full three-column competitor analysis:
//
//   Column 1 — Shared tags    : both videos use these (your overlap)
//   Column 2 — You're missing : competitor has these, you don't (steal these!)
//   Column 3 — Your unique    : only your video has these
//
// Beyond the three columns, this module computes:
//   - Sørensen-Dice overlap score (0–100) with interpretation
//   - Tag coverage percentage (how much of their strategy you already use)
//   - Missing tags ranked by estimated SEO value (long-tail first)
//   - Budget-aware steal list (only what fits in remaining character budget)
//   - Quick wins vs high-value targets classification
//   - Formatted outputs in all copy formats (YouTube-ready, plain, CSV, JSON)
//   - Add-to-template payload for saving competitor research
//   - SEO narrative interpretation of the overlap score
//
// WHAT THIS FILE DOES NOT DO:
//   - Make any API calls
//   - Touch the DOM
//   - Read or write localStorage
//   - Import from any other ytspy module, except i18n.js for translation
//
// NOTE ON FORMATTING FUNCTIONS:
// formatTagsForYouTube and other formatters are small pure functions that also
// exist in templates.js. They are duplicated here to keep overlap.js completely
// self-contained with zero inter-module dependencies (besides i18n). This is
// intentional.
//
// i18n CONTRACT:
//   The five-tier overlap system (getOverlapTiers()) is fully translated —
//   `label`, `interpretation`, and `recommendation` all route through
//   `overlap.overlap_label_*` / `overlap.interpretation_*` /
//   `overlap.recommendation_*` locale keys (added during the Phase 3 audit;
//   these 10 interpretation/recommendation keys are net-new to the schema
//   and still need translating into the 19 non-English locale files).
//
//   buildOverlapSummary()'s composite sentence still has a partial gap —
//   only the tier label portion is translated; the connecting clauses ("X
//   tags in common", "Y competitor tags not in your list", etc.) stay
//   English pending a dedicated `overlap.summary_*` key set. Lower priority
//   since app.js's current UI does not render `summary` anywhere — it's
//   computed and returned for potential future use only.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

import { t } from './i18n.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const TAG_CHAR_LIMIT = 500;

/**
 * Overlap score thresholds and their labels/interpretations.
 * Scores are Sørensen-Dice × 100 (0–100 range).
 * Built fresh on every call so `label` always reflects the active language
 * (interpretation/recommendation stay English — see file header).
 *
 * @returns {OverlapTier[]}
 */
function getOverlapTiers() {
  return [
    {
      min: 75, max: 100,
      label:          t('overlap.overlap_label_very_high'),
      cssModifier:    'very-high',
      interpretation: t('overlap.interpretation_very_high'),
      recommendation: t('overlap.recommendation_very_high'),
    },
    {
      min: 50, max: 74,
      label:          t('overlap.overlap_label_high'),
      cssModifier:    'high',
      interpretation: t('overlap.interpretation_high'),
      recommendation: t('overlap.recommendation_high'),
    },
    {
      min: 30, max: 49,
      label:          t('overlap.overlap_label_moderate'),
      cssModifier:    'moderate',
      interpretation: t('overlap.interpretation_moderate'),
      recommendation: t('overlap.recommendation_moderate'),
    },
    {
      min: 10, max: 29,
      label:          t('overlap.overlap_label_low'),
      cssModifier:    'low',
      interpretation: t('overlap.interpretation_low'),
      recommendation: t('overlap.recommendation_low'),
    },
    {
      min: 0, max: 9,
      label:          t('overlap.overlap_label_very_low'),
      cssModifier:    'very-low',
      interpretation: t('overlap.interpretation_very_low'),
      recommendation: t('overlap.recommendation_very_low'),
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMARY EXPORT — FULL OVERLAP ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute the complete competitor tag analysis between two videos.
 *
 * @param {string[]} myTags        — your video's extracted tags
 * @param {string[]} theirTags     — competitor video's extracted tags
 * @param {number}   [myCharUsed]  — optional: your current char count for
 *                                   budget-aware steal list calculation
 * @returns {OverlapResult}
 */
export function computeOverlap(myTags, theirTags, myCharUsed = null) {
  const myArr    = sanitizeTagArray(myTags);
  const theirArr = sanitizeTagArray(theirTags);

  // ── Handle empty inputs gracefully ───────────────────────────────────────
  if (myArr.length === 0 && theirArr.length === 0) {
    return buildEmptyOverlapResult('both_empty');
  }
  if (myArr.length === 0) {
    return buildEmptyOverlapResult('mine_empty', theirArr);
  }
  if (theirArr.length === 0) {
    return buildEmptyOverlapResult('theirs_empty', null, myArr);
  }

  // ── Build normalised lookup sets ─────────────────────────────────────────
  const myNormSet    = new Set(myArr.map(normalizeTag));
  const theirNormSet = new Set(theirArr.map(normalizeTag));

  // ── Three-column split ────────────────────────────────────────────────────
  // Shared: competitor's tags that appear in my set (use competitor casing)
  const shared  = theirArr.filter(tg => myNormSet.has(normalizeTag(tg)));

  // Missing: competitor has these — I don't (highest strategic value)
  const missing = theirArr.filter(tg => !myNormSet.has(normalizeTag(tg)));

  // Unique: I have these — competitor doesn't
  const unique  = myArr.filter(tg => !theirNormSet.has(normalizeTag(tg)));

  // ── Overlap score (Sørensen-Dice coefficient × 100) ───────────────────────
  // Dice = (2 × |intersection|) / (|A| + |B|)
  // Ranges 0–100. More balanced than Jaccard for set overlap.
  const diceScore  = myArr.length + theirArr.length > 0
    ? Math.round((shared.length * 2 / (myArr.length + theirArr.length)) * 100)
    : 0;

  // ── Coverage: what % of their strategy we already cover ──────────────────
  // Different from overlap score — measures one-directional coverage
  const coveragePct = theirArr.length > 0
    ? Math.round((shared.length / theirArr.length) * 100)
    : 0;

  // ── Ranked and classified missing tags ───────────────────────────────────
  const rankedMissing   = rankMissingByValue(missing);
  const quickWins       = rankedMissing.filter(tg => countWords(tg) <= 2).slice(0, 5);
  const highValueTargets = rankedMissing.filter(tg => countWords(tg) >= 3).slice(0, 8);

  // ── Budget-aware steal list ───────────────────────────────────────────────
  const effectiveCharUsed = myCharUsed !== null
    ? myCharUsed
    : computeCharCount(myArr);

  const stealableWithBudget = getStealableTags(rankedMissing, effectiveCharUsed);

  // ── Tier lookup for this score ────────────────────────────────────────────
  const tier = getOverlapTier(diceScore);

  // ── Formatted outputs ────────────────────────────────────────────────────
  const stealTagsYouTubeReady = formatTagsForYouTube(rankedMissing);
  const stealTagsPlain        = rankedMissing.join(', ');
  const stealTagsJson         = JSON.stringify(rankedMissing, null, 2);
  const stealTagsCsv          = formatTagsCsv(rankedMissing);

  // ── Stats for the missing tags ────────────────────────────────────────────
  const missingCharCount    = computeCharCount(rankedMissing);
  const missingOverBudget   = (effectiveCharUsed + missingCharCount) > TAG_CHAR_LIMIT;

  return {
    // ── Core three-column data ────────────────────────────────────────────
    shared,
    missing,       // original order from competitor's tag list
    unique,
    rankedMissing, // missing tags sorted by estimated SEO value

    // ── Counts ───────────────────────────────────────────────────────────
    sharedCount:  shared.length,
    missingCount: missing.length,
    uniqueCount:  unique.length,
    myTotal:      myArr.length,
    theirTotal:   theirArr.length,

    // ── Scores ───────────────────────────────────────────────────────────
    overlapScore:   diceScore,
    coveragePct,    // % of their tags already in my list

    // ── Tier / labels ─────────────────────────────────────────────────────
    overlapLabel:          tier.label,
    overlapCssModifier:    tier.cssModifier,
    interpretation:        tier.interpretation,
    recommendation:        tier.recommendation,

    // ── Classification of missing tags ───────────────────────────────────
    quickWins,          // short missing tags — easy to add now
    highValueTargets,   // long-tail missing tags — highest strategic value

    // ── Budget-aware stealing ─────────────────────────────────────────────
    stealableWithBudget,       // tags that fit in remaining budget
    stealableCount: stealableWithBudget.length,
    effectiveCharUsed,
    missingCharCount,
    missingOverBudget,

    // ── Formatted clipboard outputs ───────────────────────────────────────
    stealTagsYouTubeReady,
    stealTagsPlain,
    stealTagsJson,
    stealTagsCsv,

    // ── Template save payload ─────────────────────────────────────────────
    // Pass directly to storage.saveTemplate() to save competitor research
    templatePayload: buildTemplatePayload(rankedMissing, theirArr),

    // ── Human-readable summary ────────────────────────────────────────────
    summary: buildOverlapSummary(
      diceScore, shared.length, missing.length, unique.length,
      coveragePct, myArr.length, theirArr.length
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERLAP SCORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Return the tier object for a given overlap score.
 *
 * @param {number} score — 0–100
 * @returns {OverlapTier}
 */
export function getOverlapTier(score) {
  const tiers = getOverlapTiers();
  for (const tier of tiers) {
    if (score >= tier.min && score <= tier.max) return tier;
  }
  return tiers[tiers.length - 1]; // fallback to lowest tier
}

/**
 * Get just the label for a given overlap score.
 * Used in history rows and quick displays.
 *
 * @param {number} score — 0–100
 * @returns {string}
 */
export function getOverlapLabel(score) {
  return getOverlapTier(score).label;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MISSING TAG RANKING
// Ranks missing tags by estimated SEO value.
// Primary signal: word count (long-tail = more specific = less competition).
// Secondary signal: character length (longer = more specific within same word count).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sort missing tags from highest to lowest estimated SEO value.
 * Long-tail tags (3+ words) ranked first — they are more specific, face
 * less competition, and indicate the competitor's deliberate niche targeting.
 *
 * @param {string[]} missingTags
 * @returns {string[]}
 */
export function rankMissingByValue(missingTags) {
  return [...missingTags].sort((a, b) => {
    const wA = countWords(a);
    const wB = countWords(b);

    // Primary: more words = higher estimated value
    if (wB !== wA) return wB - wA;

    // Secondary: within same word count, longer string = more specific
    return b.length - a.length;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUDGET-AWARE STEAL LIST
// Returns only the missing tags that actually fit in the remaining character
// budget. Critical for avoiding the over-limit trap when stealing competitor tags.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Filter missing tags to only those that fit in the remaining character budget.
 * Processes tags in value-ranked order so the highest-value tags are selected first.
 *
 * @param {string[]} missingTags   — already ranked by value (long-tail first)
 * @param {number}   currentUsed   — character count already in use
 * @returns {string[]}             — subset that fits within 500-char budget
 */
export function getStealableTags(missingTags, currentUsed) {
  if (currentUsed >= TAG_CHAR_LIMIT) return []; // already at or over budget

  const result = [];
  let   used   = currentUsed;

  for (const tag of missingTags) {
    // Each additional tag costs: tag.length + 2 chars for the ", " separator
    // (The first tag in a completely empty list would cost tag.length only,
    //  but we're always appending to an existing list with currentUsed > 0)
    const cost = tag.length + 2;

    if (used + cost <= TAG_CHAR_LIMIT) {
      result.push(tag);
      used += cost;
    }
    // Continue checking — a shorter tag later might still fit
  }

  return result;
}

/**
 * Compute how many characters stealing a specific set of tags would consume.
 * Shows the user the budget impact before they commit.
 *
 * @param {string[]} tagsToSteal
 * @param {number}   currentUsed
 * @returns {{ newTotal: number, addedChars: number, overLimit: boolean, fitsCount: number }}
 */
export function computeStealBudgetImpact(tagsToSteal, currentUsed) {
  if (!tagsToSteal.length) {
    return {
      newTotal:   currentUsed,
      addedChars: 0,
      overLimit:  currentUsed > TAG_CHAR_LIMIT,
      fitsCount:  0,
    };
  }

  // Characters added by the steal tags: each costs length + 2 (separator)
  const addedChars = tagsToSteal.reduce((sum, tg) => sum + tg.length + 2, 0);
  const newTotal   = currentUsed + addedChars;

  return {
    newTotal,
    addedChars,
    overLimit: newTotal > TAG_CHAR_LIMIT,
    fitsCount: getStealableTags(tagsToSteal, currentUsed).length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMATTED OUTPUTS
// All format variants of the missing/stealable tags.
// Duplicated from templates.js intentionally — keeps this module self-contained.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format a tag array for YouTube Studio clipboard paste.
 * Multi-word tags are quoted; single-word tags are bare.
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTagsForYouTube(tags) {
  if (!tags.length) return '';
  return tags
    .map(tag => {
      const tg = tag.trim();
      return tg.includes(' ') ? `"${tg.replace(/"/g, '\\"')}"` : tg;
    })
    .join(' ');
}

/**
 * Format tags as comma-separated plain text.
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTagsPlain(tags) {
  return tags.map(tg => tg.trim()).join(', ');
}

/**
 * Format tags as a JSON array string.
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTagsJson(tags) {
  return JSON.stringify(tags.map(tg => tg.trim()), null, 2);
}

/**
 * Format tags as CSV (RFC 4180 compliant).
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTagsCsv(tags) {
  return tags
    .map(tag => {
      const tg = tag.trim();
      return (tg.includes(',') || tg.includes('"') || tg.includes('\n'))
        ? `"${tg.replace(/"/g, '""')}"`
        : tg;
    })
    .join(', ');
}

/**
 * Format missing tags in any supported copy format.
 * Convenience wrapper used by app.js copy buttons.
 *
 * @param {string[]} tags
 * @param {'youtube'|'plain'|'csv'|'json'} format
 * @returns {string}
 */
export function formatMissingTags(tags, format) {
  switch (format) {
    case 'youtube': return formatTagsForYouTube(tags);
    case 'csv':     return formatTagsCsv(tags);
    case 'json':    return formatTagsJson(tags);
    case 'plain':
    default:        return formatTagsPlain(tags);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE PAYLOAD BUILDER
// Prepares the object passed to storage.saveTemplate() to save competitor
// research as a named template for future reuse.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the payload for saving competitor research as a template.
 * Returns an object ready to spread into storage.saveTemplate() options.
 *
 * @param {string[]} rankedMissing   — missing tags ranked by value
 * @param {string[]} theirAllTags    — competitor's complete tag set
 * @returns {object}
 */
export function buildTemplatePayload(rankedMissing, theirAllTags) {
  return {
    suggestedName: t('overlap.title'),
    tags:          rankedMissing,
    description:   `${rankedMissing.length} tags from competitor analysis. `
                 + `${theirAllTags.length} total competitor tags analysed.`,
    sourceContext: 'overlap_analysis',
  };
}

/**
 * Build the payload for saving ONLY the competitor's complete tag set.
 * Useful when the user wants to save the entire competitor strategy as a template.
 * NOTE: not currently called from app.js — exported for future use. The
 * "Tags from: {title}" / "Competitor full tag set" strings have no locale
 * key and stay English-only.
 *
 * @param {string[]} theirTags
 * @param {string}   [competitorTitle] — the competitor video title if known
 * @returns {object}
 */
export function buildFullCompetitorTemplatePayload(theirTags, competitorTitle) {
  return {
    suggestedName: competitorTitle
      ? `Tags from: ${competitorTitle.slice(0, 50)}`
      : 'Competitor full tag set',
    tags:          theirTags,
    description:   `Complete tag set extracted from competitor video. `
                 + `${theirTags.length} tags total.`,
    sourceContext: 'overlap_analysis_full',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLUMN-LEVEL EMPTY STATE MESSAGES
// When a column has no data, return a specific message explaining why.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Return the appropriate empty-state message for each column.
 * app.js uses this when a column's array is empty.
 *
 * @param {'shared'|'missing'|'unique'} column
 * @param {object}  context
 * @param {boolean} context.myHasTags     — does my video have tags?
 * @param {boolean} context.theirHasTags  — does the competitor have tags?
 * @returns {string}
 */
export function getColumnEmptyMessage(column, context) {
  const { myHasTags, theirHasTags } = context;

  switch (column) {
    case 'shared':
      if (!myHasTags)    return t('overlap.col_empty_mine');
      if (!theirHasTags) return t('overlap.col_empty_theirs');
      return t('overlap.col_empty_shared_none');

    case 'missing':
      if (!theirHasTags) return t('overlap.col_empty_theirs');
      return t('overlap.col_empty_missing_none');

    case 'unique':
      if (!myHasTags)    return t('overlap.col_empty_mine');
      return t('overlap.col_empty_unique_none');

    default:
      // Unreachable in practice — app.js only ever passes the three columns
      // above. No dedicated locale key for this catch-all; low priority.
      return 'No data available.';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPARISON UTILITIES
// Standalone utilities that app.js can use for live comparison UI.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a specific tag from the competitor's list already exists in my tags.
 * Used to highlight individual pills in the competitor column.
 *
 * @param {string}   tag
 * @param {string[]} myTags
 * @returns {boolean}
 */
export function isTagAlreadyMine(tag, myTags) {
  const norm = normalizeTag(tag);
  return myTags.some(tg => normalizeTag(tg) === norm);
}

/**
 * Classify a tag as 'shared', 'missing', or 'unique' given both tag sets.
 * Used for rendering pills in comparison mode.
 *
 * @param {string}   tag        — the tag to classify
 * @param {string[]} myTags
 * @param {string[]} theirTags
 * @param {'mine'|'theirs'} perspective — which list this tag came from
 * @returns {'shared'|'missing'|'unique'}
 */
export function classifyTag(tag, myTags, theirTags, perspective) {
  const myNorm    = new Set(myTags.map(normalizeTag));
  const theirNorm = new Set(theirTags.map(normalizeTag));
  const norm      = normalizeTag(tag);

  if (myNorm.has(norm) && theirNorm.has(norm)) return 'shared';

  if (perspective === 'theirs') {
    return theirNorm.has(norm) && !myNorm.has(norm) ? 'missing' : 'shared';
  }

  return myNorm.has(norm) && !theirNorm.has(norm) ? 'unique' : 'shared';
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMPTY RESULT BUILDERS
// Return safe zero-value OverlapResult objects for edge cases.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build an empty overlap result for edge cases (no tags on one or both sides).
 *
 * @param {'both_empty'|'mine_empty'|'theirs_empty'} reason
 * @param {string[]} [theirTags]
 * @param {string[]} [myTags]
 * @returns {OverlapResult}
 */
function buildEmptyOverlapResult(reason, theirTags = [], myTags = []) {
  const emptyMessages = {
    both_empty:   t('overlap.col_empty_both'),
    mine_empty:   t('overlap.col_empty_mine'),
    theirs_empty: t('overlap.col_empty_theirs'),
  };

  return {
    shared: [], missing: [], unique: myTags, rankedMissing: [],
    sharedCount: 0, missingCount: 0, uniqueCount: myTags.length,
    myTotal: myTags.length, theirTotal: theirTags.length,
    overlapScore: 0, coveragePct: 0,
    overlapLabel:       t('overlap.overlap_label_no_data'),
    overlapCssModifier: 'none',
    interpretation:     emptyMessages[reason],
    recommendation:     '',
    quickWins: [], highValueTargets: [],
    stealableWithBudget: [], stealableCount: 0,
    effectiveCharUsed: 0, missingCharCount: 0, missingOverBudget: false,
    stealTagsYouTubeReady: '', stealTagsPlain: '',
    stealTagsJson: '[]', stealTagsCsv: '',
    templatePayload: null,
    summary: emptyMessages[reason],
    isEmpty: true,
    emptyReason: reason,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY BUILDER
// NOTE: not currently rendered anywhere in app.js's UI — computed and returned
// for potential future use. Only the tier label is translated; see file
// header i18n CONTRACT gap note for why the connecting clauses stay English.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a 2–3 sentence human-readable summary of the overlap analysis.
 *
 * @param {number} score
 * @param {number} shared
 * @param {number} missing
 * @param {number} unique
 * @param {number} coveragePct
 * @param {number} myTotal
 * @param {number} theirTotal
 * @returns {string}
 */
function buildOverlapSummary(score, shared, missing, unique, coveragePct, myTotal, theirTotal) {
  const tier = getOverlapTier(score);

  let summary = `${tier.label} (${score}%) — `;

  if (shared === 0) {
    summary += `no tags in common between the two videos. `;
  } else {
    summary += `${shared} tag${shared !== 1 ? 's' : ''} in common `
             + `(${coveragePct}% of the competitor's strategy). `;
  }

  if (missing === 0) {
    summary += `You already use all of the competitor's tags.`;
  } else {
    summary += `${missing} competitor tag${missing !== 1 ? 's' : ''} `
             + `not in your list — ranked by value above.`;
  }

  if (unique > 0) {
    summary += ` You have ${unique} tag${unique !== 1 ? 's' : ''} they don't use.`;
  }

  return summary;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalise a tag for case-insensitive comparison.
 *
 * @param {string} tag
 * @returns {string}
 */
function normalizeTag(tag) {
  return tag.toLowerCase().trim();
}

/**
 * Count the number of words in a tag.
 *
 * @param {string} tag
 * @returns {number}
 */
function countWords(tag) {
  return tag.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Compute the total character count of a tag array using YouTube's method.
 * (tags joined with ", ")
 *
 * @param {string[]} tags
 * @returns {number}
 */
function computeCharCount(tags) {
  if (!tags.length) return 0;
  return tags.join(', ').length;
}

/**
 * Sanitise a tag array: trim, remove empty strings.
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
function sanitizeTagArray(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map(tg => String(tg).trim())
    .filter(tg => tg.length > 0);
}
