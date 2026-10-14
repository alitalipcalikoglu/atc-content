import { ContentError } from './errors.js';

/** BCP 47 locale tags: language, optional script, optional region. */
export class Locales {
  /** Canonical form accepted: `en`, `tr-CY`, `zh-Hant-TW`, `es-419`. Extensions and variants are not. */
  static PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;

  /**
   * Canonical tag (`tr-cy` becomes `tr-CY`) or a 400.
   * @param {string} raw
   * @returns {string}
   */
  static canonical(raw) {
    let tag;
    try {
      [tag] = Intl.getCanonicalLocales(raw);
    } catch {
      tag = undefined;
    }
    if (!tag || !Locales.PATTERN.test(tag)) throw new ContentError('INVALID_LOCALE', `"${String(raw).slice(0, 40)}" is not a supported BCP 47 tag (language[-Script][-REGION])`);
    return tag;
  }

  /**
   * Lookup order for `locale`: itself, its fallback chain, then the default. Each locale once.
   * @param {string} locale
   * @param {Map<string, string|null>} fallbacks locale -> fallback
   * @param {string} defaultLocale
   * @returns {string[]}
   */
  static chain(locale, fallbacks, defaultLocale) {
    /** @type {string[]} */
    const out = [];
    /** @type {string|null|undefined} */
    let cur = locale;
    while (cur && !out.includes(cur)) {
      out.push(cur);
      cur = fallbacks.get(cur);
    }
    if (!out.includes(defaultLocale)) out.push(defaultLocale);
    return out;
  }
}

/** `{name}` placeholders. Braces that do not form a placeholder are literal text. */
export class Placeholders {
  static PATTERN = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

  /**
   * Sorted, de-duplicated, comma-joined placeholder names, the form stored and compared.
   * @param {string} value
   */
  static of(value) {
    return [...new Set(Array.from(value.matchAll(Placeholders.PATTERN), (m) => m[1]))].sort().join(',');
  }

  /** @param {string} joined */
  static list(joined) {
    return joined ? joined.split(',') : [];
  }
}

/** Translation keys, and the nested JSON shape some clients use for them. */
export class KeyPaths {
  static PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

  /** @param {string} key */
  static valid(key) {
    return KeyPaths.PATTERN.test(key);
  }

  /**
   * Flatten `{ a: { b: "x" } }` to `{ "a.b": "x" }`. Flat input passes through unchanged. Leaves
   * that are not strings are reported, not dropped silently.
   * @param {Record<string, unknown>} input
   * @returns {{ entries: [string, string][], invalid: { key: string, reason: string }[] }}
   */
  static flatten(input) {
    /** @type {[string, string][]} */
    const entries = [];
    /** @type {{ key: string, reason: string }[]} */
    const invalid = [];
    /** @param {Record<string, unknown>} obj @param {string} prefix @param {number} depth */
    const walk = (obj, prefix, depth) => {
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') entries.push([path, v]);
        else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 16) walk(/** @type {Record<string, unknown>} */ (v), path, depth + 1);
        else invalid.push({ key: path.slice(0, 200), reason: 'value must be a string or an object of strings' });
      }
    };
    walk(input, '', 0);
    return { entries, invalid };
  }

  /**
   * Nest a flat map on `.`. A key that is both a leaf and a prefix (`a` and `a.b`) cannot be
   * represented and is a 409.
   * @param {Record<string, string>} flat
   * @returns {Record<string, unknown>}
   */
  static nest(flat) {
    /** @type {Record<string, any>} */
    const root = Object.create(null);
    for (const key of Object.keys(flat).sort()) {
      const parts = key.split('.');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (typeof node[p] === 'string') throw new ContentError('NESTED_CONFLICT', `"${parts.slice(0, i + 1).join('.')}" is both a key and a prefix; export it flat`);
        node = node[p] ??= Object.create(null);
      }
      const leaf = parts.at(-1) ?? key;
      if (leaf === '' || typeof node[leaf] === 'object') throw new ContentError('NESTED_CONFLICT', `"${key}" is both a key and a prefix; export it flat`);
      node[leaf] = flat[key];
    }
    return root;
  }
}
