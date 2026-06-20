// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — TAG HEALTH SCORE ENGINE
// File: js/health.js
// Version: 2.0.0  (i18n-aware)
//
// ROLE IN THE SYSTEM:
// health.js is a pure computation module. It accepts tag data and pre-computed
// statistics from parser.js, then produces a structured score object that app.js
// renders in the health score panel.
//
// Its only dependency on another ytspy module is i18n.js (for t()) — it makes
// no network calls, touches no DOM, writes nothing to storage.
//
// SCORING OVERVIEW — 100 points total across 4 components:
//
//   Component 1 — Budget Efficiency    (25 pts)
//   How well the 500-character tag budget is being used.
//   Sweet spot: 80–95% used. Hard penalty: over 100% (tags get truncated).
//
//   Component 2 — Tail Distribution    (25 pts)
//   How balanced the short / mid / long-tail tag mix is.
//   Ideal: ~20% short-tail, ~40% mid-tail, ~40% long-tail.
//   Penalises over-reliance on either extreme.
//
//   Component 3 — Word Diversity       (25 pts)
//   How semantically varied the vocabulary across all tags is.
//   Measures unique word ratio and single-keyword concentration.
//   Penalises tag sets that are just minor variations of the same phrase.
//
//   Component 4 — Hashtag Alignment    (25 pts)
//   Whether the hashtags in the video description also appear as tags.
//   Misalignment is a missed discovery opportunity.
//   Neutral (12 pts) when no hashtags are present — not using hashtags is valid.
//
// SCORE INTERPRETATION:
//   86–100  Excellent — fully optimised tag strategy
//   66–85   Good      — competitive, with minor room to improve
//   41–65   Average   — notable gaps that are costing discovery
//   0–40    Weak      — significant structural problems
//
// WHAT THIS FILE EXPORTS:
//   computeHealthScore(tags, tagStats, hashtags)  — main entry point
//   getScoreLabel(score)                          — 'Excellent' | 'Good' | etc.
//   getScoreGrade(score)                          — 'A+' | 'A' | 'B' | etc.
//   getScoreModifier(score)                       — 'excellent' | 'good' | etc.
//
// i18n CONTRACT:
//   Every insight/summary/suggestion sentence and every label routes through
//   t() at call time, mapped against the `health_insights.*`, `health_summaries.*`,
//   and `health_suggestions.*` locale keys. These three sections are part of
//   the 93-key gap flagged during the locale audit — they exist in en.json but
//   are still pending backfill across the other 19 locale files. Until that
//   backfill lands, non-English users will see correctly-structured sentences
//   that fall back to English text for just these specific insights — t()'s
//   built-in fallback handles this gracefully, nothing breaks.
//
//   KNOWN GAP — two rare edge-case strings have no dedicated locale key and
//   stay English-only everywhere (flagged inline at point of use):
//     1. "{count} hashtags found but no tags to align with" — only reachable
//        when a video has hashtags but zero tags.
//     2. "the flagged issues" — fallback noun phrase only reachable if the
//        average-tier gaps array is somehow empty.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

import { t } from './i18n.js';

// ─── SCORING CONSTANTS ────────────────────────────────────────────────────────

const MAX_COMPONENT = 25;    // maximum points per component
const MAX_SCORE     = 100;   // total maximum

/** Ideal tail distribution percentages for YouTube SEO */
const IDEAL_DISTRIBUTION = Object.freeze({
  short: 0.20,   // 1-word tags: broad reach, high competition
  mid:   0.40,   // 2-word tags: balanced
  long:  0.40,   // 3+-word tags: specific, lower competition
});

/** Maximum possible sum of deviations from ideal distribution (for normalisation) */
const MAX_DISTRIBUTION_DEVIATION = 1.6;

/** Budget sweet spot range — full 25 points awarded within this window */
const BUDGET_SWEET_SPOT_LOW  = 0.80;
const BUDGET_SWEET_SPOT_HIGH = 0.95;

