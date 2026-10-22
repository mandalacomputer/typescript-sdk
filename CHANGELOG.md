# Changelog

Notable changes to `mandala-computer`. Dates are release dates; the format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project is pre-1.0, so a minor version may carry a behaviour change.

The reasoning behind a change lives in its commit message rather than here.
This is the summary you read to decide whether to upgrade.

## [Unreleased]

## [0.17.2] — 2026-10-22

### Fixed

- Correct public-URL guidance: omitted access is public on paid plans and private
  on trials; private URLs support appropriately scoped account API keys and
  dashboard browser sign-in. Trials cannot request public access.
- Describe runtime, storage and exec usage as resource consumption rather than
  extra subscription charges. AI-credit and model-provider billing is unchanged.

## [0.17.0] — 2026-10-19

### Added

- **CLI: agent threads and background runs.** `mandala agent run` takes
  `--thread` to continue a conversation an earlier run kept (without
  `--computer`, on the thread's own computer), `--no-store` to keep nothing,
  and `--background` to start a background run, print its id (with `--json`,
  the run, as one finite result) and exit 0. `mandala agent runs list`, `get`
  and `cancel` read and stop background runs; `get --wait` polls until the run
  ends and exits 0 only when it finished. `mandala agent threads list`, `get`
  and `delete` read and remove threads; `delete` needs `--yes`. Human output
  says which thread a run started, and a failed run's error frame carries
  `details.thread_id`.
- **CLI: `mandala agent chat` and `mandala agent resume`.** A line-based
  conversation: each line read on stdin runs the agent on one thread, streamed
  as `agent run` streams it, until Ctrl-D or `/exit`; Ctrl-C stops the run in
  flight, not the session. `agent chat --computer` starts a new thread, and
  `agent resume [thread]` continues one, offering the most recently used to pick
  from when no thread is given and stdin is a terminal. A session exits 0 when
  every run in it finished and 1 when any did not.

### Changed

- **A run refused while the platform updates is safe to send again.** While the
  platform updates, `agent()`, `agentStream()`, `agentOnce()`,
  `agentRuns.start()` and `startAgentRun()` can be refused with a `503`
  carrying `reason: "draining"` and a `Retry-After`, before anything starts.
  `isTransient` now answers true for it, whatever the method. A client
  constructed with `retries` sends those calls again after the wait, within the
  same budget, backoff and deadline; retries stay off by default, and nothing
  else those calls meet is resent. Only the refusal's own shape counts: a body
  whose `error` is not a plain string, one that also reports a run (`usage`,
  `steps`, `steps_taken`, `cost_usd`, `thread_id` or `agent`), and an answer a
  `fetch` you passed reached through a redirect are neither resent nor
  transient.
- **CLI: human error output names the platform's `reason`** after the status
  and the API's code, as `(HTTP 503, reason: draining)`. `--json` already
  carried it.

## [0.16.0] — 2026-10-18

### Added

- **Agent threads.** `agent()`, `agentStream()` and `agentOnce()` take
  `threadId`, to continue a conversation an earlier run kept: the model is
  given the thread's earlier turns and acts only on the new prompt. `store:
  false` keeps nothing, and `messages` (`[{ role, content }]`) brings a history
  you keep yourself. `store: false` with `threadId`, a non-empty `messages`
  with `threadId`, and a malformed `messages` are refused before the call. The
  thread a run was kept in is `threadId` on `AgentResult`, on `agentStream()`'s
  `error` event, and on the error a failed run throws (`err.threadId`; it was
  only in `raw` or `body` before). `client.agentThreads.list({ computerId,
  limit, before })`, `get(threadId)` and `delete(threadId)` read and remove
  them; a page's `nextBefore` is the `before` for the next.
- **Background agent runs.** `client.agentRuns.start(computerId, args)` and
  `computer.startAgentRun(args)` start the agent loop and answer at once with
  the run (`status: 'running'`), which goes on after the request ends.
  `client.agentRuns.get(runId)`, `list({ computerId, status, limit, before })`
  and `cancel(runId)` read and stop runs, and `wait(runId, { timeoutMs, pollMs,
  signal })` polls until a run has ended and answers it whatever the ending.
  `AgentRun.finished` is true only for a run that completed at `end_turn`.

### Documentation

- The section on pointing an OpenAI client at `chat/completions` no longer says
  earlier messages are ignored: the user and assistant messages before the last
  user message are the conversation so far, and those runs are kept in threads
  (`agent.thread_id`) as the native route's are.

## [0.15.0] — 2026-10-18

### Changed

- **Waits read a 409's word before polling again.** Every wait
  (`waitUntilRunning`, `waitUntilBuilt`, `waitForGuest`, `waitForDesktop`,
  `waitForSecrets`, the proxy waits, `waitForMove`, `launch`, `builds.wait`,
  `operations.wait`, the snapshot capture and delete waits, and the event
  stream's reconnect) used to poll through any 409. A 409 with a permanent
  `reason` (`unavailable`, `unsupported`, `revoked`, `exists`, `running`,
  `name_taken`, `stale_revision`, `stale_capture`) or the code
  `template_image_preparing` or `idempotency_outcome_unknown` now ends the
  wait at once with that error, rather than a timeout up to 30 minutes later.
  `contention`, `starting` and the reasonless codes `idempotency_in_progress`
  and `WORKSPACE_MOVING` keep polling. Any other 409 without a reason also ends
  the wait, except in `waitForDesktop`, where it is the "no desktop session
  yet" answer that wait exists for. `waitForGuest` rides out a booting guest's
  `starting`, as before, and treats a probe's `unavailable` as a cue to re-read
  the computer: it ends only when the computer reads stopped and holds
  nothing, and keeps probing an admitted start.
- **`isTransient` calls a 503 with no recorded method final.** Every error this
  SDK builds from a response records its method, and a 503 is transient only
  for GET and HEAD. An `UnavailableError` built by hand, with no method, used
  to be transient; it cannot be known to be a read, so it no longer is. The
  Python SDK and the MCP server answer the same way.
- **Unreadable rows fail the call instead of being dropped.** `sizes.list`
  refuses a row that is not an object, a size with no id, unreadable
  `cpu`/`ram_mb`/`disk_gb`, or an `allowed` that is neither true nor false
  (it used to read as false). `usage.read` refuses a breakdown row that is not
  an object, has no id or has an unreadable `gone`. Build progress refuses a
  step that is not an object. A webhook refuses an `events` or `computers`
  list containing anything but non-empty strings: dropping an unreadable id
  could leave `computers: []`, which means every computer in scope.

### Documentation

- `uploadFile`'s 4 MiB chunk size is fixed. Each request body must arrive
  within two minutes with no 60-second idle gap, so on a slow link use
  `writeFileChunk` with smaller chunks under the same upload ID.
- `inputBatch` coordinates are numbers, as OpenAI sends them. The platform
  drops a fraction toward zero, while `click` and the other single-action
  methods refuse a non-integer.
- Clarify the browser URL policy's advertised disconnect protection for
  temporary contexts on supported remote Linux computers, including guardian
  loss and browser-connection loss for public HTTP(S) destinations. Document
  the remaining proxy, local-network, restart, page/session detach and cleanup
  limits. This is a documentation correction; protection depends on the
  deployed backend.

## [0.14.0] — 2026-10-16

### Added

- **Resumable uploads.** On a Linux computer with Python 3,
  `computer.uploadFile(path, source, options)` uploads a file of up to 2 GiB
  in 4 MiB chunks from a random-access source (`size` plus an async
  `read(offset, length)`), and publishes it atomically when the last chunk
  lands; `overwrite: false` refuses an occupied destination. An interrupted
  upload throws with `uploadId` on the error (`UploadInterruptedError` when the
  transfer itself broke): pass it back as `uploadId` with the unchanged source
  and the upload resumes from the offset the computer reports. A supplied ID
  must already exist — a missing one is a 404, never a silent restart.
  `writeFileChunk` (at most 8 MiB), `fileUpload` and `cancelFileUpload` expose
  the protocol directly. Staging and completion receipts use guest disk until
  cancelled and do not expire. A host without the endpoint refuses it rather
  than falling back to a truncating write, and `writeFile` is unchanged.
- **The CLI uses it above 64 MiB.** `mandala files upload` and upload-side
  `scp` switch to resumable uploads for larger files; resume either with
  `mandala files upload … --upload-id ID` and the unchanged local file. The CLI
  cleans up the receipt afterwards without waking a suspended computer again,
  and says so when it could not (`cleanup_upload_id` in JSON output).
  `--no-overwrite` and `--no-wake` apply to both transfer modes.

### Changed

- Development moves to vitest 4.1.12, and CI audits the dependency tree on
  every pull request and daily.

## [0.13.0] — 2026-10-13

### Added

- **Public URLs.** Serve a port inside a computer at
  `https://<label>.<base_domain>`, on port 443; the base domain is the
  platform's (`mandala.dev`, for example), read from the list's `baseDomain`:
  `computer.publicUrls()` lists them with whether they can answer and the
  plan's limit, `createPublicUrl({ port, label?, access? })` makes one
  (`public`, the default, is anyone with the link; `private` answers only this
  account's API keys, which never reach the app), `updatePublicUrl(id, {
  port?, access? })` changes one, and `deletePublicUrl(id)` removes it. A
  deleted URL's label stays with the account: no other account can ever take
  it, and the account may use it again unless the platform has blocked it.
  The `client.publicUrls` has the same four calls by the computer's id, with
  no handle. The `mandala` CLI has the same as `computers urls
  list|create|update|rm`: a computer id is used as given and a name looked
  up, and a URL is found by its id, label, hostname or address (`--id` sends a
  URL id unlooked-up). A URL whose `access` is neither `public` nor `private`
  fails the listing rather than being shown, deliberately: who may open a URL
  is the one thing this client will not guess. Needs a platform with public
  URLs enabled for the account.
- **Move a computer to another workspace.** `computer.moveToWorkspace(id)`, or
  `null` to leave it in none, and `mandala computers move COMPUTER --workspace
  ID|unassigned` (OPL-5932). It needs an account-wide credential of a member or
  owner, and a stopped computer with no snapshots, secret bindings or
  credentialed proxies; nothing is stopped or cleaned up for you. The CLI
  refuses `--ram-mb`, `--cpu`, `--disk-gb`, `--wait`, `--timeout-ms`,
  `--poll-ms` and `--idempotency-key` in this mode, and never uses the
  profile's default workspace as the destination.
- **`WorkspaceMember.seatSuspended`** (OPL-5919): `true` while a member waits
  for a plan seat and cannot act on the account, independent of `suspended`;
  `undefined` from a server that does not send it. `members()` lists accepted
  members, including those waiting for a seat.
- **The platform's error `code` in CLI errors, as `api_code`** (OPL-5963,
  OPL-5973). `mandala --json` failures carry it as `api_code` beside the CLI's
  own `code`, so two refusals with one status, such as `LABEL_TAKEN` and
  `PUBLIC_URL_LIMIT`, can be told apart without reading the sentence. Without
  `--json`, a refusal from the platform ends its line with `(HTTP <status>,
  <code>)`, or `(HTTP <status>)` when there is no code. The platform's
  `Retry-After` is kept as well: `retry_after_ms` in the `--json` envelope, and
  a line of its own saying how long to wait in text.
- **`snapshots list --computer` takes a name** as well as an id, as `moves
  list` does. A name used to match nothing and return an empty list without a
  word; one that names no computer now is kept as an id, for a deleted
  computer's snapshots (OPL-5973).

### Changed

- **A 409 the platform did not classify is final: `isTransient()` answers
  `false`** (OPL-5973). The platform documents a 409 without a `reason` as
  unclassified, and a client treating 409 as uniformly transient loops forever
  on the refusals that are decisions: a public URL label that is taken
  (`LABEL_TAKEN`), a computer at its public URL limit (`PUBLIC_URL_LIMIT`), a
  webhook past the subscription cap, a test of a disabled webhook, an SSH key
  already registered, the SSH key limit, the cap of sixteen background
  commands. A 409 is now transient only with `reason` `contention` or
  `starting`, or with `code` `idempotency_in_progress` or `WORKSPACE_MOVING`
  and no word saying otherwise (`WORKSPACE_MOVING` with `reason:
  "unsupported"` is final). A word this version does not know is no answer, so
  on its own it leaves the 409 final. The TypeScript SDK, the Python SDK and
  the MCP server classify every 409 the same way. Code that retried every 409
  through `isTransient()` stops retrying the reasonless ones, and should retry
  a conflict it knows clears itself, bounded, after reading the error; the
  waits, which poll reads under a deadline, are unchanged.
- **Input coordinates and window geometry are whole pixels, checked before
  sending** (OPL-5973). The platform reads `x` and `y` as integers and answered
  a fraction with a 400; `click`, the other clicks, `move`, `drag`,
  `mouseDown`, `mouseUp` and `scroll` now refuse a fractional coordinate with a
  `ValidationError`. Round a computed position, such as a page element's
  centre. A window `move` takes whole `x` and `y` from -32768 to 32767, and a
  `resize` a whole width and height from 1 to 32767. The Python SDK and the MCP
  server check the same.
- **A create refuses `secrets[].revisionId`** (OPL-5973), which the platform
  always refused there with a 400: a create binds each secret's latest
  revision. The field is for a rebind with `setSecrets()`.
- **Webhook, webhook delivery and SSH key listings fail on a malformed row**
  (OPL-5973). `webhooks.list()`, `webhooks.deliveries()` and `sshKeys.list()`
  throw `MandalaError` for a row that is not an object, which used to be
  dropped, or has no `id`, which used to be kept with an empty one, and for a
  webhook whose `enabled` is absent or not a boolean, which used to read as
  false. A single webhook, delivery or key is read the same way. A row left
  out was a subscription or a key that may be live, missing from the answer
  read to find out. The Python SDK and the MCP server fail on these rows too.
- **Activity history decodes strictly** (OPL-5979), as the Python SDK reads
  it. `ActivityPage.health` is now optional: `undefined` when the platform
  sends no `health` or `null`, where it used to be filled in as an untruncated
  history, so code reading `page.health.countTruncated` must check for it
  first. A `health` that is not an object, or whose `count_truncated` or
  `age_truncated` is not a boolean, fails the call, and so does an
  `activityResults()` `more` or an activity's `has_results` that is not one.
  `1`/`0` and the text `true`/`false` read as booleans, as in Python.
- **A build stream's refusal frame is thrown as its status's error**
  (OPL-5973). When the caller's authority ends while `builds.events()` is open
  (a revoked key, a removed member), the platform ends the stream with the
  status, `reason` and request id the refusal would have had. That arrives as an
  `AuthenticationError` or `PermissionDeniedError` with `reason` and
  `requestId`, rather than a `MandalaError` advising a poll that would be
  refused the same way.
- **A retry wait that cannot fit the deadline is not started** (OPL-5973).
  With `retries` on, a 503 whose `Retry-After` outlasted the client deadline
  slept until the deadline and threw `ConnectionInterruptedError`. The 503
  itself is now thrown at once, with its `retryAfterMs`.
- **`computers list`, `workspaces list` and `operations list` print tables**
  without `--json` (OPL-5936), with an incomplete computer listing said on
  stderr. **This breaks scripts that parsed the old human output**; parse
  `--json`, whose output is unchanged.
- **`computers exec -c` never reads stdin** (OPL-5973). Stdin was read to its
  end whenever it was not a terminal, so a CI step whose stdin stayed open hung
  before sending the command; `-c` with piped input is no longer refused, and
  the input is left unread.
- **`terminal --json` exits 2**, a usage mistake, as `ssh --json` already did
  for the same refusal; it exited 1 (OPL-5973).
- **The CLI manifest** says `login` needs no credentials, and marks `--yes`
  `required` on `workspaces rm` and `artifacts rm`; both still refuse without
  it as `confirmation_required` (OPL-5973).
- **The browser toolset intercepts HTTP(S) at the browser root**, so the URL
  policy sees the requests of frames and their workers, including requests sent
  before the driver attaches (OPL-5912, OPL-5952). This supersedes the limits
  stated in 0.12.0's cross-site frame and dedicated worker entries: a sandboxed
  `srcdoc` frame's first requests, and workers started by a frame that ran
  before the driver could attach, are now covered while the control connection
  is active. A new failure mode comes with it: when the owner of a request
  cannot be established, the driver disposes its own context before releasing
  uncertain traffic, which can end an otherwise healthy toolset; create a new
  one to continue. On an unguarded connection, abrupt loss of browser control
  can still let Chromium resume a pending request without the policy approving
  it; a backend advertising `context_guard_version: 1` guards the SDK's and the
  daemon's disconnects. The URL policy is still not network isolation.

### Fixed

- `waitForDesktop()` reads the reasonless 409 a computer gives before its
  desktop session exists as an ordinary "not yet" and keeps its short ramp,
  rather than waiting a full `pollMs` between those polls (OPL-5931).
- The README's public URL example started its server with
  `exec({ command, background: true })`, which throws; it uses
  `execBackground()` (OPL-5973).
- The docs say a workspace still holding active secrets cannot be deleted
  (409, `reason: "unsupported"`), and that its computers are moved with
  `moveToWorkspace()` or `computers move --workspace` (OPL-5918, OPL-5932).
- `SshKeys` has its documentation back: the `PublicUrls` class had been
  inserted between the two (OPL-5973).
- `moves list --computer` and `operations list --computer` take a reference
  shaped like a computer id (`vm-` and twelve lowercase hex digits) as that id,
  without looking it up, as `snapshots list --computer` does. A deleted
  computer's id fell through to a live computer named like it, and that
  computer's moves or operations came back instead (OPL-5976).
- A `mandala` computer operand shaped like a computer id (`vm-` and twelve
  lowercase hex digits) never falls back to a name: when its own route answers
  404, the command fails with that 404 (OPL-5980). The platform lets a computer
  be named like another's id, so a command meant for a deleted computer,
  `computers delete` included, went to a live computer named after it. Names
  resolve as before.

## [0.12.0] — 2026-10-11

### Added

- **Run the agent on the account's AI credits.** `agent()`, `agentOnce()` and
  `agentStream()` take `modelKey` as optional: leave it out and the run spends
  the account's Mandala AI credits (Anthropic only, the platform's system
  prompt, `claude-sonnet-5-5` or `claude-opus-5-5`). `maxCostUsd` (0.25 to 20,
  default 2) caps a funded run, which then ends with `stop: 'max_cost'`; one
  that runs out part-way ends with `stop: 'credits_exhausted'`. A funded
  result carries `costUsd`, each step `costUsd` and `creditsRemainingUsd`, and
  an Activities row `funded` and `costUsd`. An account whose credits cannot
  start the run is refused with the new `InsufficientCreditsError`, whose
  `topUpUrl` is the billing page, as an absolute link. Needs a platform with
  funded runs enabled for the account; otherwise a run without a key is
  refused with a 400 as before.
- **Read the AI credit ledger.** `client.credits.read({ before, limit })`
  returns a `CreditReport`: the available balance, held credits, debt, whether
  the account is frozen, this period's grant, the live lots, and one page of
  the journal, newest first, with `nextBefore` for the next page. Amounts are
  integer USD micros, and the report is decoded strictly. `mandala credits`
  prints it, in dollars, or in micros with `--json`.
- **`mandala agent run` on credits.** With `MANDALA_MODEL_KEY` unset the run
  spends the account's AI credits, and `--max-cost-usd` caps it; set but empty
  is refused before any request. A run the credits cannot start fails with the
  error code `insufficient_credits` and the billing link in
  `details.top_up_url`.
- **Drive a browser with Claude's browser toolset.** `MandalaBrowserToolset`,
  from `mandala-computer/anthropic`, implements Anthropic's
  `browser_toolset_20260801` over the computer's authenticated CDP endpoint,
  with no SSH tunnel, local browser or Playwright. It runs in its own
  nonpersistent 1280 × 720 browser context, never adopts the desktop's tabs, and
  keeps the tabs that survive when creating another is interrupted. A URL
  policy hook sees direct navigations and intercepted HTTP(S) requests,
  redirects included. `javascript_exec` is off by default and needs `confirm`.
  It needs a running Linux computer with Chromium and the optional `ws` peer,
  8.18 or newer, which importing the package root never loads.
- **Raw browser connections, and renewable browser sessions.**
  `Computer.createBrowserConnection()`, `renewBrowserConnection()` and
  `revokeBrowserConnection()` mint, extend and revoke the WSS capability for
  the computer's managed Chromium, as `BrowserConnection` and
  `BrowserSessionLease`. With a `BrowserSessionPolicy`, which is also the
  toolset's `sessionPolicy`, a session is a 30-minute lease renewed on the same
  socket up to a two-hour limit. Without one it is the ten-minute grant, and a
  server without renewable sessions refuses the policy rather than quietly
  granting the shorter one.
- **Browser uploads and downloads, explicitly.** `BrowserFilePolicy` stages
  the files a model may upload (`stageLocalFile`, `stageGuestFile`,
  `stageDocument`) as `BrowserStagedFile` handles, each bound to one computer,
  task, context and toolset. Every upload still passes `confirm`. Downloads are
  a separate opt-in through `approveDownload`, which sees a `BrowserDownload`
  before its read-only guest path is published. Both are off by default, with
  hard ceilings on size and count. A file type the policy refuses does not
  count against the upload byte quota.
- **Choose the hosted agent's provider.** `agent()`, `agentOnce()` and
  `agentStream()` take `provider: 'anthropic' | 'openai'`, and
  `mandala agent run` takes `--provider`. A `claude-*`, `gpt-*` or o-series
  model infers it, `provider: 'openai'` alone runs `gpt-6.1-sol`, and omitting
  both keeps the Anthropic default. OpenAI runs need your own key.
  `--provider` takes only `anthropic` or `openai`; the parser refuses anything
  else as a usage error (exit 2) before any request, and the two choices are
  in `mandala manifest` and the shell completions.
- **Send a batch of OpenAI computer actions.** `computer.inputBatch(actions)`
  sends 1 to 32 OpenAI actions, in OpenAI's own spelling, as one request. It
  answers an `InputBatchResult`, and with `{ context: true }` the desktop after
  the batch. A batch refused before any action ran throws the ordinary error,
  except that a 503 may mean the batch ran: the platform answers 503 in the
  same shape when the batch was sent and its answer was lost, so never send it
  again blindly.
  One that stopped part-way throws the new `InputBatchError`, whose `result`
  carries `completed`, `failedIndex` and the results so far, and which
  `isTransient()` never calls worth sending again. Neither does it call an
  error whose answer cannot be read as a refusal before dispatch.
- **The browser toolset runs cross-site frames.** `MandalaBrowserToolset`
  treats a site-isolated cross-site frame (its own Chromium target) as part of
  its tab: it runs, and its HTTP(S) requests reach `urlPolicy` with that tab's
  ID. It is never closed, since closing a frame closes its whole tab. Its
  contents are not in `read_page`, `find` or `get_page_text`; screenshots and
  coordinate input reach it, and a download from it, or from a frame inside
  it, is handled as one from the tab. Popups (`window.open`, `target=_blank`
  links) are refused without wedging the tab that opened them: each is let go
  offline, uncached and with scripts disabled in its own process, and closed
  before it can load, and the opener's next action answers as usual (a
  sandboxed or other out-of-process frame written into one is the exception
  below until the popup closes). As with WebSockets, `urlPolicy` is not network isolation:
  a sandboxed or other out-of-process frame that starts running before the
  driver can attach to it (Chromium starts a sandboxed `srcdoc` frame this
  way) makes its first requests before `urlPolicy` can see them, and can keep
  the browser's own `Worker` constructor and start workers whose requests it
  may not see.
- **Pages in the browser toolset cannot start dedicated workers.** In every
  frame the driver attaches to before it runs, cross-site and `about:blank`
  frames included, constructing a `Worker` throws a `SecurityError` before the
  page's own scripts run, for script, `blob:` and `data:` URLs alike, and the
  page carries on without it. A frame that starts running before the driver
  can attach (above) is not covered.
  A worker could not be run under `urlPolicy`: Chromium fetches the script of a
  worker started by another worker outside any interception, and a worker held
  paused is released, unpoliced, when its page closes or navigates. Shared and
  service workers are still closed, as before.
- **A renewable browser session rides out a failed renewal.** A renewal that
  fails in passing (a connection error, a timeout, a 408, a 429 or a 5xx) is
  retried with backoff, honouring `Retry-After`, until shortly before the lease
  deadline. A refusal (any other 4xx, including a 409 whatever its `reason`)
  still ends the session at once.
- **A heavy page keeps its browser session.** Browser events past 256 in
  flight wait their turn in arrival order rather than ending the session, so a
  page that pauses hundreds of requests at once loads. Subresource requests
  waiting on `urlPolicy`, and downloads waiting on approval, queue apart from
  navigations and everything else, so a slow policy does not hold back a
  navigation, a new tab or a dialog. Only a page producing more than 8,192
  waiting events, or more than 32 MiB of them, ends the session, and
  `sessionStatus.terminalError` says why. Console, network-log, dialog and
  paused-request events keep only what the toolset reports or checks.
- **A missing `ws` is named.** Without the optional `ws` peer, the browser
  toolset's tool error says to install `ws` 8.18 or newer, instead of a generic
  browser failure. It is checked before a browser connection is created.
- **`createBrowserConnection()` revokes a grant it cannot hand out.** When the
  platform's response fails validation but carries a well-formed connection
  id, the grant is revoked before the error is thrown, with or without a
  `sessionPolicy`.

### Changed

- **`AgentStop` names every stop reason the platform documents**: `pause_turn`,
  `credits_exhausted`, `max_cost`, `incomplete` and `safety_check` beside
  `end_turn`, `max_steps`, `rate_limited` and `refusal`. Only `end_turn` is
  `finished`, as before.
- **A webhook URL longer than 2048 characters is refused before the call**,
  as `WEBHOOK_URL_MAX`, the platform's own ceiling.
- **An omitted `modelKey` is no longer refused.** It used to be a
  `ValidationError` before the call; it is now a run on AI credits. An empty
  or blank `modelKey` is still refused, so a key read from an environment
  variable that is set but empty does not quietly become a funded run. A 402
  carrying `top_up_url` on the agent routes is `InsufficientCreditsError`; every
  other 402 there is still `ModelProviderError` on your own key, and a plain
  `APIError` on a funded run, which sent no key to blame. So is a funded run's
  401, 403, 404 or 413 reported as `Mandala AI is unavailable`, the platform's
  AI service failing, rather than the class that would blame your API key, the
  computer or the request. A funded run's 429 after it took a step is not
  transient, as a relayed model 429 after a step already was not.

### Fixed

- **`zoom` checks the crop came from the capture it measured.** The computer
  toolset's zoom read a crop without checking which capture it said it was
  cut from. It now refuses a crop that names another capture, as the Python
  driver does, rather than show the model a picture of the wrong frame.
- **A usage error's `--json` envelope names its command.** `command` was `""`
  for every line the parser refused. It now names the command the line was
  read as, and stays `""` only when no whole command was typed.
- **Install beside an older `@anthropic-ai/sdk`.** 0.11.0 declared its optional
  peer as `>=0.132.0`, and npm refuses to install a package beside an optional
  peer outside its range, so a project on an older Anthropic SDK could not
  install `mandala-computer` at all, even one that never imports the driver.
  The peer now has no range. `mandala-computer/anthropic` still needs 0.132 or
  newer: importing it beside an older one fails with `Cannot find module`
  naming `@anthropic-ai/sdk/helpers/beta/toolsets`. The `ws` peer, new since
  0.11.0 for the browser toolset, is declared the same way and still needs
  8.18 or newer.

## [0.11.0] — 2026-10-08

### Added

- **Drive a computer with Claude's computer toolset.** `MandalaComputerToolset`,
  from `mandala-computer/anthropic`, is a driver for Anthropic's
  `computer_toolset_20260801`: pass it as a `tools` entry to
  `client.beta.messages.toolRunner()` and every action the model asks for runs
  on the computer. All 17 actions are served, including `zoom`, which crops
  the capture it measured by that capture's name and needs a platform that
  names its captures. Screens too
  large for the model are photographed smaller and its points scaled back up.
  `@anthropic-ai/sdk` 0.132 or newer is an optional peer dependency;
  `mandala-computer` itself does not need it.
- **Cut a second picture from the same capture.** `screenshotWithInfo()`
  returns `capture`, the name of the capture a live picture was cut from, and
  `captureSize`, that capture's own size, which is the space a `region` is read
  in. `screenshot()` and `screenshotWithInfo()` take `capture` to answer from
  that capture rather than the screen now, so a crop worked out on one picture
  is cut from the same pixels. A capture the platform has since replaced is a
  `ConflictError` with `reason: 'stale_capture'`, which `isTransient()` calls
  permanent. Needs a platform that names its captures; an older one sends
  neither field and refuses `capture` with a 400.

## [0.10.0] — 2026-10-03

### Added

- **Create a computer in a workspace, and list one workspace's computers, with
  an account-wide key.** `computers.create()`, `launch()` and `ephemeral()`
  take `workspaceId`, which also names the create's secrets from that
  workspace's scope; `computers.list()` and `listWithStatus()` take
  `workspaceId`, a workspace id or `'unassigned'` for the computers in none.
  The CLI's `computers create` and `computers list` take `--workspace`, and,
  without it, use the profile's default from `workspaces use` as `secrets` and
  `api-keys create` do; there, a `--secret` or `--secret-file` name is looked
  up in that workspace's own secrets first and then account-wide, so a name
  both hold binds the workspace's, and a name in either scope that is another
  secret's id in either is refused as `ambiguous_secret`. A workspace the key
  cannot reach is a `NotFoundError`.
  Needs a platform that accepts `workspace_id` on these two routes; an older
  one creates in no workspace and lists everything.

- **An input action's context carries the page in Chromium.**
  `InputContext.dom` is a `PageContext` — the page's URL and title and the
  interactive elements visible in it (`PageElement`: tag, role, name, text,
  `href` on links, and a box in screen pixels to click) — when the focused
  window is Chromium, and `null` otherwise. `InputContext.error` can now be
  set beside `windows`, saying why `dom` is `null` (another window focused,
  Chromium not listening, an older computer image); with `windows: null` it
  still means the windows could not be read. A platform without page context
  decodes as before, with `dom: null`.

- **`mandala secrets set --keep-newline` stores a piped value byte for byte.**
  `secrets set` drops one trailing `\n` or `\r\n` from what stdin gives, so
  `echo "$TOKEN" | mandala secrets set NAME` stores the token alone; a PEM or
  kubeconfig whose final newline matters lost it, with no flag to keep it.
  `--keep-newline` keeps it, as `mandala-py secrets set --keep-newline` does.
  A value typed at the prompt is unchanged: the Enter that ends it is never
  part of the value.

- **`SshKey.reach` says whether this account accepts a listed key**:
  `'everywhere'` (added from the dashboard), `'this_account'` or
  `'another_account'` (added through an API key or connected app on that
  account), relative to the account the credential acts on and never naming
  another. `null` from a platform that does not report it.

- **`computer.waitForEgressProxy({ expectCredentials: true })`**, as
  `waitForSecrets` has `expectSecrets` and `waitForBrowserProxy` has
  `expectBrowserProxy`, and as Python's `wait_for_egress_proxy` has
  `expect_credentials`: for a caller that knows the egress proxy names
  credentials, a read that leaves the setting out is not taken for "none"
  while the computer is not running yet, so the wait goes on until it runs.
  Without it, such a read still answers at once. `launch()` passes it when it
  waits for the credentials.

### Fixed

- **The CLI shows an SSH key's reach, and stops before `ssh` when no key you
  hold is accepted here.** `mandala ssh-key list` has a REACH column (`every
  account`, `this account`, or `another account (refused here)`) and, for a
  key bound to another account, prints on stderr what to do about it.
  `mandala ssh-key rm` of a key this API key cannot remove says so and names
  both causes (a key added from the dashboard, or one bound to another
  account, is removed from the dashboard) instead of the platform's bare
  "ssh key not found"; it is still `not_found` with status 404 and exit 1.
  `mandala ssh <computer>` refuses with `ssh_key_elsewhere`, before running
  ssh, when every key you hold is bound to another account, rather than
  leaving ssh to fail authentication. `--json` output is unchanged.

- **The `operations` docs no longer say dashboard calls record none.** The
  platform records the dashboard's lifecycle calls the same way and lists them
  in `operations.list()`, all but a move. The `Operations` doc comment and the
  README now say so.

- **An event stream refused for the open-stream cap now ends instead of
  reconnecting forever.** The platform refuses a stream past 8 open on one
  computer or 128 per account on one server with a 409 and no reason, which a
  websocket sees as an ordinary failed connection on a running computer. With
  the default `maxRetries` (never give up) `events()` reconnected for as long as
  the process lived and `waitFor()` ended only at its timeout, never naming the
  cap. After five refused upgrades in a row on a computer that reads `running`,
  the stream now ends with a settled `ConnectionError` saying to close another
  stream on that computer. A connection that opens, or a re-read that does not
  say `running`, starts the count again, so a briefly unreachable server still
  recovers. The run of five applies whatever `maxRetries` says. `maxRetries: N`
  allows N+1 attempts, so a `maxRetries` of 1 to 3 gives up before the fifth
  refusal, unsettled, and one of 4 or more (or 0) settles at the fifth refusal
  in a row.

- **`mandala terminal` exits 255, not 0, when the session ends without the
  shell's exit status** — a dropped link, a session another connection took,
  or a refusal the server sent after the upgrade, whose message is now printed.
  An exit frame with no readable code also reports 255 rather than 1. So
  `mandala terminal dev < build.sh && ./deploy.sh` no longer deploys after a
  build whose end nobody saw. `mandala-py terminal` already behaved this way.

- **`mandala ssh --setup` no longer reports success with a key bound to another
  of your accounts.** It used to see the fingerprint in the listing, print
  "already registered" and switch SSH on, and the gateway then refused the key.
  It now exits 1 with `ssh_key_elsewhere`, leaves SSH as it was, and says what
  to do: remove the key and add it again from the dashboard to use it on every
  account, or pass `--key` with a separate key. The `SshKeys.add()`
  documentation gives the same advice instead of "remove it and add it again
  with this client", which an API key cannot do for a key bound elsewhere.
- **`mandala computers secrets set` finds a `--secret` or `--secret-file` name
  in the computer's workspace, as `computers create` does.** For a computer in
  a workspace it looked in the key's default scope alone, so with an
  account-wide key a name only that workspace holds was refused as not found,
  and a name both scopes hold bound the account-wide secret where a create into
  that workspace binds the workspace's. It now looks in the computer's own
  workspace first and then account-wide, and refuses a name in either that is
  another secret's id in either as `ambiguous_secret`, changing nothing. A
  computer in no workspace is looked up as before.

### Changed

- **Behaviour change: the CLI's usage errors now exit 2 (was 1)**, as
  `mandala-py` and POSIX tools do: a command line the parser refuses — an
  unknown command or option, a group typed without a command, a missing,
  extra or blank argument, a repeated option, an option value of the wrong
  type or outside its choices, a missing required option, two options the
  command declares as conflicting (`webhooks update --enable --disable`), or
  an `--as`/`--path` not directly after the option it names. `--json` reports
  `exit_code: 2`.
  An unknown command word now carries the help of the group it was typed under
  as `usage` (the whole command list for an unknown first word), printed under
  the message; under `secrets` the word itself is still not repeated. A value
  or combination the CLI refuses after parsing (`--cpu 0`,
  `--browser-proxy-bypass` without `--browser-proxy`), and every refusal from
  the platform, still exit 1.

- **`setSshAccess()` and `SshAccess.keyCount` say which keys log in.** They
  said every registered key of every member of the account; keys bound to
  another account and the keys of a member whose seat is suspended do not, and
  viewers' keys never do. Documentation only.

- **Deleting a workspace is documented as the platform does it: only an
  empty one.** `workspaces.delete()`, `WorkspaceDeleted`, the README and the
  CLI's `workspaces rm` help and confirmation said a deleted workspace's
  computers were kept. The platform refuses to delete a workspace that still
  holds computers, with a `ConflictError` (409) saying how many, and deletes
  and revokes nothing; when it cannot confirm the workspace is empty it answers
  an `UnavailableError` (503), also with nothing deleted. Documentation only.

- **The `SshKeys` documentation says a key added through the API is bound to
  its credential.** A key registered with `client.sshKeys.add()` now reaches
  only the account the API key (or connected app) acts on, and is removed when
  that credential is revoked; a key added from the dashboard still reaches
  every account where you are an owner or member. The `add()` documentation no
  longer suggests a fingerprint match in `list()` makes registration
  idempotent: `list()` shows every key you hold, including one bound to another
  account, which this account's computers refuse. No API change.

- **`SshKeys.remove()` documents that it removes only a key bound to this
  account.** With an API key or connected app, the platform now removes only a
  key whose `reach` is `this_account`. A key added from the dashboard, or with
  an API key before keys were bound to an account (`reach` `everywhere`), is a
  `NotFoundError` like a key bound to another account, so a leaked credential
  cannot take away SSH access you use on your other accounts; remove such a key
  from the dashboard. `mandala ssh-key rm` behaves the same way. Documentation
  only; no SDK change.

- **The `Builds` and `Templates` documentation says which methods need an
  account-wide key.** The platform refuses an API key confined to a workspace
  with a `403` (`PermissionDeniedError`) on every build route and on
  publishing, reading the account's own template back and retiring one; such a
  key can still list templates, read `system` ones and launch a computer from a
  template by its ref. `builds.start()` no longer says build secrets resolve in
  the key's scope, workspace first: they resolve among the account-wide
  secrets. `builds.list()` no longer describes what a workspace-scoped key sees
  in a build listing. Documentation only; no API change.

- **A bound `launch()` returns within moments of its secrets landing**, rather
  than up to a whole poll interval later. `waitForSecrets`,
  `waitForBrowserProxy`, `waitForEgressProxy` and `waitForDesktop` (and the
  matching `launch()` stages) now poll 250ms after their first read, doubling up
  to `pollMs`, which stays the ceiling and keeps its default. A poll that failed
  still waits `pollMs`, or the `Retry-After` the platform sent.

- **`Webhook.disabledReason` documents `plan`.** When the account moves to a
  plan without webhooks the platform disables its subscriptions with
  `disabledReason: 'plan'`, refuses `enabled: true` with a 402 meanwhile, and
  enables them again, oldest first up to the plan's allowance, when a plan with
  webhooks is chosen. `enabled` and `disabledReason` used to name only
  `customer` and `failing`. The field stays a plain string. Documentation only;
  no API change.

- **`clipboard()` says which new computer fixes a missing `xclip`.** A
  computer whose image has no `xclip` is refused with a permanent 400; the
  documentation used to say to install `xclip` in the guest or create a new
  computer, and now says the new computer must be created from an image that
  includes it, matching the platform's corrected refusal. The refusal's
  sentence comes from the platform. Documentation only; no API change.

- **The clipboard docs name the Wayland tool.** `clipboard()`,
  `setClipboard()`, `VncConnect` and the README said the clipboard needs
  `xclip` in the guest, which is only the X11 half: a Wayland image such as
  Omarchy needs `wl-clipboard` (`wl-paste`/`wl-copy`) instead, and the
  platform's permanent 400 there names that tool. They now name the tool each
  desktop needs, with `desktop` saying which. Documentation only; no API
  change.

## [0.9.0] — 2026-09-30

### Changed

- **`launch()` now waits for the desktop session** on a Linux computer,
  after its guest, secrets and proxy waits and inside the same readiness
  budget. The guest agent answers a few seconds before the desktop user is
  logged in, and an `exec(..., { desktop: true })` sent in between was refused
  with a 409 "no active desktop session". A computer that never gets a desktop
  session now makes `launch()` throw a `TimeoutError` instead of returning.
- **`mandala workspaces get` and `mandala workspaces members` take a workspace
  name** as well as an id, as computer arguments do. An id wins over a name,
  and a name that fits more than one workspace is refused
  (`ambiguous_workspace`) with their ids.
- **`mandala logout` with no saved profile exits 0** and says `Not logged in;
  nothing to remove.` (with `--json`, `removed: false`). A named profile that
  is not saved while others are is still `not_logged_in`.
- **The missing-key error points to Settings → Credentials → API keys**, the
  dashboard tab that holds API keys, instead of a Settings tab named "API keys"
  that no longer exists. The README says the same.
- `mandala --help` lists `operations wait` beside `operations list` and
  `operations get`.
- **`isTransient` calls a 409 with `reason` `name_taken` or `stale_revision`
  final**: the secret store's words for a name another secret already has and
  for a revision that is no longer the current one. Neither clears by waiting.
  A platform that does not send them yet is unaffected.
- `readTextFile` is documented as decoding strictly: bytes that are not valid
  UTF-8 throw a `MandalaError`, and `readFile` gives the raw bytes. The Python
  SDK replaces invalid bytes instead. No behaviour change.

### Added

- **`mandala computers exec-poll COMPUTER PID` and `exec-kill COMPUTER PID`**:
  follow up a `computers exec --background`. `exec-poll` prints what the
  command wrote since the last read (reading on while more is waiting, and
  keeping what it read if a later read fails, with a non-zero exit) and
  whether it is still running; it exits 0 while it runs and then with the
  command's own status, 0 through 255 (1 when unknown). `exec-kill` kills it,
  prints what had not been read, and exits 0. `--json` gives the raw fields
  with the output as base64 and decoded text.
- **`mandala computers move COMPUTER --ram-mb N [--cpu N] [--disk-gb N] [--wait]`
  and `mandala moves list [--computer C]`**: move a stopped computer to another
  host in its region that can run a size its own cannot, and list the moves
  running or finished in the last day. With `--wait`, `move` exits 0 only when
  the move's state is `done`. A `computers resize` refused with `move_required`
  now names the `computers move` command to run when another host can take it.
- **`mandala computers idle-suspend COMPUTER MINUTES|off|default`**: set the
  idle-suspend window; `off` never suspends it and `default` follows the
  host's own window.
- **`mandala secrets get NAME|ID [--workspace W]`**: one secret's metadata
  (id, name, workspace, revision and dates, never its value), found by name or
  id as `secrets rm` finds one, in the saved default workspace when
  `--workspace` is not given.
- **`--idempotency-key KEY` on every keyed command** (`computers create`,
  `start`, `stop`, `suspend`, `restart`, `clone`, `delete`, `rename`, `resize`,
  `move`, `idle-suspend`, the proxy `set` and `clear` commands, and `snapshots
  restore` and `clone`), sent instead of a new key and checked locally first
  (1-255 printable ASCII, no space); any other command refuses it by name. The
  error line that names a lost call's key now also says to resend the command
  with it.
- **`computers exec --retain-output`** (foreground only) keeps the output as a
  retained result and names its `result_id`; **`files upload` and `files
  download --no-wake`** fail with `not_running` rather than resume a suspended
  computer; **`computers secrets set --keep-revision`** keeps the revision a
  computer holds for each secret it is already bound to, sending the bindings'
  `version` read with it.
- **`computers wait --until desktop`**: wait until the desktop session is
  logged in and takes commands, which comes a few seconds after `guest`.
- **`mandala workspaces use` and `workspaces current`**: save a default
  workspace, by name or id, for the saved profile in use; `secrets list`, `set`
  and `rm` and `api-keys create` then use it when `--workspace` is not given
  (an explicit `--workspace` wins; `workspaces use --clear` goes back to
  account-wide). `current` says which workspace applies and why: the key's own,
  the profile's default, or none. The default is kept in a new
  `~/.mandala/defaults.json`, keyed by profile and account, so
  `credentials.json` and older readers of it are unaffected. `use` is refused
  with `MANDALA_API_KEY` set, and for another workspace when the profile's key
  is confined to one; `logout` removes the profile's default. A
  `defaults.json` that cannot be read is ignored with a note by `secrets list`,
  but `secrets set`, `secrets rm` and `api-keys create` refuse without sending
  anything rather than act account-wide (pass `--workspace`, or fix or delete
  the file).
- **`mandala billing`**: the plan and the current billing period on one
  screen — totals, how far it is settled, and the five computers with the most
  run hours — from the `account` and `usage` reads; `--json` returns both
  objects as `{ account, usage }`.
- **`mandala computers secrets get` and `set`**: read or replace the secrets an
  existing computer is bound to. `set` takes the same `--secret`/`--as`,
  `--secret-file`/`--path` and `--no-value-check` as `computers create`, with the
  same value check and redaction, and `--clear` removes every binding. The
  platform's refusal to bind a running computer's first secrets is printed as
  it came.
- **`mandala artifacts export`, `get`, `download` and `rm`**: keep a guest file
  as an immutable artifact (its size and SHA-256 read on the computer first,
  unless `--size` and `--sha256` give them), read its metadata, save its
  verified bytes, and delete it with `--yes`. The automatic read is Linux-only:
  a Windows computer, or one whose os is not given, needs `--size` and
  `--sha256`, and no command is run on it.
- `mandala computers view`'s help says the desktop there needs no VNC password.
- **Workspace create, rename and delete**: `client.workspaces.create({ name })`,
  `rename(id, name)` and `delete(id)`, and `mandala workspaces create`,
  `rename` and `rm --yes` (by name or id). They need an owner's account-wide
  key; a key confined to a workspace is refused with a `PermissionDeniedError`.
  Deleting a workspace revokes every API key confined to it and resolves to a
  `WorkspaceDeleted` whose `revokedKeys` says how many; its computers are kept.
  `mandala workspaces rm` without `--yes` is refused before any request
  (`confirmation_required`). A `rename` or `rm` target shaped like a workspace
  id (`wsp-` and twelve hex) is always sent as that id, never matched against
  workspace names, so a retried `rm` of an already-deleted workspace answers
  not found instead of deleting one named like it. Needs a platform that has
  these routes; an older one answers 405.
- **A click repeat count**: `click`, `rightClick` and `middleClick` take
  `{ count }`, 1 to 10, pressing the button that many times at double-click
  pacing. `doubleClick` and `tripleClick` refuse one. Needs a platform that
  accepts `count`; an older one answers 400.
- **Post-action window context on every input action**: the clicks, `move`,
  `drag`, `mouseDown`, `mouseUp`, `scroll`, `type`, `paste`, `key` (array
  form), `holdKey` and `wait` take `{ context: true }` and then answer an
  `InputContext` — the windows `windows()` lists by default and the `focused`
  one, as they stand just after the action. An action that answered nothing
  resolves to it instead of `undefined`; `type` carries it as
  `TypeResult.context`. When the windows cannot be read, `windows` is `null`
  and `error` says why; the action still happened. New exports: `ClickOptions`,
  `InputOptions`, `PasteOptions`, `InputContext`. A call without `context` is
  typed as it was; `{ context: true }` is typed `Promise<InputContext>` (or a
  `TypeResult` whose `context` is set).
- **A `User-Agent` naming this SDK and its version**:
  `mandala-computer-ts/<VERSION> node/<version>`, so the platform can tell
  which client and release sent a request. The new `userAgent` client option
  appends your own token, such as `my-app/1.2`. Not sent in a browser, which
  does not allow it.
- **`computer.waitForDesktop()`** polls a no-output `true` in the desktop
  session until it finishes with exit 0. A probe that times out inside the
  guest is polled through, not taken as a session. It returns at once for a Windows guest or a
  computer whose `os` is not reported. An absent `computer.desktop` is an X11
  desktop and is waited on.
- **`computer.snapshotHoldings()`**, the same call as `holdings()` under the
  name the Python SDK and the MCP server use.

### Fixed

- **The `api-keys` help, the README and the `ApiKeys` docs name the real
  dashboard control** that allows a key to manage keys: Settings → Credentials
  → API keys → the key's menu → **Allow managing keys**. They used to point at
  a "Manage keys" checkbox that does not exist.
- **A `noWake` file transfer to a computer that is not running** is a
  `ComputerNotRunningError` when the platform says `unavailable`, as well as
  when it says nothing, with `reason` kept. It was a plain `ConflictError`.
  This covers create-only uploads too.
- **`type()` of text that is not all ASCII** is sent with a deadline of at
  least 110 seconds instead of the client's 60-second default, which cut off
  a long Unicode type the platform was still allowed to finish.
- **An event stream (`agentStream`, `builds.events`) that sends nothing for
  60 seconds**, not even the platform's 10-second keepalive, fails with a
  `ConnectionInterruptedError`. A connection dropped without a close used to
  leave the caller waiting for ever. An answer that is not an event stream at
  all, such as a proxy's HTML page, is bounded the same way while its body is
  read for the error, which then names the content type it got.
- **`readFileChunks` follows a file that grows** while it is read, to its new
  end. Only a file that gets shorter is refused.
- **A base URL with a query or a fragment is refused** when the client is
  made. `https://host/api/v1?t=x` used to send every request to
  `…?t=x/<path>`.
