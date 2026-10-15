import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/atc-service-core/config';
import { EventPublisher } from './events/event-publisher.js';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.webhookOut = v.webhookOut;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.actorKeys = v.actorKeys;
    this.publicBundles = v.publicBundles;
    this.rateLimitMax = v.rateLimitMax;
    this.limits = Object.freeze({ ...v.limits });
    Object.freeze(this);
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    const apiKeys = Config.#parseApiKeys(r.required('CONTENT_API_KEYS'));
    return new Config({
      port: r.integer('PORT', 3013, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      webhookOut: EventPublisher.parseEnv(r, ConfigError),
      bodyLimit: r.integer('BODY_LIMIT', 1_048_576, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/content.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys,
      actorKeys: Config.#actorKeys(r, apiKeys),
      publicBundles: r.boolean('CONTENT_PUBLIC_BUNDLES', false),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 1_200, { min: 1 }),
      limits: {
        maxValueLength: r.integer('MAX_VALUE_LENGTH', 4_096, { min: 16, max: 1_000_000 }),
        maxKeysPerNamespace: r.integer('MAX_KEYS_PER_NAMESPACE', 20_000, { min: 1 }),
        maxLocalesPerNamespace: r.integer('MAX_LOCALES_PER_NAMESPACE', 50, { min: 1, max: 500 }),
        releaseRetention: r.integer('RELEASE_RETENTION', 100, { min: 1 }),
        publishRequiresReview: r.boolean('PUBLISH_REQUIRES_REVIEW', false),
      },
    });
  }

  /**
   * `ACTOR_KEYS`: ids of keys allowed to name the acting person in `X-Actor` (the console).
   * @param {EnvReader} r @param {ApiKey[]} apiKeys
   */
  static #actorKeys(r, apiKeys) {
    const ids = r.optional('ACTOR_KEYS').split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) if (!apiKeys.some((k) => k.id === id)) throw new ConfigError(`ACTOR_KEYS names "${id}", which is not a key id in the API keys`);
    return ids;
  }

  /**
   * Parse `id:secret[:role]`. Role defaults to `readwrite`.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'CONTENT_API_KEYS', { roles: ['read', 'write', 'readwrite'], scopePattern: /^[a-z][a-z0-9-]{0,63}$/, scopeNoun: 'namespace', minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read, write or readwrite' })
      .map(({ id, secret, role, scopes }) => ({ id, secret, role: /** @type {KeyRole} */ (role), scopes }));
  }
}
