/**
 * `mandala secrets list | set | rm` — the account's secret store (OPL-4984).
 *
 * A value goes IN and never comes back out: the platform answers names, ids and
 * revisions only, so nothing here ever prints one. `set` reads it from stdin or
 * a hidden prompt, never from argv, where it would sit in shell history and in
 * every process listing on the machine.
 */

import { CliError } from './cli-options.js';
import type { Output } from './cli-output.js';
import { type CliIO, readSecretValue } from './cli-runtime.js';
import { ConflictError } from './errors.js';
import type { Client, Secret } from './index.js';
import * as P from './paths.js';

/** How many times `set` and `rm` re-read a secret whose revision moved under them. */
const REVISION_ATTEMPTS = 3;

const scope = (workspace: string | undefined): P.SecretScopeArgs =>
  workspace === undefined ? {} : { workspaceId: workspace };

/** A secret as the CLI prints it: the platform's own projection, which has no value in it. */
const shown = (s: Secret) => s.raw;

/**
 * The secret a NAME means in one scope, or `undefined`.
 *
 * The platform keeps names unique ignoring ASCII case, so `token` and `TOKEN`
 * are one secret: an exact match wins, and otherwise the one case-folded match.
 * Never an id: a name may legally spell another secret's id, and `set` resolving
 * one as the other would overwrite an unrelated credential.
 */
function byName(secrets: readonly Secret[], name: string): Secret | undefined {
  const exact = secrets.find((s) => s.name === name.trim());
  if (exact) return exact;
  const fold = (v: string) => v.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return secrets.find((s) => fold(s.name) === fold(name));
}

async function scopeRows(
  client: Client,
  ws: P.SecretScopeArgs,
  signal: AbortSignal,
): Promise<Secret[]> {
  return (await client.secrets.list({ ...ws, signal })).secrets;
}

/**
 * The secret a name OR an id means, for the one command that accepts either.
 *
 * A name that spells a different secret's id is ambiguous, and refused: guessing
 * wrong deletes the wrong credential.
 */
function byNameOrId(
  secrets: readonly Secret[],
  key: string,
  unchanged = 'nothing was deleted',
  shownAs = JSON.stringify(key),
): Secret | undefined {
  const named = byName(secrets, key);
  const identified = secrets.find((s) => s.id === key);
  if (named && identified && named.id !== identified.id)
    throw new CliError(
      'ambiguous_secret',
      `${shownAs} is the name of ${named.id} and the id of another secret; ` +
        `${unchanged}: rename one of them first`,
    );
  return named ?? identified;
}

/** A secret id: `csec-` and sixteen hex characters. */
const SECRET_ID = /^csec-[0-9a-f]{16}$/;

/**
 * The prefixes credential issuers put on their tokens: GitHub, OpenAI and
 * Stripe style `sk-`/`sk_live_`, Slack, GitLab, Google, Hugging Face, npm,
 * PyPI, SendGrid, DigitalOcean, Shopify, xAI, Groq, Replicate, Linear, Square,
 * Perplexity, and a JWT's encoded header.
 */
const TOKEN_PREFIX =
  /^(?:gh[pousr]_|github_pat_|sk-|sk_(?:live|test)_|rk_(?:live|test)_|xox[abeprs]-|xapp-|glpat-|AIza|hf_|npm_|pypi-|SG\.|dop_v1_|shp(?:at|ca|pa|ss)_|xai-|gsk_|r8_|lin_api_|sq0(?:atp|csp)-|pplx-|eyJ)/;

/** An AWS access key id, which is shaped exactly like a variable name. */
const AWS_KEY_ID = /^(?:AKIA|ASIA)[A-Z0-9]{16}$/;

/** A UUID, the whole of some providers' API keys, and a valid file name. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Shannon entropy, in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

/** The share of `run`'s letters that sit in `words`, pieces of it. */
function letterShare(run: string, words: readonly string[] | null): number {
  const letters = run.replace(/[0-9]/g, '').length;
  return letters ? (words ?? []).join('').length / letters : 0;
}

