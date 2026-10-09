import { MandalaError, ValidationError } from './errors.js';
import { isRecord } from './paths.js';

/** A revocable, ten-minute capability. Expiration closes attached CDP sockets too. */
export class BrowserConnection {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: Date;
  readonly #token: string;

  private constructor(id: string, url: string, token: string, expiresAt: Date) {
    this.id = id;
    this.url = url;
    this.#token = token;
    this.expiresAt = expiresAt;
  }

  /** Secret: send as Authorization: Bearer, never in a URL or model context. */
  get token(): string {
    return this.#token;
  }

  static fromApi(data: unknown, baseUrl: string, path: string): BrowserConnection {
    const invalid = () => new MandalaError('invalid browser connection response');
    if (
      !isRecord(data) ||
      typeof data.id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(data.id) ||
      typeof data.token !== 'string' ||
      !/^bcdp_[0-9a-f]{64}$/.test(data.token) ||
      typeof data.expires_at !== 'string'
    )
      throw invalid();
    const expected = new URL(`${baseUrl}/${path}/${data.id}/cdp`);
    expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
    const expiresAt = new Date(data.expires_at);
    if (
      data.url !== expected.href ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(data.expires_at) ||
      !Number.isFinite(expiresAt.getTime())
    )
      throw invalid();
    return new BrowserConnection(data.id, expected.href, data.token, expiresAt);
  }
}

export function connectionId(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
    throw new ValidationError('connectionId must be a 32-character lowercase hexadecimal id');
  }
  return value;
}