- **`scroll()` refuses an `amount` that is not a whole number from 1 to 50**
  before sending. `0` became the platform's default of 3, and a fraction went
  on the wire.
- **A secret binding with a key other than `secretId`, `env`, `file` and
  `revisionId` is refused.** A `revision_id` spelled the wire's way was dropped,
  so the binding recorded the latest revision instead of the one named.

## [0.8.0] — 2026-09-29

### Added

- **`computer.screenshotWithInfo()`** returns `{ bytes, contentType,
  suspended }`; `suspended` is true for a suspended computer's saved frame
  (`X-GC-Frame: suspended`) rather than a live capture. `mandala computers
  screenshot` notes a saved frame on stderr and adds `"suspended": true` to
  its result. New export: `ScreenshotInfo`.
- **`mandala sizes list`** prints the named sizes `computers create --size`
  takes: `id`, `label`, `template`, `cpu`, `ram_mb`, `disk_gb`, `allowed` and
  `cheapest_plan`.
- **`idempotencyKey` on `launch()`** (sent on its create only), on both
  `ephemeral()` forms and on `rename()`. `ephemeral()` always sent a key but
  never took yours, although this changelog said it did. An error `launch()`
  throws after its create returned (`launch of <id> failed: ...`) that carries
  an `err.idempotencyKey` (a dropped connection, a 5xx or an unsettled 409)
  carries the create's key, even when its own start failed, so resending
  `launch()` with it replays the same computer rather than creating a second.
  On a replayed create (`Idempotent-Replayed: true`) launch reads the computer
  afresh before acting, so a start the first attempt reported failed is sent
  again rather than thrown again, and a computer stopped or suspended since is
  started.
  One without a key (a start refused with a 4xx such as 402 or 409, or a wait
  that timed out) means the computer `<id>` exists: use it (`computers.get(id)`)
  or resend `launch()` with the key you passed yourself, never with the absent
  `err.idempotencyKey`. That key finds the create's operation, not the failed
  stage's; an `err.operationId` the error names is the failed stage's own, read
  with `operations.get()`. An error from the create itself follows the ordinary
  idempotency rules.
