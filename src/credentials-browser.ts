import { MandalaError } from './errors.js';

/** The credential schema is shared by the CLI and local SDKs. This module has no Node imports. */
export type CredentialProfile = {
  api_key: string;
  base_url: string;
  key_id: string;
  account: { id: string; name: string | null };
  scope: { type: 'account' } | { type: 'workspace'; workspace_id: string; workspace_name: string };
};
export type CredentialsFile = {
  version: 1;
  default_profile: string;
  profiles: Record<string, CredentialProfile>;
};
export type CredentialOptions = { apiKey?: string; baseUrl?: string; profile?: string };
export type CredentialEnvironment = Record<string, string | undefined>;
export type ResolvedCredentials = {
  apiKey: string;
  baseUrl: string;
  source: 'explicit' | 'environment' | 'file';
  profile?: string;
};
export const DEFAULT_CREDENTIAL_BASE = 'https://app.mandala.computer/api/v1';
export const MAX_CREDENTIAL_BYTES = 65_536;

/** Codes identify the failed local stage; messages never include file contents or option values. */
export class CredentialsError extends MandalaError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function credentialError(code: string): never {
  const instructions =
    code === 'missing_credentials'
      ? 'No API key. Pass apiKey, set MANDALA_API_KEY, or run mandala login (or create a key at Settings → API keys).'
      : `Cannot use local credentials (${code}). Check ~/.mandala/credentials.json or run mandala login; explicit API-key authentication remains available.`;
  throw new CredentialsError(code, instructions);
}

const trimCodePoint = (c: number): boolean =>
  (c >= 9 && c <= 13) ||
  c === 32 ||
  c === 133 ||
  c === 160 ||
  c === 5760 ||
  (c >= 8192 && c <= 8202) ||
  c === 8232 ||
  c === 8233 ||
  c === 8239 ||
  c === 8287 ||
  c === 12288 ||
  c === 65279;
export function trimCredentialWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && trimCodePoint(value.charCodeAt(start))) start++;
  while (end > start && trimCodePoint(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}
const reserved = new Set([
  '__proto__',
  'prototype',
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  'hasOwnProperty',
  '__lookupGetter__',
  '__lookupSetter__',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);
export function validateProfileName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[A-Za-z0-9]/.test(value) ||
    /[^A-Za-z0-9._-]/.test(value) ||
    reserved.has(value)
  )
    credentialError('invalid_profile');
}

const strictIpv4 = (host: string): boolean => {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]*)$/.test(p) && Number(p) <= 255);
};

/** A deliberately narrow, cross-language URL grammar for file-bound keys and login targets. */
export function canonicalBase(value: unknown): string {
  if (typeof value !== 'string') credentialError('invalid_base_url');
  const text = trimCredentialWhitespace(value);
  if (!text || text.length > 2048 || /[^\x21-\x7e]|[\\%?#]/.test(text))
    credentialError('invalid_base_url');
  const match = /^(https?):\/\/([^/]+)(.*)$/i.exec(text);
  if (!match) credentialError('invalid_base_url');
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!;
  const path = match[3]!;
  if (
    authority.includes('@') ||
    /[^A-Za-z0-9\-._~!$&'()*+,;=:@/]/.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  )
    credentialError('invalid_base_url');
  let host: string;
  let port: string | undefined;
  if (authority.startsWith('[')) {
    const parts = /^(\[[0-9a-fA-F:.]+\])(?::([0-9]+))?$/.exec(authority);
    if (!parts) credentialError('invalid_base_url');
    const literal = parts[1]!;
    if (literal.includes('.')) {
      const tail = literal.slice(literal.lastIndexOf(':') + 1, -1);
      if (!strictIpv4(tail)) credentialError('invalid_base_url');
    }
    try {
      host = new URL(`http://${literal}`).hostname;
    } catch {
      credentialError('invalid_base_url');
    }
    port = parts[2];
  } else {
    const parts = /^([^:]+)(?::([0-9]+))?$/.exec(authority);
    if (!parts) credentialError('invalid_base_url');
    host = parts[1]!.toLowerCase();
    port = parts[2];
    const labels = host.split('.');
    if (
      host.length > 253 ||
      labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    )
      credentialError('invalid_base_url');
    const last = labels.at(-1)!;
    if ((/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) && !strictIpv4(host))
      credentialError('invalid_base_url');
  }
  if (port !== undefined) {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      credentialError('invalid_base_url');
    port =
      (scheme === 'http' && number === 80) || (scheme === 'https' && number === 443)
        ? undefined
        : String(number);
  }
  if (
    scheme === 'http' &&
    host !== 'localhost' &&
    host !== '[::1]' &&
    !(strictIpv4(host) && host.startsWith('127.'))
  )
    credentialError('invalid_base_url');
  return `${scheme}://${host}${port === undefined ? '' : `:${port}`}${path.replace(/\/+$/, '')}`;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    credentialError('invalid_schema');
}
function text(value: unknown, nonempty = true): asserts value is string {
  if (typeof value !== 'string' || (nonempty && value.length === 0))
    credentialError('invalid_schema');
}
function unicode(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      for (let i = 0; i < item.length; i++) {
        const code = item.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = item.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) credentialError('invalid_schema');
        } else if (code >= 0xdc00 && code <= 0xdfff) credentialError('invalid_schema');
      }
    } else if (Array.isArray(item)) pending.push(...item);
    else if (record(item)) {
      for (const [key, child] of Object.entries(item)) pending.push(key, child);
    }
  }
}
export function validateCredentialProfile(value: unknown): asserts value is CredentialProfile {
  closed(value, ['api_key', 'base_url', 'key_id', 'account', 'scope']);
  text(value.api_key);
  if (!trimCredentialWhitespace(value.api_key)) credentialError('invalid_schema');
  if (canonicalBase(value.base_url) !== value.base_url) credentialError('invalid_base_url');
  text(value.key_id);
  closed(value.account, ['id', 'name']);
  text(value.account.id);
  if (value.account.name !== null) text(value.account.name, false);
  if (!record(value.scope)) credentialError('invalid_schema');
  if (value.scope.type === 'account') closed(value.scope, ['type']);
  else if (value.scope.type === 'workspace') {
    closed(value.scope, ['type', 'workspace_id', 'workspace_name']);
    text(value.scope.workspace_id);
    text(value.scope.workspace_name);
  } else credentialError('invalid_schema');
  unicode(value);
}
export function validateCredentials(value: unknown): asserts value is CredentialsFile {
  unicode(value);
  if (!record(value)) credentialError('invalid_schema');
  if (typeof value.version !== 'number' || !Number.isInteger(value.version))
    credentialError('invalid_schema');
  if (value.version !== 1) credentialError('unsupported_version');
  if (!Object.hasOwn(value, 'default_profile')) credentialError('missing_default_profile');
  closed(value, ['version', 'default_profile', 'profiles']);
  text(value.default_profile, false);
  validateProfileName(value.default_profile);
  if (!record(value.profiles) || Object.keys(value.profiles).length === 0)
    credentialError('invalid_schema');
  if (Object.keys(value.profiles).length > 100) credentialError('too_many_profiles');
  for (const [name, profile] of Object.entries(value.profiles)) {
    validateProfileName(name);
    validateCredentialProfile(profile);
  }
  if (!Object.hasOwn(value.profiles, value.default_profile))
    credentialError('missing_default_profile');
}
export function parseCredentials(bytes: Uint8Array): CredentialsFile {
  if (bytes.length > MAX_CREDENTIAL_BYTES) credentialError('file_too_large');
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    credentialError('invalid_utf8');
  }
  let data: unknown;
  try {
    data = JSON.parse(decoded);
  } catch {
    credentialError('invalid_json');
  }
  validateCredentials(data);
  return data;
}

