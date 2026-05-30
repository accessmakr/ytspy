// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — TAG HEALTH SCORE ENGINE
// File: js/health.js
// Version: 1.0.0
//
// ROLE IN THE SYSTEM:
// health.js is a pure computation module. It accepts tag data and pre-computed
// statistics from parser.js, then produces a structured score object that app.js
// renders in the health score panel.
//
// It has zero dependencies on any other ytspy module.
// It makes no network calls, touches no DOM, writes nothing to storage.
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
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

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
      label:    'Over limit',
      insight:  `Tag budget exceeded by ${Math.abs(charRemaining)} characters. `
               + `YouTube silently truncates tags from the end of your list. `
               + `Remove the highlighted tags to fix this.`,
      charUsed,
      charPct,
      overLimit,
    };
  }

  // ── Zero tags ─────────────────────────────────────────────────────────────
  if (total === 0 || charPct === 0) {
    return {
      score: 0, maxScore: MAX_COMPONENT, pct: 0,
      label: 'No tags', insight: 'No tags to evaluate.',
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
    insight = `Excellent use of the tag budget — ${charUsed} of 500 characters (${Math.round(charPct * 100)}%). `
            + `This is the optimal range.`;
  } else if (charPct > BUDGET_SWEET_SPOT_HIGH) {
    insight = `Tag budget is very full at ${Math.round(charPct * 100)}%. `
            + `${charRemaining} characters remain — consider whether all tags add value.`;
  } else if (charPct >= 0.60) {
    insight = `${charRemaining} characters remaining. Good usage — consider adding 1–2 more descriptive long-tail tags.`;
  } else if (charPct >= 0.30) {
    insight = `Only ${Math.round(charPct * 100)}% of the 500-character budget is used. `
            + `Adding more specific long-tail tags would improve discoverability.`;
  } else {
    insight = `Significantly under-tagged — only ${charUsed} of 500 characters used. `
            + `More tags create more potential discovery pathways.`;
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
  if (overLimit)                       return 'Over limit';
  if (charPct >= 0.80)                 return 'Optimal';
  if (charPct >= 0.60)                 return 'Good';
  if (charPct >= 0.30)                 return 'Under-used';
  return 'Severely under-used';
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
      label: 'No data',
      insight: 'No tags to evaluate.',
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
  if (score >= 20) return 'Well balanced';
  if (score >= 14) return 'Fairly balanced';
  if (score >= 8)  return 'Uneven';
  return 'Heavily skewed';
}

function buildDistributionInsight(sc, mc, lc, sp, mp, lp, total) {
  // Detect the dominant skew
  if (sp > 0.50) {
    return `${Math.round(sp * 100)}% of tags are single-word (short-tail). `
          + `These are highly competitive. Adding more mid and long-tail tags `
          + `(2+ words) targets more specific searches with less competition.`;
  }
  if (lp > 0.70) {
    return `${Math.round(lp * 100)}% of tags are long-tail (3+ words). `
          + `While specific, adding some shorter 1–2 word tags improves broad discoverability.`;
  }
  if (mp > 0.70) {
    return `${Math.round(mp * 100)}% of tags are mid-tail (2 words). `
          + `Consider adding a few single-word broad tags and some 3+ word specific tags.`;
  }
  if (total < 5) {
    return `Only ${total} tags — too few to analyse distribution meaningfully. `
          + `Aim for at least 8–12 tags across all three types.`;
  }
  // Balanced
  return `${sc} short-tail, ${mc} mid-tail, ${lc} long-tail tags. `
        + `Distribution is ${sp >= 0.15 && lp >= 0.30 ? 'well' : 'reasonably'} balanced.`;
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
      label: 'No data', insight: 'No tags to evaluate.',
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
  if (score >= 20) return 'Excellent variety';
  if (score >= 14) return 'Good variety';
  if (score >= 8)  return 'Repetitive';
  return 'Very repetitive';
}

function buildDiversityInsight(uniqueWords, totalWords, ratio, concentration, tags) {
  const pct = Math.round(ratio * 100);

  if (uniqueWords < 5) {
    return `Only ${uniqueWords} unique words across all tags — very repetitive. `
          + `Each tag should introduce new vocabulary to cover different search queries.`;
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
    return `The word "${dominant}" appears in over ${Math.round(concentration * 100)}% of all tag words. `
          + `Diversify by adding tags that don't rely on this keyword.`;
  }

  if (concentration > CONCENTRATION_PENALTY_THRESHOLD) {
    return `${uniqueWords} unique words across ${totalWords} total (${pct}% diversity ratio). `
          + `A few keywords repeat heavily — try adding tags with different vocabulary.`;
  }

  if (ratio >= 0.80) {
    return `Strong vocabulary variety — ${uniqueWords} unique words out of ${totalWords} total (${pct}%). `
          + `Each tag is introducing new search territory.`;
  }

  return `${uniqueWords} unique words out of ${totalWords} total (${pct}% diversity). `
        + `Moderate variety — adding tags with different vocabulary would improve coverage.`;
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
      label:          'No hashtags',
      insight:        'This video has no hashtags in the description. '
                    + 'Adding 2–3 relevant hashtags that also appear in your tags '
                    + 'can strengthen topical signals.',
      alignedCount:   0,
      totalHashtags:  0,
      alignmentRatio: 0,
      missingHashtags: [],
      neutralScore:   true,
    };
  }

  // ── No tags, has hashtags ─────────────────────────────────────────────────
  if (tags.length === 0) {
    return {
      score:          0,
      maxScore:       MAX_COMPONENT,
      pct:            0,
      label:          'No alignment',
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
  const tagText = tags.map(t => t.toLowerCase()).join(' ');

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
    insight = `All ${hashtagWords.length} hashtag${hashtagWords.length !== 1 ? 's' : ''} `
            + `appear in the tag list — perfect alignment.`;
  } else if (alignmentRatio >= 0.5) {
    insight = `${aligned.length} of ${hashtagWords.length} hashtags appear in the tags. `
            + `Consider adding: ${missing.slice(0, 3).map(w => `"${w}"`).join(', ')}.`;
  } else if (alignmentRatio > 0) {
    insight = `Only ${aligned.length} of ${hashtagWords.length} hashtags appear in the tags. `
            + `Adding the missing hashtag words as tags would strengthen topical consistency.`;
  } else {
    insight = `None of the ${hashtagWords.length} hashtag${hashtagWords.length !== 1 ? 's' : ''} `
            + `appear in the tag list. These are a missed opportunity: `
            + `${hashtagWords.slice(0, 3).map(w => `"${w}"`).join(', ')}.`;
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
  if (ratio === 1)   return 'Perfect alignment';
  if (ratio >= 0.75) return 'Strong alignment';
  if (ratio >= 0.50) return 'Partial alignment';
  if (ratio > 0)     return 'Weak alignment';
  return 'No alignment';
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
      text: `Remove or shorten tags to get below the 500-character limit. `
           + `${tagStats.truncatedTags?.length || 0} tags are currently being ignored by YouTube.`,
      actionLabel: 'View truncated tags',
      data: tagStats.truncatedTags || [],
    });
  } else if (budget.charPct < 0.40) {
    suggestions.push({
      component:    'budget',
      priority:     'high',
      potentialGain: Math.round(potentialBudget * 0.7),
      text: `Only ${Math.round(budget.charPct * 100)}% of the 500-character tag budget is used. `
           + `Add more specific long-tail tags (3+ words) to fill the remaining ${budget.charRemaining} characters.`,
      actionLabel: 'Add more tags',
      data: null,
    });
  } else if (budget.charPct < 0.70) {
    suggestions.push({
      component:    'budget',
      priority:     'medium',
      potentialGain: Math.round(potentialBudget * 0.5),
      text: `${budget.charRemaining} characters remain in the tag budget. `
           + `There is room for 1–3 more descriptive tags.`,
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
        text: `${Math.round(actual.short * 100)}% of tags are single-word — highly competitive. `
             + `Add 2-word and 3+-word tags to target less competitive, more specific searches.`,
        actionLabel: 'Improve tail balance',
        data: { actual: tail.actual, ideal: IDEAL_DISTRIBUTION },
      });
    } else if (actual.long < 0.20) {
      suggestions.push({
        component:    'tailDistribution',
        priority:     'medium',
        potentialGain: Math.round(potentialTail * 0.6),
        text: `Only ${Math.round(actual.long * 100)}% of tags are long-tail (3+ words). `
             + `Long-tail tags have less competition and convert better. Aim for ~40%.`,
        actionLabel: 'Add long-tail tags',
        data: null,
      });
    } else {
      suggestions.push({
        component:    'tailDistribution',
        priority:     'low',
        potentialGain: Math.round(potentialTail * 0.4),
        text: `Tag distribution could be more balanced. `
             + `Ideal: ~20% single-word, ~40% two-word, ~40% three-or-more-word tags.`,
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
        text: `One keyword dominates ${Math.round(diversity.concentration * 100)}% of all tag words. `
             + `Add tags that introduce completely different vocabulary to cover more search queries.`,
        actionLabel: 'Diversify vocabulary',
        data: null,
      });
    } else {
      suggestions.push({
        component:    'diversity',
        priority:     'medium',
        potentialGain: Math.round(potentialDiversity * 0.5),
        text: `Word diversity is below average (${Math.round(diversity.diversityRatio * 100)}% unique). `
             + `Tags are repeating vocabulary. Try adding tags that cover adjacent topics.`,
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
      text: `${hashtag.missingHashtags.length} hashtag${hashtag.missingHashtags.length !== 1 ? 's' : ''} `
           + `from the description don't appear in the tags: `
           + `${missing.map(w => `"${w}"`).join(', ')}.`,
      actionLabel:  'Add missing hashtag words as tags',
      data:         missing,
    });
  } else if (hashtag.neutralScore) {
    suggestions.push({
      component:    'hashtagAlignment',
      priority:     'low',
      potentialGain: 13,   // max gain from adding hashtags + aligning them
      text: 'No hashtags found in the description. Adding 2–3 relevant hashtags that also '
           + 'appear in your tag list can strengthen your video\'s topical signals.',
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
    return 'Excellent tag strategy. This video is well optimised for discovery across all four dimensions.';
  }

  if (overall >= 66) {
    // Find the weakest component to highlight
    const weakest = [
      { name: 'budget efficiency',  score: budget.score    },
      { name: 'tag distribution',   score: tail.score      },
      { name: 'vocabulary variety', score: diversity.score },
      { name: 'hashtag alignment',  score: hashtag.score   },
    ].sort((a, b) => a.score - b.score)[0];

    return `Good overall tag strategy. The main area to improve is ${weakest.name}, `
          + `which would push this video into excellent territory.`;
  }

  if (overall >= 41) {
    const gaps = [
      budget.score    < 15 ? 'tag budget usage' : null,
      tail.score      < 12 ? 'tail distribution' : null,
      diversity.score < 12 ? 'vocabulary variety' : null,
      hashtag.score   < 10 && !hashtag.neutralScore ? 'hashtag alignment' : null,
    ].filter(Boolean);

    return `Average tag strategy. Addressing ${gaps.length > 1 ? gaps.slice(0, -1).join(', ') + ' and ' + gaps[gaps.length - 1] : gaps[0] || 'the flagged issues'} `
          + `would meaningfully improve this video's discoverability.`;
  }

  return 'Weak tag strategy with significant gaps across multiple dimensions. '
        + 'Review the suggestions below to identify the highest-impact improvements.';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZERO SCORE (returned when no tags exist)
// ═══════════════════════════════════════════════════════════════════════════════

function buildZeroScore() {
  const emptyComponent = (label) => ({
    score: 0, maxScore: MAX_COMPONENT, pct: 0,
    label, insight: 'No tags to evaluate.',
  });

  return {
    overall:  0,
    label:    'No tags',
    grade:    'N/A',
    summary:  'No tags were found for this video. The creator may not have added tags, '
            + 'or they may be unavailable for this video type.',
    components: {
      budget:           emptyComponent('No data'),
      tailDistribution: emptyComponent('No data'),
      diversity:        emptyComponent('No data'),
      hashtagAlignment: emptyComponent('No data'),
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
 * @returns {'Excellent'|'Good'|'Average'|'Weak'|'No tags'}
 */
export function getScoreLabel(score) {
  if (score >= 86) return 'Excellent';
  if (score >= 66) return 'Good';
  if (score >= 41) return 'Average';
  if (score >   0) return 'Weak';
  return 'No tags';
}

/**
 * Return a letter grade for a given overall score.
 *
 * @param {number} score — 0–100
 * @returns {'A+'|'A'|'B'|'C'|'D'|'F'|'N/A'}
 */
export function getScoreGrade(score) {
  if (score >= 93) return 'A+';
  if (score >= 86) return 'A';
  if (score >= 76) return 'B+';
  if (score >= 66) return 'B';
  if (score >= 56) return 'C+';
  if (score >= 41) return 'C';
  if (score >= 25) return 'D';
  if (score >   0) return 'F';
  return 'N/A';
}

/**
 * Return the CSS modifier class suffix for a given score.
 * Used by app.js to apply colour coding: .score-ring--excellent, etc.
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