- **`RateLimitError` carries `limit`, `remaining` and `resetSeconds`** from the
  refusal's `RateLimit-*` headers. New export: `RateLimitInfo`.
- **`AgentResult.stepsTaken`**: every step of an `agentOnce()` run, from the
  non-streaming answer's `steps_taken`. The streaming `done` frame does not
  carry it.
- **`computer.halfRemoved`**, true for a computer whose deletion stopped
  part-way (`status: "half-removed"`).

### Changed

- **A 402 from `agent()` or `agentOnce()` is a `ModelProviderError`, not a
  `PlanLimitError`.** Nothing inside an agent run answers 402 on the
  platform's behalf; it is the model API's billing refusal for the account
  behind `X-Model-Key`, relayed. `ModelProviderError` extends `APIError`, and
  `isTransient` still answers `false`. The docs no longer say a plan
  downgrade stops a run: the mid-run recheck covers the credential, the role
  and the account's standing (401/403 with `reason: "revoked"`), and a 402,
  504 or 529 on these routes is the model API's status. It is also raised
  for a 404 or 413 the model API answered; see Fixed.
- **A model API 504 on `agentOnce()` is a plain `APIError`, not a
  `GatewayTimeoutError`.** The platform relays the model's `timeout_error`
  with the run's `usage` and `steps_taken` in the body, so the connection was
  not cut; `agent()` already reported the same 504 this way. A body-less 504,
  one whose body carries neither field, and a 524 are still
  `GatewayTimeoutError`.