/**
 * Whether a run holding both cases reads as camel-case words (`Access`, `key`)
 * rather than at random, which rarely runs two lowercase letters together.
 *
 * Words when 65% of its letters sit in camel-case words. A name heavy with
 * acronyms (`JWTRSAPublicKeyPEMBase64`, `AWSIAMRoleARNForCIDeployer`) falls
 * short of that, so the acronyms count too — an uppercase run ahead of a word,
 * a digit or the end — but only once two capitalised words with a vowel hold
 * 40% of the letters: counting acronyms alone would pass most random strings,
 * and this costs a random one only a point or two of being caught.
 */
function camelWords(run: string): boolean {
  if (letterShare(run, run.match(/[A-Z]?[a-z]{2,}/g)) >= 0.65) return true;
  const words = (run.match(/[A-Z][a-z]{2,}/g) ?? []).filter((w) => /[aeiou]/.test(w));
  return (
    words.length >= 2 &&
    letterShare(run, words) >= 0.4 &&
    letterShare(run, run.match(/[A-Z]?[a-z]{2,}|[A-Z]{2,}(?=[A-Z][a-z]{2}|[0-9]|$)/g)) >= 0.65
  );
}

/**
 * Two-letter words a camel-case name really holds (`Id`, `In`, `Of`, `Db`):
 * the only ones {@link wordSegment} takes, as a random body is mostly pairs.
 */
const SHORT_WORDS = new Set(
  (
    'ad ai an as at be by ci db do eu go id if in io ip is it js me my no of ok on or os ' +
    'pr qa so to ui up us vm we'
  ).split(' '),
);

/** Words a name holds with no vowel in them (`Http`, `Ssh`, `Cfg`). */
const BARE_WORDS = new Set(
  (
    'cfg cmd crt ctx dns dsn dst ftp gpg html http https jwt jwks mgmt msg pkg prd pwd ' +
    'sftp smtp sql src ssh stg svc tls tmp txt xml'
  ).split(' '),
);

/**
 * The consonants that follow each consonant inside English words (`y` counts
 * as a vowel): every pair making up 0.02% or more of the consonant pairs in
 * a 236,000-word dictionary, and each one ahead of a plural `s`. About half
 * of the 400 pairs, and the half random letters rarely keep to: a random
 * segment of four or more letters almost always holds a pair outside it.
 */
const CONSONANT_PAIRS = new Set(
  Object.entries({
    b: 'bcdhjlmnprstv',
    c: 'chklnqrst',
    d: 'bcdfghjlmnprsvw',
    f: 'flrst',
    g: 'bdghlmnrstw',
    h: 'bdflmnprstw',
    j: 's',
    k: 'bfhlmnrstw',
    l: 'bcdfghklmnprstvw',
    m: 'bflmnps',
    n: 'bcdfghjklmnpqrstvwz',
    p: 'bfhlmnprstw',
    r: 'bcdfghjklmnpqrstvw',
    s: 'bcdfghklmnpqrstw',
    t: 'bcdfghlmnprstwz',
    v: 's',
    w: 'bdfhklmnrst',
    x: 'chpst',
    z: 'lsz',
  }).flatMap(([first, next]) => [...next].map((c) => first + c)),
);

/**
 * Whether one camel-case segment of a name reads as a word:
 * - an acronym, plural `s` and all (`JWT`, `JWTs`);
 * - a lone capital closing the run (the `V` of `V2`, once its digit is
 *   dropped), or a lone vowel anywhere (the `O` of `OAuth`);
 * - a two-letter word from {@link SHORT_WORDS};
 * - a vowelless word from {@link BARE_WORDS};
 * - otherwise a vowel, a `q` only ahead of a `u`, and every consonant ahead
 *   of another making a pair in {@link CONSONANT_PAIRS}.
 */
