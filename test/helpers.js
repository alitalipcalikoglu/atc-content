import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { ContentService } from '../src/domain/content-service.js';
import { ContentStore } from '../src/store/content-store.js';
import { ReleaseStore } from '../src/store/release-store.js';

export const RW_KEY = 'k'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const WRITE_KEY = 'w'.repeat(40);

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return {
    PORT: '0',
    CONTENT_API_KEYS: `console:${RW_KEY},web-app:${READ_KEY}:read,translator:${WRITE_KEY}:write`,
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

/** @param {Record<string, string>} [overrides] */
export function testConfig(overrides) {
  return Config.fromEnv(testEnv(overrides));
}

/**
 * Wired domain objects over an in-memory database.
 * @param {Record<string, string>} [overrides]
 * @param {() => number} [clock]
 */
export function testService(overrides, clock) {
  const config = testConfig(overrides);
  const db = new Database(':memory:');
  const content = new ContentStore(db);
  const releases = new ReleaseStore(db);
  const service = new ContentService({ db, content, releases, limits: config.limits, clock });
  return { config, db, content, releases, service };
}



/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}

/** A steadily advancing clock so ordering by time is deterministic. */
export function tickingClock(start = 1_700_000_000_000) {
  let t = start;
  return () => (t += 1_000);
}
