# Changelog

Notable changes to `mandala-computer`. Dates are release dates; the format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project is pre-1.0, so a minor version may carry a behaviour change.

The reasoning behind a change lives in its commit message rather than here.
This is the summary you read to decide whether to upgrade.

## [Unreleased]

One behaviour change to read before upgrading, under **Changed**: the CLI's
`--json` output is snake_case throughout, envelope included, so its
`schema_version` is now 2 and `error.code` is a reason word rather than a class
name.

### Added

- **CLI: `computers create --secret SECRET --as VAR` and `--secret-file SECRET
  --path FILE`** name a binding's variable or file with a flag of its own, so
  nothing typed there can be taken for the secret's value. Each `--as` or
  `--path` must come directly after its `--secret` or `--secret-file`; a stray
  one is refused without being quoted, unless `--help` is also given, which
  prints help. A name given this way is not put
  through the value-shape check and prints as it is. The manifest marks both
  with `follows`, and the completions offer them.
- **A proxy for a computer's browsers:** `browserProxy: { server, bypass? }` on
  `computers.create()` and `launch()`, and on `computer.update()`, where it
  travels alone and `null` removes it; `computer.browserProxy` and
  `computer.browserProxyPending` read it back, and
  `computer.waitForBrowserProxy()` waits until the guest has it (its
  `expectBrowserProxy` option waits past a read that leaves the setting out,
  and a computer with none whose start is admitted is waited on until it
  runs, so a proxy removed while it was stopped is gone first). `launch()`
  waits for it when the create carried one. Which proxies are accepted is the
  platform's rule, so a refused value is its `400`, not a check here. The CLI
  takes `computers create --browser-proxy URL [--browser-proxy-bypass LIST]`,
  `computers browser-proxy set COMPUTER URL [--bypass LIST]`,
  `computers browser-proxy clear COMPUTER` and `computers wait --until
  browser-proxy`; an empty bypass entry is refused, as the SDK refuses one. New exports: `BrowserProxy` and `BrowserProxyArgs`.
- **Screenshot shaping: `region`, `scale`, `format` and `quality`** on
  `computer.screenshot(width, { ... })`, over the platform's new query
  parameters — a crop in screen pixels, a shrink factor in (0, 1], `png` or
  `jpeg`, and a JPEG quality of 1-100 — for a cheaper frame to hand a model.
  A scale beside a width, a quality on a PNG and malformed values throw a
  `ValidationError` before anything is sent. A suspended computer refuses a
  crop, a scale, a PNG or a quality with a `ConflictError` whose `reason` is
  `unavailable`. The CLI's `computers screenshot` takes `--region`, `--scale`,
  `--format` and `--quality`. New exports: `ScreenshotShape`,
  `ScreenshotRegion`, `ScreenshotFormat` and `SCREENSHOT_FORMATS`.
- **`client.apiKeys.list()`, `create({ name, workspaceId })` and
  `revoke(id)`**, and **`client.account.whoami()`**, over the platform's new
  `GET whoami` and `GET|POST api-keys`, `DELETE api-keys/{id}`. The key
  routes need the calling key's opt-in "Manage keys" permission, granted only
  from a dashboard session; without it they are a `PermissionDeniedError`
  carrying the platform's sentence. A minted key is answered once, as
  `ApiKeyCreated.key`, and never has the permission itself.
- **CLI: `whoami`, `api-keys list | create | revoke`, `logout` and
  `--version`** (also `version`). `logout` forgets one saved profile on this
  machine and prints the id of the key it held, which stays valid until
  revoked; `api-keys create` prints only the new key on stdout.
- **Two ways to install only the CLI:** `brew install mandalacomputer/tap/mandala`
  (the formula's reviewed copy is in `packaging/homebrew/`) and
  `curl -fsSL https://mandala.computer/install.sh | sh`. The formula installs
  this package's npm tarball against Homebrew's `node`, with bash, zsh and fish
  completions; the script installs it with npm. The README's Install and CLI
  sections give both. The package itself is unchanged.
- **CLI: `files list`, `files upload`, `files download`.** A guest directory's
  entries, and one file in or out, with the computer named on its own rather
  than spelled `computer:/path`. Upload and download are `scp`'s two halves,
  `--no-overwrite` included, and report the same result.
- **CLI: `computers rename`, `computers resize` and `computers view`.** Resize
  takes `--cpu`, `--ram-mb` and `--disk-gb` and needs the computer stopped.
  View opens the computer's dashboard page and prints its URL (`--no-open` only
  prints it).
