import { createHash } from 'node:crypto';
import { ContentError } from './errors.js';
import { KeyPaths, Locales, Placeholders } from './rules.js';

/** @typedef {import('../store/content-store.js').ContentStore} ContentStore */
/** @typedef {import('../store/release-store.js').ReleaseStore} ReleaseStore */
/** @typedef {import('../types.js').NamespaceRow} NamespaceRow */
/** @typedef {import('../types.js').ReleaseContent} ReleaseContent */
/** @typedef {import('../types.js').ImportReport} ImportReport */
/** @typedef {import('../types.js').Limits} Limits */
/** @typedef {'added'|'updated'|'unchanged'|{ code: 'INVALID_VALUE'|'DEFAULT_REQUIRED'|'PLACEHOLDER_MISMATCH', reason: string }} SetResult */

/**
 * Draft editing, validation, publishing and bundle resolution. Every write runs in one
 * transaction; the draft never holds a value whose placeholders differ from the default locale's
 * at write time, and publishing refuses a draft that drifted (default value changed later).
 */
export class ContentService {
  static NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
  static BUNDLE_CACHE_MAX = 1_000;
  static REPORT_MAX = 100;

  /**
   * @param {object} deps
   * @param {import('../db.js').Database} deps.db
   * @param {ContentStore} deps.content
   * @param {ReleaseStore} deps.releases
   * @param {Limits} deps.limits
   * @param {() => number} [deps.clock]
   */
  constructor({ db, content, releases, limits, clock = Date.now }) {
    this.db = db;
    this.content = content;
    this.releases = releases;
    this.limits = limits;
    this.clock = clock;
    /** Serialized bundle bodies by namespace, release and locale. @type {Map<string, { body: string, etag: string }>} */
    this.bundleCache = new Map();
    /** Process-local bundle request counters by namespace and outcome. @type {Map<string, { ok: number, notModified: number }>} */
    this.bundleRequests = new Map();
  }

  // ---- namespaces

  /** @param {string} name @returns {NamespaceRow} */
  namespace(name) {
    const row = this.content.namespace(name);
    if (!row) throw new ContentError('NAMESPACE_NOT_FOUND', `namespace "${name}" does not exist`);
    return row;
  }

  /**
   * @param {{ name: string, defaultLocale: string, description?: string, locales?: { locale: string, fallback?: string|null }[] }} input
   * @param {string} actor
   */
  createNamespace(input, actor) {
    const name = input.name;
    if (!ContentService.NAME_PATTERN.test(name)) throw new ContentError('INVALID_VALUE', 'namespace name must match [a-z][a-z0-9-]{0,63}');
    const defaultLocale = Locales.canonical(input.defaultLocale);
    const extra = (input.locales ?? []).map((l) => ({ locale: Locales.canonical(l.locale), fallback: l.fallback ? Locales.canonical(l.fallback) : null }));
    return this.db.transaction(() => {
      if (this.content.namespace(name)) throw new ContentError('NAMESPACE_EXISTS', `namespace "${name}" already exists`);
      const now = this.clock();
      this.content.insertNamespace({ name, default_locale: defaultLocale, description: input.description ?? '', created_by: actor, created_at: now, updated_at: now });
      this.content.insertLocale(name, defaultLocale, null, now);
      // Insert every locale first so fallbacks may point at locales listed later.
      for (const l of extra) if (l.locale !== defaultLocale) this.#addLocale(name, l.locale, now);
      for (const l of extra) if (l.locale !== defaultLocale || l.fallback) this.#setFallback(name, l.locale, l.fallback);
      return this.namespace(name);
    });
  }

  /** @param {string} name @param {{ description?: string, defaultLocale?: string }} patch @param {string} _actor */
  updateNamespace(name, patch, _actor) {
    return this.db.transaction(() => {
      const ns = this.namespace(name);
      const now = this.clock();
      let defaultLocale = ns.default_locale;
      if (patch.defaultLocale !== undefined) {
        defaultLocale = Locales.canonical(patch.defaultLocale);
        this.#locale(name, defaultLocale);
        if (defaultLocale !== ns.default_locale) {
          // The default ends every chain, so it has no fallback of its own.
          this.content.setFallback(name, defaultLocale, null);
          this.content.touch(name, now);
        }
      }
      this.content.updateNamespace(name, { defaultLocale, description: patch.description ?? ns.description }, now);
      return this.namespace(name);
    });
  }

