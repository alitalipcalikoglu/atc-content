import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/atc-service-core/auth';
import { ContentError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/**
 * Bearer API-key authentication with read/write roles. Thin wrapper over service-core's
 * `ApiKeyAuth`; routes marked `config.publicRead` may also be called without any key when public
 * bundles are enabled.
 */
export class ApiKeyAuth {
  /** @param {ApiKey[]} apiKeys @param {{ publicReads: boolean }} opts */
  constructor(apiKeys, { publicReads }) {
    this.core = new CoreApiKeyAuth(apiKeys);
    this.publicReads = publicReads;
  }

  /**
   * Fastify `onRequest` hook. A request without an `Authorization` header passes as anonymous
   * only on a public route while public reads are on; a presented key is always verified.
   * @type {import('fastify').onRequestAsyncHookHandler}
   */
  hook = async (request, reply) => {
    if (this.publicReads && request.headers.authorization === undefined && /** @type {any} */ (request.routeOptions.config).publicRead === true) return;
    return this.core.hook(request, reply);
  };

  /**
   * Route-level guard on role. `allowAnonymous` lets requests the hook passed without a key through.
   * @param {'read'|'write'} need
   * @param {{ allowAnonymous?: boolean }} [opts]
   */
  static require(need, { allowAnonymous = false } = {}) {
    const check = CoreApiKeyAuth.require(need, {
      roleOf: (request) => request.apiKey?.role,
      makeError: (n) => new ContentError('FORBIDDEN', `this API key has no ${n} access`),
    });
    /** @param {import('fastify').FastifyRequest} request */
    return async (request) => {
      if (allowAnonymous && request.apiKey === null) return;
      return check(request);
    };
  }
}
