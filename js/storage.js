// ═══════════════════════════════════════════════════════════════════════════════
// YTSPY — PERSISTENT LOCAL STORAGE LAYER
// File: js/storage.js
// Version: 1.0.0
//
// ROLE IN THE SYSTEM:
// storage.js is the single module that reads from and writes to localStorage.
// No other module touches localStorage directly — everything routes through here.
// This makes storage behaviour predictable, testable, and easy to migrate later.
//
// WHAT IS STORED:
//   ytspy_history    — extraction history, newest first, max 50 entries
//   ytspy_templates  — tag template library, unlimited entries
//   ytspy_prefs      — user preferences (mode toggle, section states, etc.)
//   ytspy_version    — storage schema version (for future migrations)
//
// FAILURE STRATEGY:
//   Read operations  → return safe default on any error (never throw)
//   Write operations → silently fail, return false to signal failure
//   Callers          → treat false return as "storage unavailable" gracefully
//
// SCHEMA VERSION: 1
// If storage format ever changes, increment SCHEMA_VERSION and add a migration
// case inside migrateIfNeeded(). Called once on first import by any module.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── STORAGE KEYS ─────────────────────────────────────────────────────────────

const KEYS = Object.freeze({
  HISTORY:   'ytspy_history',
  TEMPLATES: 'ytspy_templates',
  PREFS:     'ytspy_prefs',
  VERSION:   'ytspy_version',
});

// ─── LIMITS ───────────────────────────────────────────────────────────────────

const MAX_HISTORY_ENTRIES = 50;

/** Current schema version. Increment when data shape changes incompatibly. */
const SCHEMA_VERSION = 1;

// ─── DEFAULT VALUES ───────────────────────────────────────────────────────────

/** Returned by getPreferences() when nothing has been stored yet */
const DEFAULT_PREFS = Object.freeze({
  selectedMode: 'both',           // 'both' | 'tags' | 'thumbnails'
  expandedSections: {
    bulk:      false,
    overlap:   false,
    history:   false,
    templates: false,
  },
  lastUsedTemplateId: null,
  hasSeenWelcome:     false,
});

// ─── INITIALISE ON FIRST IMPORT ───────────────────────────────────────────────
// This runs once when any module imports storage.js.
// It is safe to call multiple times (idempotent).
migrateIfNeeded();

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — EXTRACTION HISTORY
// Stores the 50 most recent extractions.
// When a video is re-extracted it moves to the top (no duplicates by videoId).
// Full tag array stored so history entries can be used without re-extraction.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Save an extraction result to history.
 * Moves existing entry to top if the same videoId was extracted before.
 * Evicts the oldest entry when MAX_HISTORY_ENTRIES is exceeded.
 *
 * @param {object} data — enriched video data object from parser.js
 * @returns {boolean} true on success, false on storage failure
 */
export function saveExtraction(data) {
  if (!data?.videoId) return false;

  const history = getHistory();

  const entry = {
    id:          data.videoId,
    title:       (data.title || '').slice(0, 200),     // cap length for storage safety
    channel:     (data.channel || '').slice(0, 100),
    tagCount:    (data.tags || []).length,
    thumbUrl:    data.thumbnails?.hq?.url || '',
    extractedAt: Date.now(),
    tags:        data.tags        || [],
    hashtags:    data.hashtags    || [],
    duration:    data.duration    || '',
    viewCount:   data.viewCount   || 0,
    isShort:     data.isShort     || false,
    isLive:      data.isLive      || false,
  };

  // Remove existing entry for this video (to avoid duplicates)
  const filtered = history.filter(h => h.id !== entry.id);

  // Prepend new entry, enforce max limit (FIFO eviction from tail)
  const updated = [entry, ...filtered].slice(0, MAX_HISTORY_ENTRIES);

  return writeJson(KEYS.HISTORY, updated);
}

/**
 * Return the full history array, newest first.
 *
 * @returns {HistoryEntry[]}
 */
export function getHistory() {
  return readJson(KEYS.HISTORY, []);
}

/**
 * Return a single history entry by video ID, or null if not found.
 *
 * @param {string} videoId
 * @returns {HistoryEntry|null}
 */
export function getHistoryEntry(videoId) {
  return getHistory().find(h => h.id === videoId) || null;
}

/**
 * Remove a single entry from history by video ID.
 *
 * @param {string} videoId
 * @returns {boolean}
 */
export function removeHistoryEntry(videoId) {
  const updated = getHistory().filter(h => h.id !== videoId);
  return writeJson(KEYS.HISTORY, updated);
}

/**
 * Delete all history entries.
 *
 * @returns {boolean}
 */