- **`computer.open()` picks the browser from what the image has installed**
  (`firefox-esr`, then `firefox`, then `chromium`) and **throws a
  `MandalaError` when the launch exits non-zero**, as it does on an image
  with none of the three. It named `firefox` alone, which the Omarchy image
  does not have, and the detached launch exited 0 there having opened
  nothing (OPL-3705).
- **A `ConflictError` from `templates.publish()` is permanent to
  `isTransient`**: it carries `reason: "exists"` where the platform sent no
  reason. None of those conflicts (a different document under the ref, a
  retired ref, either template ceiling) clears by sending it again.
- **`mandala computers delete` reports a purge that did not complete.** It
  reads the detailed result and prints `ok`, `computer_deleted`,
  `snapshots_deleted`, `purge` and `error`; `ok: false` (copies still queued,
  or refused) exits 1 instead of printing `deleted: true` and exiting 0.

### Fixed

- **A 404 or 413 the model API answered on `agent()` or `agentOnce()` is a
  `ModelProviderError`**, not a `NotFoundError` or `TooLargeError`. The
  platform relays the model API's own failures with the message prefixed
  `model API: `; a 404 there is usually a model name the provider does not
  know, and a 413 a request it found too large, not a missing computer or an
  oversized upload. The platform's own 404 and 413 on these routes carry no
  prefix and keep their classes. `agentStream()` still yields the failure as
  an `error` event.
