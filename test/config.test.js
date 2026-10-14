import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults and key roles', () => {
  const c = Config.fromEnv(testEnv());
  assert.equal(c.port, 0);
  assert.equal(Config.fromEnv(testEnv({ PORT: '' })).port, 3013);
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role]), [['console', 'readwrite'], ['web-app', 'read'], ['translator', 'write']]);
  assert.equal(c.publicBundles, false);
  assert.equal(Config.fromEnv(testEnv({ CONTENT_PUBLIC_BUNDLES: 'true' })).publicBundles, true);
  assert.deepEqual(c.limits, { maxValueLength: 4096, maxKeysPerNamespace: 20000, maxLocalesPerNamespace: 50, releaseRetention: 100 });
  assert.equal(c.audit, null);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.limits));
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ CONTENT_API_KEYS: '' }, /CONTENT_API_KEYS is required/);
  bad({ CONTENT_API_KEYS: 'a:short' }, /at least 32/);
  bad({ CONTENT_API_KEYS: `a:${'a'.repeat(40)}:owner` }, /read, write or readwrite/);
  bad({ CONTENT_API_KEYS: `a:${'a'.repeat(40)}:read:extra` }, /id:secret\[:role\]/);
  bad({ CONTENT_API_KEYS: `a:${'a'.repeat(40)},b:${'a'.repeat(40)}` }, /unique/);
  bad({ TLS_CERT_PATH: '/x.pem' }, /must be set together/);
  bad({ AUDIT_URL: 'http://audit' }, /must be set together/);
  bad({ RELEASE_RETENTION: '0' }, /RELEASE_RETENTION/);
});
