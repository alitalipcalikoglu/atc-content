import { Locales, Placeholders } from '../domain/rules.js';

/** @typedef {import('../types.js').NamespaceRow} NamespaceRow */
/** @typedef {import('../types.js').KeyRow} KeyRow */
/** @typedef {import('../types.js').TranslationRow} TranslationRow */
/** @typedef {import('../types.js').ReleaseRow} ReleaseRow */
/** @typedef {ReturnType<import('../domain/content-service.js').ContentService['summary']>} Summary */

/** Response shapes. */
export class Views {
  /** @param {number} t */
  static iso(t) {
    return new Date(Number(t)).toISOString();
  }

  /** @param {NamespaceRow} n @param {Summary} s */
  static namespace(n, s) {
    const fallbacks = new Map(s.locales.map((l) => [l.locale, l.fallback]));
    return {
      name: n.name, defaultLocale: n.default_locale, description: n.description,
      locales: s.locales.map((l) => ({ locale: l.locale, fallback: l.fallback, chain: Locales.chain(l.locale, fallbacks, n.default_locale) })),
      keys: s.keys,
      missing: Object.fromEntries(s.locales.map((l) => [l.locale, s.missing.get(l.locale) ?? 0])),
      mismatched: s.mismatched,
      release: s.latest ? Views.release(s.latest) : null,
      unpublishedChanges: s.unpublishedChanges,
      createdBy: n.created_by, createdAt: Views.iso(n.created_at), updatedAt: Views.iso(n.updated_at), draftUpdatedAt: Views.iso(n.draft_updated_at),
    };
  }

  /** @param {KeyRow} k @param {TranslationRow[]} values @param {string} defaultLocale */
  static key(k, values, defaultLocale) {
    const def = values.find((t) => t.locale === defaultLocale);
    return {
      key: k.key, description: k.description,
      placeholders: def ? Placeholders.list(def.placeholders) : [],
      values: Object.fromEntries(values.map((t) => [t.locale, t.value])),
      mismatched: def ? values.filter((t) => t.locale !== defaultLocale && t.placeholders !== def.placeholders).map((t) => t.locale) : values.map((t) => t.locale),
      updatedBy: Object.fromEntries(values.map((t) => [t.locale, t.updated_by])),
      createdAt: Views.iso(k.created_at), updatedAt: Views.iso(Math.max(k.updated_at, ...values.map((t) => t.updated_at))),
    };
  }

  /** @param {ReleaseRow} r */
  static release(r) {
    return { number: Number(r.number), note: r.note, rollbackOf: r.rollback_of === null ? null : Number(r.rollback_of), keys: Number(r.key_count), createdBy: r.created_by, createdAt: Views.iso(r.created_at) };
  }
}