- **CLI: `computers create --secret SECRET[=VAR]` and
  `--secret-file SECRET[=FILE]`**, repeatable, bind stored secrets at create,
  found by name or id. The variable or file defaults to the secret's name. An
  error never quotes what follows the first `=`, where a value typed by mistake
  would be, and a secret or a target bound twice fails before the create.
  A target that looks like a secret's value rather than a name is refused
  before anything is sent: a known token prefix (`ghp_`, `github_pat_`, `sk-`,
  `sk_live_`, `xoxb-`, `glpat-`, `AIza`, `hf_`, `npm_`, `pypi-`, `SG.` and
  others) ahead of a token body, an AWS key id, a UUID, or a random-looking
  stretch of twenty or more characters. Camel-case words, acronyms among
  them, are not random. After a token prefix, a body of twelve or more
  mixed-case letters counts as words only when every camel-case segment of it
  reads as one (an acronym, a known abbreviation such as `Ssl` or `Pg`, or a
  word spelled as English spells, allowing one join such as `Kafka` or
  `Webflow`), so a random body with no digit in it is caught too (99% or
  more). A name the check still refuses goes through when it is named with
  `--as` or `--path`, which are not checked, or with `--no-value-check`.
  A variable or file typed after `=`
  prints as `[REDACTED]` in the create's bindings and in the create's error;
  one that defaults to the secret's name prints as it is.
- **`client.secrets.set({ name, value, workspaceId })`**: create the name, or
  replace its value if the scope already holds it — the upsert Python and both
  CLIs already had. Names match ignoring ASCII case, as the platform keeps them
  unique; a conflict between the read and the write is read again up to three
  times, and a 503 is never sent again.
- **`computer.waitForSecrets()`** and **`computer.secretsDelivering`**. A computer
  comes back `running`, and its guest answers, a few seconds before its secrets
  land. The wait polls until the platform's `secrets_delivering` is false (or,
  on a platform that predates it, until the receipt names the latest delivering
  start), and throws instead of waiting out its timeout for a delivery that
  failed, a stopped computer the platform says has no start admitted, or a
  create's computer whose first start failed (`startError`, kept past the
  refresh that clears it, as `waitUntilRunning` keeps it); a host that does
  not say is waited on. `expectSecrets: true` tells it secrets are bound, so a
  read that leaves the bindings out is waited past rather than taken for
  "nothing bound" — unless that read says outright that nothing is starting,
  which is refused as above. A restart delivers bound secrets again and reads
  `running` before they land. Called after `restart()`, it waits for them on a
  platform that reports that redelivery as `secrets_delivering`; on one that
  does not, `secrets_delivering` reads false throughout and the wait returns at
  once. The CLI's `computers wait --until secrets` runs it.

### Changed

- **`computers.launch()` waits for bound secrets.** With secrets bound it now
  returns only once they have reached the desktop, inside the same readiness
  budget, so the first command on the returned computer sees them. A delivery
  that failed throws, naming why. A launch with nothing bound makes no extra
  request.
- **CLI `--json` is snake_case everywhere** (`schema_version` 2). The envelope
  reads `schema_version` and `exit_code`; `account`, `usage`, `exec`, agent and
  build-progress data read like the API (`observed_at`, `per_computer`,
  `reported_through`, `exit_code`, `stdout_base64`, `input_tokens`, …);
  `computers delete` reads `snapshots_deleted`; the manifest reads `json_mode`,
  `requires_credentials` and `terminal_types`.
- **CLI `error.code` is one reason word**, the same vocabulary as `mandala-py`:
  `not_found`, `unauthenticated`, `conflict`, `timeout`, … never a class name
  such as `NotFoundError`. The platform's own `reason` rides beside it, and a
  local system error reads `io_error` with its errno under `details.errno`.
  The README lists every code.