export function clearHistory() {
  return removeKey(KEYS.HISTORY);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — TAG TEMPLATE LIBRARY
// Named, saveable tag sets. Each template stores the full tag array plus
// metadata. Templates are the primary user lock-in mechanism in ytspy.
//
// Template data shape:
// {
//   id:            string,   — "tpl_1714912345678_abc12" (collision-safe)
//   name:          string,   — "Cooking channel base tags"
//   description:   string,   — optional user note
//   tags:          string[], — the saved tag array
//   createdAt:     number,   — Unix ms timestamp
//   updatedAt:     number,   — Unix ms timestamp
//   usageCount:    number,   — times this template was applied
//   sourceVideoId: string,   — video it was extracted from (if any)
//   sourceTitle:   string,   — title of source video (for reference display)
// }
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create and save a new template.
 *
 * @param {string}   name          — template name (shown in library)
 * @param {string[]} tags          — tag array to save
 * @param {object}   [options]
 * @param {string}   [options.description]   — optional note
 * @param {string}   [options.sourceVideoId] — video ID this came from
 * @param {string}   [options.sourceTitle]   — title of source video
 * @returns {{ success: boolean, id?: string, error?: string }}
 */
export function saveTemplate(name, tags, options = {}) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { success: false, error: 'Template name is required.' };
  }
  if (!Array.isArray(tags) || tags.length === 0) {
    return { success: false, error: 'Cannot save an empty template.' };
  }

  const templates = getTemplates();

  // Warn if name already exists (do not block — allow duplicates)
  // App.js can check for duplicates if it wants to prompt the user
  const id = generateTemplateId();
  const now = Date.now();

  const template = {
    id,
    name:          name.trim().slice(0, 100),
    description:   (options.description || '').slice(0, 500),
    tags:          tags.map(t => String(t).trim()).filter(Boolean),
    createdAt:     now,
    updatedAt:     now,
    usageCount:    0,
    sourceVideoId: options.sourceVideoId || null,
    sourceTitle:   (options.sourceTitle  || '').slice(0, 200),
  };

  const updated = [template, ...templates];
  const ok      = writeJson(KEYS.TEMPLATES, updated);

  return ok
    ? { success: true, id }
    : { success: false, error: 'Storage write failed. Your browser storage may be full.' };
}

/**
 * Return all templates, most recently updated first.
 *
 * @returns {Template[]}
 */
