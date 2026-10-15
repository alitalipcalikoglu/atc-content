/** JSON Schemas for the HTTP surface. Locales are canonicalised and checked in the domain layer. */
export class Schemas {
  static ns = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' };
  static key = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,127}$' };
  static locale = { type: 'string', minLength: 2, maxLength: 35 };
  static description = { type: 'string', maxLength: 500 };
  static note = { type: 'string', maxLength: 500 };
  static release = { type: 'integer', minimum: 1, maximum: 1_000_000_000 };

  /**
   * @param {string[]} required
   * @param {Record<string, object>} properties
   */
  static body(required, properties) {
    return { type: 'object', additionalProperties: false, required, properties };
  }

  static fallback = { anyOf: [Schemas.locale, { type: 'null' }] };
  static createNamespace = Schemas.body(['name', 'defaultLocale'], {
    name: Schemas.ns, defaultLocale: Schemas.locale, description: Schemas.description,
    locales: { type: 'array', maxItems: 500, items: Schemas.body(['locale'], { locale: Schemas.locale, fallback: Schemas.fallback }) },
  });
  static patchNamespace = { type: 'object', additionalProperties: false, minProperties: 1, properties: { description: Schemas.description, defaultLocale: Schemas.locale } };
  static putLocale = Schemas.body([], { fallback: Schemas.fallback });
  /** Value types and lengths are checked in the domain so import and single edits share one rule. */
  static putKey = Schemas.body([], {
    description: Schemas.description,
    values: { type: 'object', maxProperties: 500, additionalProperties: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  });
  static importBody = Schemas.body(['locale', 'strings'], { locale: Schemas.locale, strings: { type: 'object' } });
  static publish = Schemas.body([], { note: Schemas.note });
  static rollback = Schemas.body(['release'], { release: Schemas.release, note: Schemas.note, restoreDraft: { type: 'boolean' } });

  static nsParams = { type: 'object', properties: { ns: Schemas.ns }, required: ['ns'] };
  static localeParams = { type: 'object', properties: { ns: Schemas.ns, locale: Schemas.locale }, required: ['ns', 'locale'] };
  static keyParams = { type: 'object', properties: { ns: Schemas.ns, key: Schemas.key }, required: ['ns', 'key'] };
  static releaseParams = { type: 'object', properties: { ns: Schemas.ns, number: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } }, required: ['ns', 'number'] };

  static keysQuery = {
    type: 'object', additionalProperties: false,
    properties: {
      q: { type: 'string', minLength: 1, maxLength: 120 }, missing: Schemas.locale,
      review: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, reviewLocale: Schemas.locale,
      limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' }, cursor: Schemas.key,
    },
  };
  static review = {
    type: 'object', additionalProperties: false, required: ['items', 'decision'],
    properties: {
      decision: { type: 'string', enum: ['approve', 'reject'] },
      note: { type: 'string', maxLength: 500 },
      items: {
        type: 'array', minItems: 1, maxItems: 500,
        items: { type: 'object', additionalProperties: false, required: ['key', 'locale'], properties: { key: Schemas.key, locale: Schemas.locale, value: { type: 'string', maxLength: 1_000_000 } } },
      },
    },
  };
  static exportQuery = { type: 'object', additionalProperties: false, properties: { source: { type: 'string', enum: ['draft', 'published'] }, format: { type: 'string', enum: ['flat', 'nested'] } } };
  static releasesQuery = { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' }, before: { type: 'string', pattern: '^[0-9]{1,10}$' } } };
}
