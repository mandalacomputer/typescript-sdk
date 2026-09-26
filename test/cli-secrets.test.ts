import { describe, expect, it } from 'vitest';
import {
  bindingSpecs,
  equalsDeprecation,
  looksLikeSecretValue,
  scrubTypedTargets,
  withoutTypedTargets,
} from '../src/cli-secrets.js';

// Token-shaped fixtures are assembled at run time, so no literal in this file
// reads as a leaked credential to a scanner. None of them is a real token.
const body = (n: number, alphabet = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY') =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
const tok = (prefix: string, rest: string) => [prefix, rest].join('');

/** A deterministic stream, so a run that flags a share of random tokens is repeatable. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const random = (next: () => number, alphabet: string, n: number) =>
  Array.from({ length: n }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');

/** Names people really bind as — none of which may be refused. */
const NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_STORAGE_CONNECTION_STRING',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'CLOUDFLARE_API_TOKEN_2024',
  'POSTGRES_PASSWORD_PROD_EU_WEST_1',
  'E2E_TEST_USER_PASSWORD_V2',
  'ID_RSA_4096_PRIVATE_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'HF_TOKEN',
  'NPM_TOKEN',
  'STRIPE_SECRET_KEY',
  'SLACK_BOT_TOKEN',
  'myServiceAccountKey2024',
  'ServiceAccountKeyProd2025V2',
  'AppConfigValueForTesting123',
  'K8sClusterAdminToken2024',
  'ApiKeyV2ForS3BackupJob',
  'S3BucketAccessKeyIdProd',
  'OAuth2ClientSecretForGitHubApp',
  'X509CertificateChainPem',
  'Base64EncodedServiceAccountJSON',
  'IPv4AddressForHost01',
  'MyApp2FASecretV3Backup',
  'GPGKeyFingerprint2024Q3',
  'SSHHostKeyEd25519Pub',
  'K8sSvcAcctJWTPubKeyV1',
  // Heavy with acronyms: under 65% of the letters sit in camel-case words.
  'JWTRSAPublicKeyPEMBase64',
  'AWSIAMRoleARNForCIDeployer',
  'GCPServiceAccountJSONKeyB64',
  'TLSCertAndKeyPEMForMTLSProxy',
  'DBURLForETLJobInUSEast',
  'DatabaseURLProdEUWest1',
  'SSHPrivateKeyED25519ForCI',
  'kubeconfig',
  'gh',
  'id_ed25519',
  'hf_token',
  'npm_token',
  // A token prefix ahead of camel-case words, not a token body.
  'npm_package_devDependencies',
  'sk_test_integrationTestKey',
  'hf_hubTokenReadOnly2024',
  'ghp_personalAccessTokenForCI',
  'sk-prod-signing-key',
  'sk_live_mode_config',
  'xoxb-bot-token-for-alerts',
  'gcloud-service-account-key',
  'db_backup_2024_01_15',
  'prod-eu-west-1-kubeconfig',
  'aws-credentials-2025-q3',
  'stripe_webhook_signing_secret',
  'my-app-v2-config-prod-01',
  'terraform-cloud-token-2024',
  'x509-client-cert-prod-2025',
  'kubeconfig20240115backup',
  'sha256sumsforrelease2024',
  'user1password2024prod',
  'mysql8rootpassword2024',
  '/home/user/.config/gcloud/key.json',
  '/etc/ssl/private/server-2025.key',
  '/run/mandala-secrets/user/files/openai',
];

