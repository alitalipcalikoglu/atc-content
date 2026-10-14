/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').ReleaseRow} ReleaseRow */

/** Immutable numbered releases per namespace. */
export class ReleaseStore {
  static META = 'ns, number, note, rollback_of, key_count, created_by, created_at';

  /** @param {Database} db */
  constructor(db) {
    const M = ReleaseStore.META;
    this.stmt = {
      insert: db.prepare(`INSERT INTO releases (${M}, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      latest: db.prepare(`SELECT ${M} FROM releases WHERE ns = ? ORDER BY number DESC LIMIT 1`),
      maxNumber: db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM releases WHERE ns = ?'),
      get: db.prepare(`SELECT ${M} FROM releases WHERE ns = ? AND number = ?`),
      content: db.prepare('SELECT content FROM releases WHERE ns = ? AND number = ?'),
      page: db.prepare(`SELECT ${M} FROM releases WHERE ns = ? AND number < ? ORDER BY number DESC LIMIT ?`),
      prune: db.prepare('DELETE FROM releases WHERE ns = ? AND number <= ?'),
      total: db.prepare('SELECT COUNT(*) AS n FROM releases'),
    };
  }

  /** @param {Omit<ReleaseRow, never>} r @param {string} content JSON */
  insert(r, content) {
    this.stmt.insert.run(r.ns, r.number, r.note, r.rollback_of, r.key_count, r.created_by, r.created_at, content);
  }

  /** @param {string} ns @returns {ReleaseRow|undefined} */
  latest(ns) {
    return /** @type {ReleaseRow|undefined} */ (this.stmt.latest.get(ns));
  }

  /** Highest number ever used, so pruned numbers are never reused. @param {string} ns */
  maxNumber(ns) {
    return Number(/** @type {{ n: number }} */ (this.stmt.maxNumber.get(ns)).n);
  }

  /** @param {string} ns @param {number} number @returns {ReleaseRow|undefined} */
  get(ns, number) {
    return /** @type {ReleaseRow|undefined} */ (this.stmt.get.get(ns, number));
  }

  /** @param {string} ns @param {number} number @returns {import('../types.js').ReleaseContent|undefined} */
  content(ns, number) {
    const row = /** @type {{ content: string }|undefined} */ (this.stmt.content.get(ns, number));
    return row ? JSON.parse(row.content) : undefined;
  }

  /** @param {string} ns @param {{ limit: number, before?: number }} q @returns {ReleaseRow[]} */
  list(ns, { limit, before = Number.MAX_SAFE_INTEGER }) {
    return /** @type {ReleaseRow[]} */ (this.stmt.page.all(ns, before, limit));
  }

  /** Delete releases numbered at or below `upTo`. @param {string} ns @param {number} upTo */
  prune(ns, upTo) {
    return Number(this.stmt.prune.run(ns, upTo).changes);
  }

  total() {
    return Number(/** @type {{ n: number }} */ (this.stmt.total.get()).n);
  }
}