- **`isTransient()` answers false for a 429 the model API answered an agent
  run with after the run had already taken steps** (`agent()` and
  `agentOnce()`). The wait is the model provider's, but the steps are on the
  desktop, and sending the same prompt again repeats them; read the error's
  `body` before running again. Steps count as taken when the error body lists
  them, or, on `agent()`, when the stream delivered a `step` event before the
  failure. The same relayed 429 before any step, and the platform's own 429 on
  the agent routes, are still transient.
- **A 429 the model API answered on `agentOnce()` has `limit`, `remaining`
  and `resetSeconds` undefined**, as one reported mid-stream on `agent()`
  already did. They came from the platform's `RateLimit-*` headers, the
  caller's Mandala budget, which did not refuse the call. `retryAfterMs`
  stays: it is the model API's own wait, forwarded. The platform's own 429 on
  the agent routes keeps all three.
- **`mandala secrets set` takes a path-shaped name whose last piece an
  acronym closes or splits again**, such as `myapp/DATABASE/RedisURL`, and
  likewise `MongoURI`, `NeonDBURL`, `ZoomJWT`, `SSHKeyEd25519`, `Ed25519Key`
  and `PyPIToken` there. The CLI's value check refused them as looking like a
  secret's value.
- **`mandala secrets set` takes a path piece made of a two-letter word and
  an acronym**, such as `myapp/DATABASE/MySQLURL`, and likewise `MySQLDSN` and
  `MyDBURL` there, which the value check refused as a secret's value.