  /** @param {string} name */
  deleteNamespace(name) {
    this.namespace(name);
    this.content.deleteNamespace(name);
    for (const k of this.bundleCache.keys()) if (k.startsWith(`${name}\u0000`)) this.bundleCache.delete(k);
    this.bundleRequests.delete(name);
  }

  /** Counts for one namespace, as shown in lists and stats. @param {NamespaceRow} ns */
  summary(ns) {
    const locales = this.content.locales(ns.name);
    const missing = this.content.missing(ns.name);
    const latest = this.releases.latest(ns.name) ?? null;
    return {
      locales,
      keys: this.content.keyCount(ns.name),
      missing,
      mismatched: this.content.mismatched(ns.name).length + this.content.orphans(ns.name).length,
      latest,
      unpublishedChanges: latest === null ? true : ns.draft_updated_at > latest.created_at,
    };
  }

  // ---- locales

  /**
   * Add a locale or change its fallback.
   * @param {string} ns
   * @param {string} rawLocale
   * @param {{ fallback?: string|null }} input
   * @returns {{ created: boolean }}
   */
  setLocale(ns, rawLocale, input, _actor = '') {
    const locale = Locales.canonical(rawLocale);
    const fallback = input.fallback ? Locales.canonical(input.fallback) : null;
    return this.db.transaction(() => {
      this.namespace(ns);
      const now = this.clock();
      const created = !this.content.locales(ns).some((l) => l.locale === locale);
      if (created) this.#addLocale(ns, locale, now);
      this.#setFallback(ns, locale, fallback);
      this.content.touch(ns, now);
      return { created, locale };
    });
  }

  /** @param {string} ns @param {string} rawLocale */
  deleteLocale(ns, rawLocale) {
    const locale = Locales.canonical(rawLocale);
    this.db.transaction(() => {
      const row = this.namespace(ns);
      this.#locale(ns, locale);
      if (row.default_locale === locale) throw new ContentError('LOCALE_IN_USE', `"${locale}" is the default locale of "${ns}"; make another locale the default first`);
      const dependents = this.content.locales(ns).filter((l) => l.fallback === locale).map((l) => l.locale);
      if (dependents.length) throw new ContentError('LOCALE_IN_USE', `"${locale}" is the fallback of ${dependents.join(', ')}`, { dependents });
      this.content.deleteLocale(ns, locale);
      this.content.touch(ns, this.clock());
    });
  }

