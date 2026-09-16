import {
  type CredentialProfile,
  canonicalBase,
  trimCredentialWhitespace,
  validateCredentialProfile,
} from './credentials-browser.js';
import { MandalaError } from './errors.js';

export class DeviceLoginError extends MandalaError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const guidance =
  'Check the device-named key in Settings and revoke it before a fresh explicit login if issuance or delivery is uncertain.';
function invalid(): never {
  throw new DeviceLoginError(
    'invalid_device_response',
    `Invalid device login response. ${guidance}`,
  );
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  object(v) && keys.length === Object.keys(v).length && keys.every((key) => Object.hasOwn(v, key));
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 600;
const positiveRetry = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const boundedText = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  Array.from(v).every(
    (c) => c.charCodeAt(0) > 31 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159),
  );
export type DevicePrompt = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
};
export type DeviceLoginOptions = {
  baseUrl: string;
  deviceName: string;
  workspace?: string;
  signal: AbortSignal;
};
export type DeviceLoginDependencies = {
  fetch: typeof globalThis.fetch;
  /** Monotonic clock for the original grant lifetime. */
  now: () => number;
  /** Wall clock used only to interpret HTTP-date Retry-After values. */
  wallNow?: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  prompt: (value: DevicePrompt) => Promise<void>;
  registerSecret: (secret: string) => void;
  diagnostic: (message: string) => void;
};