- **The value check catches more pasted base64 keys**: one whose first
  character is `/`, which it read as an absolute path, and one inside quotes,
  after `Bearer ` or `NAME=`, or ahead of a `,` or `;`.
- The check is best-effort, and the `--no-value-check` help now says so: a
  URL-safe base64 key (`-` and `_`) or a short one can get past it, and a real
  name it misreads goes through with `--no-value-check`.
- **`mandala ssh-config` no longer writes a computer's name as its `Host`
  when ssh would also read that name as another destination**: a dotted
  name shaped like a hostname (one ending in a dot, as `github.com.` does, or
  in an all-letter or `xn--` label, as `github.com` and `corp.internal` do),
  an IPv4 address in any form the resolver reads (`10.5` is `10.0.0.5`), a
  bare decimal or `0x` number, `localhost`, the gateway's alias
  `mandala-gateway`, or another computer's id, compared without regard to
  case as OpenSSH does. A block under such a name took over every connection
  made there, so a computer a teammate named `github.com` received the
  pushes meant for GitHub. The block uses the computer's id instead, and a
  note on stderr says so; for such a name the `--json` output's `host` and
  `config` carry the id rather than the name, and `--write` replaces a block
  written earlier under the name with one under the id, so `ssh <name>`
  stops reaching that computer and `ssh <id>` does. Other names, dotted ones
  such as `ubuntu-24.04` or `py3.12` included, are used as before. This is
  the rule `mandala-py ssh-config` already follows.
  Upgrading changes nothing in `~/.ssh/config` by itself: `--write`
  replaces only the block of the computer it is run for, so a block an
  earlier version wrote under such a name stays until you run
  `mandala ssh-config <computer> --write` again for that computer. To find
  one, read the `Host` line after each `# >>> mandala computer <id> >>>`
  marker in `~/.ssh/config`, and run `--write` again for any whose `Host` is
  a hostname, an IP address, a bare number, `localhost`, `mandala-gateway`,
  another computer's id, or a name another computer also has (for a computer
  that no longer exists, delete its block, markers included).
- **`mandala ssh-config` refuses as a `Host` every IPv4 form macOS reads**,
  not only those `inet_aton` takes: a part with a leading zero and an `8` or
  `9` (`08.0.0.1` is `8.0.0.1` there, and `192.168.1.09` an address), an
  empty `0x` part (`0x.1` is `0.0.0.1`), and a part too big for its bytes. A
  block under such a name took over the connections macOS's ssh made to that
  address. The block uses the computer's id instead, with the same stderr
  note as for the other refused names.
- **`mandala ssh-config` uses the computer's id as its `Host` when a block
  already in `~/.ssh/config` uses the name for another computer**, as its
  `Host` or as its id, compared without regard to case: one written with
  another account's API key, say, which the listing the name was checked
  against does not show. `ssh <name>` went to whichever of the two blocks came
  first. A note on stderr says so, and `--json`'s `host` and `config` carry
  the id. The computer's own earlier block never counts, and `--write` still
  replaces it where it stands. The file is only read, in print mode too; one
  that is missing or cannot be read holds no blocks. When the id itself is
  already another computer's `Host` there (one named after this computer's
  id, say), there is no other name to use, so `ssh-config` refuses, in every
  mode, with a `conflict` error naming that computer: it prints and writes
  nothing, since a second block under the id would never be reached and
  `ssh <id>` would go to the other computer. Remove that block, then run
  again.
- **`mandala ssh-config` refuses a computer id that is not a plain host
  word** (letters, digits, `.`, `_` and `-`, not starting with `-`), with an
  `invalid_response` error, in every mode and before it reads, prints or
  writes anything. The id goes into the snippet as `HostName`,
  `HostKeyAlias` and sometimes `Host`, so an id with a line break from the
  API could have added a directive such as `ProxyCommand` to
  `~/.ssh/config`. This is the check `mandala-py ssh-config` already makes.
