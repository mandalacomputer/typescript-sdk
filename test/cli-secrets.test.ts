import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import type { CliIO } from '../src/cli-runtime.js';
import {
  bindingSpecs,
  equalsDeprecation,
  looksLikeSecretValue,
  scrubTypedTargets,
  withoutTypedTargets,
} from '../src/cli-secrets.js';
import { Client } from '../src/index.js';
import { BASE, json, type Responder, recorder, SECRET, SECRET_LIST } from './harness.js';

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
  'db-password',
  'SLACK_WEBHOOK_URL',
  '/etc/app/key',
  // Relative paths: base64's alphabet, cut by `/` into pieces that read as words.
  'config/prod/DatabasePassword2024',
  'secrets/prod/StripeSecretKeyLive',
  'team/ServiceAccountKeyProd2025V2/config1',
  'apps/prod/OAuth2ClientSecretForGitHubApp',
  'k8s/ClusterAdminToken2024/v2',
  // Forty characters, as an AWS secret access key is, and still names.
  'services/payments/prod/DB/password/v2024',
  'infra/terraform/AWS/state/bucket/key2024',
  'ci/github/actions/deploy/SSH/key/ed25519',
  // Pieces that joined lose their case and letter/digit edges, and read random.
  'myapp/prod/DATABASE/URL',
  'github/org/repo/NPMTOKEN',
  'prod/GCP/SA/JSON/key/2024',
  'prod/APIKEY/STRIPE/live2',
  'OPENAI+ANTHROPIC/keys/prod',
  'k8s/v2/db1/s3/prod/x509/certs',
  // One case with digits inside a piece: a version, a service, a region.
  'myapp/staging/REDIS/URL/v1beta1',
  'myapp/prod/DATABASE/URL/v2beta',
  'myapp/s3cache/DATABASE/URL',
  'acme/prod2eu/SMTP/PASSWORD',
  'myapp/prod/OAUTH2CLIENTSECRET',
  'myapp/prod/S3BUCKETKEY',
  // A mixed-case piece that reads as camel-case words, after a leading acronym.
  'myapp/DATABASE/DbPassword',
  'myapp/DATABASE/JSONWebKey',
  'prod/DATABASE/DbPassword',
  'acme/prod/DATABASE/APIKey',
  'myapp/staging/REDIS/HMACKey',
  'myapp/DATABASE/TLSCert',
  // A mixed-case piece of four characters or fewer.
  'myapp/prod/DATABASE/iOS',
  'mobile/prod/DATABASE/tvOS',
  // Both cases as words an acronym closes or sits between: refused while only
  // a leading acronym was dropped.
  'RedisURL',
  'MongoURI',
  'NeonDBURL',
  'ZoomJWT',
  'SSHKeyEd25519',
  'Ed25519Key',
  'PyPIToken',
  'myapp/DATABASE/RedisURL',
  'myapp/DATABASE/MongoURI',
  'myapp/DATABASE/NeonDBURL',
  'myapp/DATABASE/ZoomJWT',
  'myapp/DATABASE/SSHKeyEd25519',
  'myapp/DATABASE/Ed25519Key',
  'myapp/DATABASE/PyPIToken',
  'team/prod/SSHKeyEd25519',
  'ci/PyPIToken',
  // A two-letter word ahead of one acronym: refused under a path while the
  // piece had to hold a word of three letters.
  'MySQLURL',
  'MySQLDSN',
  'MyDBURL',
  'myapp/DATABASE/MySQLURL',
  'myapp/DATABASE/MySQLDSN',
  'myapp/DATABASE/MyDBURL',
  // An absolute path in base64's alphabet alone, twenty characters and more.
  '/srv/myapp/secrets/DatabasePassword',
  '/srv/app/config/StripeSecretKeyLive',
];

/** An AWS secret access key's documented example, which `/` cuts into runs of 13, 7 and 18. */
const AWS_SECRET_EXAMPLE = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');