function wordSegment(segment: string, last: boolean): boolean {
  if (segment.length === 1) return /[AEIOU]/.test(segment) || (last && /[A-Z]/.test(segment));
  if (/^[A-Z]+s?$/.test(segment)) return true;
  const word = segment.toLowerCase();
  if (word.length === 2) return SHORT_WORDS.has(word);
  if (BARE_WORDS.has(word)) return true;
  if (!/[aeiouy]/.test(word) || /q(?!u)/.test(word)) return false;
  const pairs = (word.match(/[^aeiouy]{2,}/g) ?? []).flatMap((run) =>
    [...run.slice(1)].map((_, i) => run.slice(i, i + 2)),
  );
  return pairs.every((pair) => CONSONANT_PAIRS.has(pair));
}

/**
 * Whether a digit-free run holding both cases, after a known token prefix,
 * reads as camel-case words (`hubTokenReadOnly`, `personalAccessTokenForCI`)
 * rather than as a token body: {@link camelWords}, and every segment a word
 * ({@link wordSegment}).
 *
 * Stricter than a bare run's test, as a prefix already says token: a random
 * body split at its capitals is mostly pairs and lone capitals, with the odd
 * longer stretch of letters no word would put together, so nearly every one
 * holds a segment that fails. Measured over 20,000 random letter bodies each,
 * it catches 99.5% of twelve letters and 99.8% of sixteen, where
 * {@link camelWords} alone caught under 80%.
 */