- **A mistyped command prints its full usage** under a message that says what
  was wrong (`1 argument too many: mandala computers exec takes <computer> and
  nothing more`), rather than the bare usage line. `--json` carries the same
  text as `error.usage`. The extra arguments are counted, never quoted, and an
  unknown option is named only when it is shaped like one: either could be a
  secret typed where `secrets set` reads stdin. Under `secrets`, no usage
  error repeats what was typed — not an option-shaped word such as
  `--sk-live-0123`, even typed before `secrets`, `help secrets` or
  `-- secrets`, and not an unknown verb — and a word after `--` is always an
  operand, counted; a `--json` there no longer turns a usage error into JSON.
  An unknown option under `secrets` points at stdin unless the verb is `list`
  or `rm`, which read no value: for `set`, for no verb, and for a word that is
  no verb, wherever the option sits. A `--profile` whose value was left out,
  so that it took `secrets` or a verb under it as its value, is read both ways,
  before or after the unknown option: `--profile secrets --sk-live-0123 set A`
  is judged as typed under `secrets set`, and `secrets --sk-live-0123
  --profile list` under `secrets list`, with no stdin hint. Of the two
  readings, the one that passes over fewer words wins, and the one under
  `secrets` on a tie, so `--profile secrets --sk-live-0123 computers list`
  names a profile and is judged as typed under `computers list`. A second
  `--profile` is refused before an unknown option is judged, so it cannot
  hide which of the two was meant.

### Deprecated

- **CLI `computers create --secret SECRET=VAR` and `--secret-file
  SECRET=FILE`.** They still bind, with the value-shape guard and the redacted
  output they had, and now print one line on stderr naming `--as` and `--path`
  instead; the line never repeats what followed the `=`.

## [0.6.0] — 2026-09-25

Two behaviour changes to read before upgrading, both under **Changed**: a 503
on a change is no longer transient, and `computer.type()` now returns a value
and refuses empty or over-long text before sending. A create-only upload's
refusals arrive as two new `ConflictError` subclasses, `FileExistsError` and
`CreateOnlyConflictError`; `noWake`'s reasonless 409 as `ComputerNotRunningError`.

### Added

- **Create-only uploads.** `computer.writeFile(path, data, { overwrite: false })`
  writes the file only if nothing is at `path`. A path that is taken is refused
  with the new `FileExistsError` — a `ConflictError` whose `reason` is
  `"exists"`, which `isTransient` calls permanent — and that request writes
  nothing. A create-only upload's 409 with no usable reason (a body that could not
  be read, or JSON without a string `reason`) is raised as the new
  `CreateOnlyConflictError`, a `ConflictError` that `isTransient` calls
  permanent and that claims nothing about the path; `FileExistsError` is only
  the platform's explicit `exists`. If an earlier attempt's
  outcome was unknown, the file may be yours: read it and compare before
  choosing another path or overwriting.
  The default is unchanged: an upload replaces the file. Linux computers only.
  The CLI gains `scp --no-overwrite` for uploads: error code `exists` for a
  taken path, and `conflict` for a refusal whose reason could not be read.
- **The account's secret store.** `client.secrets.list()`, `create()`,
  `get()`, `replace()` and `delete()` over `GET/POST /secrets` and
  `GET/PUT/DELETE /secrets/{id}`, with `workspaceId` for a workspace's secrets.
  Values are write-only: every answer is a `Secret` — name, scope,
  `revisionId`, never a value. `replace` and `delete` send back the revision a
  read answered, and `delete` requires it. The CLI gains `mandala secrets list`,
  `mandala secrets set NAME` (value from stdin or a hidden prompt, never argv;
  creates or replaces, re-reading a moved revision) and `mandala secrets rm NAME`.
- **A computer's secret state.** `computer.secretBindings`,
  `secretsGeneration`, `secretsApplied` (the delivery receipt), `secretsError`
  and `secretsPending` — `true`, `false`, or `null` when the platform could not
  check, which is unknown and never false.
- **`computer.paste(text, { shortcut })`**, the `paste` input action: clipboard
  plus Ctrl+V (or Ctrl+Shift+V), up to 8192 bytes.
- **`computer.listDirectory(path)`**, `activities()`, `activity()`,
  `activityResults()` and `signals()` — the directory listing, retained API
  history and passive platform signals, which had no method.
- **`noWake: true`** on every file read and write: refuse rather than resume a
  computer that is not running. A reasonless 409 under it is the new
  `ComputerNotRunningError`, which `isTransient` calls final.
- **`computer.delete({ ..., detailed: true })`** answers the whole
  `DeleteResult` — `ok`, `computerDeleted` and the per-copy `purge` counts —
  since a purge still queued answers 202 with `ok: false` and does not throw.
- `Snapshot.restoreAvailable` and `computerUnreachable`; `Holdings`
  `computerPresent`, `capturing` and `deleting`; `APIError.method`.

### Changed