function deviceRetryAfterSeconds(header: string | null, wallNow: () => number): number {
  if (!header) return 0;
  const value = header.trim();
  if (/^[0-9]+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : 0;
  }
  const httpDate =
    /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/;
  if (!httpDate.test(value)) return 0;
  const at = Date.parse(value.endsWith(' GMT') ? value : `${value} GMT`);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - wallNow()) / 1000)) : 0;
}
export const sleepForLogin = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
function raceAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    value
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {});
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (
    !response.body ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
  )
    invalid();
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      length += value.length;
      if (length > 16_384) invalid();
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const part of chunks) {
      bytes.set(part, at);
      at += part.length;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
      invalid();
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Anonymous, explicit bootstrap. This state machine never changes resource transport retries. */
export async function deviceLogin(
  options: DeviceLoginOptions,
  deps: DeviceLoginDependencies,
): Promise<CredentialProfile> {
  const baseUrl = canonicalBase(options.baseUrl);
  const origin = new URL(baseUrl).origin;
  // The public protocol lives at the control-plane origin, independently of the bearer API prefix.
  if (
    !boundedText(options.deviceName, 60) ||
    trimCredentialWhitespace(options.deviceName) !== options.deviceName
  )
    throw new DeviceLoginError(
      'invalid_device_name',
      'Device name must contain 1–60 characters without controls.',
    );
  // Workspace request names use the service's name trimming, independently of
  // the fixed whitespace algorithm for stored credentials and profile names.
  const workspace =
    typeof options.workspace === 'string' ? options.workspace.trim() : options.workspace;
  if (workspace !== undefined && !boundedText(workspace, 40))
    throw new DeviceLoginError(
      'invalid_workspace',
      'Workspace name must contain 1–40 characters without controls.',
    );
  const { signal } = options;
  signal.throwIfAborted();
  const deadline = deps.now() + 600_000;
  let secret: string | undefined;
  let collecting = false;
  let uncertain = false;
  let cancelled = false;
  async function post(
    endpoint: 'start' | 'poll',
    body: object,
    cleanup = false,
  ): Promise<{ status: number; data: unknown; retryAfter: number }> {
    const controller = new AbortController();
    const remaining = cleanup ? 2000 : Math.min(10_000, deadline - deps.now());
    if (remaining <= 0)
      throw new DeviceLoginError(
        'expired_token',
        'Device login expired. Run mandala login again to start a new exchange.',
      );
    const timer = setTimeout(
      () =>
        controller.abort(
          new DeviceLoginError('connection_timeout', 'Device login request timed out.'),
        ),
      remaining,
    );
    const abort = () => controller.abort(signal.reason);
    if (!cleanup) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    try {
      const response = await raceAbort(
        deps.fetch(`${origin}/api/auth/device/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (response.status >= 300 && response.status < 400) invalid();
      const data = await readResponse(response, controller.signal);
      return {
        status: response.status,
        data,
        retryAfter: deviceRetryAfterSeconds(
          response.headers.get('retry-after'),
          deps.wallNow ?? Date.now,
        ),
      };
    } catch (error) {
      if (error instanceof DeviceLoginError || signal.aborted) throw error;
      throw new DeviceLoginError('connection_failed', 'Device login connection failed.');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  const failure = (
    data: unknown,
    status: number,
  ): { code: string; retry: number; interval: number } => {
    if (
      !object(data) ||
      !boundedText(data.code, 64) ||
      !boundedText(data.error, 512) ||
      !boundedText(data.request_id, 128) ||
      Object.keys(data).some(
        (key) => !['error', 'code', 'request_id', 'retry_after', 'interval'].includes(key),
      ) ||
      (data.retry_after !== undefined && !positiveRetry(data.retry_after)) ||
      (data.interval !== undefined && !positive(data.interval))
    )
      invalid();
    const retryable =
      (status === 429 && ['slow_down', 'rate_limited'].includes(data.code)) ||
      (status === 503 && data.code === 'temporarily_unavailable');
    if (retryable) {
      if (data.code === 'slow_down' && !positive(data.interval)) invalid();
      return {
        code: data.code,
        retry: (data.retry_after as number | undefined) ?? 0,
        interval: (data.interval as number | undefined) ?? 0,
      };
    }
    const terminal: Record<string, number[]> = {
      invalid_request: [400, 413],
      invalid_device_code: [400],
      expired_token: [400],
      access_denied: [403],
      cancelled: [400],
      already_consumed: [409],
      key_limit: [400],
      request_timeout: [408],
    };
    if (!Object.hasOwn(terminal, data.code) || !terminal[data.code]!.includes(status)) invalid();
    throw new DeviceLoginError(
      data.code,
      `Device login stopped (${data.code}). ${data.code === 'already_consumed' || uncertain ? guidance : 'Start a new login explicitly when ready.'}`,
    );
  };
  try {
    const start = await post(
      'start',
      workspace === undefined
        ? { device_name: options.deviceName, scope: 'account' }
        : {
            device_name: options.deviceName,
            scope: 'workspace',
            workspace_name: workspace,
          },
    );
    const d = start.data;
    if (object(d) && typeof d.device_code === 'string') deps.registerSecret(d.device_code);
    if (start.status !== 200) {
      failure(d, start.status);
      throw new DeviceLoginError(
        'start_unavailable',
        'Device login is temporarily unavailable. Try a new explicit login later.',
      );
    }
    if (
      !hasKeys(d, [
        'device_code',
        'user_code',
        'verification_uri',
        'verification_uri_complete',
        'expires_in',
        'interval',
      ]) ||
      typeof d.device_code !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(d.device_code) ||
      typeof d.user_code !== 'string' ||
      !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(
        d.user_code,
      ) ||
      d.expires_in !== 600 ||
      d.interval !== 5 ||
      d.verification_uri !== `${origin}/device` ||
      d.verification_uri_complete !== `${origin}/device?user_code=${d.user_code}`
    )
      invalid();
    secret = d.device_code;
    await raceAbort(
      deps.prompt({
        userCode: d.user_code,
        verificationUri: d.verification_uri as string,
        verificationUriComplete: d.verification_uri_complete as string,
      }),
      signal,
    );
    let interval = d.interval * 1000;
    let delay = interval;
    let failures = 0;
    for (;;) {
      signal.throwIfAborted();
      const left = deadline - deps.now();
      if (left <= delay) {
        if (left > 0) await deps.sleep(left, signal);
        throw new DeviceLoginError(
          'expired_token',
          `Device login expired. ${uncertain ? guidance : 'Run mandala login again to start a new exchange.'}`,
        );
      }
      await deps.sleep(delay, signal);
      signal.throwIfAborted();
      collecting = true;
      let reply: Awaited<ReturnType<typeof post>>;
      try {
        reply = await post('poll', { device_code: secret, action: 'poll' });
      } catch (error) {
        if (signal.aborted) throw error;
        if (
          !(error instanceof DeviceLoginError) ||
          !['connection_failed', 'connection_timeout'].includes(error.code)
        )
          throw error;
        uncertain = true;
        failures++;
        delay = Math.max(interval, Math.min(60_000, 5000 * 2 ** Math.min(failures, 4)));
        deps.diagnostic(
          'Connection interrupted; checking the same exchange after backoff. Issuance may already have occurred.',
        );
        continue;
      }
      signal.throwIfAborted();
      if (deps.now() >= deadline)
        throw new DeviceLoginError(
          'expired_token',
          `Device login expired before collection finished. ${guidance}`,
        );
      const data = reply.data;
      if (object(data) && typeof data.api_key === 'string') deps.registerSecret(data.api_key);
      failures = 0;
      if (reply.status === 202) {
        if (
          !hasKeys(data, ['status', 'interval']) ||
          data.status !== 'pending' ||
          !positive(data.interval)
        )
          invalid();
        interval = Math.max(interval, data.interval * 1000);
        delay = Math.max(interval, reply.retryAfter * 1000);
        continue;
      }
      if (reply.status !== 200) {
        const retry = failure(data, reply.status);
        interval = Math.max(interval, retry.interval * 1000);
        delay = Math.max(interval, retry.retry * 1000, reply.retryAfter * 1000);
        continue;
      }
      if (hasKeys(data, ['status']) && data.status === 'cancelled')
        throw new DeviceLoginError('cancelled', 'Device login was cancelled.');
      if (
        !hasKeys(data, ['status', 'api_key', 'key', 'account', 'scope']) ||
        data.status !== 'authorized' ||
        !hasKeys(data.key, ['id', 'name', 'created_at']) ||
        !boundedText(data.key.name, 60) ||
        typeof data.key.created_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(data.key.created_at) ||
        !Number.isFinite(Date.parse(data.key.created_at))
      )
        invalid();
      const entry = {
        api_key: data.api_key,
        base_url: baseUrl,
        key_id: data.key.id,
        account: data.account,
        scope: data.scope,
      };
      try {
        validateCredentialProfile(entry);
      } catch {
        invalid();
      }
      // Requested scope is an invariant, never silently widened by a response.
      if (
        workspace === undefined
          ? entry.scope.type !== 'account'
          : entry.scope.type !== 'workspace' ||
            entry.scope.workspace_name.toLowerCase() !== workspace.toLowerCase()
      )
        invalid();
      entry.api_key = trimCredentialWhitespace(entry.api_key);
      signal.throwIfAborted();
      return entry;
    }
  } catch (error) {
    if (signal.aborted && secret && !cancelled) {
      cancelled = true;
      try {
        const reply = await post('poll', { device_code: secret, action: 'cancel' }, true);
        if (
          !hasKeys(reply.data, ['status']) ||
          reply.status !== 200 ||
          reply.data.status !== 'cancelled'
        )
          uncertain = true;
      } catch {
        uncertain = true;
      }
      if (collecting || uncertain)
        deps.diagnostic(`Cancelled; issuance may already have occurred. ${guidance}`);
    }
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}
