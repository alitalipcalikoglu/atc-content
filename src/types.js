/**
 * Shared JSDoc typedefs for the content service. No runtime exports.
 */

/** @typedef {'read'|'write'|'readwrite'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 * @property {string[]|null} scopes  Namespaces this key may reach; null = all.
 */

/**
 * @typedef {object} Limits
 * @property {number} maxValueLength          Characters per translated value.
 * @property {number} maxKeysPerNamespace
 * @property {number} maxLocalesPerNamespace
 * @property {number} releaseRetention        Releases kept per namespace; older ones are pruned on publish.
 */

/**
 * Plain values accepted by the `Config` constructor.
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit   Audit service to forward events to; null = off.
 * @property {{ url: string, apiKey: string, timeoutMs: number }|null} webhookOut  atc-webhook-out target for events; null = off.
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string} [dbBackupDir]
 * @property {ApiKey[]} apiKeys
 * @property {string[]} actorKeys   Key ids whose `X-Actor` header names the acting person.
 * @property {boolean} publicBundles   Serve `GET /v1/bundles/*` without a key.
 * @property {number} rateLimitMax
 * @property {Limits} limits
 */

/**
 * @typedef {object} NamespaceRow
 * @property {string} name
 * @property {string} default_locale
 * @property {string} description
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 * @property {number} draft_updated_at
 * @property {number} draft_version
 * @property {number|null} published_version
 */

/**
 * @typedef {object} LocaleRow
 * @property {string} ns
 * @property {string} locale
 * @property {string|null} fallback
 * @property {number} created_at
 */

/**
 * @typedef {object} KeyRow
 * @property {string} ns
 * @property {string} key
 * @property {string} description
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {object} TranslationRow
 * @property {string} ns
 * @property {string} key
 * @property {string} locale
 * @property {string} value
 * @property {string} placeholders   Sorted, comma-joined names.
 * @property {string} updated_by
 * @property {number} updated_at
 */

/**
 * @typedef {object} ReleaseRow
 * @property {string} ns
 * @property {number} number
 * @property {string} note
 * @property {number|null} rollback_of
 * @property {number} key_count
 * @property {string} created_by
 * @property {number} created_at
 */

/**
 * Whole published namespace, stored as JSON on the release.
 * @typedef {object} ReleaseContent
 * @property {string} defaultLocale
 * @property {{ locale: string, fallback: string|null }[]} locales
 * @property {Record<string, { description: string, values: Record<string, string> }>} keys
 */

/**
 * @typedef {object} ImportReport
 * @property {string} locale
 * @property {number} added
 * @property {number} updated
 * @property {number} unchanged
 * @property {number} invalidCount
 * @property {{ key: string, reason: string }[]} invalid   First 100 rejected entries.
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
