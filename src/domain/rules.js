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

/**
 * Placeholders in ICU MessageFormat values: simple `{name}`, formatted `{n, number}` /
 * `{d, date, short}`, and the complex `{count, plural, one {# item} other {# items}}`,
 * `{rank, selectordinal, …}` and `{gender, select, female {…} other {…}}` with nested messages.
 * Values are stored as written and never formatted here (clients format with their ICU library);
 * parsing yields the argument names that must match across locales, and rejects broken complex
 * arguments: missing `other`, plural categories the locale does not have, unbalanced braces.
 * A `{` that does not start an argument (`{ x`, `{1}`) stays literal text, as do `'{…}'` quotes.
 */
export class Placeholders {
  static NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  static SIMPLE_TYPES = new Set(['number', 'date', 'time', 'spellout', 'ordinal', 'duration']);

  /**
   * Sorted, de-duplicated, comma-joined argument names, the form stored and compared.
   * @param {string} value
   * @param {string} [locale]  Checks plural/selectordinal categories against this locale.
   * @returns {string}
   * @throws {ContentError} INVALID_MESSAGE
   */
  static of(value, locale = 'en') {
    const names = new Set();
    const p = new MessageParser(value, locale, names);
    p.message(0, false);
    return [...names].sort().join(',');
  }

  /** @param {string} joined */
  static list(joined) {
    return joined ? joined.split(',') : [];
  }
}

/** Recursive-descent parser for the ICU MessageFormat subset described on {@link Placeholders}. */
class MessageParser {
  /** @param {string} src @param {string} locale @param {Set<string>} names */
  constructor(src, locale, names) {
    this.src = src;
    this.i = 0;
    this.locale = locale;
    this.names = names;
  }

  /** @param {string} why @returns {never} */
  fail(why) {
    throw new ContentError('INVALID_MESSAGE', `${why} (at character ${this.i + 1})`);
  }

  ws() { while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++; }

  /** Name-like token at the cursor (argument names, selectors, types). */
  word() {
    const m = /^[^\s{},]+/.exec(this.src.slice(this.i));
    if (!m) return '';
    this.i += m[0].length;
    return m[0];
  }

  /**
   * Text and arguments up to the end, or (nested) up to the `}` closing a sub-message.
   * @param {number} depth @param {boolean} nested
   */
  message(depth, nested) {
    const s = this.src;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "'") {
        // '' is a literal apostrophe; '{…' quotes up to the next apostrophe.
        if (s[this.i + 1] === "'") { this.i += 2; continue; }
        if (s[this.i + 1] === '{' || s[this.i + 1] === '}' || (nested && s[this.i + 1] === '#')) {
          const end = s.indexOf("'", this.i + 1);
          this.i = end === -1 ? s.length : end + 1;
          continue;
        }
        this.i++;
        continue;
      }
      if (c === '}') {
        if (nested) return;
        this.i++; // a stray } at the top level is text
        continue;
      }
      if (c === '{') {
        const start = this.i;
        if (!this.argument(depth)) { this.i = start + 1; continue; } // not an argument: literal {
        continue;
      }
      this.i++;
    }
    if (nested) this.fail('a sub-message is missing its closing }');
  }

  /**
   * At `{`. Returns false (cursor untouched by the caller) when this is not an argument at all.
   * @param {number} depth
   */
  argument(depth) {
    this.i++;
    this.ws();
    const name = this.word();
    if (!Placeholders.NAME.test(name)) return false;
    this.ws();
    if (this.src[this.i] === '}') { this.i++; this.names.add(name); return true; }
    if (this.src[this.i] !== ',') return false;
    // From here on it is clearly meant as an ICU argument: errors are reported, not ignored.
    this.names.add(name);
    this.i++;
    this.ws();
    const type = this.word();
    this.ws();
    if (Placeholders.SIMPLE_TYPES.has(type)) {
      if (this.src[this.i] === ',') {
        const end = this.src.indexOf('}', this.i);
        if (end === -1) this.fail(`{${name}, ${type}, …} is missing its closing }`);
        if (this.src.slice(this.i, end).includes('{')) this.fail(`the style of {${name}, ${type}} cannot contain {`);
        this.i = end;
      }
      if (this.src[this.i] !== '}') this.fail(`{${name}, ${type}} is missing its closing }`);
      this.i++;
      return true;
    }
    if (type !== 'plural' && type !== 'select' && type !== 'selectordinal') this.fail(`unknown argument type "${type}" in {${name}, …}; use number, date, time, plural, select or selectordinal`);
    if (depth >= 8) this.fail('arguments are nested more than 8 levels deep');
    if (this.src[this.i] !== ',') this.fail(`{${name}, ${type}} needs options: {${name}, ${type}, … other {…}}`);
    this.i++;
    this.ws();
    if (type !== 'select' && this.src.startsWith('offset:', this.i)) {
      this.i += 7;
      if (!/^\d+$/.test(this.word())) this.fail(`offset in {${name}, ${type}} must be a whole number`);
      this.ws();
    }
    const allowed = type === 'select' ? null : MessageParser.categories(this.locale, type === 'selectordinal' ? 'ordinal' : 'cardinal');
    const seen = new Set();
    while (this.i < this.src.length && this.src[this.i] !== '}') {
      const selector = this.word();
      if (!selector) this.fail(`expected a selector in {${name}, ${type}}`);
      if (type === 'select' ? !/^[A-Za-z0-9_-]+$/.test(selector) : !(/^=\d+$/.test(selector) || allowed?.has(selector))) {
        this.fail(type === 'select'
          ? `"${selector}" is not a valid select key`
          : `"${selector}" is not a ${type === 'plural' ? 'plural' : 'ordinal'} category of ${this.locale} (${[...(allowed ?? [])].join(', ')}, or =N)`);
      }
      if (seen.has(selector)) this.fail(`"${selector}" appears twice in {${name}, ${type}}`);
      seen.add(selector);
      this.ws();
      if (this.src[this.i] !== '{') this.fail(`"${selector}" in {${name}, ${type}} needs a {message}`);
      this.i++;
      this.message(depth + 1, true);
      this.i++; // the sub-message's }
      this.ws();
    }
    if (this.src[this.i] !== '}') this.fail(`{${name}, ${type}, …} is missing its closing }`);
    if (!seen.has('other')) this.fail(`{${name}, ${type}} needs an "other" option`);
    this.i++;
    return true;
  }

  /** @type {Map<string, Set<string>>} */
  static #cache = new Map();

  /** Plural categories CLDR defines for a locale. @param {string} locale @param {'cardinal'|'ordinal'} type */
  static categories(locale, type) {
    const k = `${locale}|${type}`;
    let set = MessageParser.#cache.get(k);
    if (!set) {
      set = new Set(new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories);
      MessageParser.#cache.set(k, set);
    }
    return set;
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