export function getTemplates() {
  const raw = readJson(KEYS.TEMPLATES, []);
  // Sort: most recently updated at top
  return raw.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Return a single template by ID, or null if not found.
 *
 * @param {string} id
 * @returns {Template|null}
 */
export function getTemplate(id) {
  return getTemplates().find(t => t.id === id) || null;
}

/**
 * Update properties of an existing template.
 * Partial update — only the fields you pass are changed.
 *
 * Updatable fields: name, description, tags
 *
 * @param {string} id
 * @param {{ name?: string, description?: string, tags?: string[] }} updates
 * @returns {boolean}
 */
export function updateTemplate(id, updates) {
  const templates = getTemplates();
  const index     = templates.findIndex(t => t.id === id);

  if (index === -1) return false;

  const existing = templates[index];
  const updated  = {
    ...existing,
    updatedAt: Date.now(),
  };

  if (updates.name !== undefined) {
    updated.name = String(updates.name).trim().slice(0, 100);
  }
  if (updates.description !== undefined) {
    updated.description = String(updates.description).slice(0, 500);
  }
  if (Array.isArray(updates.tags)) {
    updated.tags = updates.tags.map(t => String(t).trim()).filter(Boolean);
  }

  templates[index] = updated;
  return writeJson(KEYS.TEMPLATES, templates);
}

/**
 * Increment usageCount for a template and update its updatedAt timestamp.
 * Called by app.js whenever a user applies a template.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function incrementTemplateUsage(id) {
  const templates = getTemplates();
  const index     = templates.findIndex(t => t.id === id);

  if (index === -1) return false;

  templates[index] = {
    ...templates[index],
    usageCount: (templates[index].usageCount || 0) + 1,
    updatedAt:  Date.now(),
  };

  return writeJson(KEYS.TEMPLATES, templates);
}

/**
 * Delete a template by ID.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function deleteTemplate(id) {
  const updated = getTemplates().filter(t => t.id !== id);
  return writeJson(KEYS.TEMPLATES, updated);
}

/**
 * Delete all templates.
 *
 * @returns {boolean}
 */
export function clearTemplates() {
  return removeKey(KEYS.TEMPLATES);
}

/**
 * Export all templates as a JSON string (for file download).
 * The exported format is portable — can be imported on another browser/device.
 *
 * @returns {string} — JSON string, or empty string on failure
 */
export function exportTemplates() {
  const templates = getTemplates();
  if (!templates.length) return '';

  const exportData = {
    exportedAt:    new Date().toISOString(),
    exportVersion: SCHEMA_VERSION,
    templateCount: templates.length,
    templates,
  };

  try {
    return JSON.stringify(exportData, null, 2);
  } catch {
    return '';
  }
}

/**
 * Import templates from a JSON string (result of exportTemplates()).
 * Merges with existing templates — no duplicates by ID.
 * Templates with the same ID are skipped (existing takes priority).
 *
 * @param {string} jsonStr
 * @returns {{ success: boolean, imported: number, skipped: number, error?: string }}
 */
export function importTemplates(jsonStr) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { success: false, imported: 0, skipped: 0, error: 'Invalid JSON format.' };
  }

  // Accept both the envelope format and a raw array
  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.templates)
    ? parsed.templates
    : null;

  if (!incoming) {
    return { success: false, imported: 0, skipped: 0, error: 'No template data found in file.' };
  }

  const existing    = getTemplates();
  const existingIds = new Set(existing.map(t => t.id));

  let imported = 0;
  let skipped  = 0;
  const toAdd  = [];

  for (const tpl of incoming) {
    // Validate minimum required fields
    if (!tpl.id || !Array.isArray(tpl.tags) || !tpl.name) {
      skipped++;
      continue;
    }
    if (existingIds.has(tpl.id)) {
      skipped++;
      continue;
    }
    // Sanitise imported data
    toAdd.push({
      id:            String(tpl.id),
      name:          String(tpl.name || 'Imported Template').slice(0, 100),
      description:   String(tpl.description || '').slice(0, 500),
      tags:          tpl.tags.map(t => String(t).trim()).filter(Boolean),
      createdAt:     Number(tpl.createdAt) || Date.now(),
      updatedAt:     Date.now(),
      usageCount:    Number(tpl.usageCount) || 0,
      sourceVideoId: tpl.sourceVideoId || null,
      sourceTitle:   String(tpl.sourceTitle || '').slice(0, 200),
    });
    imported++;
  }

  if (toAdd.length > 0) {
    const updated = [...existing, ...toAdd];
    const ok      = writeJson(KEYS.TEMPLATES, updated);
    if (!ok) {
      return { success: false, imported: 0, skipped, error: 'Storage write failed.' };
    }
  }

  return { success: true, imported, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — USER PREFERENCES
// Thin key-value store for UI state that should persist across sessions.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Return the full preferences object, merged with defaults for missing keys.
 *
 * @returns {Preferences}
 */
export function getPreferences() {
  const stored = readJson(KEYS.PREFS, {});
  return {
    ...DEFAULT_PREFS,
    ...stored,
    // Deep merge expandedSections so missing keys get defaults
    expandedSections: {
      ...DEFAULT_PREFS.expandedSections,
      ...(stored.expandedSections || {}),
    },
  };
}

/**
 * Update a single top-level preference key.
 *
 * @param {string} key   — must be a known key in DEFAULT_PREFS
 * @param {*}      value
 * @returns {boolean}
 */
export function savePreference(key, value) {
  if (!(key in DEFAULT_PREFS)) return false;
  const current = getPreferences();
  current[key]  = value;
  return writeJson(KEYS.PREFS, current);
}

/**
 * Save the selected tool mode (persists across page reloads).
 *
 * @param {'both'|'tags'|'thumbnails'} mode
 * @returns {boolean}
 */
export function saveSelectedMode(mode) {
  const valid = ['both', 'tags', 'thumbnails'];
  if (!valid.includes(mode)) return false;
  return savePreference('selectedMode', mode);
}

/**
 * Get the currently saved tool mode.
 *
 * @returns {'both'|'tags'|'thumbnails'}
 */
export function getSelectedMode() {
  return getPreferences().selectedMode;
}

/**
 * Save the expand/collapse state of a named section.
 *
 * @param {'bulk'|'overlap'|'history'|'templates'} sectionId
 * @param {boolean} isExpanded
 * @returns {boolean}
 */
export function saveSectionState(sectionId, isExpanded) {
  const prefs = getPreferences();
  if (!(sectionId in DEFAULT_PREFS.expandedSections)) return false;
  prefs.expandedSections[sectionId] = Boolean(isExpanded);
  return writeJson(KEYS.PREFS, prefs);
}

/**
 * Get the expand/collapse state of a named section.
 *
 * @param {'bulk'|'overlap'|'history'|'templates'} sectionId
 * @returns {boolean}
 */
export function getSectionState(sectionId) {
  const prefs = getPreferences();
  return prefs.expandedSections[sectionId] ?? false;
}

/**
 * Save the ID of the most recently applied template.
 * Lets app.js highlight the last-used template in the library UI.
 *
 * @param {string|null} id
 * @returns {boolean}
 */
export function saveLastUsedTemplate(id) {
  return savePreference('lastUsedTemplateId', id);
}

/**
 * Mark that the user has dismissed the welcome/onboarding message.
 *
 * @returns {boolean}
 */
export function markWelcomeSeen() {
  return savePreference('hasSeenWelcome', true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — STORAGE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check whether localStorage is accessible in the current browser context.
 * Returns false in private/incognito mode with storage disabled, or when
 * localStorage is disabled by browser policy.
 *
 * @returns {boolean}
 */
export function isStorageAvailable() {
  try {
    const testKey = '__ytspy_test__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Estimate total localStorage space consumed by ytspy keys.
 * localStorage uses UTF-16 internally (~2 bytes per character).
 *
 * @returns {{ bytes: number, kb: number, formattedString: string }}
 */
export function getStorageUsage() {
  let totalChars = 0;

  for (const key of Object.values(KEYS)) {
    try {
      const val = localStorage.getItem(key);
      if (val) totalChars += key.length + val.length;
    } catch { /* ignore */ }
  }

  const bytes = totalChars * 2; // UTF-16 approximation
  const kb    = Math.round(bytes / 1024 * 10) / 10;

  let formattedString;
  if (bytes < 1024)         formattedString = `${bytes} B`;
  else if (bytes < 102_400) formattedString = `${kb} KB`;
  else                      formattedString = `${(kb / 1024).toFixed(2)} MB`;

  return { bytes, kb, formattedString };
}

/**
 * Return a summary object for debugging storage state.
 * Useful for the browser console during development.
 *
 * @returns {object}
 */
export function getStorageDebugInfo() {
  return {
    available:     isStorageAvailable(),
    schemaVersion: SCHEMA_VERSION,
    historyCount:  getHistory().length,
    templateCount: getTemplates().length,
    prefs:         getPreferences(),
    usage:         getStorageUsage(),
  };
}

/**
 * Wipe ALL ytspy data from localStorage.
 * Called from a "Reset all data" option (not exposed in primary UI).
 *
 * @returns {boolean}
 */
export function clearAllData() {
  const results = Object.values(KEYS).map(key => removeKey(key));
  return results.every(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — SCHEMA MIGRATION
// Called once on module initialisation. Handles forward migrations only.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check stored schema version and apply any needed migrations.
 * Idempotent — safe to call multiple times.
 */
function migrateIfNeeded() {
  try {
    const stored = parseInt(localStorage.getItem(KEYS.VERSION) || '0', 10);

    if (stored >= SCHEMA_VERSION) return; // already up to date

    // ── Migration: 0 → 1 (initial schema) ───────────────────────────────────
    // No data to migrate — first version. Just write the version key.
    if (stored < 1) {
      // Nothing to migrate from pre-version storage — it was a different tool.
      // Clear any stale keys from the original blueprint version to avoid
      // shape mismatches (original used different key structures).
      safeRemove('ytspy_history'); // will be re-created fresh in v1 format
      // Note: only clear if format was incompatible. In this case it was.
    }

    // Future migrations would be added as additional if (stored < N) blocks:
    // if (stored < 2) { /* migrate v1 → v2 */ }
    // if (stored < 3) { /* migrate v2 → v3 */ }

    // Write current version
    localStorage.setItem(KEYS.VERSION, String(SCHEMA_VERSION));

  } catch {
    // localStorage unavailable — migration skipped silently.
    // All read operations will return defaults; writes will fail silently.
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS — NOT EXPORTED
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read and JSON-parse a localStorage key.
 * Returns defaultValue on any failure (missing key, parse error, unavailable).
 *
 * @template T
 * @param {string} key
 * @param {T}      defaultValue
 * @returns {T}
 */
function readJson(key, defaultValue) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

/**
 * JSON-stringify and write a value to a localStorage key.
 * Returns false on any failure (quota exceeded, unavailable, circular ref).
 *
 * @param {string} key
 * @param {*}      value
 * @returns {boolean}
 */
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a localStorage key. Returns true even if key did not exist.
 *
 * @param {string} key
 * @returns {boolean}
 */
function removeKey(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safe remove — identical to removeKey but named for clarity inside migration.
 *
 * @param {string} key
 */
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/**
 * Generate a collision-safe template ID.
 * Format: tpl_ + timestamp (ms) + 5 random base-36 chars
 * Collision probability at 1000 templates: effectively zero.
 *
 * @returns {string}
 */
function generateTemplateId() {
  const rand = Math.random().toString(36).slice(2, 7);
  return `tpl_${Date.now()}_${rand}`;
}