- **`mandala ssh-config` reads a `~/.ssh/config` saved with CRLF line
  endings.** It found none of the blocks it had written in such a file, so a
  name or id another computer's block already used went unnoticed, and
  `--write` added a second block beside the one already there instead of
  replacing it. `--write` now replaces its block in place and writes the file
  back with LF line endings, as `mandala-py ssh-config` already does; a file
  it has nothing to change in is left as it is.
- **`mandala ssh-config --write` removes a second copy of the computer's
  block or the gateway's block**, which versions before this one appended to
  a `~/.ssh/config` saved with CRLF line endings. That copy kept its old
  `Host` alias routing, and the next run said "already up to date". Run
  `mandala ssh-config <computer> --write` once for each computer you wrote
  that way (or delete the later `# >>> mandala … >>>` block by hand). A copy
  followed by a line of your own before the next `Host` or `Match` line is
  left in place, since that line belongs to the copy's `Host` and removing
  the copy would apply it to other hosts. A later copy whose
  `# <<< mandala … <<<` line was deleted is left in place, with every copy
  after it.
- **`mandala ssh-config --write` no longer replaces a byte that is not valid
  UTF-8 anywhere in `~/.ssh/config` with U+FFFD.** It refuses with
  `invalid_arguments`, naming the file, and leaves it byte for byte as it
  was, as `mandala-py ssh-config` already does.
- **`mandala ssh-config` counts every alias of a hand-edited block's `Host`
  lines**, read the way OpenSSH reads them: `Host dev # mine`, `Host other
  dev`, `  host=dev`, `Host "dev"`, `Host 'dev'` and a second `Host` line all
  put `dev` in that block. Only spaces and tabs separate aliases, as for ssh:
  a no-break space does not, so the `#` after one starts no comment. Only the
  whole first `Host` line counted before, so a name such a block used could
  still be written under, and `ssh <name>` went to whichever block came
  first. Negated patterns (`!dev`) do not count, and a wildcard pattern is
  compared as written, not expanded.
- **`mandala ssh-config` no longer refuses forever when two computers are
  named after each other's ids** (say `vm-1` named `vm-other` and `vm-other`
  named `vm-1`, in two accounts). The one written second fell back to its id,
  which the first one's block held, and removing that block only moved the
  refusal to the other computer. `--write` now puts both under their ids in
  one write: it changes only the other block's `Host` line, to its id, and a
  note on stderr says so. Without `--write` it still refuses, and the
  `conflict` error says that `--write` moves both. A block with more than the
  one alias the CLI writes, or whose id another block uses as a `Host`, is
  refused as before.
- **Every wait fails at once on a half-removed computer** — `waitUntilRunning`,
  `waitForGuest`, `waitUntilBuilt`, the secrets and proxy waits, and
  `launch()` — saying its files were partly removed, it cannot be started,
  and `delete()` clears it. They polled it to a `TimeoutError`.
- **`setSchedule()` no longer refreshes the handle** to read the current
  window, which dropped a create's `startError` that the waits fail fast on.
  `setSchedule()` and `clearSchedule()` now update `snapshotSchedule`, which
  went stale after either.
- **Idempotency after a `5xx`**, in the docs: one that names an
  `operation_id` spends the key (resends answer `idempotency_outcome_unknown`
  for 24 hours); one that names none may have been refused before dispatch,
  which releases the key; one made in front of the platform (an edge `524`)
  can arrive while the first call still runs, and a resend then answers
  `idempotency_in_progress`, then that call's own answer. Resending under the
  same key is safe after any `5xx`. Keys are kept per credential scope, so
  `operations.list({ idempotencyKey })` finds only operations reserved by a
  credential of the same scope. A replayed answer carries no `vnc`;
  `refresh()` fetches it.
- **Docs**: `agentOnce()` cannot outlive about 120 seconds on the hosted API
  (a body-less `524`, the run stopped, its usage and steps lost); the
  snapshot admission `503` and what to check before retrying; build secrets
  (`spec.secrets`), the `system/...` rule for `spec.from`, and that
  `spec.env` alone makes a document a build; `idleSuspendMin`'s `0`, its
  per-plan cap and its 10080 ceiling; `--resume-only`'s help now says a
  stopped computer with no saved session succeeds without booting;
  `PlanLimitError` no longer lists the rate budget (that is a `429`); and
  smaller corrections to the webhook retry count, a Connected app key's
  name, API key name rules, where a `capturing` snapshot lists, and which
  execs see bound secrets.

## [0.7.0] — 2026-09-27

Read **Changed** before upgrading. The largest change is the CLI's `--json`
output, which is snake_case throughout, envelope included, so its
`schema_version` is now 2 and `error.code` is a reason word rather than a class
name. Two types are widened: `Whoami.user.email` and `Whoami.account.plan` are
`string | null`, and `CreateArgs.browserProxy` takes `null`.

### Added

- **`client.workspaces`: `list()`, `get(id)` and `members(id)`**, over the
  platform's `GET workspaces`, `GET workspaces/{id}` and
  `GET workspaces/{id}/members`. Read only. An id the key cannot see is a
  `NotFoundError`, and `members()` for a key confined to a workspace is a
  `PermissionDeniedError`. CLI: `workspaces list | get | members`. New
  exports: `Workspaces`, `Workspace`, `WorkspaceMember`.
- **`ApiKey.mintedByKeyId`** (`string | null`), on every listed key,
  `ApiKeyCreated` and `Whoami.key`: the key that minted this one over the
  API, kept after that key is revoked. The plain keys a manage-keys key minted
  keep working after it is revoked, so this is how to find and revoke them.
  `mandala api-keys list` prints `minted by <id>`.
- **`Computer.waitForEgressProxy()`**, which waits until the computer's host
  holds the credentials its egress proxy names (`egressProxyPending` false);
  until then every connection the computer opens is closed. `launch()` now
  waits for it, inside the same readiness budget, when the create or the
  computer names `credentialsSecretId`. CLI: `computers wait --until
  egress-proxy`.
- **`browserProxy: null` on `computers.create()` and `launch()`**, sent as
  `browser_proxy: null`: a template you published may carry a default proxy
  that a create leaving the field out inherits, and `null` creates the
  computer with none. It used to throw. CLI: `computers create
  --no-browser-proxy`.
- **`Computer.drag()` holds keys**: `drag(toX, toY, from, { modifiers:
  ['shift'] })`, sent the way a click's are. New export: `DragOptions`.
- **`APIError.code` and `APIError.operationId`**, read off the body's `code`
  (`idempotency_in_progress`, `idempotency_outcome_unknown`, …) and
  `operation_id` (on the `409` answers to a keyed call and a `5xx` answer to
  one). `OperationFailedError.code` is unchanged.
- **`DeleteResult.operationId`**: the delete's operation, from
  `delete({ detailed: true })`.
- **CLI: `builds list [--allow-partial]`, `builds get`, `builds progress`
  and `templates schema`**, and `operations list --idempotency-key KEY`. A
  failed command's `--json` error carries `idempotency_key`, `request_id` and
  `operation_id` when present, and its text form a second `mandala:` line
  naming them and the command to run next. `snapshots restore` prints the
  `operation_id` it recorded.

- **An egress proxy for all of a computer's outbound TCP:** `egressProxy`
  (`{ server, credentialsSecretId? }`) on `computers.create` and
  `Computer.update` — alone in an update, where `null` removes it — and
  `Computer.egressProxy` / `Computer.egressProxyPending` on the read. The
  server is `http://`, `https://` or `socks5://` with an explicit port;
  `credentialsSecretId` names a secret holding `user:password` that the
  computer's host signs in with and the computer never receives. It fails
  closed, drops UDP to the internet and ICMP, and does not proxy DNS. A key an
  egress proxy does not have (such as `bypass`), or `egressProxy` beside any
  other field in an update, is a `ValidationError` before a request is sent.
  The CLI gains `computers create --egress-proxy URL [--egress-proxy-credentials
  SECRET_ID]` and `computers egress-proxy set|clear`, whose `set` keeps the
  current credentials for an unchanged server as `browser-proxy set` does. New
  exports: `EgressProxy`, `EgressProxyArgs`.

- **`Idempotency-Key` on every lifecycle call:** create (and `ephemeral`),
  `clone`, `start`, `stop`, `suspend`, `restart`, `update`, `relocate`,
  `delete`, `snapshots.restore` and `snapshots.clone` send one — a fresh random
  key per call, or your own through the new `idempotencyKey` option (1 to 255
  printable ASCII characters, no spaces; anything else is a `ValidationError`
  before a request is sent). An error that leaves the outcome unknown — a
  dropped connection or timeout after the request went out, a `5xx`, or the
  platform's `409` `idempotency_in_progress` / `idempotency_outcome_unknown` —
  carries the key as `err.idempotencyKey`. After a dropped connection, a
  timeout or `idempotency_in_progress`, sending the same call again with it
  answers the first call's result instead of doing it twice. After a `5xx` the
  platform marks the key lost and every resend answers
  `idempotency_outcome_unknown`: read the computer, or its operation with
  `operations.get(err.operationId)` or `operations.list({ idempotencyKey })`.
  `operations.list`
  takes `idempotencyKey`, `Operation.idempotencyKey` says which key started one
  (`null` when none, or on an older platform), `delete` is a documented
  `OperationKind`, and `isTransient` is false for `idempotency_outcome_unknown`.
  New exports: `IdempotencyOptions`, `IDEMPOTENCY_KEY_HEADER`.