- **`isTransient` no longer calls a 503 on a change transient.** The platform
  answers a failure after the request was sent with 503 too, so a create,
  command or delete answered 503 may already have happened. An
  `UnavailableError` is transient only for GET and HEAD (one built by hand,
  with no `method`, keeps the old answer). Nothing in the SDK retried a change
  on 503 before; this is the answer an embedder's own retry loop gets.
- **`computer.type()` returns `{ mechanism }`** — `physical`, `unicode` or
  `mixed` — instead of nothing, and refuses empty text or more than 400
  characters before sending. Its docs no longer claim unmappable characters are
  skipped: the platform refuses unsupported text before typing anything.
- Docs: `WebhookDelivery.lastError` is an open set; `memoryDroppedReason` can
  be `"capture unrecorded"`; a replaced secret value reaches a running computer
  asynchronously and best effort, not "as soon as" or "within seconds".

## [0.5.0] — 2026-09-23

### Added

- **Secret bindings.** `computers.create({ secrets: [...] })` binds secrets
  from the account at create, each as an environment variable (`env`) or as a
  file under `/run/mandala-secrets/user/files` (`file`). `computer.secrets()`
  reads a computer's bindings with the `version` to send back, and
  `computer.setSecrets(list, { version })` replaces them. A binding's
  `revisionId` is the revision last delivered: every start and restart delivers
  each secret's latest value, and a secret bound as a file is replaced on a
  running computer as soon as its value is.
- **Memory snapshot clone options.** `snapshots.clone(id, name, { memory: false })`
  builds a memory snapshot's clone from its disk alone, as a fresh boot with its
  own network identity. `{ inheritSecrets: true }` consents to resuming a memory
  snapshot of a computer that held secrets: the copy holds the same credentials.
  The CLI gains `snapshots clone --disk-only` and `--inherit-secrets`.
- **`computer.memoryDropped` and `memoryDroppedReason`.** On the computer a
  snapshot clone returns, they say when the session you asked for was not
  resumed and the computer was built from the disk instead (`"secrets"` or
  `"bindings unrecorded"`). Check it before assuming the session came across.
- **`computers.launch()` creates a computer and returns it ready.** It creates,
  starts it if needed, and waits for the guest agent, sharing one 180-second
  readiness budget after the create. A failure leaves the computer in place and
  the error carries its id, so nothing is created twice or left untracked.
- **Stable execution ids and independent output reads.** A background command
  on a newer platform carries `job.executionId`. `computer.execution(id)` reads
  its state and `computer.executionOutput(id, { stdoutOffset, stderrOffset })`
  reads its bytes at offsets you hold, so several readers no longer split one
  output between them and a reused pid cannot point at the wrong command. PID
  polling and `execKill` are unchanged, and an older reply simply has no id.
- **Retained output and artifacts.** `computer.retainExecutionOutput()` and
  `exec(cmd, { retainOutput: true })` keep a command's output as an immutable,
  expiring result that `result()` and `resultOutput()` read without waking the
  computer; `deleteResult()` removes it. `publishArtifact(path, { expectedSize,
  expectedSha256 })` keeps a guest file you name, and `downloadArtifact()` returns
  it only after checking its length and SHA-256 in full.
- **Account quota.** `client.account.read()` returns the account's current
  quota, keeping an unknown value distinct from zero. The CLI gains
  `mandala account` and `mandala usage --from/--to`.
- **SSH keys and per-computer SSH.** `client.sshKeys.list()`, `add()` and
  `remove()` manage your keys (a duplicate is a `ConflictError`), and
  `computer.sshAccess()` / `setSshAccess(enabled)` switch the gateway on and off.
  `mandala ssh <computer>` runs your system OpenSSH through the Mandala gateway
  with its host key pinned, and `mandala ssh --setup`, `ssh-key`, `ssh-access`
  and `ssh-config` register a key, switch it on, and write a `~/.ssh/config`
  block that scp, sftp and VS Code Remote-SSH can use.
- **`mandala login` and saved profiles.** Approving in a browser saves an
  account or workspace API key to `~/.mandala/credentials.json`, shared with the
  Python client. `new Client({ profile })`, then `MANDALA_PROFILE`, selects one.
  An explicit `apiKey` or `MANDALA_API_KEY` still wins and never reads the file,
  and browser builds do not import the file store at all.
- **Opt-in retries for safe reads.** `new Client({ retries: { idempotent: N } })`
  retries GET and HEAD on a connection failure or a 502/503/504, with backoff
  that honours `Retry-After`, inside the original deadline and signal. It is
  off by default; mutations and consuming polls such as `execPoll` never retry.