describe('looksLikeSecretValue', () => {
  it('passes every realistic variable name, file name and path', () => {
    for (const name of NAMES) expect(looksLikeSecretValue(name), name).toBe(false);
  });

  it('catches the token formats issuers hand out, including those shaped like a name', () => {
    const tokens = [
      tok('ghp_', body(36)), // a valid variable name: the ticket's case
      tok('gho_', body(36)),
      tok('ghs_', body(36)),
      tok('github_pat_', `${body(22)}_${body(59)}`),
      tok('sk-', body(48)),
      tok('sk-proj-', `${body(40)}-${body(20)}`),
      tok('sk-ant-api03-', body(40)),
      tok('sk_live_', body(24)),
      tok('sk_test_', body(24)),
      tok('rk_live_', body(24)),
      tok('xoxb-', `123456789012-1234567890123-${body(24)}`),
      tok('glpat-', body(20)),
      tok('AIza', body(35)),
      tok('hf_', body(34)),
      tok('npm_', body(36)),
      tok('pypi-', body(60)),
      tok('SG.', `${body(22)}.${body(43)}`),
      tok('AKIA', 'Q2W3E4R5T6Y7U8I9'),
      tok('ASIA', 'Q2W3E4R5T6Y7U8I9'),
      tok('dop_v1_', body(64, '0123456789abcdef')),
      tok('eyJ', `${body(30)}.${body(40)}.${body(43)}`),
      // A UUID (some providers' whole key), and bare hex a file name can hold.
      '9f86d081-884c-4d63-a6c5-2a1f0e8b7c3d',
      'a3f9c0e17b2d48a6e5f1c9b3d7a0e4f8',
      'f1e2d3c4b5a697887766554433221100aabbccdd',
      // A random mixed-case run with no prefix at all.
      'Xk9fQ2mZr7Lp4Tw8Bv3Nc6Hd',
      // A prefix ahead of a mixed-case body with no digit, which is no words.
      tok('sk_test_', 'QxZrTpLmWvNbKjHg'),
      // ...and one whose only digits close it, as a name's year would.
      tok('hf_', 'QxZrTpLmWvNbKjHg2024'),
      // Random, with uppercase runs an acronym could explain, but no words.
      'QZXkTRmWPbNVcJHLdGFsYK',
    ];
    for (const t of tokens) expect(looksLikeSecretValue(t), t).toBe(true);
  });

  it('catches most random tokens, and every hex one of 24 characters or more', () => {
    const next = seeded(5076);
    const share = (alphabet: string, n: number, runs = 400) => {
      let hit = 0;
      for (let i = 0; i < runs; i++) if (looksLikeSecretValue(random(next, alphabet, n))) hit++;
      return hit / runs;
    };
    const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (const n of [24, 32, 40])
      expect(share('0123456789abcdef', n), `hex ${n}`).toBeGreaterThan(0.98);
    for (const n of [24, 32, 40]) expect(share(ALNUM, n), `alnum ${n}`).toBeGreaterThan(0.85);
    expect(share('abcdefghijklmnopqrstuvwxyz0123456789', 32)).toBeGreaterThan(0.6);
  });

  it('catches a known prefix ahead of random letters and no digits, from twelve on', () => {
    // Issued tokens nearly always hold a digit, but a random letter body is
    // still one: split at its capitals it is mostly pairs and lone capitals,
    // which no run of camel-case words is.
    const next = seeded(5128);
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    for (const [prefix, n] of [
      ['sk_test_', 12],
      ['sk_test_', 24],
      ['hf_', 16],
      ['hf_', 34],
      ['ghp_', 36],
      ['xoxb-', 24],
      ['sk-proj-', 20],
      ['AIza', 20],
      ['glpat-', 20],
    ] as const) {
      let hit = 0;
      for (let i = 0; i < 1000; i++)
        if (looksLikeSecretValue(tok(prefix, random(next, LETTERS, n)))) hit++;
      expect(hit / 1000, `${prefix} + ${n} letters`).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('passes a known prefix ahead of camel-case words, acronyms among them', () => {
    const words = [
      'integrationTestKey',
      'hubTokenReadOnly',
      'personalAccessTokenForCI',
      'devDependencies',
      'JWTRSAPublicKeyPEMBase64',
      'AWSIAMRoleARNForCIDeployer',
      'GCPServiceAccountJSONKeyB64',
      'TLSCertAndKeyPEMForMTLSProxy',
      'DBURLForETLJobInUSEast',
      'DatabaseURLProdEUWest1',
      'OAuthClientSecretForGitHubApp',
      'XMLHttpRequestToken',
      'signingKeyForJWTs',
      'StripeWebhookSigningSecret',
      'ScriptsForStrings',
      'CloudflareDNSEditToken',
      'KubernetesClusterAdmin',
      'PostgresReplicaPassword',
      'WebhookSecretForGitLabCI',
      'SentryDsnForFrontend',
      'FirebaseAdminCredentials',
      'ServiceAccountKeyProdV2',
      'readOnlyTokenForMyApp',
      'nightlyBackupSigningKey',
    ];
    for (const prefix of ['hf_', 'sk_test_', 'ghp_', 'npm_'])
      for (const w of words) expect(looksLikeSecretValue(tok(prefix, w)), prefix + w).toBe(false);
  });

  it('never flags something short, whatever it is', () => {
    const next = seeded(1);
    for (let i = 0; i < 200; i++)
      expect(looksLikeSecretValue(random(next, 'ABCDEFabcdef0123456789', 19))).toBe(false);
  });
});

describe('a secret-looking target is refused before anything is sent', () => {
  it('names the flag, the position and the text before =, never the target', () => {
    const value = tok('ghp_', body(36));
    for (const flag of ['--secret', '--secret-file'] as const) {
      const typed = [`OPENAI_API_KEY=${value}`];
      let message = '';
      try {
        flag === '--secret' ? bindingSpecs(['X=Y', ...typed]) : bindingSpecs([], ['x=y', ...typed]);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`${flag} #2 ("OPENAI_API_KEY=…")`);
      expect(message).toContain("looks like a secret's value");
      expect(message).toContain('nothing was sent');
      expect(message).not.toContain(value);
    }
  });

  it('names --no-value-check, and with it sends a flagged but valid target as typed', () => {
    // A file name holding a hash: a real name the heuristic cannot tell from a
    // hex value, which after = only this override gets through.
    const hashed = 'cert-sha256-9f86d081884c7d659a2f';
    const acronyms = 'AWSKMSKeyARNForS3SSE';
    expect(looksLikeSecretValue(hashed)).toBe(true);
    expect(looksLikeSecretValue(acronyms)).toBe(true);
    expect(() => bindingSpecs([], [`tls=${hashed}`])).toThrow('--no-value-check');
    expect(() => bindingSpecs([`K=${acronyms}`])).toThrow('--no-value-check');
    expect(bindingSpecs([`K=${acronyms}`], [`tls=${hashed}`], { valueCheck: false })).toEqual([
      expect.objectContaining({ flag: '--secret', key: 'K', target: acronyms }),
      expect.objectContaining({ flag: '--secret-file', key: 'tls', target: hashed }),
    ]);
    // The override skips only the value check: the name rules still hold.
    expect(() => bindingSpecs([], ['tls=Cert.PEM'], { valueCheck: false })).toThrow(
      'what follows = must be',
    );
  });

  it('still binds a realistic custom target', () => {
    expect(bindingSpecs(['OPENAI_API_KEY=MY_OPENAI_KEY'], ['gh-token=hf_token'])).toEqual([
      expect.objectContaining({ key: 'OPENAI_API_KEY', target: 'MY_OPENAI_KEY' }),
      expect.objectContaining({ key: 'gh-token', target: 'hf_token' }),
    ]);
  });
});

describe('a target named by --as or --path', () => {
  it('pairs each with its own binding, and takes the whole value as the secret', () => {
    expect(
      bindingSpecs(['A', 'b=c', 'D=E'], ['f', 'g'], {
        as: [undefined, 'BC'],
        paths: [undefined, 'gee'],
      }),
    ).toEqual([
      expect.objectContaining({ key: 'A', afterEquals: false }),
      expect.objectContaining({ key: 'b=c', target: 'BC', afterEquals: false }),
      expect.objectContaining({ key: 'D', target: 'E', afterEquals: true }),
      expect.objectContaining({ key: 'f', afterEquals: false }),
      expect.objectContaining({ key: 'g', target: 'gee', afterEquals: false }),
    ]);
  });

  it('skips the value check, which only a target typed after = needs', () => {
    const hashed = 'cert-sha256-9f86d081884c7d659a2f';
    expect(bindingSpecs([], ['tls'], { paths: [hashed] })).toEqual([
      expect.objectContaining({ key: 'tls', target: hashed, afterEquals: false }),
    ]);
  });

  it('still holds it to the naming rules, without quoting it', () => {
    expect(() => bindingSpecs(['A'], [], { as: ['not-a-var'] })).toThrow(
      '--secret "A": --as must be letters',
    );
    expect(() => bindingSpecs([], ['a'], { paths: ['Not.A.File'] })).toThrow(
      '--secret-file "a": --path must be lowercase',
    );
  });

  it('is never hidden from the output, where a target typed after = is', () => {
    const specs = bindingSpecs(['A', 'B=TYPED'], [], { as: ['NAMED'] });
    const shown = withoutTypedTargets({ secrets: [{ env: 'NAMED' }, { env: 'TYPED' }] }, specs);
    expect(shown.secrets).toEqual([{ env: 'NAMED' }, { env: '[REDACTED]' }]);
    const error = scrubTypedTargets(new Error('env NAMED and env TYPED are reserved'), specs);
    expect((error as Error).message).toBe('env NAMED and env [REDACTED] are reserved');
  });
});

describe('the deprecation of SECRET=TARGET', () => {
  it('is one line naming the flags used, never what was typed', () => {
    expect(equalsDeprecation(bindingSpecs(['A'], ['b'], { as: ['X'] }))).toBeUndefined();
    const env = equalsDeprecation(bindingSpecs(['A=HIDDEN_NAME']));
    expect(env).toBe('mandala: --secret SECRET=VAR is deprecated; use --secret SECRET --as VAR');
    const file = equalsDeprecation(bindingSpecs([], ['a=hidden_file']));
    expect(file).toBe(
      'mandala: --secret-file SECRET=FILE is deprecated; use --secret-file SECRET --path FILE',
    );
    const both = equalsDeprecation(bindingSpecs(['A=HIDDEN_NAME', 'B=OTHER'], ['a=hidden_file']));
    expect(both).not.toContain('\n');
    for (const typed of ['HIDDEN_NAME', 'OTHER', 'hidden_file']) expect(both).not.toContain(typed);
  });
});

describe('typed targets stay out of what a create prints', () => {
  const specs = bindingSpecs(['A=MY_KEY', 'B'], ['C=gh']);

  it('hides a typed variable or file in the bindings, and keeps its kind', () => {
    const computer = {
      id: 'vm-1',
      name: 'MY_KEY',
      secrets: [
        { secret_id: 'csec-0', revision_id: 'r', env: 'MY_KEY' },
        { secret_id: 'csec-1', revision_id: 'r', env: 'B' },
        { secret_id: 'csec-2', revision_id: 'r', file: 'gh' },
      ],
    };
    expect(withoutTypedTargets(computer, specs)).toEqual({
      id: 'vm-1',
      // Only the bindings: a computer name that happens to match is its own.
      name: 'MY_KEY',
      secrets: [
        { secret_id: 'csec-0', revision_id: 'r', env: '[REDACTED]' },
        // Bound under the secret's own name, which is not a typed target.
        { secret_id: 'csec-1', revision_id: 'r', env: 'B' },
        { secret_id: 'csec-2', revision_id: 'r', file: '[REDACTED]' },
      ],
    });
    // Nothing typed after =: the record is printed as it came.
    const plain = { id: 'vm-1', secrets: [{ secret_id: 'csec-1', env: 'B' }] };
    expect(withoutTypedTargets(plain, bindingSpecs(['B']))).toBe(plain);
  });

  it('cuts a typed target out of an error message only where it is a whole name', () => {
    const error = new Error('env MY_KEY is reserved; file gh is taken; ghost and MY_KEY_2 are not');
    expect((scrubTypedTargets(error, specs) as Error).message).toBe(
      'env [REDACTED] is reserved; file [REDACTED] is taken; ghost and MY_KEY_2 are not',
    );
    expect(scrubTypedTargets('not an error', specs)).toBe('not an error');
  });
});