  /** @param {string} ns @param {string} locale */
  #locale(ns, locale) {
    const row = this.content.locales(ns).find((l) => l.locale === locale);
    if (!row) throw new ContentError('LOCALE_NOT_FOUND', `locale "${locale}" is not configured in "${ns}"`);
    return row;
  }

  /** @param {string} ns @param {string} locale @param {number} now */
  #addLocale(ns, locale, now) {
    const existing = this.content.locales(ns);
    if (existing.some((l) => l.locale === locale)) return;
    if (existing.length >= this.limits.maxLocalesPerNamespace) throw new ContentError('LIMIT_EXCEEDED', `a namespace holds at most ${this.limits.maxLocalesPerNamespace} locales`);
    this.content.insertLocale(ns, locale, null, now);
  }

  /** @param {string} ns @param {string} locale @param {string|null} fallback */
  #setFallback(ns, locale, fallback) {
    const row = this.namespace(ns);
    if (fallback !== null) {
      if (locale === row.default_locale) throw new ContentError('INVALID_FALLBACK', 'the default locale ends every chain and has no fallback');
      if (fallback === locale) throw new ContentError('INVALID_FALLBACK', 'a locale cannot fall back to itself');
      const map = new Map(this.content.locales(ns).map((l) => [l.locale, l.fallback]));
      if (!map.has(fallback)) throw new ContentError('INVALID_FALLBACK', `fallback "${fallback}" is not configured in "${ns}"`);
      for (let cur = /** @type {string|null|undefined} */ (fallback); cur; cur = map.get(cur)) {
        if (cur === locale) throw new ContentError('INVALID_FALLBACK', `"${locale}" -> "${fallback}" would create a cycle`);
      }
    }
    this.content.setFallback(ns, locale, fallback);
  }

  // ---- keys and values

  /** @param {string} ns @param {string} key */
  key(ns, key) {
    this.namespace(ns);
    const row = this.content.key(ns, key);
    if (!row) throw new ContentError('KEY_NOT_FOUND', `key "${key}" does not exist in "${ns}"`);
    return row;
  }

  /**
   * Create or update a key. `values` is merged: a string sets that locale, `null` removes it.
   * @param {string} ns
   * @param {string} key
   * @param {{ description?: string, values?: Record<string, string|null> }} input
   * @param {string} actor
   * @returns {{ created: boolean, mismatched: string[] }} `mismatched`: locales whose value no longer matches the default's placeholders.
   */
  upsertKey(ns, key, input, actor) {
    if (!KeyPaths.valid(key)) throw new ContentError('INVALID_VALUE', 'key must match [a-z0-9][a-z0-9._-]{0,127}');
    /** @type {[string, string|null][]} */
    const values = Object.entries(input.values ?? {}).map(([l, v]) => [Locales.canonical(l), v]);
    if (new Set(values.map(([l]) => l)).size !== values.length) throw new ContentError('INVALID_VALUE', 'values name the same locale twice');
    return this.db.transaction(() => {
      const row = this.namespace(ns);
      const now = this.clock();
      const existing = this.content.key(ns, key);
      if (!existing) {
        if (this.content.keyCount(ns) >= this.limits.maxKeysPerNamespace) throw new ContentError('LIMIT_EXCEEDED', `a namespace holds at most ${this.limits.maxKeysPerNamespace} keys`);
        this.content.insertKey(ns, key, input.description ?? '', now);
      } else if (input.description !== undefined && input.description !== existing.description) {
        this.content.updateKey(ns, key, input.description, now);
      }
      const configured = new Set(this.content.locales(ns).map((l) => l.locale));
      // The default goes first: other locales are checked against its new value.
      values.sort(([a], [b]) => Number(b === row.default_locale) - Number(a === row.default_locale));
      for (const [locale, value] of values) {
        if (!configured.has(locale)) throw new ContentError('LOCALE_NOT_FOUND', `locale "${locale}" is not configured in "${ns}"`);
        if (value === null) this.#removeValue(row, key, locale);
        else this.#check(this.#setValue(row, key, locale, value, actor, now));
      }
      if (values.length || !existing) this.content.touch(ns, now);
      const def = this.content.translation(ns, key, row.default_locale);
      const mismatched = def ? this.content.translationsOfKey(ns, key).filter((t) => t.locale !== row.default_locale && t.placeholders !== def.placeholders).map((t) => t.locale) : [];
      return { created: !existing, mismatched };
    });
  }

  /** @param {string} ns @param {string} key */
  deleteKey(ns, key) {
    this.key(ns, key);
    this.db.transaction(() => {
      this.content.deleteKey(ns, key);
      this.content.touch(ns, this.clock());
    });
  }

  /**
   * Validate and store one value; returns why it was refused instead of throwing so import can
   * report and continue.
   * @param {NamespaceRow} ns
   * @param {string} key
   * @param {string} locale
   * @param {unknown} value
   * @param {string} actor
   * @param {number} now
   * @returns {SetResult}
   */
  #setValue(ns, key, locale, value, actor, now) {
    if (typeof value !== 'string') return { code: 'INVALID_VALUE', reason: 'value must be a string' };
    if (value.length > this.limits.maxValueLength) return { code: 'INVALID_VALUE', reason: `value is longer than ${this.limits.maxValueLength} characters` };
    const placeholders = Placeholders.of(value);
    if (locale !== ns.default_locale) {
      const def = this.content.translation(ns.name, key, ns.default_locale);
      if (!def) return { code: 'DEFAULT_REQUIRED', reason: `set the ${ns.default_locale} value first` };
      if (def.placeholders !== placeholders) return { code: 'PLACEHOLDER_MISMATCH', reason: `placeholders {${Placeholders.list(placeholders).join('}, {')}} must be {${Placeholders.list(def.placeholders).join('}, {')}} as in ${ns.default_locale}`.replace(/\{\}/g, 'none') };
    }
    const current = this.content.translation(ns.name, key, locale);
    if (current?.value === value) return 'unchanged';
    this.content.upsertTranslation({ ns: ns.name, key, locale, value, placeholders, updated_by: actor, updated_at: now });
    return current ? 'updated' : 'added';
  }

  /** @param {SetResult} result */
  #check(result) {
    if (typeof result === 'object') throw new ContentError(result.code, result.reason);
  }

  /** @param {NamespaceRow} ns @param {string} key @param {string} locale */
  #removeValue(ns, key, locale) {
    if (locale === ns.default_locale) {
      const others = this.content.translationsOfKey(ns.name, key).filter((t) => t.locale !== locale);
      if (others.length) throw new ContentError('DEFAULT_REQUIRED', `remove the ${others.map((t) => t.locale).join(', ')} values before the ${locale} value`);
    }
    this.content.deleteTranslation(ns.name, key, locale);
  }

  // ---- import / export

  /**
   * Merge a flat or nested JSON object into one locale. Valid entries are applied, invalid ones
   * reported; nothing is deleted. Importing the default locale creates missing keys.
   * @param {string} ns
   * @param {string} rawLocale
   * @param {Record<string, unknown>} strings
   * @param {string} actor
   * @returns {ImportReport}
   */
  importLocale(ns, rawLocale, strings, actor) {
    const locale = Locales.canonical(rawLocale);
    const { entries, invalid } = KeyPaths.flatten(strings);
    const report = { locale, added: 0, updated: 0, unchanged: 0, invalidCount: 0, invalid: /** @type {{ key: string, reason: string }[]} */ ([]) };
    const reject = (/** @type {string} */ key, /** @type {string} */ reason) => {
      report.invalidCount++;
      if (report.invalid.length < ContentService.REPORT_MAX) report.invalid.push({ key, reason });
    };
    for (const i of invalid) reject(i.key, i.reason);
    this.db.transaction(() => {
      const row = this.namespace(ns);
      this.#locale(ns, locale);
      const now = this.clock();
      let count = this.content.keyCount(ns);
      const seen = new Set();
      for (const [key, value] of entries) {
        if (!KeyPaths.valid(key)) { reject(key.slice(0, 200), 'key must match [a-z0-9][a-z0-9._-]{0,127}'); continue; }
        if (seen.has(key)) { reject(key, 'key appears twice (flat and nested)'); continue; }
        seen.add(key);
        if (!this.content.key(ns, key)) {
          if (locale !== row.default_locale) { reject(key, `unknown key; import ${row.default_locale} first`); continue; }
          if (count >= this.limits.maxKeysPerNamespace) { reject(key, `namespace key limit ${this.limits.maxKeysPerNamespace} reached`); continue; }
          this.content.insertKey(ns, key, '', now);
          count++;
        }
        const result = this.#setValue(row, key, locale, value, actor, now);
        if (typeof result === 'object') reject(key, result.reason);
        else report[result]++;
      }
      if (report.added || report.updated) this.content.touch(ns, now);
    });
    return report;
  }

  /**
   * One locale's own values (no fallback), from the draft or the latest release.
   * @param {string} ns
   * @param {string} rawLocale
   * @param {{ source: 'draft'|'published', nested: boolean }} opts
   */
  exportLocale(ns, rawLocale, { source, nested }) {
    const locale = Locales.canonical(rawLocale);
    this.namespace(ns);
    /** @type {Record<string, string>} */
    const flat = {};
    let release = null;
    if (source === 'draft') {
      this.#locale(ns, locale);
      for (const t of this.content.translationsOfLocale(ns, locale)) flat[t.key] = t.value;
    } else {
      const latest = this.releases.latest(ns);
      if (!latest) throw new ContentError('NOT_PUBLISHED', `"${ns}" has no published release`);
      const content = /** @type {ReleaseContent} */ (this.releases.content(ns, latest.number));
      if (!content.locales.some((l) => l.locale === locale)) throw new ContentError('LOCALE_NOT_FOUND', `locale "${locale}" is not in release ${latest.number} of "${ns}"`);
      for (const [key, k] of Object.entries(content.keys)) if (k.values[locale] !== undefined) flat[key] = k.values[locale];
      release = latest.number;
    }
    return { namespace: ns, locale, source, release, strings: nested ? KeyPaths.nest(flat) : flat };
  }

  // ---- releases

  /** @param {string} ns @param {{ note?: string }} input @param {string} actor */
  publish(ns, input, actor) {
    return this.db.transaction(() => {
      const row = this.namespace(ns);
      const problems = [
        ...this.content.mismatched(ns).map((p) => ({ ...p, reason: 'placeholders differ from the default locale' })),
        ...this.content.orphans(ns).map((p) => ({ ...p, reason: `no ${row.default_locale} value` })),
      ];
      if (problems.length) throw new ContentError('UNPUBLISHABLE', `${problems.length} value(s) must be fixed before publishing`, { problems: problems.slice(0, ContentService.REPORT_MAX) });
      return this.#release(ns, this.#draftContent(row), { note: input.note ?? '', rollbackOf: null }, actor);
    });
  }

  /**
   * Publish an earlier release's content again as a new release. With `restoreDraft`, the draft
   * is replaced by that content too (unpublished edits are discarded); otherwise it is untouched.
   * @param {string} ns
   * @param {{ release: number, note?: string, restoreDraft?: boolean }} input
   * @param {string} actor
   */
  rollback(ns, input, actor) {
    return this.db.transaction(() => {
      this.namespace(ns);
      const content = this.releases.content(ns, input.release);
      if (!content) throw new ContentError('RELEASE_NOT_FOUND', `release ${input.release} of "${ns}" does not exist`);
      const out = this.#release(ns, content, { note: input.note ?? `rollback to release ${input.release}`, rollbackOf: input.release }, actor);
      if (input.restoreDraft) this.#restoreDraft(ns, content, actor, out.created_at);
      return out;
    });
  }

  /** @param {string} ns @param {number} number */
  release(ns, number) {
    this.namespace(ns);
    const row = this.releases.get(ns, number);
    if (!row) throw new ContentError('RELEASE_NOT_FOUND', `release ${number} of "${ns}" does not exist`);
    return { row, content: /** @type {ReleaseContent} */ (this.releases.content(ns, number)) };
  }

  /** @param {NamespaceRow} ns @returns {ReleaseContent} */
  #draftContent(ns) {
    /** @type {ReleaseContent['keys']} */
    const keys = {};
    for (const k of this.content.allKeys(ns.name)) keys[k.key] = { description: k.description, values: {} };
    for (const t of this.content.translationsOfNamespace(ns.name)) keys[t.key].values[t.locale] = t.value;
    return { defaultLocale: ns.default_locale, locales: this.content.locales(ns.name).map((l) => ({ locale: l.locale, fallback: l.fallback })), keys };
  }

  /**
   * @param {string} ns
   * @param {ReleaseContent} content
   * @param {{ note: string, rollbackOf: number|null }} meta
   * @param {string} actor
   */
  #release(ns, content, { note, rollbackOf }, actor) {
    const number = this.releases.maxNumber(ns) + 1;
    const row = { ns, number, note, rollback_of: rollbackOf, key_count: Object.keys(content.keys).length, created_by: actor, created_at: this.clock() };
    this.releases.insert(row, JSON.stringify(content));
    this.releases.prune(ns, number - this.limits.releaseRetention);
    return row;
  }

  /** @param {string} ns @param {ReleaseContent} content @param {string} actor @param {number} now */
  #restoreDraft(ns, content, actor, now) {
    for (const k of this.content.allKeys(ns)) this.content.deleteKey(ns, k.key);
    for (const l of this.content.locales(ns)) this.content.deleteLocale(ns, l.locale);
    const row = this.namespace(ns);
    this.content.updateNamespace(ns, { defaultLocale: content.defaultLocale, description: row.description }, now);
    for (const l of content.locales) this.content.insertLocale(ns, l.locale, null, now);
    for (const l of content.locales) if (l.fallback) this.content.setFallback(ns, l.locale, l.fallback);
    for (const [key, k] of Object.entries(content.keys)) {
      this.content.insertKey(ns, key, k.description, now);
      for (const [locale, value] of Object.entries(k.values)) this.content.upsertTranslation({ ns, key, locale, value, placeholders: Placeholders.of(value), updated_by: actor, updated_at: now });
    }
    this.content.touch(ns, now);
  }

  // ---- bundles

  /**
   * Published, fallback-resolved strings for one locale, serialized once per release.
   * @param {string} ns
   * @param {string} rawLocale
   * @returns {{ body: string, etag: string }}
   */
  bundle(ns, rawLocale) {
    const locale = Locales.canonical(rawLocale);
    this.namespace(ns);
    const latest = this.releases.latest(ns);
    if (!latest) throw new ContentError('NOT_PUBLISHED', `"${ns}" has no published release`);
    const cacheKey = `${ns}\u0000${latest.number}\u0000${locale}`;
    const hit = this.bundleCache.get(cacheKey);
    if (hit) return hit;
    const content = /** @type {ReleaseContent} */ (this.releases.content(ns, latest.number));
    const fallbacks = new Map(content.locales.map((l) => [l.locale, l.fallback]));
    if (!fallbacks.has(locale)) throw new ContentError('LOCALE_NOT_FOUND', `locale "${locale}" is not in release ${latest.number} of "${ns}"`);
    const chain = Locales.chain(locale, fallbacks, content.defaultLocale);
    /** @type {Record<string, string>} */
    const strings = {};
    for (const [key, k] of Object.entries(content.keys)) {
      for (const l of chain) {
        if (k.values[l] !== undefined) { strings[key] = k.values[l]; break; }
      }
    }
    const body = JSON.stringify({ namespace: ns, locale, chain, release: latest.number, publishedAt: new Date(latest.created_at).toISOString(), strings });
    const entry = { body, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"` };
    // shortcut: whole-cache reset when full instead of LRU; fine while entries are few and cheap to rebuild.
    if (this.bundleCache.size >= ContentService.BUNDLE_CACHE_MAX) this.bundleCache.clear();
    this.bundleCache.set(cacheKey, entry);
    return entry;
  }

  /** @param {string} ns @param {'ok'|'notModified'} outcome */
  countBundle(ns, outcome) {
    const c = this.bundleRequests.get(ns) ?? { ok: 0, notModified: 0 };
    c[outcome]++;
    this.bundleRequests.set(ns, c);
  }

  // ---- stats

  /** Totals across namespaces plus one row per namespace. */
  stats() {
    const items = this.content.namespaces().map((ns) => {
      const s = this.summary(ns);
      return {
        namespace: ns.name, defaultLocale: ns.default_locale, keys: s.keys, locales: s.locales.length,
        missing: [...s.missing.values()].reduce((a, b) => a + b, 0), missingByLocale: Object.fromEntries(s.missing), mismatched: s.mismatched,
        release: s.latest?.number ?? null, publishedAt: s.latest ? new Date(s.latest.created_at).toISOString() : null, publishedBy: s.latest?.created_by ?? null,
        unpublishedChanges: s.unpublishedChanges,
      };
    });
    const last = items.filter((i) => i.publishedAt).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))[0];
    const sum = (/** @type {'keys'|'locales'|'missing'|'mismatched'} */ f) => items.reduce((a, i) => a + i[f], 0);
    return {
      namespaces: items.length, keys: sum('keys'), locales: sum('locales'), missing: sum('missing'), mismatched: sum('mismatched'),
      releases: this.releases.total(),
      lastPublish: last ? { namespace: last.namespace, release: last.release, at: last.publishedAt, by: last.publishedBy } : null,
      items,
    };
  }
}