describe('looksLikeSecretValue', () => {
  it('passes every realistic variable name, file name and path', () => {
    for (const name of NAMES) expect(looksLikeSecretValue(name), name).toBe(false);
  });

  it('reads a base64 piece of two-letter words alone as a value, acronym or not', () => {
    // Every segment of these pieces is a word, so only the second reading's
    // want of a three-letter word, and the narrow shape it lets pass without
    // one (one two-letter word, then one acronym), keep them from a name's.
    for (const value of [
      'AsBeByDoGo/InIsOnUpTo',
      'OnUpSQL/AsByURL/DoGoDSN',
      'SQLMy/URLAs/DSNGo/JWTUp',
      'MyDbUpIs+SQLOnAs+GoURLs',
    ])
      expect(looksLikeSecretValue(value), value).toBe(true);
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

  it('catches a base64 secret that `/` or `+` cut into short runs', () => {
    expect(looksLikeSecretValue(AWS_SECRET_EXAMPLE)).toBe(true);
    const next = seeded(5076);
    const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let hit = 0;
    let cut = 0;
    let cutHit = 0;
    for (let i = 0; i < 2000; i++) {
      const key = random(next, BASE64, 40);
      const flagged = looksLikeSecretValue(key);
      if (flagged) hit++;
      if (/[+/]/.test(key)) {
        cut++;
        if (flagged) cutHit++;
      }
    }
    expect(cut).toBeGreaterThan(1000);
    expect(cutHit / cut, 'holding / or +').toBeGreaterThan(0.93);
    expect(hit / 2000, 'all').toBeGreaterThan(0.93);
  });

  it('catches a base64 secret whose first character is `/`', () => {
    expect(looksLikeSecretValue(`/${AWS_SECRET_EXAMPLE.slice(1)}`)).toBe(true);
    const next = seeded(5076);
    const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let hit = 0;
    for (let i = 0; i < 2000; i++) if (looksLikeSecretValue(`/${random(next, BASE64, 39)}`)) hit++;
    expect(hit / 2000).toBeGreaterThan(0.93);
  });

  it('catches a base64 secret inside quotes, after Bearer or NAME=, or ahead of , or ;', () => {
    const padded = `${AWS_SECRET_EXAMPLE}Xw==`;
    for (const key of [AWS_SECRET_EXAMPLE, padded])
      for (const wrapped of [
        `"${key}"`,
        `'${key}'`,
        `Bearer ${key}`,
        `AWS_SECRET_ACCESS_KEY=${key}`,
        `${key},`,
        `${key};`,
      ])
        expect(looksLikeSecretValue(wrapped), wrapped).toBe(true);
    const next = seeded(5076);
    const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let cut = 0;
    let cutHit = 0;
    for (let i = 0; i < 2000; i++) {
      const key = random(next, BASE64, 40);
      if (!/[+/]/.test(key)) continue;
      cut++;
      if (looksLikeSecretValue(`"${key}"`) && looksLikeSecretValue(`KEY=${key};`)) cutHit++;
    }
    expect(cutHit / cut, 'holding / or +').toBeGreaterThan(0.93);
  });

  it('catches a padded base64 secret, as `openssl rand -base64 32` prints', () => {
    const next = seeded(5076);
    const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let cut = 0;
    let cutHit = 0;
    for (let i = 0; i < 2000; i++) {
      const key = `${random(next, BASE64, 43)}=`;
      if (!/[+/]/.test(key)) continue;
      cut++;
      if (looksLikeSecretValue(key)) cutHit++;
    }
    expect(cut).toBeGreaterThan(1000);
    expect(cutHit / cut, 'holding / or +').toBeGreaterThan(0.93);
    expect(looksLikeSecretValue(`${AWS_SECRET_EXAMPLE}Xw==`)).toBe(true);
  });

  it('catches a known prefix ahead of random letters and no digits, from twelve on', () => {
    // Issued tokens nearly always hold a digit, but a random letter body is
    // still one: split at its capitals it is mostly pairs and lone capitals,
    // which no run of camel-case words is. Twelve letters sit about a tenth of
    // a point above the bar, so the sample is large enough to see that.
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
      for (let i = 0; i < 10_000; i++)
        if (looksLikeSecretValue(tok(prefix, random(next, LETTERS, n)))) hit++;
      expect(hit / 10_000, `${prefix} + ${n} letters`).toBeGreaterThanOrEqual(0.99);
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

  it('passes names the spelling rules alone would refuse', () => {
    // Collected in review, not picked to fit: every one was refused by a
    // version that held each segment to English spelling with no give.
    const words = [
      // Vowelless abbreviations, title-cased.
      'SslCertPassword',
      'NpmPublishToken',
      'GcpServiceKey',
      'GrpcAuthToken',
      'CdnPurgeToken',
      'KmsKeyForBackups',
      'VpnSharedSecret',
      'PgpPrivateKeyArmored',
      'RdsMasterPassword',
      'StsAssumeRoleSecret',
      'McpServerToken',
      // Names joined from words, meeting at a pair no single word holds.
      'KafkaConsumerSecret',
      'LangchainApiKeyProd',
      'myHuggingfaceToken',
      'BlockchainNodeKey',
      'WebflowApiToken',
      'BuildkiteAgentToken',
      'FirmwareSigningKey',
      'MemcachedAuthSecret',
      'DeepgramApiKeyProd',
      'InfluxdbWriteToken',
      'ZipkinCollectorToken',
      'HetznerCloudToken',
      'NextjsPreviewSecret',
      'EcdsaSigningKey',
      'strengthLengthWidth',
      'LlamaApiKey',
      // Spelled against English, and listed.
      'nginxConfigSecret',
      'EtcdClientCert',
      'JfrogArtifactToken',
      'GroqApiKeyForBot',
      'RabbitmqAdminPassword',
      // A q ahead of an l.
      'MysqlReplicaPassword',
      'PostgresqlAdminPassword',
      'SqliteEncryptionKey',
      'GraphqlGatewaySecret',
      'BigqueryServiceAccount',
      // Two-letter abbreviations.
      'CiCdDeployToken',
      'PgBouncerPassword',
      'TfCloudApiToken',
      'PyPackageIndexToken',
      'GhActionsDeployKey',
      'TsNodeSigningKey',
      // A lone lowercase vowel opening the name.
      'iPhoneBackupKey',
      'iOSSigningCertificate',
      'eSignatureToken',
      'aTokenForMyApp',
    ];
    for (const prefix of ['hf_', 'sk-', 'sk_test_', 'npm_'])
      for (const w of words) expect(looksLikeSecretValue(tok(prefix, w)), prefix + w).toBe(false);
  });

  it('refuses the names it is known to, so a change to the rules shows here', () => {
    // A lone consonant capital inside the run: random bodies are full of
    // them, so no name holding one gets through. Its way through is
    // --no-value-check.
    expect(looksLikeSecretValue(tok('hf_', 'WalGEncryptionKey'))).toBe(true);
    // A capital and an s is a two-letter segment, held to the short-word
    // list like any other, not an acronym's plural (`JWTs` above is one).
    expect(looksLikeSecretValue(tok('hf_', 'QsPublishingToken'))).toBe(true);
    // A two-letter segment outside the list, and a vowelless one.
    expect(looksLikeSecretValue(tok('hf_', 'ZqPublishingToken'))).toBe(true);
    expect(looksLikeSecretValue(tok('hf_', 'PublishingXzvToken'))).toBe(true);
    // Two pairs no English word holds, in one segment.
    expect(looksLikeSecretValue(tok('hf_', 'PublishingTokenXavkzq'))).toBe(true);
  });

  it('never flags something short, whatever it is', () => {
    const next = seeded(1);
    for (let i = 0; i < 200; i++)
      expect(looksLikeSecretValue(random(next, 'ABCDEFabcdef0123456789', 19))).toBe(false);
  });
});

describe('a secret-looking target is refused before anything is sent', () => {
  it('names the flag and the position alone, never what was typed', () => {
    const value = tok('ghp_', body(36));
    for (const flag of ['--secret', '--secret-file'] as const) {
      const typed = [`OPENAI_API_KEY=${value}`];
      let message = '';
      try {
        flag === '--secret' ? bindingSpecs(['X=Y', ...typed]) : bindingSpecs([], ['x=y', ...typed]);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`${flag} #2: what follows =`);
      expect(message).not.toContain('OPENAI_API_KEY');
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

  // Assembled at run time, like the fixtures above. Each is a valid variable
  // name, or file name for --path, so only its shape says it is a value.
  const values = {
    ghp: tok('ghp_', body(36)),
    stripe: tok('sk_live_', body(32)),
    slack: tok('xoxb-', '123456789012-4096409640964-abcdef0123'),
    random: body(40),
  };

  it('refuses one that looks like a value, as after =, and never quotes it', () => {
    for (const value of Object.values(values)) expect(looksLikeSecretValue(value)).toBe(true);
    // Each one also passes the naming rule it is held to, so the naming rule
    // alone would have sent it.
    for (const value of [values.ghp, values.stripe, values.random])
      expect(value).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
    expect(values.slack).toMatch(/^[a-z][a-z0-9_-]{0,47}$/);
    const cases: [() => unknown, string, string][] = [
      [() => bindingSpecs(['GH'], [], { as: [values.ghp] }), '--secret #1: --as', values.ghp],
      [() => bindingSpecs(['S'], [], { as: [values.stripe] }), '--as', values.stripe],
      [() => bindingSpecs(['R'], [], { as: [values.random] }), '--as', values.random],
      [
        () => bindingSpecs([], ['slack'], { paths: [values.slack] }),
        '--secret-file #1: --path',
        values.slack,
      ],
      // Not a valid variable name either: the value is still what it says.
      [() => bindingSpecs(['S'], [], { as: [tok('sk-live-', body(32))] }), '--as', 'sk-live-'],
    ];
    for (const [call, named, value] of cases) {
      let message = '';
      try {
        call();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(named);
      expect(message).toContain("looks like a secret's value");
      expect(message).toContain('nothing was sent');
      expect(message).toContain('--no-value-check');
      expect(message).not.toContain(value);
    }
  });

  it('takes the names people bind as, the ones the check lets through after =', () => {
    for (const name of NAMES.filter((n) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(n)))
      expect(bindingSpecs(['S'], [], { as: [name] }), name).toEqual([
        expect.objectContaining({ key: 'S', target: name, hidden: true }),
      ]);
    for (const name of ['HF_TOKEN', 'OPENAI_API_KEY', 'MysqlReplicaPassword'])
      expect(bindingSpecs(['S'], [], { as: [name] })[0]).toMatchObject({ target: name });
    for (const file of ['config_token', 'gh-token', 'id_ed25519'])
      expect(bindingSpecs([], ['s'], { paths: [file] })[0]).toMatchObject({
        target: file,
        hidden: true,
      });
  });

  it('with --no-value-check sends a flagged one as typed, and marks it hidden', () => {
    const hashed = 'cert-sha256-9f86d081884c7d659a2f';
    expect(() => bindingSpecs([], ['tls'], { paths: [hashed] })).toThrow('--no-value-check');
    expect(
      bindingSpecs(['GH'], ['tls'], { as: [values.ghp], paths: [hashed], valueCheck: false }),
    ).toEqual([
      expect.objectContaining({ key: 'GH', target: values.ghp, afterEquals: false, hidden: true }),
      expect.objectContaining({ key: 'tls', target: hashed, afterEquals: false, hidden: true }),
    ]);
    // The override skips only the value check: the name rules still hold.
    expect(() => bindingSpecs(['S'], [], { as: ['not-a-var'], valueCheck: false })).toThrow(
      '--as must be letters',
    );
  });

  it('still holds it to the naming rules, without quoting it', () => {
    expect(() => bindingSpecs(['A'], [], { as: ['not-a-var'] })).toThrow(
      '--secret #1: --as must be letters',
    );
    expect(() => bindingSpecs([], ['a'], { paths: ['Not.A.File'] })).toThrow(
      '--secret-file #1: --path must be lowercase',
    );
  });

  it('is hidden even when it reads as a name, as a target typed after = is', () => {
    // Only a target taken from the secret's own name (C here) is shown.
    const specs = bindingSpecs(['A', 'B=TYPED', 'C'], [], { as: ['NAMED'] });
    const shown = withoutTypedTargets(
      { secrets: [{ env: 'NAMED' }, { env: 'TYPED' }, { env: 'C' }] },
      specs,
    );
    expect(shown.secrets).toEqual([{ env: '[REDACTED]' }, { env: '[REDACTED]' }, { env: 'C' }]);
    const error = scrubTypedTargets(new Error('env NAMED and env TYPED are reserved'), specs);
    expect((error as Error).message).toBe('env [REDACTED] and env [REDACTED] are reserved');
  });

  it('is hidden from the output and the error when it looks like a value', () => {
    // B takes its secret's own name, which is shown.
    const specs = bindingSpecs(['A', 'B'], ['c'], {
      as: [values.ghp],
      paths: [values.slack],
      valueCheck: false,
    });
    const shown = withoutTypedTargets(
      { secrets: [{ env: values.ghp }, { env: 'B' }, { file: values.slack }] },
      specs,
    );
    expect(shown.secrets).toEqual([{ env: '[REDACTED]' }, { env: 'B' }, { file: '[REDACTED]' }]);
    const error = scrubTypedTargets(
      new Error(`env ${values.ghp} is reserved; file ${values.slack} is taken; B is fine`),
      specs,
    );
    expect((error as Error).message).toBe(
      'env [REDACTED] is reserved; file [REDACTED] is taken; B is fine',
    );
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

// --- what `secrets set` and `secrets rm` send and repeat (OPL-5234, OPL-5235, OPL-5214)

/** `main` over a fake store: stdin piped as `stdin`, or `tty` read as a terminal. */
async function run(
  args: string[],
  respond: Responder,
  stdin: string | CliIO['stdin'] = 'the-value\n',
) {
  const rec = recorder(respond);
  let out = '';
  let err = '';
  const sink = (add: (s: string) => void) => ({
    write: ((s: unknown) => {
      add(String(s));
      return true;
    }) as NodeJS.WritableStream['write'],
  });
  const code = await main(args, {
    env: { MANDALA_API_KEY: 'com_cli_test' },
    stdin:
      typeof stdin === 'string'
        ? Object.assign(Readable.from([Buffer.from(stdin)]), { isTTY: false })
        : stdin,
    stdout: sink((s) => {
      out += s;
    }),
    stderr: sink((s) => {
      err += s;
    }),
    createClient: () => new Client({ apiKey: 'com_cli_test', baseUrl: BASE, fetch: rec.fetch }),
    now: () => new Date('2026-09-16T00:00:00Z'),
  });
  return { code, out, err, rec };
}

/** A store holding `rows`, which creates what it is sent and deletes what it is asked to. */
const store =
  (rows: (typeof SECRET)[]): Responder =>
  (call) => {
    if (call.path === '/secrets' && call.method === 'GET')
      return json({ ...SECRET_LIST, secrets: rows });
    if (call.path === '/secrets' && call.method === 'POST')
      return json(
        { ...SECRET, id: 'csec-00000000000000aa', name: (call.body as { name: string }).name },
        { status: 201 },
      );
    if (call.method === 'DELETE') return json({ ok: true });
    return json({ error: 'No such secret.' }, { status: 404 });
  };

/** The value typed where a NAME goes. A valid name by the platform's rules, too. */
const TOKEN = tok('ghp_', body(36));

describe('secrets set refuses a NAME that looks like a value', () => {
  it('is flagged by the value check, and passes the name rules', () => {
    expect(looksLikeSecretValue(TOKEN)).toBe(true);
    expect(TOKEN.length).toBeLessThanOrEqual(60);
  });

  it('sends nothing and never repeats it, piped or --json', async () => {
    for (const mode of [[], ['--json']]) {
      const r = await run(['secrets', 'set', TOKEN, ...mode], store([]));
      expect(r.code).not.toBe(0);
      expect(r.rec.calls).toEqual([]);
      expect(r.out + r.err).not.toContain(TOKEN);
      expect(r.out + r.err).toContain('--no-value-check');
      expect(r.out + r.err).toMatch(/nothing was sent/);
    }
    // Surrounding spaces are trimmed off a name, so they do not hide one.
    const padded = await run(['secrets', 'set', ` ${TOKEN} `], store([]));
    expect(padded.code).not.toBe(0);
    expect(padded.rec.calls).toEqual([]);
  });

  it('refuses a base64 secret that `/` cuts short, and never repeats it', async () => {
    const text = await run(['secrets', 'set', AWS_SECRET_EXAMPLE], store([]));
    expect(text.code).not.toBe(0);
    expect(text.rec.calls).toEqual([]);
    expect(text.out + text.err).not.toContain(AWS_SECRET_EXAMPLE);
    expect(text.err).toMatch(/looks like a secret's value.*nothing was sent/);
    const asJson = await run(['secrets', 'set', AWS_SECRET_EXAMPLE, '--json'], store([]));
    expect(asJson.code).not.toBe(0);
    expect(asJson.rec.calls).toEqual([]);
    expect(asJson.out + asJson.err).not.toContain(AWS_SECRET_EXAMPLE);
    expect(JSON.parse(asJson.out).error.code).toBe('invalid_arguments');
  });

  it('never prompts with it at a terminal', async () => {
    const modes: boolean[] = [];
    const tty = Object.assign(new PassThrough({ objectMode: true }), {
      isTTY: true,
      setRawMode: (mode: boolean) => modes.push(mode),
    });
    tty.write(Buffer.from('the-value\r'));
    const r = await run(['secrets', 'set', TOKEN], store([]), tty);
    expect(r.code).not.toBe(0);
    expect(r.err).not.toMatch(/Value for/);
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(modes).toEqual([]);
    expect(r.rec.calls).toEqual([]);
  });

  it('sends it as typed with --no-value-check', async () => {
    const r = await run(['secrets', 'set', TOKEN, '--no-value-check'], store([]));
    expect(r.code).toBe(0);
    expect(r.rec.calls.find((x) => x.method === 'POST')?.body).toEqual({
      name: TOKEN,
      value: 'the-value',
    });
  });

  it('takes the names people store', async () => {
    for (const name of ['GITHUB_TOKEN', 'db-password', 'SLACK_WEBHOOK_URL', 'OPENAI_API_KEY']) {
      const r = await run(['secrets', 'set', name], store([]));
      expect(r.code).toBe(0);
      expect(r.rec.calls.find((x) => x.method === 'POST')?.body).toEqual({
        name,
        value: 'the-value',
      });
    }
  });
});

describe('secrets rm repeats the NAME only when it is safe to', () => {
  it('does not repeat a value typed as the name, in text or --json', async () => {
    const text = await run(['secrets', 'rm', TOKEN], store([]));
    expect(text.code).toBe(1);
    expect(text.out + text.err).not.toContain(TOKEN);
    expect(text.err).toContain('no secret with that name or id in this scope');
    const asJson = await run(['secrets', 'rm', TOKEN, '--json'], store([]));
    expect(asJson.code).toBe(1);
    expect(asJson.out + asJson.err).not.toContain(TOKEN);
    expect(JSON.parse(asJson.out).error).toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('that name or id'),
    });
    expect(asJson.rec.calls.some((x) => x.method === 'DELETE')).toBe(false);
  });

  it('does not repeat a base64 secret that `/` cuts short, in text or --json', async () => {
    const text = await run(['secrets', 'rm', AWS_SECRET_EXAMPLE], store([]));
    expect(text.code).toBe(1);
    expect(text.out + text.err).not.toContain(AWS_SECRET_EXAMPLE);
    expect(text.err).toContain('no secret with that name or id in this scope');
    const asJson = await run(['secrets', 'rm', AWS_SECRET_EXAMPLE, '--json'], store([]));
    expect(asJson.code).toBe(1);
    expect(asJson.out + asJson.err).not.toContain(AWS_SECRET_EXAMPLE);
    expect(JSON.parse(asJson.out).error).toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('that name or id'),
    });
  });

  it('still names an id, and a name that reads as one, it did not find', async () => {
    for (const typed of ['csec-0123456789abcdef', 'MY_KEY']) {
      const r = await run(['secrets', 'rm', typed], store([]));
      expect(r.code).toBe(1);
      expect(r.err).toContain(`no secret named ${JSON.stringify(typed)} in this scope`);
    }
  });

  it('does not repeat it when it is one secret’s name and another’s id', async () => {
    // A value stored as a name by mistake, and a secret whose id spells it.
    const rows = [
      { ...SECRET, id: TOKEN, name: 'OTHER' },
      { ...SECRET, id: 'csec-00000000000000cc', name: TOKEN },
    ];
    for (const mode of [[], ['--json']]) {
      const r = await run(['secrets', 'rm', TOKEN, ...mode], store(rows));
      expect(r.code).not.toBe(0);
      expect(r.out + r.err).toMatch(/ambiguous_secret|is the name of/);
      expect(r.out + r.err).toContain('that name or id is the name of csec-00000000000000cc');
      expect(r.out + r.err).not.toContain(TOKEN);
      expect(r.rec.calls.some((x) => x.method === 'DELETE')).toBe(false);
    }
  });

  it('does not repeat a value-shaped name it deleted, in text or --json', async () => {
    const rows = [{ ...SECRET, id: 'csec-00000000000000cc', name: TOKEN }];
    for (const typed of [TOKEN, 'csec-00000000000000cc']) {
      const text = await run(['secrets', 'rm', typed], store(rows));
      expect(text.code).toBe(0);
      expect(text.rec.calls.some((x) => x.method === 'DELETE')).toBe(true);
      expect(text.out + text.err).not.toContain(TOKEN);
      expect(text.out).toBe('deleted csec-00000000000000cc\n');
      const asJson = await run(['secrets', 'rm', typed, '--json'], store(rows));
      expect(asJson.code).toBe(0);
      expect(asJson.rec.calls.some((x) => x.method === 'DELETE')).toBe(true);
      expect(asJson.out + asJson.err).not.toContain(TOKEN);
      expect(JSON.parse(asJson.out).data).toEqual({ id: 'csec-00000000000000cc', deleted: true });
    }
  });

  it('still names a plain name it deleted', async () => {
    const rows = [{ ...SECRET, id: 'csec-00000000000000cc', name: 'MY_KEY' }];
    const text = await run(['secrets', 'rm', 'MY_KEY'], store(rows));
    expect(text.code).toBe(0);
    expect(text.out).toBe('deleted csec-00000000000000cc  MY_KEY\n');
    const asJson = await run(['secrets', 'rm', 'MY_KEY', '--json'], store(rows));
    expect(JSON.parse(asJson.out).data).toEqual({
      id: 'csec-00000000000000cc',
      name: 'MY_KEY',
      deleted: true,
    });
  });

  it('does not repeat an operand the name rules refuse, though the value check passes it', async () => {
    const passphrase = 'correct horse battery staple and a few more words to pass sixty chars';
    expect(passphrase.length).toBeGreaterThan(60);
    for (const typed of [passphrase, 'MY\u0007KEY']) {
      expect(looksLikeSecretValue(typed)).toBe(false);
      const text = await run(['secrets', 'rm', typed], store([]));
      expect(text.code).toBe(1);
      expect(text.out + text.err).not.toContain(typed);
      expect(text.err).toContain('no secret with that name or id in this scope');
      const asJson = await run(['secrets', 'rm', typed, '--json'], store([]));
      expect(asJson.code).toBe(1);
      expect(asJson.out + asJson.err).not.toContain(typed);
      expect(JSON.parse(asJson.out).error.message).toContain('that name or id');
    }
  });

  it('still names an ambiguous key that reads as a name', async () => {
    const rows = [
      { ...SECRET, id: 'csec-00000000000000bb', name: 'OTHER' },
      { ...SECRET, id: 'csec-00000000000000cc', name: 'csec-00000000000000bb' },
    ];
    const r = await run(['secrets', 'rm', 'csec-00000000000000bb'], store(rows));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('"csec-00000000000000bb" is the name of csec-00000000000000cc');
  });
});

describe('a create binding a stored name that looks like a value', () => {
  it('names the binding by position alone when refusing it', async () => {
    const rows = [{ ...SECRET, id: 'csec-00000000000000cc', name: TOKEN }];
    const r = await run(['computers', 'create', '--secret', TOKEN, '--secret', TOKEN], store(rows));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--secret #2 binds the secret --secret #1 already binds');
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(r.rec.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it('names it by position alone when its name cannot be a variable', async () => {
    const dashed = tok('sk-', body(40));
    expect(looksLikeSecretValue(dashed)).toBe(true);
    const rows = [{ ...SECRET, id: 'csec-00000000000000cc', name: dashed }];
    const r = await run(['computers', 'create', '--secret', dashed], store(rows));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--secret #1: its name cannot be a variable name as it is');
    expect(r.out + r.err).not.toContain(dashed);
    expect(r.rec.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it('still quotes a key that reads as a name', async () => {
    const r = await run(
      ['computers', 'create', '--secret', 'OPENAI_API_KEY', '--secret', 'OPENAI_API_KEY'],
      store([{ ...SECRET }]),
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--secret #2 ("OPENAI_API_KEY") binds the secret');
  });
});

describe('secret names reach the terminal escaped', () => {
  // The platform refuses only control characters in a name, so a bidi
  // override is stored and would reorder the id, revision and dates after it.
  const SPOOF = 'API‮KEY';
  const row = { ...SECRET, name: SPOOF };

  it('in list, set and rm, and as the real string under --json', async () => {
    const list = await run(['secrets', 'list'], store([row]));
    expect(list.code).toBe(0);
    expect(list.out).not.toContain('‮');
    expect(list.out).toContain('API\\u202eKEY');
    const set = await run(['secrets', 'set', SPOOF], store([]));
    expect(set.code).toBe(0);
    expect(set.out).not.toContain('‮');
    expect(set.out).toContain('API\\u202eKEY');
    const rm = await run(['secrets', 'rm', SPOOF], store([row]));
    expect(rm.code).toBe(0);
    expect(rm.out).not.toContain('‮');
    expect(rm.out).toContain('API\\u202eKEY');
    const asJson = await run(['secrets', 'list', '--json'], store([row]));
    expect(JSON.parse(asJson.out).data.secrets[0].name).toBe(SPOOF);
  });
});
