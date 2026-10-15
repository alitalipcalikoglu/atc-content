/**
 * Domain error with a stable machine-readable code and the HTTP status the API maps it to.
 */
export class ContentError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    NAMESPACE_NOT_FOUND: 404,
    NAMESPACE_EXISTS: 409,
    LOCALE_NOT_FOUND: 404,
    KEY_NOT_FOUND: 404,
    RELEASE_NOT_FOUND: 404,
    NOT_PUBLISHED: 404,
    INVALID_LOCALE: 400,
    INVALID_FALLBACK: 400,
    INVALID_VALUE: 400,
    INVALID_MESSAGE: 400,
    DEFAULT_REQUIRED: 400,
    PLACEHOLDER_MISMATCH: 400,
    LOCALE_IN_USE: 409,
    NESTED_CONFLICT: 409,
    UNPUBLISHABLE: 409,
    LIMIT_EXCEEDED: 409,
    INVALID_CURSOR: 400,
    FORBIDDEN: 403,
  };

  /**
   * @param {keyof typeof ContentError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
    this.statusCode = ContentError.STATUS[code];
    this.details = details;
  }
}