- **A full `mandala` CLI.** Commands for computers, templates, snapshots,
  webhooks, agent runs, files and remote commands, with offline help, a JSON
  command manifest, Bash/Zsh/Fish completions, versioned `--json`/NDJSON output
  and distinct exit statuses.
- **Error metadata.** API errors carry `requestId`, `allow` and
  `wwwAuthenticate` when the response had them, and a 405 is now the exported
  `MethodNotAllowedError` rather than a plain `APIError`.

### Changed

- **The CLI's websocket shell is now `mandala terminal`.** It was `mandala ssh`,
  with the same flags and exit codes. `mandala ssh` now opens a real OpenSSH
  session and needs a registered key and SSH switched on for the computer, so a
  script that used `mandala ssh` for a shell should say `terminal`.

### Fixed

- **A nested error is classified by its HTTP status.** An error body nested
  inside another kept its message and reason but could be classified by the
  wrong status; it now uses the response's actual status and keeps the full
  body. A failed event stream keeps its partial-work evidence without becoming
  safe to replay.

### Documentation

- The OpenAI-compatible chat-completions endpoint has an executable example
  using the `openai` client, with separate Mandala and Anthropic keys.

## [0.4.0] — 2026-09-14

### Changed

- **`maxSteps` above the platform's ceiling is now refused locally.** This SDK
  documented the ceiling of 100, said in the same breath that it did not check
  it, and sent the value anyway to be told `400`. It is now one of the mirrored
  limits, checked beside the existing lower bound. A call sending more than 100
  failed either way; what changes is that it fails before the round trip, and
  that all three clients now answer the same way.
- **`screenshot(width, { fresh: true })` is allowed.** It used to throw a
  `ValidationError` before any request, and both the doc comment and the README
  said the refusal was the API's — that a width always serves a cached frame, so
  the flag would be taken and ignored. The API honours the two together, so the
  refusal was this SDK enforcing a rule that had stopped being true.
- **`reason: "revoked"` is classified as permanent.** The platform added a fifth
  refusal word for the case where the authority a request arrived with no longer
  holds — suspended, demoted, removed, or a retired session — and it is the
  first of these words about the *caller* rather than about a computer. Nothing
  was broken before this: a 401 or 403 is none of the four transient classes, so
  an unrecognised word already answered `false` from `isTransient`. What changes
  is that it is answered on purpose. The status still says what to do: 401 means
  present a credential again, 403 means the role changed and signing in again
  will not help.

### Fixed

- **A mid-run refusal carries the spend it already made.** A long call's
  authorization is not settled when the call starts, so an agent run can be
  stopped after steps have run on the desktop and cost model tokens. The error
  now carries the usage and the steps taken, which is the only place either is
  ever reported — the platform meters nothing on your model key.
- **A cancelled build event stream no longer reports a protocol failure.**
  `Builds.events` threw its missing-`done` error without checking the signal
  first, unlike `agentStream`, so a caller who cancelled was told the stream had
  broken.
- **Empty snapshot filters and incomplete agent streams are rejected** rather
  than being read as a request for everything or as a clean end.
- Stream errors are preserved, closed event backlogs are released, and terminal
  exit output survives.

### Documentation

- **A run's steps are not its model calls.** Several places said they were and
  offered `maxSteps` as a way to size Anthropic spend on that basis. The
  platform counts a step per *tool call* and encourages a model to ask for
  several actions in one reply, so one model call can spend several steps; a
  paused turn is resubmitted for tokens and no step; and a bash call or a cursor
  read takes no screenshot. A caller budgeting from the old sentence was wrong
  whichever way their run went.
- Webhook replay retention clarified.

### Internal

No effect on the published surface, listed because it is most of the window.

- The drift check reads the platform's published **surface manifest** instead of
  scanning its TypeScript as text, and imports this repo's own mirror the way
  the suite does rather than reading it with regexes. 760 lines of hand-written
  reader are gone, along with the class of defect they kept producing: a false
  all-clear, reporting the mirror in step because the scan had silently read
  nothing. The new reader fails closed on a manifest that is missing,
  unparseable, of an unknown version, or that names a key twice.
- The limits this SDK mirrors are now compared against the platform's, which
  nothing did before — seven of them, `agent.maxSteps` having joined the set with
  the change above.
- Several parser fixes landed before that scanner was retired, each ported
  to and from the MCP server's byte-identical copy.

[0.6.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.3.0...v0.4.0
