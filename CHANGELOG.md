# Changelog

Notable changes to `mandala-computer`. Dates are release dates; the format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project is pre-1.0, so a minor version may carry a behaviour change.

The reasoning behind a change lives in its commit message rather than here.
This is the summary you read to decide whether to upgrade.

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

[0.5.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.3.0...v0.4.0
