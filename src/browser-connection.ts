import { MandalaError, ValidationError } from './errors.js';
import { LIMITS } from './limits.js';
import { isRecord } from './paths.js';

/** Opt in to bounded version 2 leases. autoRenew is used by browser toolsets only. */
export interface BrowserSessionPolicy {
  leaseSeconds?: number;
  maxDurationSeconds?: number;
  autoRenew?: boolean;
}

export function browserSessionOptions(policy: BrowserSessionPolicy): {
  lifecycle_version: 2;
  lease_seconds: number;
  max_duration_seconds: number;
} {
  if (!isRecord(policy)) throw new ValidationError('sessionPolicy must be an object');
  const lease =
      policy.leaseSeconds === undefined
        ? LIMITS['browser.defaultLeaseSeconds']
        : policy.leaseSeconds,
    maximum =
      policy.maxDurationSeconds === undefined
        ? LIMITS['browser.maximumSessionSeconds']
        : policy.maxDurationSeconds;
  if (
    typeof lease !== 'number' ||
    typeof maximum !== 'number' ||
    !Number.isInteger(lease) ||
    !Number.isInteger(maximum) ||
    lease < LIMITS['browser.minimumLeaseSeconds'] ||
    maximum < lease ||
    maximum > LIMITS['browser.maximumSessionSeconds'] ||
    (policy.autoRenew !== undefined && typeof policy.autoRenew !== 'boolean')
  )
    throw new ValidationError(
      'browser lease/max duration must be integers with 60 <= lease <= maximum <= 7200; autoRenew must be boolean',
    );
  return { lifecycle_version: 2, lease_seconds: lease, max_duration_seconds: maximum };
}

/** Immutable deadline snapshot for one existing browser connection. */
export class BrowserSessionLease {
  readonly id: string;
  readonly leaseSeconds: number;
  readonly idleTimeoutSeconds = 0;
  readonly #times: number[];
  private constructor(id: string, lease: number, times: number[]) {
    this.id = id;
    this.leaseSeconds = lease;
    this.#times = times;
    Object.freeze(this);
  }
  get serverTime(): Date {
    return new Date(this.#times[0]!);
  }
  get attachExpiresAt(): Date {
    return new Date(this.#times[1]!);
  }
  get leaseExpiresAt(): Date {
    return new Date(this.#times[2]!);
  }
  get absoluteExpiresAt(): Date {
    return new Date(this.#times[3]!);
  }
  static fromApi(data: unknown, id: string): BrowserSessionLease {
    const invalid = () => new MandalaError('invalid browser session lease response');
    if (
      !isRecord(data) ||
      data.id !== id ||
      data.lifecycle_version !== 2 ||
      data.idle_timeout_seconds !== 0 ||
      !Number.isInteger(data.lease_seconds) ||
      Number(data.lease_seconds) < LIMITS['browser.minimumLeaseSeconds'] ||
      Number(data.lease_seconds) > LIMITS['browser.maximumSessionSeconds']
    )
      throw invalid();
    const times = [
      'server_time',
      'attach_expires_at',
      'lease_expires_at',
      'absolute_expires_at',
    ].map((key) => {
      const value = data[key];
      if (
        typeof value !== 'string' ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
        !Number.isFinite(Date.parse(value))
      )
        throw invalid();
      return Date.parse(value);
    });
    const [now, attach, lease, absolute] = times as [number, number, number, number];
    if (
      !(
        attach <= lease &&
        lease <= absolute &&
        now < lease &&
        absolute - now <= LIMITS['browser.maximumSessionSeconds'] * 1000 &&
        lease - now <= Number(data.lease_seconds) * 1000
      )
    )
      throw invalid();
    return new BrowserSessionLease(id, Number(data.lease_seconds), times);
  }
}

/** A revocable capability. Version 2 expiresAt is only the attachment deadline. */
export class BrowserConnection {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: Date;
  readonly lease: BrowserSessionLease | undefined;
  readonly #token: string;

  private constructor(
    id: string,
    url: string,
    token: string,
    expiresAt: Date,
    lease?: BrowserSessionLease,
  ) {
    this.id = id;
    this.url = url;
    this.#token = token;
    this.expiresAt = expiresAt;
    this.lease = lease;
  }

  /** Secret: send as Authorization: Bearer, never in a URL or model context. */
  get token(): string {
    return this.#token;
  }

  static fromApi(
    data: unknown,
    baseUrl: string,
    path: string,
    policy?: BrowserSessionPolicy,
  ): BrowserConnection {
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
    const lease =
      data.lifecycle_version !== undefined || policy !== undefined
        ? BrowserSessionLease.fromApi(data, data.id)
        : undefined;
    if (
      lease &&
      (lease.attachExpiresAt.getTime() !== expiresAt.getTime() ||
        (policy &&
          (lease.leaseSeconds !== browserSessionOptions(policy).lease_seconds ||
            (lease.absoluteExpiresAt.getTime() - lease.serverTime.getTime()) / 1000 >
              browserSessionOptions(policy).max_duration_seconds)))
    )
      throw invalid();
    return new BrowserConnection(data.id, expected.href, data.token, expiresAt, lease);
  }
}

export function connectionId(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
    throw new ValidationError('connectionId must be a 32-character lowercase hexadecimal id');
  }
  return value;
}