- **Lifecycle operations:** `client.operations.get(id)`, `list({ computerId,
  limit, cursor })` and `wait(idOrOperation, { timeoutMs, pollMs })`, over the
  platform's `GET operations` and `GET operations/{id}`. `wait` resolves on
  `succeeded` and throws the new `OperationFailedError` (with the platform's
  `code` and `detail`) on `failed`. `succeeded` means the platform finished
  its step, not that the desktop has booted: keep `waitForGuest` for that.
  `kind` and `state` are open strings, since the platform adds kinds. The id is
  surfaced as `computer.operationId` (after a create, a clone, and each start,
  stop, suspend, restart or update through the handle; a refresh keeps it),
  `move.operationId` on what `relocate` accepted, and on
  `snapshots.restore()`, which now returns a `LifecycleAck` rather than
  nothing. CLI: `operations list | get | wait`; a failed wait is
  `operation_failed`. `operations list --computer` takes a name or an id, and
  sends a value that is neither as typed, since a deleted computer's
  operations are still found by its id. New exports: `Operations`, `Operation`, `OperationKind`,
  `OperationState`, `OperationPage`, `OperationListArgs`, `LifecycleAck`,
  `OperationFailedError` and `OPERATIONS_PAGE_MAX`.
- **CLI: `computers create --secret SECRET --as VAR` and `--secret-file SECRET
  --path FILE`** name a binding's variable or file with a flag of its own, so
  nothing typed there can be taken for the secret's value. Each `--as` or
  `--path` must come directly after its `--secret` or `--secret-file`; a stray
  one is refused without being quoted, unless `--help` is also given, which
  prints help. A name given this way goes through the same value-shape check
  as one after `=`, so `--as "$GITHUB_TOKEN"` is refused without being quoted
  rather than sent as the variable's name; `--no-value-check` lets a flagged
  one through. The check is a guess and misses some values, so every `--as` or
  `--path` name prints as `[REDACTED]` in the create's bindings and error,
  flagged or not; `computers get` shows it. A secret typed where its name was
  meant (`--secret "$GITHUB_TOKEN" --as GITHUB_TOKEN`, or
  `--secret "$TOKEN"=VAR`) is not quoted either, whether the check flags it or
  not: an error names a binding by its flag and position alone, and quotes
  the secret only once it matched a stored name or id. The manifest marks
  both with `follows`, and the completions offer them.
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
  revoked; `api-keys create` prints only the new key on stdout. For a
  workspace-scoped key, `whoami` names what the platform withholds from it
  (the user's name and email, the account's name and plan) instead of
  printing them empty: `User usr-1 (name and email withheld from a
  workspace-scoped key)` rather than `<> (usr-1)`, and `Account: acc-1,
  active (name and plan withheld …)` rather than `(unnamed)` and `plan ,`.
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
  more). A name the check still refuses goes through with `--no-value-check`,
  whether it is typed after `=` or named with `--as` or `--path`.
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
  does not, `secrets_delivering` may read false before the values land, and on
  a platform that predates the field the wait falls back to the receipt as
  above. Either way the wait can return before the values land. The CLI's
  `computers wait --until secrets` runs it.
- **A browser proxy's credentials:** `credentialsSecretId` on `BrowserProxy`
  and `BrowserProxyArgs`, the id of a secret whose value is `user:password`
  for an upstream that asks for one. It is read back and sent on, so
  `update({ browserProxy: { ...computer.browserProxy!, bypass } })` keeps the
  credentials; before this, that read-modify-write removed them, and every
  browser on the computer was then answered `407` by its upstream. The secret
  must be bound to the computer as a file, and an update that leaves the id
  out removes the credentials, since the setting is replaced whole. A value
  that is not a secret's id is refused before any request. The CLI's
  `computers browser-proxy set` keeps the proxy's current credentials when
  the server is unchanged, unless given `--credentials SECRET_ID` or
  `--no-credentials`; a set that names a different server with neither is
  refused before any request, since the credentials are sent to the proxy on
  every request and belong to the server they were set for. `computers create`
  takes `--browser-proxy-credentials SECRET_ID`.

### Changed

- **`Whoami.user.email` and `Whoami.account.plan` are `string | null`.** The
  platform answers `null` for both to a key confined to a workspace, and they
  were decoded as `''`. Such a key reads the plan with `client.account.read()`.
- **`setSchedule()` keeps the fields you leave out.** It reads the computer
  first and takes each omitted `hour`, `minute` and `tz` from its schedule
  (04:00 UTC only when it has none; a window disabled at 00:00 UTC is kept
  like any other), so `setSchedule({ enabled: false })` and
  `setSchedule({ enabled: true })` pause and resume the chosen window. It used
  to send 04:00 UTC for each, replacing the window. A call naming all four
  sends no read.
- **`setClipboard('')` clears the clipboard** rather than throwing: an empty
  string is how the platform is told to clear it.
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

### Fixed

- **Documentation brought in line with the platform:** a custom build is
  launchable (publish it and create from its ref, with the
  `template_image_preparing` continuation); an egress proxy create is never
  answered from the warm pool (not "always a cold boot"); `clone()` takes a
  stopped or suspended source; a memory snapshot's resumed copy gets its own
  identity and runs beside its source; `docDigest` does not change with
  comments, key order or whitespace; publishing an invalid document lists
  every problem in `err.body.problems`; the template schema needs an API key,
  so save it to a file for an editor; `buildDigest` is present only for a
  document with no `spec.from`; a suspended computer's screenshot is a JPEG up
  to 640 pixels wide whose pixels are not screen coordinates; `running` is
  listed among the refusal reasons; `BuildStep.status` can be `unknown`.
- **A 409 whose `reason` is `running` is permanent.** It is the platform's
  refusal of something only a stopped computer can have, a resize today, and
  nothing clears it by waiting: stop the computer, then send it again.
  `isTransient` called it worth sending again, as it does any other
  `ConflictError`, so a caller looping on it resent the same resize until it
  gave up. It now answers `false`.
- **The CLI's value check now recognises a base64 secret that `/` or `+`
  split into short pieces**, an AWS secret access key say. It read each piece
  on its own, and none was long enough to look random, so `secrets set` with
  such a value as its NAME sent it and `secrets rm` repeated it in its error.
  A base64 string of twenty characters or more holding `/` or `+` is now read
  whole, unless every piece reads as part of a name (a word, an all-caps
  acronym, a version or year, camel-case words such as `DbPassword` or
  `APIKey`), so a relative path such as `myapp/prod/DATABASE/URL` still
  passes. A real name the check refuses goes through with `--no-value-check`.

### Security

- **`computers browser-proxy set` and `egress-proxy set` no longer repeat a
  typed proxy URL's `user:password@`** when they refuse to carry the current
  credentials to a different server. The refusal names only the scheme, host
  and port, so a password typed into the URL does not reach stderr or the
  `--json` error.
- **The credential carry-over is documented as the server's.** The docs said
  spreading `computer.egressProxy` or `browserProxy` with a new `server` keeps
  the credentials, which sends the old proxy's username and password to the
  new server. They now say to leave `credentialsSecretId` out, or name the new
  server's secret, when the server changes.
- **The README said a leaked manage-keys key could not mint keys that
  survive its revocation.** The plain keys it minted do keep working after it
  is revoked; what it cannot do is pass the permission on. Find its children
  by `mintedByKeyId` and revoke them too.
- **`secrets list`, `secrets set` and `secrets rm` escape a secret's name** in
  their text output, as every other name is: the platform refuses only control
  characters in one, so a bidi override could reorder the rest of the line.
- **The CLI's text output no longer passes a terminal the control characters
  in names other people chose.** A team, user, workspace, key, SSH key or
  computer name, a guest's filename, and a platform error were written to the
  terminal as they came, so an escape sequence in one was obeyed rather than
  shown: an OSC 52 clipboard write, an erased line, a spoofed `Account:` line,
  or a bidi override reordering what followed. `whoami`, `api-keys list`,
  `api-keys create`'s notice, `account`, `usage`, `files list`, `ssh`,
  `ssh-key list | add`, `ssh-access`, every diagnostic and error on stderr,
  the text form of streamed frames, and the indented JSON printed without
  `--json` now show each C0 and C1 control, DEL and bidi control as `\uXXXX`
  (`\u001b` for ESC). A diagnostic and a streamed frame's text keep their own
  line breaks, so a line feed is the one control a string quoted in them can
  still carry; an error's message and the names in `api-keys create`'s notice
  are escaped whole, line feed included, so neither can start a line of its
  own. Credentials are still masked before anything is escaped, so a secret
  with line breaks in it, such as a PEM key given to `secrets set`, still
  prints as `[REDACTED]` when an error or a name repeats it. Letters in any
  script and emoji are unchanged. The indented JSON still parses to the real
  strings, and `--json` output is unchanged. `files list` now says when a name was shown escaped, and its note
  about names left out no longer claims every name with a control character
  was. `computers exec` still writes the command's own output unaltered, as
  `ssh` would.
- **`secrets set` refuses a NAME that looks like a secret's value, and
  `secrets rm` no longer repeats one.** `secrets set "$GITHUB_TOKEN"`, the
  value typed where the name goes, stored the token as a name everyone in the
  scope can read, and printed it in the prompt and the result. Such a NAME is
  now refused before any prompt or request, without repeating it; a real name
  the check misreads goes through with the new `secrets set --no-value-check`.
  `secrets rm`'s "no secret named" and "name of one secret and the id of
  another" errors, and a create's errors about a `--secret` or
  `--secret-file` binding, now quote what was typed only when it is shaped
  like a secret id or reads as a name, and otherwise say `that name or id` or
  name the binding by its position, in text and `--json` alike. A
  successful `secrets rm` of a secret whose stored name looks like a value
  prints only its id, and its `--json` result leaves `name` out.
- **`apiKeys.revoke()` refuses an API key passed where its id goes** (and
  `mandala api-keys revoke`). Revoking the key you hold by pasting it
  (`com_...`) put the live key into the request path, where access logs record
  it, and the platform answered 404 and left the key valid. Any value starting
  `com_`, or holding a full key anywhere (behind a zero-width space or
  byte-order mark, in quotes, after `Bearer`), now rejects with a
  `ValidationError` ("that is an API key, not a key id; run api-keys list to
  find its id (key-...)") before any request, and neither the error nor the
  CLI repeats the value.

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

[Unreleased]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.17.2...HEAD
[0.17.2]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.17.0...v0.17.2
[0.17.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mandalacomputer/typescript-sdk/compare/v0.3.0...v0.4.0