/** Word concentration threshold — penalise when top word > this share of all words */
const CONCENTRATION_PENALTY_THRESHOLD = 0.30;

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMARY EXPORT — MAIN SCORE CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute the full health score object for a set of tags.
 *
 * @param {string[]} tags      — raw tag array from the backend
 * @param {TagStats} tagStats  — pre-computed stats from parser.js computeTagStats()
 * @param {string[]} hashtags  — hashtags extracted from video description
 * @returns {HealthScore}
 */
export function computeHealthScore(tags, tagStats, hashtags) {
  // ── Guard: empty tag array ────────────────────────────────────────────────
  if (!Array.isArray(tags) || tags.length === 0) {
    return buildZeroScore();
  }

  const ht = Array.isArray(hashtags) ? hashtags : [];

  // ── Score each component ──────────────────────────────────────────────────
  const budgetComponent      = scoreBudget(tagStats);
  const tailComponent        = scoreTailDistribution(tagStats);
  const diversityComponent   = scoreDiversity(tags, tagStats);
  const hashtagComponent     = scoreHashtagAlignment(tags, ht);

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const overall = Math.min(
    MAX_SCORE,
    Math.max(0,
      budgetComponent.score +
      tailComponent.score   +
      diversityComponent.score +
      hashtagComponent.score
    )
  );

  const label   = getScoreLabel(overall);
  const grade   = getScoreGrade(overall);
  const summary = buildSummary(overall, budgetComponent, tailComponent, diversityComponent, hashtagComponent);

  // ── Rank suggestions by potential gain (highest first) ───────────────────
  const suggestions = buildSuggestions(
    budgetComponent,
    tailComponent,
    diversityComponent,
    hashtagComponent,
    tagStats,
    ht
  ).sort((a, b) => b.potentialGain - a.potentialGain);

  return {
    overall,
    label,
    grade,
    summary,
    components: {
      budget:            budgetComponent,
      tailDistribution:  tailComponent,
      diversity:         diversityComponent,
      hashtagAlignment:  hashtagComponent,
    },
    suggestions,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT 1 — BUDGET EFFICIENCY (25 points)
//
// Scoring logic:
//   Over 100% (truncated) → 0 pts    (hard penalty — tags are silently ignored)
//   0%                   → 0 pts    (no tags)
//   1–29%                → 1–4 pts  (severely under-tagged)
//   30–59%               → 5–14 pts (under-tagged)
//   60–79%               → 15–21 pts (leaving budget on the table)
//   80–95%               → 22–25 pts (sweet spot — full score at 87.5%)
//   96–100%              → 18–21 pts (slightly over-packed, minor efficiency loss)
// ═══════════════════════════════════════════════════════════════════════════════

function scoreBudget(tagStats) {
  const { charUsed, charPct, overLimit, charRemaining, total } = tagStats;

  // ── Hard penalty: over the 500-char limit ─────────────────────────────────
  if (overLimit) {
    return {
      score:    0,
      maxScore: MAX_COMPONENT,
      pct:      0,
      label:    t('budget_labels.over_limit'),
      insight:  t('health_insights.budget_over', { over: Math.abs(charRemaining) }),
      charUsed,
      charPct,
      overLimit,
    };
  }

  // ── Zero tags (defensive — unreachable in practice since computeHealthScore
  //    already short-circuits to buildZeroScore() before tagStats is built
  //    from an empty array) ───────────────────────────────────────────────────
  if (total === 0 || charPct === 0) {
    return {
      score: 0, maxScore: MAX_COMPONENT, pct: 0,
      label: t('budget_labels.no_tags'), insight: t('tags_panel.no_tags_default'),
      charUsed: 0, charPct: 0, overLimit: false,
    };
  }

  // ── Piecewise linear score ────────────────────────────────────────────────
  let score;

  if (charPct >= BUDGET_SWEET_SPOT_LOW && charPct <= BUDGET_SWEET_SPOT_HIGH) {
    // Sweet spot: full score, interpolated to peak at 87.5%
    const distFromPeak = Math.abs(charPct - 0.875);
    score = Math.round(25 - distFromPeak * 20);
    score = Math.min(25, Math.max(22, score));

  } else if (charPct > BUDGET_SWEET_SPOT_HIGH && charPct <= 1.0) {
    // Over-packed: 96–100% → interpolate 21 → 18
    score = Math.round(21 - ((charPct - BUDGET_SWEET_SPOT_HIGH) / 0.05) * 3);

  } else if (charPct >= 0.60) {
    // Good range: 60–79% → interpolate 15 → 21
    score = Math.round(15 + ((charPct - 0.60) / 0.20) * 6);

  } else if (charPct >= 0.30) {
    // Under-tagged: 30–59% → interpolate 5 → 14
    score = Math.round(5 + ((charPct - 0.30) / 0.30) * 9);

  } else {
    // Severely under-tagged: 1–29% → interpolate 1 → 4
    score = Math.max(1, Math.round((charPct / 0.30) * 4));
  }

  score = Math.min(MAX_COMPONENT, Math.max(0, score));

  // ── Build insight text ────────────────────────────────────────────────────
  let insight;
  if (charPct >= BUDGET_SWEET_SPOT_LOW && charPct <= BUDGET_SWEET_SPOT_HIGH) {
    insight = t('health_insights.budget_optimal', { used: charUsed, pct: Math.round(charPct * 100) });
  } else if (charPct > BUDGET_SWEET_SPOT_HIGH) {
    insight = t('health_insights.budget_over_packed', { pct: Math.round(charPct * 100), remaining: charRemaining });
  } else if (charPct >= 0.60) {
    insight = t('health_insights.budget_good', { remaining: charRemaining });
  } else if (charPct >= 0.30) {
    insight = t('health_insights.budget_under', { pct: Math.round(charPct * 100) });
  } else {
    insight = t('health_insights.budget_severe', { used: charUsed });
  }

  return {
    score,
    maxScore: MAX_COMPONENT,
    pct:      score / MAX_COMPONENT,
    label:    getBudgetLabel(charPct, overLimit),
    insight,
    charUsed,
    charPct,
    charRemaining,
    overLimit,
  };
}

function getBudgetLabel(charPct, overLimit) {
  if (overLimit)        return t('budget_labels.over_limit');
  if (charPct >= 0.80)  return t('budget_labels.optimal');
  if (charPct >= 0.60)  return t('budget_labels.good');
  if (charPct >= 0.30)  return t('budget_labels.under_used');
  return t('budget_labels.severely_under');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT 2 — TAIL DISTRIBUTION (25 points)
//
// Compares actual short/mid/long-tail distribution against the ideal ratio.
// Uses sum-of-absolute-deviations, normalised to 0–1, then inverted for score.
//
// Adjustments for small tag counts (< 5 tags):
// Distribution analysis is unreliable with fewer than 5 data points.
// Cap the maximum achievable score at 10 for very small sets.
// ═══════════════════════════════════════════════════════════════════════════════

function scoreTailDistribution(tagStats) {
  const {
    total, shortTailCount, midTailCount, longTailCount,
    shortTailPct, midTailPct, longTailPct,
  } = tagStats;

  if (total === 0) {
    return {
      score: 0, maxScore: MAX_COMPONENT, pct: 0,
      label: t('distribution_labels.no_data'),
      insight: t('tags_panel.no_tags_default'),
      actual: { short: 0, mid: 0, long: 0 },
      ideal: IDEAL_DISTRIBUTION,
    };
  }

  // ── Sum of absolute deviations from ideal ─────────────────────────────────
  const deviationShort = Math.abs(shortTailPct - IDEAL_DISTRIBUTION.short);
  const deviationMid   = Math.abs(midTailPct   - IDEAL_DISTRIBUTION.mid);
  const deviationLong  = Math.abs(longTailPct  - IDEAL_DISTRIBUTION.long);
  const totalDeviation = deviationShort + deviationMid + deviationLong;

  // Normalise to 0–1 (0 = perfect, 1 = maximally wrong)
  const normalised = Math.min(1, totalDeviation / MAX_DISTRIBUTION_DEVIATION);

  // Convert to score (0 = 0 pts, 1 = 25 pts on the scale)
  let score = Math.round(MAX_COMPONENT * (1 - normalised));

  // ── Small dataset cap ────────────────────────────────────────────────────
  if (total < 5)  score = Math.min(score, 10);
  else if (total < 10) score = Math.min(score, 20);

  score = Math.min(MAX_COMPONENT, Math.max(0, score));

  // ── Build insight ─────────────────────────────────────────────────────────
  const actual = {
    short: shortTailPct,
    mid:   midTailPct,
    long:  longTailPct,
  };

  const insight = buildDistributionInsight(
    shortTailCount, midTailCount, longTailCount,
    shortTailPct, midTailPct, longTailPct,
    total
  );

  return {
    score,
    maxScore: MAX_COMPONENT,
    pct:      score / MAX_COMPONENT,
    label:    getDistributionLabel(score),
    insight,
    actual,
    ideal:    IDEAL_DISTRIBUTION,
    counts: { short: shortTailCount, mid: midTailCount, long: longTailCount },
  };
}

function getDistributionLabel(score) {
  if (score >= 20) return t('distribution_labels.well_balanced');
  if (score >= 14) return t('distribution_labels.fairly_balanced');
  if (score >= 8)  return t('distribution_labels.uneven');
  return t('distribution_labels.heavily_skewed');
}

function buildDistributionInsight(sc, mc, lc, sp, mp, lp, total) {
  // Detect the dominant skew
  if (sp > 0.50) {
    return t('health_insights.tail_too_short', { pct: Math.round(sp * 100) });
  }
  if (lp > 0.70) {
    return t('health_insights.tail_too_long', { pct: Math.round(lp * 100) });
  }
  if (mp > 0.70) {
    return t('health_insights.tail_too_mid', { pct: Math.round(mp * 100) });
  }
  if (total < 5) {
    return t('health_insights.tail_few', { count: total });
  }
  // Balanced
  return t('health_insights.tail_balanced', { short: sc, mid: mc, long: lc });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT 3 — WORD DIVERSITY (25 points)
//
// Two metrics combined:
//   A) Word diversity ratio: unique words / total words  (primary, weight 0.70)
//   B) Keyword concentration: most-common word's share   (penalty, weight 0.30)
//
// Why both? A tag set like:
//   "guitar", "guitar lesson", "guitar tips", "guitar tutorial", "guitar course"
// has a decent diversity ratio (many unique words) but is dominated by "guitar".
// The concentration metric catches this pattern.
// ═══════════════════════════════════════════════════════════════════════════════

function scoreDiversity(tags, tagStats) {
  const { total, uniqueWordCount, totalWordCount, wordDiversityRatio } = tagStats;

  if (total === 0 || totalWordCount === 0) {
    return {
      score: 0, maxScore: MAX_COMPONENT, pct: 0,
      label: t('diversity_labels.no_data'), insight: t('tags_panel.no_tags_default'),
      diversityRatio: 0, concentration: 0, uniqueWordCount: 0,
    };
  }

  // ── A) Base score from word diversity ratio ──────────────────────────────
  // ratio 1.0 → 25 pts, ratio 0.5 → 12 pts, ratio 0.0 → 0 pts
  const baseScore = wordDiversityRatio * MAX_COMPONENT;

  // ── B) Keyword concentration penalty ─────────────────────────────────────
  const concentration = computeKeywordConcentration(tags);

  // Penalty kicks in when one word dominates > threshold of all words
  let concentrationPenalty = 0;
  if (concentration > CONCENTRATION_PENALTY_THRESHOLD) {
    // Scales from 0 at threshold to max 10 pts at 100% concentration
    concentrationPenalty = ((concentration - CONCENTRATION_PENALTY_THRESHOLD)
                         / (1 - CONCENTRATION_PENALTY_THRESHOLD)) * 10;
  }

  // ── Unique word count floor ───────────────────────────────────────────────
  // Very few unique words caps the score regardless of ratio
  let uniquenessCap = MAX_COMPONENT;
  if (uniqueWordCount < 3)  uniquenessCap = 5;
  else if (uniqueWordCount < 6)  uniquenessCap = 12;
  else if (uniqueWordCount < 12) uniquenessCap = 20;

  // ── Combine ───────────────────────────────────────────────────────────────
  let score = Math.round(baseScore - concentrationPenalty);
  score     = Math.min(uniquenessCap, score);
  score     = Math.min(MAX_COMPONENT, Math.max(0, score));

  // ── Bonus: reward genuinely broad vocabulary ───────────────────────────────
  if (uniqueWordCount >= 30 && concentration < 0.20) {
    score = Math.min(MAX_COMPONENT, score + 2);
  }

  const insight = buildDiversityInsight(
    uniqueWordCount, totalWordCount, wordDiversityRatio, concentration, tags
  );

  return {
    score,
    maxScore:       MAX_COMPONENT,
    pct:            score / MAX_COMPONENT,
    label:          getDiversityLabel(score),
    insight,
    diversityRatio: wordDiversityRatio,
    concentration,
    uniqueWordCount,
    totalWordCount,
  };
}

/**
 * Compute what share of all words is the single most-frequent word.
 * Returns 0–1. Higher = more dominated by a single keyword.
 *
 * @param {string[]} tags
 * @returns {number}
 */
function computeKeywordConcentration(tags) {
  const freq = new Map();

  for (const tag of tags) {
    for (const word of tag.toLowerCase().split(/\s+/).filter(Boolean)) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }
  }

  if (freq.size === 0) return 0;

  const totalWords = [...freq.values()].reduce((a, b) => a + b, 0);
  const maxFreq    = Math.max(...freq.values());

  return totalWords > 0 ? maxFreq / totalWords : 0;
}

function getDiversityLabel(score) {
  if (score >= 20) return t('diversity_labels.excellent');
  if (score >= 14) return t('diversity_labels.good');
  if (score >= 8)  return t('diversity_labels.repetitive');
  return t('diversity_labels.very_repetitive');
}

function buildDiversityInsight(uniqueWords, totalWords, ratio, concentration, tags) {
  const pct = Math.round(ratio * 100);

  if (uniqueWords < 5) {
    return t('health_insights.diversity_low_unique', { n: uniqueWords });
  }

  if (concentration > 0.50) {
    // Find the dominant word to name it in the insight
    const freq = new Map();
    for (const tag of tags) {
      for (const word of tag.toLowerCase().split(/\s+/).filter(Boolean)) {
        freq.set(word, (freq.get(word) || 0) + 1);
      }
    }
    const dominant = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return t('health_insights.diversity_concentrated', {
      word: dominant,
      pct:  Math.round(concentration * 100),
    });
  }

  if (concentration > CONCENTRATION_PENALTY_THRESHOLD) {
    return t('health_insights.diversity_moderate', { unique: uniqueWords, total: totalWords, pct });
  }

  if (ratio >= 0.80) {
    return t('health_insights.diversity_strong', { unique: uniqueWords, total: totalWords, pct });
  }

  // Moderate variety, below the "strong" threshold — reuses the same
  // sentence shape as diversity_moderate (the two scenarios read near-
  // identically to a user: "some repetition, try varying vocabulary").
  return t('health_insights.diversity_moderate', { unique: uniqueWords, total: totalWords, pct });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT 4 — HASHTAG ALIGNMENT (25 points)
//
// Measures whether hashtags used in the description also appear as tags.
// YouTube treats hashtags and tags as related but separate signals.
// When a hashtag word also appears as a tag, YouTube's systems see a consistent
// topical signal across two different metadata fields — stronger overall ranking.
//
// Edge cases:
//   No hashtags → neutral 12 pts (not penalised for a valid creator choice)
//   No tags, has hashtags → 0 pts (missed alignment entirely)
//   Perfect alignment → 25 pts
// ═══════════════════════════════════════════════════════════════════════════════

function scoreHashtagAlignment(tags, hashtags) {
  // ── No hashtags: neutral score ────────────────────────────────────────────
  if (hashtags.length === 0) {
    return {
      score:          12,   // neutral — not using hashtags is a valid choice
      maxScore:       MAX_COMPONENT,
      pct:            0.48,
      label:          t('hashtag_labels.no_hashtags'),
      insight:        t('health_insights.hashtag_no_hashtags'),
      alignedCount:   0,
      totalHashtags:  0,
      alignmentRatio: 0,
      missingHashtags: [],
      neutralScore:   true,
    };
  }

  // ── No tags, has hashtags ─────────────────────────────────────────────────
  // NOTE: rare edge case with no dedicated locale key yet — see file header.
  if (tags.length === 0) {
    return {
      score:          0,
      maxScore:       MAX_COMPONENT,
      pct:            0,
      label:          t('hashtag_labels.none'),
      insight:        `${hashtags.length} hashtag${hashtags.length !== 1 ? 's' : ''} found `
                    + `but no tags to align with.`,
      alignedCount:   0,
      totalHashtags:  hashtags.length,
      alignmentRatio: 0,
      missingHashtags: hashtags.map(h => h.replace(/^#/, '')),
      neutralScore:   false,
    };
  }

  // ── Compute alignment ─────────────────────────────────────────────────────
  // Normalise hashtags: strip the # prefix and lowercase
  const hashtagWords = hashtags.map(h => h.replace(/^#/, '').toLowerCase().trim());

  // A hashtag is considered "aligned" if its word appears anywhere in any tag
  // e.g. hashtag #cooking aligns with tag "cooking tips" or "best cooking channel"
  const tagText = tags.map(tg => tg.toLowerCase()).join(' ');

  const aligned = hashtagWords.filter(hw => tagText.includes(hw));
  const missing = hashtagWords.filter(hw => !tagText.includes(hw));

  const alignmentRatio = aligned.length / hashtagWords.length;
  let   score          = Math.round(alignmentRatio * MAX_COMPONENT);

  // Small bonus: perfect alignment on 3+ hashtags is harder and deserves extra
  if (alignmentRatio === 1 && hashtagWords.length >= 3) {
    score = MAX_COMPONENT; // guarantee full score for perfect alignment
  }

  score = Math.min(MAX_COMPONENT, Math.max(0, score));

  // ── Build insight ─────────────────────────────────────────────────────────
  let insight;
  if (alignmentRatio === 1) {
    insight = t('health_insights.hashtag_perfect', { count: hashtagWords.length });
  } else if (alignmentRatio >= 0.5) {
    insight = t('health_insights.hashtag_partial', {
      aligned: aligned.length,
      total:   hashtagWords.length,
      missing: missing.slice(0, 3).map(w => `"${w}"`).join(', '),
    });
  } else if (alignmentRatio > 0) {
    insight = t('health_insights.hashtag_weak', {
      aligned: aligned.length,
      total:   hashtagWords.length,
    });
  } else {
    insight = t('health_insights.hashtag_none_aligned', {
      total:   hashtagWords.length,
      missing: hashtagWords.slice(0, 3).map(w => `"${w}"`).join(', '),
    });
  }

  return {
    score,
    maxScore:        MAX_COMPONENT,
    pct:             score / MAX_COMPONENT,
    label:           getHashtagLabel(alignmentRatio),
    insight,
    alignedCount:    aligned.length,
    totalHashtags:   hashtagWords.length,
    alignmentRatio,
    missingHashtags: missing,
    neutralScore:    false,
  };
}

function getHashtagLabel(ratio) {
  if (ratio === 1)   return t('hashtag_labels.perfect');
  if (ratio >= 0.75) return t('hashtag_labels.strong');
  if (ratio >= 0.50) return t('hashtag_labels.partial');
  if (ratio > 0)     return t('hashtag_labels.weak');
  return t('hashtag_labels.none');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUGGESTIONS BUILDER
// Generates actionable, prioritised suggestions from component results.
// Each suggestion tells the user exactly what to do and estimates the gain.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a ranked list of actionable suggestions from all four component scores.
 *
 * @returns {Suggestion[]}
 */
function buildSuggestions(budget, tail, diversity, hashtag, tagStats, hashtags) {
  const suggestions = [];
  const potentialBudget    = MAX_COMPONENT - budget.score;
  const potentialTail      = MAX_COMPONENT - tail.score;
  const potentialDiversity = MAX_COMPONENT - diversity.score;
  const potentialHashtag   = MAX_COMPONENT - hashtag.score;

  // ── Budget suggestions ────────────────────────────────────────────────────
  if (budget.overLimit) {
    suggestions.push({
      component:    'budget',
      priority:     'critical',
      potentialGain: potentialBudget,
      text: t('health_suggestions.over_budget', { count: tagStats.truncatedTags?.length || 0 }),
      actionLabel: 'View truncated tags',
      data: tagStats.truncatedTags || [],
    });
  } else if (budget.charPct < 0.40) {
    suggestions.push({
      component:    'budget',
      priority:     'high',
      potentialGain: Math.round(potentialBudget * 0.7),
      text: t('health_suggestions.under_budget_severe', {
        pct:       Math.round(budget.charPct * 100),
        remaining: budget.charRemaining,
      }),
      actionLabel: 'Add more tags',
      data: null,
    });
  } else if (budget.charPct < 0.70) {
    suggestions.push({
      component:    'budget',
      priority:     'medium',
      potentialGain: Math.round(potentialBudget * 0.5),
      text: t('health_suggestions.under_budget_moderate', { remaining: budget.charRemaining }),
      actionLabel: 'Expand tag list',
      data: null,
    });
  }

  // ── Tail distribution suggestions ─────────────────────────────────────────
  if (tail.score < 15) {
    const { actual } = tail;

    if (actual.short > 0.50) {
      suggestions.push({
        component:    'tailDistribution',
        priority:     'high',
        potentialGain: Math.round(potentialTail * 0.8),
        text: t('health_suggestions.too_many_short', { pct: Math.round(actual.short * 100) }),
        actionLabel: 'Improve tail balance',
        data: { actual: tail.actual, ideal: IDEAL_DISTRIBUTION },
      });
    } else if (actual.long < 0.20) {
      suggestions.push({
        component:    'tailDistribution',
        priority:     'medium',
        potentialGain: Math.round(potentialTail * 0.6),
        text: t('health_suggestions.not_enough_long', { pct: Math.round(actual.long * 100) }),
        actionLabel: 'Add long-tail tags',
        data: null,
      });
    } else {
      suggestions.push({
        component:    'tailDistribution',
        priority:     'low',
        potentialGain: Math.round(potentialTail * 0.4),
        text: t('health_suggestions.balance_distribution'),
        actionLabel: 'Balance tag types',
        data: { actual: tail.actual, ideal: IDEAL_DISTRIBUTION },
      });
    }
  }

  // ── Diversity suggestions ─────────────────────────────────────────────────
  if (diversity.score < 15) {
    if (diversity.concentration > 0.40) {
      suggestions.push({
        component:    'diversity',
        priority:     'high',
        potentialGain: Math.round(potentialDiversity * 0.7),
        text: t('health_suggestions.high_concentration', { pct: Math.round(diversity.concentration * 100) }),
        actionLabel: 'Diversify vocabulary',
        data: null,
      });
    } else {
      suggestions.push({
        component:    'diversity',
        priority:     'medium',
        potentialGain: Math.round(potentialDiversity * 0.5),
        text: t('health_suggestions.low_diversity', { pct: Math.round(diversity.diversityRatio * 100) }),
        actionLabel: 'Add varied tags',
        data: null,
      });
    }
  }

  // ── Hashtag alignment suggestions ─────────────────────────────────────────
  if (!hashtag.neutralScore && hashtag.missingHashtags?.length > 0) {
    const missing = hashtag.missingHashtags.slice(0, 5);
    suggestions.push({
      component:    'hashtagAlignment',
      priority:     hashtag.alignmentRatio < 0.5 ? 'high' : 'medium',
      potentialGain: Math.round(potentialHashtag * 0.9),
      text: t('health_suggestions.missing_hashtags', {
        count:   hashtag.missingHashtags.length,
        missing: missing.map(w => `"${w}"`).join(', '),
      }),
      actionLabel:  'Add missing hashtag words as tags',
      data:         missing,
    });
  } else if (hashtag.neutralScore) {
    suggestions.push({
      component:    'hashtagAlignment',
      priority:     'low',
      potentialGain: 13,   // max gain from adding hashtags + aligning them
      text: t('health_suggestions.no_hashtags'),
      actionLabel: 'Learn about hashtag alignment',
      data: null,
    });
  }

  // Only return suggestions for components with meaningful gain potential
  return suggestions.filter(s => s.potentialGain >= 2);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY BUILDER
// One or two sentences that synthesise the overall picture.
// ═══════════════════════════════════════════════════════════════════════════════

function buildSummary(overall, budget, tail, diversity, hashtag) {
  if (overall >= 86) {
    return t('health_summaries.excellent');
  }

  if (overall >= 66) {
    // Find the weakest component to highlight
    const weakest = [
      { name: t('health.comp_budget'),    score: budget.score    },
      { name: t('health.comp_tail'),      score: tail.score      },
      { name: t('health.comp_diversity'), score: diversity.score },
      { name: t('health.comp_hashtag'),   score: hashtag.score   },
    ].sort((a, b) => a.score - b.score)[0];

    return t('health_summaries.good', { weakest: weakest.name });
  }

  if (overall >= 41) {
    const gaps = [
      budget.score    < 15 ? t('health.comp_budget')    : null,
      tail.score      < 12 ? t('health.comp_tail')      : null,
      diversity.score < 12 ? t('health.comp_diversity') : null,
      hashtag.score   < 10 && !hashtag.neutralScore ? t('health.comp_hashtag') : null,
    ].filter(Boolean);

    // NOTE: joined with a plain comma rather than an English-style "X, Y and Z"
    // construction — conjunction grammar varies too much across 20 languages
    // to hardcode safely without a dedicated locale-aware list-join helper.
    const gapsText = gaps.length > 0 ? gaps.join(', ') : 'the flagged issues';

    return t('health_summaries.average', { gaps: gapsText });
  }

  return t('health_summaries.weak');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZERO SCORE (returned when no tags exist)
// ═══════════════════════════════════════════════════════════════════════════════

function buildZeroScore() {
  const emptyComponent = (label) => ({
    score: 0, maxScore: MAX_COMPONENT, pct: 0,
    label, insight: t('tags_panel.no_tags_default'),
  });

  return {
    overall:  0,
    label:    t('health.label_no_tags'),
    grade:    t('health.grade_na'),
    summary:  t('health.no_tags_summary'),
    components: {
      budget:           emptyComponent(t('distribution_labels.no_data')),
      tailDistribution: emptyComponent(t('distribution_labels.no_data')),
      diversity:        emptyComponent(t('diversity_labels.no_data')),
      hashtagAlignment: emptyComponent(t('distribution_labels.no_data')),
    },
    suggestions: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTED LABEL AND GRADE HELPERS
// Used by app.js independently of the full score object (e.g., in history rows).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Return a human-readable label for a given overall score.
 *
 * @param {number} score — 0–100
 * @returns {string} translated label
 */
export function getScoreLabel(score) {
  if (score >= 86) return t('health.label_excellent');
  if (score >= 66) return t('health.label_good');
  if (score >= 41) return t('health.label_average');
  if (score >   0) return t('health.label_weak');
  return t('health.label_no_tags');
}

/**
 * Return a letter grade for a given overall score.
 *
 * @param {number} score — 0–100
 * @returns {string} 'A+'|'A'|'B+'|'B'|'C+'|'C'|'D'|'F'|'N/A' (digit/letter grades
 *   are visually identical across locales by design — routed through t() anyway
 *   for architectural consistency and in case a locale ever needs to override).
 */
export function getScoreGrade(score) {
  if (score >= 93) return t('health.grade_a_plus');
  if (score >= 86) return t('health.grade_a');
  if (score >= 76) return t('health.grade_b_plus');
  if (score >= 66) return t('health.grade_b');
  if (score >= 56) return t('health.grade_c_plus');
  if (score >= 41) return t('health.grade_c');
  if (score >= 25) return t('health.grade_d');
  if (score >   0) return t('health.grade_f');
  return t('health.grade_na');
}

/**
 * Return the CSS modifier class suffix for a given score.
 * Used by app.js to apply colour coding: .score-ring--excellent, etc.
 * NOT translated — these are CSS class identifiers, not display text.
 *
 * @param {number} score — 0–100
 * @returns {'excellent'|'good'|'average'|'weak'|'none'}
 */
export function getScoreModifier(score) {
  if (score >= 86) return 'excellent';
  if (score >= 66) return 'good';
  if (score >= 41) return 'average';
  if (score >   0) return 'weak';
  return 'none';
}
