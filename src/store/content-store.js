/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').NamespaceRow} NamespaceRow */
/** @typedef {import('../types.js').LocaleRow} LocaleRow */
/** @typedef {import('../types.js').KeyRow} KeyRow */
/** @typedef {import('../types.js').TranslationRow} TranslationRow */

/** Persistence for the draft: namespaces, their locales, keys and per-locale values. */
export class ContentStore {
  static NS = 'name, default_locale, description, created_by, created_at, updated_at, draft_updated_at, draft_version, published_version';
  static TR = 'ns, key, locale, value, placeholders, updated_by, updated_at';

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const N = ContentStore.NS;
    const T = ContentStore.TR;
    this.stmt = {
      insertNs: db.prepare('INSERT INTO namespaces (name, default_locale, description, created_by, created_at, updated_at, draft_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      ns: db.prepare(`SELECT ${N} FROM namespaces WHERE name = ?`),
      allNs: db.prepare(`SELECT ${N} FROM namespaces ORDER BY name`),
      updateNs: db.prepare('UPDATE namespaces SET default_locale = ?, description = ?, updated_at = ? WHERE name = ?'),
      touch: db.prepare('UPDATE namespaces SET draft_updated_at = ?, draft_version = draft_version + 1 WHERE name = ?'),
      markPublished: db.prepare('UPDATE namespaces SET published_version = ? WHERE name = ?'),
      deleteNs: db.prepare('DELETE FROM namespaces WHERE name = ?'),
      insertLocale: db.prepare('INSERT INTO locales (ns, locale, fallback, created_at) VALUES (?, ?, ?, ?)'),
      setFallback: db.prepare('UPDATE locales SET fallback = ? WHERE ns = ? AND locale = ?'),
      locales: db.prepare('SELECT ns, locale, fallback, created_at FROM locales WHERE ns = ? ORDER BY locale'),
      deleteLocale: db.prepare('DELETE FROM locales WHERE ns = ? AND locale = ?'),
      insertKey: db.prepare('INSERT INTO keys (ns, key, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
      key: db.prepare('SELECT ns, key, description, created_at, updated_at FROM keys WHERE ns = ? AND key = ?'),
      updateKey: db.prepare('UPDATE keys SET description = ?, updated_at = ? WHERE ns = ? AND key = ?'),
      deleteKey: db.prepare('DELETE FROM keys WHERE ns = ? AND key = ?'),
      keyCount: db.prepare('SELECT COUNT(*) AS n FROM keys WHERE ns = ?'),
      allKeys: db.prepare('SELECT ns, key, description, created_at, updated_at FROM keys WHERE ns = ? ORDER BY key'),
      upsertTr: db.prepare(`INSERT INTO translations (${T}) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ns, key, locale) DO UPDATE SET value = excluded.value, placeholders = excluded.placeholders, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
      tr: db.prepare(`SELECT ${T} FROM translations WHERE ns = ? AND key = ? AND locale = ?`),
      trOfKey: db.prepare(`SELECT ${T} FROM translations WHERE ns = ? AND key = ? ORDER BY locale`),
      trOfLocale: db.prepare(`SELECT ${T} FROM translations WHERE ns = ? AND locale = ? ORDER BY key`),
      trOfNs: db.prepare(`SELECT ${T} FROM translations WHERE ns = ? ORDER BY key, locale`),
      deleteTr: db.prepare('DELETE FROM translations WHERE ns = ? AND key = ? AND locale = ?'),
      // Missing: (key, locale) pairs without a value. Mismatched: values whose placeholder set
      // differs from the default locale's value for the same key.
      missing: db.prepare(`SELECT l.locale AS locale, COUNT(*) AS n FROM keys k JOIN locales l ON l.ns = k.ns
        LEFT JOIN translations t ON t.ns = k.ns AND t.key = k.key AND t.locale = l.locale
        WHERE k.ns = ? AND t.key IS NULL GROUP BY l.locale`),
      mismatched: db.prepare(`SELECT t.key AS key, t.locale AS locale FROM translations t
        JOIN namespaces n ON n.name = t.ns
        JOIN translations d ON d.ns = t.ns AND d.key = t.key AND d.locale = n.default_locale
        WHERE t.ns = ? AND t.locale <> n.default_locale AND t.placeholders <> d.placeholders ORDER BY t.key, t.locale`),
      orphans: db.prepare(`SELECT t.key AS key, t.locale AS locale FROM translations t
        JOIN namespaces n ON n.name = t.ns
        LEFT JOIN translations d ON d.ns = t.ns AND d.key = t.key AND d.locale = n.default_locale
        WHERE t.ns = ? AND t.locale <> n.default_locale AND d.key IS NULL ORDER BY t.key, t.locale`),
    };
  }

  /** @param {Omit<NamespaceRow, 'draft_updated_at'|'draft_version'|'published_version'>} n */
  insertNamespace(n) {
    this.stmt.insertNs.run(n.name, n.default_locale, n.description, n.created_by, n.created_at, n.updated_at, n.updated_at);
  }

  /** @param {string} name @returns {NamespaceRow|undefined} */
  namespace(name) {
    return /** @type {NamespaceRow|undefined} */ (this.stmt.ns.get(name));
  }

  /** @returns {NamespaceRow[]} */
  namespaces() {
    return /** @type {NamespaceRow[]} */ (this.stmt.allNs.all());
  }

  /** @param {string} name @param {{ defaultLocale: string, description: string }} v @param {number} now */
  updateNamespace(name, { defaultLocale, description }, now) {
    this.stmt.updateNs.run(defaultLocale, description, now, name);
  }

  /** Mark the draft as changed. @param {string} name @param {number} now */
  touch(name, now) {
    this.stmt.touch.run(now, name);
  }

  /** Record which draft version the latest release holds; null = it holds something else. @param {string} name @param {number|null} version */
  markPublished(name, version) {
    this.stmt.markPublished.run(version, name);
  }

  /** @param {string} name */
  deleteNamespace(name) {
    return Number(this.stmt.deleteNs.run(name).changes) > 0;
  }

  /** @param {string} ns @param {string} locale @param {string|null} fallback @param {number} now */
  insertLocale(ns, locale, fallback, now) {
    this.stmt.insertLocale.run(ns, locale, fallback, now);
  }

  /** @param {string} ns @param {string} locale @param {string|null} fallback */
  setFallback(ns, locale, fallback) {
    this.stmt.setFallback.run(fallback, ns, locale);
  }

  /** @param {string} ns @returns {LocaleRow[]} */
  locales(ns) {
    return /** @type {LocaleRow[]} */ (this.stmt.locales.all(ns));
  }

  /** @param {string} ns @param {string} locale */
  deleteLocale(ns, locale) {
    this.stmt.deleteLocale.run(ns, locale);
  }

  /** @param {string} ns @param {string} key @param {string} description @param {number} now */
  insertKey(ns, key, description, now) {
    this.stmt.insertKey.run(ns, key, description, now, now);
  }

  /** @param {string} ns @param {string} key @returns {KeyRow|undefined} */
  key(ns, key) {
    return /** @type {KeyRow|undefined} */ (this.stmt.key.get(ns, key));
  }

  /** @param {string} ns @param {string} key @param {string} description @param {number} now */
  updateKey(ns, key, description, now) {
    this.stmt.updateKey.run(description, now, ns, key);
  }

  /** @param {string} ns @param {string} key */
  deleteKey(ns, key) {
    return Number(this.stmt.deleteKey.run(ns, key).changes) > 0;
  }

  /** @param {string} ns */
  keyCount(ns) {
    return Number(/** @type {{ n: number }} */ (this.stmt.keyCount.get(ns)).n);
  }

  /** @param {string} ns @returns {KeyRow[]} */
  allKeys(ns) {
    return /** @type {KeyRow[]} */ (this.stmt.allKeys.all(ns));
  }

  /**
   * One page of keys ordered by key, optionally filtered by substring or by a locale without a value.
   * @param {string} ns
   * @param {{ q?: string, missing?: string, after?: string, limit: number }} f
   * @returns {KeyRow[]}
   */
  listKeys(ns, { q, missing, after, limit }) {
    const where = ['k.ns = ?'];
    /** @type {(string|number)[]} */
    const args = [ns];
    if (q) {
      where.push("(k.key LIKE ? ESCAPE '\\' OR k.description LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like);
    }
    if (missing) {
      where.push('NOT EXISTS (SELECT 1 FROM translations t WHERE t.ns = k.ns AND t.key = k.key AND t.locale = ?)');
      args.push(missing);
    }
    if (after) {
      where.push('k.key > ?');
      args.push(after);
    }
    args.push(limit);
    return /** @type {KeyRow[]} */ (this.db.prepare(`SELECT k.ns, k.key, k.description, k.created_at, k.updated_at FROM keys k WHERE ${where.join(' AND ')} ORDER BY k.key LIMIT ?`).all(...args));
  }

  /** @param {Omit<TranslationRow, never>} t */
  upsertTranslation(t) {
    this.stmt.upsertTr.run(t.ns, t.key, t.locale, t.value, t.placeholders, t.updated_by, t.updated_at);
  }

  /** @param {string} ns @param {string} key @param {string} locale @returns {TranslationRow|undefined} */
  translation(ns, key, locale) {
    return /** @type {TranslationRow|undefined} */ (this.stmt.tr.get(ns, key, locale));
  }

  /** @param {string} ns @param {string} key @returns {TranslationRow[]} */
  translationsOfKey(ns, key) {
    return /** @type {TranslationRow[]} */ (this.stmt.trOfKey.all(ns, key));
  }

  /** @param {string} ns @param {string} locale @returns {TranslationRow[]} */
  translationsOfLocale(ns, locale) {
    return /** @type {TranslationRow[]} */ (this.stmt.trOfLocale.all(ns, locale));
  }

  /** @param {string} ns @returns {TranslationRow[]} */
  translationsOfNamespace(ns) {
    return /** @type {TranslationRow[]} */ (this.stmt.trOfNs.all(ns));
  }

  /** @param {string} ns @param {string} key @param {string} locale */
  deleteTranslation(ns, key, locale) {
    return Number(this.stmt.deleteTr.run(ns, key, locale).changes) > 0;
  }

  /** @param {string} ns @returns {Map<string, number>} locale -> keys without a value */
  missing(ns) {
    return new Map(/** @type {{ locale: string, n: number }[]} */ (this.stmt.missing.all(ns)).map((r) => [r.locale, Number(r.n)]));
  }

  /** @param {string} ns @returns {{ key: string, locale: string }[]} */
  mismatched(ns) {
    return /** @type {{ key: string, locale: string }[]} */ (this.stmt.mismatched.all(ns));
  }

  /** Values in other locales whose key has no default-locale value. @param {string} ns @returns {{ key: string, locale: string }[]} */
  orphans(ns) {
    return /** @type {{ key: string, locale: string }[]} */ (this.stmt.orphans.all(ns));
  }
}