export const credentialEnvironment = (): CredentialEnvironment =>
  typeof process === 'undefined' ? {} : (process.env ?? {});

/** This early return deliberately precedes profile validation and every home/store operation. */
export function resolveSuppliedCredential(
  options: CredentialOptions,
  env: CredentialEnvironment,
): ResolvedCredentials | undefined {
  let apiKey: string | undefined;
  let source: 'explicit' | 'environment' = 'explicit';
  if (options.apiKey !== undefined) {
    if (typeof options.apiKey !== 'string' || !trimCredentialWhitespace(options.apiKey))
      credentialError('invalid_explicit_key');
    apiKey = trimCredentialWhitespace(options.apiKey);
  } else {
    apiKey = trimCredentialWhitespace(env.MANDALA_API_KEY ?? '');
    source = 'environment';
  }
  if (!apiKey) return undefined;
  // Retain the SDK's existing explicit/environment-key base semantics.
  const baseUrl = (
    options.baseUrl?.trim() ||
    env.MANDALA_BASE_URL?.trim() ||
    DEFAULT_CREDENTIAL_BASE
  ).replace(/\/+$/, '');
  return { apiKey, baseUrl, source };
}
export function selectedProfile(
  options: CredentialOptions,
  env: CredentialEnvironment,
): string | undefined {
  const profile =
    options.profile !== undefined
      ? options.profile
      : trimCredentialWhitespace(env.MANDALA_PROFILE ?? '') || undefined;
  if (profile !== undefined) validateProfileName(profile);
  return profile;
}
export function selectCredentials(
  file: CredentialsFile,
  profile: string | undefined,
  options: CredentialOptions,
  env: CredentialEnvironment,
): ResolvedCredentials {
  const name = profile ?? file.default_profile;
  if (!Object.hasOwn(file.profiles, name)) credentialError('missing_selected_profile');
  const entry = file.profiles[name]!;
  const override =
    options.baseUrl !== undefined
      ? options.baseUrl
      : trimCredentialWhitespace(env.MANDALA_BASE_URL ?? '') || undefined;
  if (override !== undefined && canonicalBase(override) !== entry.base_url)
    credentialError('base_binding_mismatch');
  return {
    apiKey: trimCredentialWhitespace(entry.api_key),
    baseUrl: entry.base_url,
    profile: name,
    source: 'file',
  };
}
export function resolveCredentials(
  options: CredentialOptions = {},
  env: CredentialEnvironment = credentialEnvironment(),
): ResolvedCredentials {
  const key = resolveSuppliedCredential(options, env);
  if (key) return key;
  selectedProfile(options, env);
  throw new CredentialsError(
    'unsupported_file_protection',
    'Local credential files are unavailable in this runtime. Pass apiKey explicitly.',
  );
}