function prefixedWords(run: string): boolean {
  const segments = run.match(/[A-Z]{2,}s(?![a-z])|[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  return (
    camelWords(run) &&
    segments.join('') === run &&
    segments.every((s, i) => wordSegment(s, i === segments.length - 1))
  );
}

/**
 * Whether one run of letters and digits reads as random rather than as words.
 *
 * Twenty characters or more, at least two of lowercase, uppercase and digits,
 * and 3 bits a character or more — which every name made of a few words also
 * reaches, so one more test decides:
 * - a hex stretch of twenty or more holding letters and digits is random;
 * - mixed case is random unless it reads as camel-case words
 *   ({@link camelWords});
 * - one case with digits is random when its letter/digit runs average under
 *   3.2 characters and under 30% of its letters are vowels, which words are
 *   not (`kubeconfig20240115backup`).
 *
 * Tuned against realistic names (`CLOUDFLARE_API_TOKEN_2024`,
 * `ServiceAccountKeyProd2025V2`, `prod-eu-west-1-kubeconfig`), none of which it
 * flags, and random tokens, most of which it does: every hex one of 24 or more,
 * and most mixed-case alphanumeric ones. A miss is not a leak by itself — the
 * value is still only bound on the caller's own computer — and a false alarm
 * blocks a real name, so it errs toward the names; one it still refuses (a
 * name holding a hash, say) goes through with `--no-value-check`.
 */
function randomRun(run: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((c) => c.test(run)).length;
  if (run.length < 20 || classes < 2 || entropy(run) < 3) return false;
  const hex = run.match(/[0-9a-f]{20,}|[0-9A-F]{20,}/)?.[0];
  if (hex && /[0-9]/.test(hex) && /[a-fA-F]/.test(hex)) return true;
  if (/[a-z]/.test(run) && /[A-Z]/.test(run)) return !camelWords(run);
  const letters = run.replace(/[0-9]/g, '').length;
  const runs = run.match(/[a-z]+|[A-Z]+|[0-9]+/g) ?? [];
  const vowels = (run.match(/[aeiou]/gi) ?? []).length;
  return run.length / runs.length < 3.2 && vowels / letters < 0.3;
}

/**
 * Whether what follows `=` in `--secret NAME=…` looks like a secret's VALUE
 * rather than the variable or file it is bound as: a known token prefix ahead
 * of a token body, an AWS key id, a UUID, or a random-looking stretch.
 *
 * A prefix alone is not enough — `hf_token`, `sk-prod-signing-key`,
 * `npm_package_devDependencies` and `hf_hubTokenReadOnly2024` are names — so
 * what follows it must hold a run of twelve or more letters and digits with a
 * digit in it, or both cases that do not read as camel-case words
 * ({@link prefixedWords}, stricter than a bare run's test), as every issued
 * token does. Up to four digits closing the run are a name's version or year,
 * and do not count.
 */
export function looksLikeSecretValue(text: string): boolean {
  const runs = text.split(/[^A-Za-z0-9]+/);
  const prefix = TOKEN_PREFIX.exec(text);
  if (prefix) {
    const tokenBody = (run: string) => {
      if (run.length < 12) return false;
      const core = run.replace(/[0-9]{1,4}$/, '');
      return (
        /[0-9]/.test(core) || (/[a-z]/.test(core) && /[A-Z]/.test(core) && !prefixedWords(core))
      );
    };
    if (
      text
        .slice(prefix[0].length)
        .split(/[^A-Za-z0-9]+/)
        .some(tokenBody)
    )
      return true;
  }
  return UUID.test(text) || runs.some((r) => AWS_KEY_ID.test(r) || randomRun(r));
}

/** One `--secret` or `--secret-file` on `computers create`, as typed. */
export type BindingSpec = {
  flag: '--secret' | '--secret-file';
  /** A secret's name or id. */
  key: string;
  /** The variable or file it is published as; absent means the secret's own name. */
  target?: string;
  /**
   * Whether `target` was typed after `=` (`SECRET=VAR`, deprecated) rather than
   * given by `--as` or `--path`: only such a target may be a value typed there
   * by mistake, so only such a one is checked for that and printed hidden.
   */
  afterEquals: boolean;
  /**
   * How an error names this binding. Never the whole of `key` once an `=` was
   * typed: see {@link bindingSpecs}.
   */
  label: string;
};

/**
 * The `--secret` and `--secret-file` values, with the `--as VAR` or `--path
 * FILE` typed directly after each (`as` and `paths`, one entry per binding, in
 * order), checked before any request.
 *
 * A binding given `--as` or `--path` takes its whole value as the secret, `=`
 * and all: the target has its own flag, so nothing there can be a value typed
 * where a name was meant, and it is only held to the naming rules.
 *
 * Without one, the deprecated `SECRET=VAR` and `SECRET=FILE` are still read.
 * Split at the LAST `=`, since neither a variable nor a file name can hold one
 * and a secret's name can. Nothing after the FIRST `=` is ever quoted back: the
 * likely mistake is `--secret NAME=<the value itself>`, an error is the last
 * place that should print it, and a value can hold `=` itself (Base64 padding,
 * say), which the last-`=` split would move into the key. So once an `=` was
 * typed, an error names the binding by its flag, its position and the text
 * before the first `=` alone.
 *
 * A target that {@link looksLikeSecretValue} flags is refused unless
 * `valueCheck` is false (`--no-value-check`): the check is a heuristic, and a
 * real name it misreads — one holding a hash, say — has no other way through.
 * It must still be a valid name either way, and prints redacted either way.
 */
export function bindingSpecs(
  envs: readonly string[] = [],
  files: readonly string[] = [],
  {
    valueCheck = true,
    as = [],
    paths = [],
  }: {
    valueCheck?: boolean;
    as?: readonly (string | undefined)[];
    paths?: readonly (string | undefined)[];
  } = {},
): BindingSpec[] {
  const split = (
    flag: BindingSpec['flag'],
    typed: string,
    index: number,
    named: string | undefined,
  ): BindingSpec => {
    const env = flag === '--secret';
    const [pattern, rule] = env
      ? [P.SECRET_ENV, 'letters, digits and underscores, not starting with a digit, at most 64']
      : [P.SECRET_FILE, 'lowercase letters, digits, - and _, starting with a letter, at most 48'];
    // Labelled without what follows an `=` even when --as took the target: a
    // value typed after one by mistake is still in the key.
    const eq = typed.indexOf('=');
    const label =
      eq < 0
        ? `${flag} ${JSON.stringify(typed.trim())}`
        : `${flag} #${index + 1} (${JSON.stringify(`${typed.slice(0, eq).trim()}=…`)})`;
    if (named !== undefined) {
      const key = typed.trim();
      if (!key) throw new CliError('invalid_arguments', `${flag} needs a secret name or id`);
      if (!pattern.test(named))
        throw new CliError(
          'invalid_arguments',
          `${label}: ${env ? '--as' : '--path'} must be ${rule} characters`,
        );
      return { flag, key, target: named, afterEquals: false, label };
    }
    const at = typed.lastIndexOf('=');
    const key = (at < 0 ? typed : typed.slice(0, at)).trim();
    if (!key) throw new CliError('invalid_arguments', `${flag} needs a secret name or id`);
    if (at < 0) return { flag, key, afterEquals: false, label };
    const target = typed.slice(at + 1);
    // Checked first, as a value that also passes the pattern (a GitHub token
    // is a valid variable name) would otherwise be sent as the name and
    // printed back as the computer's binding.
    if (valueCheck && looksLikeSecretValue(target))
      throw new CliError(
        'invalid_arguments',
        `${label}: what follows = looks like a secret's value, not ${env ? 'a variable' : 'a file'} name, ` +
          `so nothing was sent. It names where the value goes, never the value: store that with ` +
          `mandala secrets set, then bind the secret by its name. ` +
          `If it is a name after all, give it with ${env ? '--as' : '--path'} instead of =, ` +
          `or send it as typed with --no-value-check`,
      );
    if (!pattern.test(target))
      throw new CliError(
        'invalid_arguments',
        `${label}: what follows = must be ${rule} characters. ` +
          `It names where the value goes, never the value: store that with mandala secrets set`,
      );
    return { flag, key, target, afterEquals: true, label };
  };
  return [
    ...envs.map((typed, i) => split('--secret', typed, i, as[i])),
    ...files.map((typed, i) => split('--secret-file', typed, i, paths[i])),
  ];
}

/**
 * The one-line warning a create prints when a binding used the deprecated
 * `SECRET=VAR` or `SECRET=FILE`, or `undefined` when none did. It names the
 * flags and never what was typed: the target may be a value put there by
 * mistake.
 */
export function equalsDeprecation(specs: readonly BindingSpec[]): string | undefined {
  const used = new Set(specs.filter((s) => s.afterEquals).map((s) => s.flag));
  if (!used.size) return undefined;
  const instead = [
    ...(used.has('--secret') ? ['--secret SECRET --as VAR'] : []),
    ...(used.has('--secret-file') ? ['--secret-file SECRET --path FILE'] : []),
  ];
  const old = [
    ...(used.has('--secret') ? ['--secret SECRET=VAR'] : []),
    ...(used.has('--secret-file') ? ['--secret-file SECRET=FILE'] : []),
  ];
  return `mandala: ${old.join(' and ')} ${old.length > 1 ? 'are' : 'is'} deprecated; use ${instead.join(' and ')}`;
}

/**
 * The bindings a create sends, each secret found by name or id in the default
 * scope — the account-wide one, or the workspace an API key is confined to.
 *
 * An id that listing does not hold is sent as it is, for a secret in a scope
 * the listing did not cover; the platform refuses one it cannot bind, and the
 * create with it. A name it does not hold is refused here.
 *
 * Two bindings of one secret, or into one variable or file, are refused here
 * too, by label: the SDK's own check would quote a typed target, which may be
 * a value typed after `=` by mistake.
 */
export async function secretBindings(
  client: Client,
  specs: readonly BindingSpec[],
  signal: AbortSignal,
): Promise<P.SecretBindingArgs[]> {
  if (!specs.length) return [];
  const list = await client.secrets.list({ signal });
  if (!list.delivery)
    throw new CliError(
      'unsupported',
      'Delivery is off on this platform: secrets can be stored but not bound; nothing was created',
    );
  const seen = new Map<string, string>();
  const once = (slot: string, label: string, what: string) => {
    const first = seen.get(slot);
    if (first !== undefined)
      throw new CliError(
        'invalid_arguments',
        `${label} binds ${what} ${first} already binds; nothing was created`,
      );
    seen.set(slot, label);
  };
  return specs.map(({ flag, key, target, label }) => {
    const found = byNameOrId(list.secrets, key, 'nothing was created', label);
    if (!found && !SECRET_ID.test(key))
      throw new CliError(
        'not_found',
        `${label}: no secret by that name or id in this scope; nothing was created`,
      );
    const as = target ?? found?.name;
    const env = flag === '--secret';
    const name = env ? '--as VAR' : '--path FILE';
    if (as === undefined)
      throw new CliError(
        'invalid_arguments',
        `${flag} ${key}: say what to bind it as, ${flag} ${key} ${name}`,
      );
    if (target === undefined && !(env ? P.SECRET_ENV : P.SECRET_FILE).test(as))
      throw new CliError(
        'invalid_arguments',
        `${flag} ${JSON.stringify(key)}: its name cannot be ${env ? 'a variable' : 'a file'} name as it is; ` +
          `name one: ${flag} ${JSON.stringify(key)} ${name}`,
      );
    const secretId = found?.id ?? key;
    once(`id:${secretId}`, label, 'the secret');
    once(env ? `env:${as}` : `file:${as}`, label, env ? 'the variable' : 'the file');
    return env ? { secretId, env: as } : { secretId, file: as };
  });
}

/**
 * A create's computer as the CLI prints it: each binding whose variable or file
 * was typed after `=` keeps its kind (`env` or `file`) but not the name.
 *
 * {@link looksLikeSecretValue} cannot catch every value, and one it misses is
 * bound as the name; the create's own output is then the first place it would
 * be printed. A name taken from the secret's own (no `=`), or given by `--as`
 * or `--path`, is shown as it is, and `computers get` shows every name.
 */
export function withoutTypedTargets(
  computer: Record<string, unknown>,
  specs: readonly BindingSpec[],
): Record<string, unknown> {
  const typed = (flag: BindingSpec['flag']) =>
    new Set(
      specs.flatMap((s) =>
        s.flag === flag && s.afterEquals && s.target !== undefined ? [s.target] : [],
      ),
    );
  const env = typed('--secret');
  const file = typed('--secret-file');
  if (!env.size && !file.size) return computer;
  const rows = computer.secrets;
  if (!Array.isArray(rows)) return computer;
  const hide = (row: unknown) => {
    if (!row || typeof row !== 'object') return row;
    const r = row as Record<string, unknown>;
    if (typeof r.env === 'string' && env.has(r.env)) return { ...r, env: '[REDACTED]' };
    if (typeof r.file === 'string' && file.has(r.file)) return { ...r, file: '[REDACTED]' };
    return r;
  };
  return { ...computer, secrets: rows.map(hide) };
}

/**
 * The error a create failed with, with every variable or file typed after `=`
 * cut out of its message: the platform's refusal may name the binding it
 * refused. Cut only where it stands as a whole name, so a short one (`gh`)
 * does not take letters out of the words around it.
 */
export function scrubTypedTargets(error: unknown, specs: readonly BindingSpec[]): unknown {
  if (!(error instanceof Error)) return error;
  let message = error.message;
  for (const { target, afterEquals } of specs) {
    if (!target || !afterEquals) continue;
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    message = message.replace(
      new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'g'),
      '[REDACTED]',
    );
  }
  if (message !== error.message) error.message = message;
  return error;
}

/** `mandala secrets list [--workspace ID]`. */
export async function secretsList(
  client: Client,
  io: CliIO,
  output: Output,
  workspace: string | undefined,
  signal: AbortSignal,
): Promise<number> {
  const list = await client.secrets.list({ ...scope(workspace), signal });
  if (output.json)
    return output.result({
      secrets: list.secrets.map(shown),
      delivery: list.delivery,
      limits: list.raw.limits,
    });
  if (!list.secrets.length) io.stdout.write('no secrets in this scope\n');
  for (const s of list.secrets) {
    const used = s.lastUsedAt ? `last used ${s.lastUsedAt}` : 'never delivered';
    io.stdout.write(`${s.id}  ${s.name}  ${s.revisionId}  updated ${s.updatedAt}  ${used}\n`);
  }
  if (!list.delivery)
    output.diagnostic('Delivery is off on this platform: secrets can be stored but not bound.');
  return 0;
}

/**
 * `mandala secrets set NAME [--workspace ID]`: create it, or replace its value.
 *
 * Create-or-replace, against the revision it read. A replace whose revision
 * moved under it (somebody else replaced it first) is read again and sent again,
 * a few times — `set` means "make it this value", and the last writer is the one
 * who asked for that. A create that loses a race for the name becomes a replace.
 * A 503 is NOT retried: a write answered 503 may already have happened, so the
 * error says so and the caller decides.
 */
export async function secretsSet(
  client: Client,
  io: CliIO,
  output: Output,
  name: string,
  workspace: string | undefined,
  signal: AbortSignal,
): Promise<number> {
  const trimmed = P.secretName(name);
  const ws = scope(workspace);
  // Checked before the value is asked for, so a mistyped scope is not found
  // out only after someone has typed a secret into a prompt.
  P.secretScopeQuery(ws);
  const value = await readSecretValue(io, trimmed, signal);
  io.secrets?.add(value);
  if (!value)
    throw new CliError('invalid_arguments', 'the value is empty: pipe it on stdin or type it');
  // Validated (size, encoding) before anything is sent; never quoted.
  P.secretCreateBody({ name: trimmed, value, ...ws });

  let created = false;
  let result: Secret | undefined;
  for (let attempt = 1; !result; attempt++) {
    const current = byName(await scopeRows(client, ws, signal), trimmed);
    try {
      if (current) {
        result = await client.secrets.replace(
          current.id,
          { value, revisionId: current.revisionId, ...ws },
          { signal },
        );
      } else {
        result = await client.secrets.create({ name: trimmed, value, ...ws }, { signal });
        created = true;
      }
    } catch (error) {
      // A stale revision, or a name somebody else just took: read again.
      if (!(error instanceof ConflictError) || attempt >= REVISION_ATTEMPTS) throw error;
    }
  }
  const stored = result as Secret;
  if (output.json) return output.result({ ...shown(stored), created });
  io.stdout.write(
    `${created ? 'created' : 'replaced'} ${stored.id}  ${stored.name}  ${stored.revisionId}\n`,
  );
  return 0;
}

/** `mandala secrets rm NAME [--workspace ID]`: delete it, by name or id. */
export async function secretsRemove(
  client: Client,
  io: CliIO,
  output: Output,
  nameOrId: string,
  workspace: string | undefined,
  signal: AbortSignal,
): Promise<number> {
  const ws = scope(workspace);
  P.secretScopeQuery(ws);
  let removed: Secret | undefined;
  for (let attempt = 1; !removed; attempt++) {
    const current = byNameOrId(await scopeRows(client, ws, signal), nameOrId);
    if (!current)
      throw new CliError('not_found', `no secret named ${JSON.stringify(nameOrId)} in this scope`);
    try {
      await client.secrets.delete(
        current.id,
        { revisionId: current.revisionId, ...ws },
        { signal },
      );
      removed = current;
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt >= REVISION_ATTEMPTS) throw error;
    }
  }
  const gone = removed as Secret;
  if (output.json) return output.result({ id: gone.id, name: gone.name, deleted: true });
  io.stdout.write(`deleted ${gone.id}  ${gone.name}\n`);
  return 0;
}
