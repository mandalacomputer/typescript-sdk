# mandala-computer

TypeScript SDK for [Mandala Computer](https://mandala.computer) — cloud desktops
for AI agents.

A real Linux desktop your code can **see and drive**: screenshots come back as
bytes, clicks go in as coordinates, and a shell in the guest is one call away.

> **Status: alpha, unpublished.** The surface is settling; expect breaking
> changes before 1.0. Tracks the platform's `/api/v1`, which is itself still
> moving.

Zero runtime dependencies. Node 22+, and anywhere else with `fetch` — Bun, Deno,
workers, the edge. (The `mandala` CLI is Node-only; the library is not.)

## Install

```sh
npm install mandala-computer
```

You need an API key from the dashboard — **Settings → API keys**, a `com_…`
string. It is scoped to your account and it *is* every computer on it, so treat
it the way you would treat a password. Never ship it to a browser.

```sh
export MANDALA_API_KEY=com_…
```

## Use

```ts
import { Client } from 'mandala-computer';

const client = new Client();                  // reads MANDALA_API_KEY

await client.computers.ephemeral({ template: 'base' }, async (c) => {
  await c.waitForGuest();                     // the guest agent answers, not just the VM
  await c.open('https://example.com');        // on the screen, not as root
  const png = await c.screenshot();
  await c.click(640, 400);
  await c.type('hello');
});                                           // destroyed here, even if the block threw
```

`create()` deliberately does not destroy anything. Deleting a computer destroys
its disk, so tying that to a scope is only safe when the scope is unambiguously
the machine's whole lifetime — which is what `ephemeral()` declares:

```ts
const c = await client.computers.create({ size: 'large' });
await c.waitForGuest();
// ... it outlives this function. Delete it when you mean to.
```

On a runtime with explicit resource management, `ephemeral` also works as a
disposable:

```ts
await using c = await client.computers.ephemeral({ template: 'base' });
await c.waitForGuest();
```

### Sizes

`size` names a template and a CPU/RAM/disk shape together, and these are the
shapes the platform keeps pre-booted — so naming one is the likeliest way to get
a computer in about a second rather than a cold boot.

```ts
for (const s of await client.sizes.list()) {
  console.log(s.id, s.label, s.cpu, s.ramMb, s.allowed ? '' : `needs ${s.cheapestPlan}`);
}

const c = await client.computers.create({ size: 'large' });
```

`allowed` is about your plan's per-computer ceilings only — what the account
already holds is not counted, so a create at an allowed size can still be refused
against the plan's pools.

It cannot be combined with `template`, `cpu`, `ramMb` or `diskGb`. Sending both
throws before any request is made.

### Resolution

Create-time, and **only** create-time: the screen is part of the machine QEMU
builds, so changing it needs a new computer.

```ts
const c = await client.computers.create({ template: 'base', resolution: '1920x1080' });
const { width, height } = c.screen;           // what every coordinate is in
```

Read `c.screen` rather than assuming 1280x800. Computer-use accuracy is
resolution-sensitive, and a model told the wrong numbers clicks proportionally
short of everything it aims at:

```ts
const tool = {
  type: 'computer_20250124',
  name: 'computer',
  display_width_px: c.screen.width,
  display_height_px: c.screen.height,
};
```

### Driving the desktop

The verb set is Anthropic's computer tool, in full — so whatever a computer-use
model emits, there is a method for it:

```ts
await c.move(100, 200);
await c.click(100, 200);
await c.click();                              // where the pointer already is
await c.click(100, 200, ['shift']);           // held for the click
await c.rightClick(100, 200);
await c.doubleClick(100, 200);
await c.tripleClick(100, 200);                // selects a line in most editors
await c.drag(400, 300, { x: 100, y: 200 });   // one gesture, not two clicks
await c.mouseDown(100, 200);
await c.mouseUp(400, 300);
await c.scroll(640, 400, { direction: 'down', amount: 3 });
await c.type('hello');
await c.key('ctrl', 'c');                     // X11 keysyms work too: Page_Down, BackSpace
await c.key(['ctrl', 'c'], { signal });       // the same chord, cancellable
await c.holdKey(['shift'], 1.5);
await c.wait(2);
const at = await c.cursorPosition();          // undefined if nothing has placed it
```

No coordinate means "where the pointer already is", which is a real and different
request from clicking (0, 0). Half a coordinate — `click(5)` — is refused rather
than completed with a zero: it would succeed, at the wrong place, and nothing
would say so.

### Screenshots, and the one flag a drive loop needs

```ts
const png = await c.screenshot();                   // full-resolution PNG
const thumb = await c.screenshot(320);              // downscaled JPEG
const now = await c.screenshot(undefined, { fresh: true });
```

**Pass `fresh` whenever the image is feeding a decision.** A bare screenshot may
be served from a cache up to 1.5 seconds old — which is what makes ten watchers
of one desktop cost a single screendump, and what makes a drive loop read the
screen as it was *before* its own last click. A model handed that frame concludes
the click missed and clicks again, and the second click lands on whatever the
first one revealed. A thumbnail can have the cached frame; a decision cannot.

`fresh` and a width cannot be combined — `screenshot(320, { fresh: true })` is
refused, not half-honoured. The platform serves every downscaled screenshot from
its cache, so the flag alongside a width is one it would take and ignore.

### Windows

A screenshot says what the desktop *looks like*; this says what any of it **is**,
which is how you tell a browser that failed to open from one that has not painted
yet. Linux only.

```ts
for (const w of await c.windows()) {
  console.log(w.id, w.windowClass, w.title, w.focused);
}
await c.windowAction('0x2600003', 'focus');
await c.windowAction('0x2600003', 'move', { x: 100, y: 100 });
```

Match on `windowClass`, not `title`: the class is the application, the title is
whatever page it is showing. Prefer `focus` over `raise` — raising without
focusing gives a window that is visibly in front and silently not receiving
keystrokes. The reply is the window *afterwards*, not an acknowledgement: window
managers snap to their own grid, so a move to 300,200 routinely lands at 305,229.

### Running commands

```ts
const res = await c.exec('ls /home/user');
if (!res.ok) console.error(res.stderr);
if (res.truncated) { /* the guest agent capped output at 16 MiB */ }
```

A non-zero exit is returned, not thrown. By default the command runs as `root`
with no display; anything with a window needs the desktop session:

```ts
await c.exec('nohup firefox https://example.com >/dev/null 2>&1 &', { desktop: true });
```

`env` is the right way to hand a build a token, since the alternative is
interpolating one into the command line where the guest's shell history and
process list can both read it:

```ts
await c.exec('./deploy.sh', { cwd: '/src', env: { CI: '1', TOKEN: token } });
```

On Linux those variables go *on top of* the guest's profile — `PATH` and the rest
survive, because the command runs through `bash -lc`. On Windows they **replace**
it: `cmd.exe /c` sources no profile, so the command sees exactly what you passed
and nothing else, `PATH` and `SystemRoot` included. Pass what it needs there.

Or call `open()` and let the SDK write that line — it names a browser that
actually works on the image, quotes the URL, and detaches the launch:

```ts
await c.open('https://example.com');
```

> Firefox by name, rather than `xdg-open` or one of the other portable
> wrappers: naming it puts the choice in one place. `open()` is the only thing
> that decides which browser the guest opens, so if that ever needs to be a
> different one, it changes there and your callers do not.

### Long-running commands

**`exec` cannot wait longer than about two minutes**, whatever `timeoutS` says.
The HTTP budget is derived from it and the platform stretches its own deadline
to match, but a proxy in front of the platform abandons a request that has
produced no response for roughly that long and answers 524, which arrives as
`GatewayTimeoutError`. Measured against `app.mandala.computer`:

| command | `timeoutS` | result | wall clock |
|---|---|---|---|
| `sleep 110` | 230 | ok | 110.6s |
| `sleep 130` | 300 | `GatewayTimeoutError` | 125.2s |
| `sleep 130` | 3600 | `GatewayTimeoutError` | 125.3s |

The last two rows are the point: a twelvefold difference in what was asked for,
a tenth of a second in where it ended, because the hop that gives up never saw
the argument. The command also survives the request that abandoned it, so the
call after one of these often raises `ConflictError` — the guest agent still
busy with it, which is the first failure continuing rather than a second one.

So `execBackground` is not merely the tidier option past a few seconds; past two
minutes it is the only one that works. Strictly better than backgrounding with
`&`, which throws away the exit code and the output:

```ts
const job = await c.execBackground('apt-get install -y build-essential');

for (;;) {
  const s = await c.execPoll(job.pid);
  process.stdout.write(s.stdout);             // only the NEW bytes
  if (!s.running) break;
  if (!s.more) await new Promise((r) => setTimeout(r, 1000));
}

await c.execKill(job.pid);                    // if you change your mind
```

The output is a **cursor, not a buffer**: each poll gives you only what has been
printed since the last one, so two readers on one pid split the output between
them rather than each seeing all of it.

### Files

```ts
await c.writeFile('/home/user/.env', 'TOKEN=secret');   // never echoed through a shell
const bytes = await c.readFile('/home/user/out.bin');
const text = await c.readTextFile('/home/user/out.txt');
```

Paths are absolute, inside the guest. There is no shell and no working directory
behind a transfer, so a relative path is refused before the request is made.
Works while the computer is running or suspended.

#### Files bigger than one request

One transfer moves at most **64 MiB** — the bytes cross the guest agent in
chunks and a single request holds that channel for as long as it takes. A whole
file past that is refused with a `TooLargeError`, and a range is the way through
it: the ceiling then applies to the *window* you asked for rather than to the
file, so a 2 GB build output is something to page rather than something you
cannot fetch.

```ts
const out = await open('./build.tar', 'w');
for await (const chunk of c.readFileChunks('/home/user/build.tar')) {
  await out.write(chunk.bytes);                 // in order, end to end
}
await out.close();
```

`readFileChunks` is that loop. Chunks arrive in order and contiguously, and
nothing is held but the chunk in hand. `offset` and `length` narrow it to part
of the file, and `chunkBytes` caps how much any one request asks for.

For a single window there is `readFilePart`:

```ts
const tail = await c.readFilePart('/var/log/app.log', { offset: -4096 });
console.log(`${tail.bytes.length} of ${tail.total} bytes, from ${tail.offset}`);
```

A **negative** offset is the tail — the last N bytes — and takes no length.

Two things about ranges are worth knowing before you write your own loop, which
is why `readFileChunks` exists:

**You can get fewer bytes than you asked for.** A window past the ceiling is
trimmed rather than refused, since you cannot know the limit before you ask. So
`chunk.offset` and what actually came back, not the numbers you passed, are
where the next window starts.

**Which end gets trimmed follows the end you anchored.** An open window keeps its
start; a tail keeps its **end**, because a tail longer than one request moves is
still the tail of the file rather than the middle of it. Re-deriving a tail as
`total - N` and asking forward is how that goes quietly wrong.

A file whose length the guest cannot report — a `/proc` entry — has no byte
positions to name. The range is ignored and the whole thing arrives with
`partial: false` and `seekable: false`; there is no total to promise.

### The agent loop

One call that drives the computer until the task is done — screenshot, decide,
click, type, repeat — **inside the platform**, on your own Anthropic key, which
the platform never stores.

```ts
const result = await c.agent({
  prompt: 'Open the settings and turn on dark mode.',
  modelKey: process.env.ANTHROPIC_API_KEY!,
  maxSteps: 20,
});

if (!result.finished) console.warn(`did not finish: ${result.stop}`);
console.log(result.text, result.usage);
```

Ten clicks stop being ten images in *your* context. Each step is a model call
plus a screenshot billed to your key, so `maxSteps` is a spending cap as much as
a loop bound.

Stream it when the run is long enough that silence looks like a hang:

```ts
const ac = new AbortController();
for await (const ev of c.agentStream({ prompt, modelKey, signal: ac.signal })) {
  if (ev.type === 'step') console.log(`${ev.step.n}. ${ev.step.detail}`);
  if (ev.type === 'done') console.log(ev.result.text);
}
```

Pass a `signal` on anything long. Without one an abandoned run keeps spending:
the model request nobody is waiting for still completes on your key, and the
desktop action it asks for is still performed.

`finished` is true only for `stop === 'end_turn'`. A run that hit `max_steps`,
ran out of API budget (`rate_limited`), or was declined (`refusal`) is **not**
raised as an error — the steps already taken are real and what they did to the
desktop stands. They say the run did not finish, which is a different thing from
the run having gone wrong.

### Power

```ts
await c.start();
await c.stop();                               // asks the guest to shut down
await c.stop({ force: true });                // pulls the power
await c.restart();                            // the reset button, not a fresh boot
```

`stop()` asks the guest to shut down and gives it time. `force` skips the asking
— the equivalent of holding the button in. It is what to reach for when a guest
will not come down on its own, and it loses whatever had not been written to
disk, so it is not where to start.

### Suspending

A pause, not a stop. The session is written to disk, the host gets its memory
back, and `start()` resumes the same processes and the same open windows in about
a second rather than booting:

```ts
await c.suspend();
console.log(c.isSuspended, c.suspendedAt);
await c.start();                              // same desktop, ~1s
```

A computer can arrive here without anyone asking: its host suspends anything
nobody has used for the host's idle window — 30 minutes by default. Input, exec
and file transfers resume it automatically. **Screenshots deliberately do not
count as use and do not resume it**, so a loop that only polls the screen can be
suspended out from under itself.

```ts
await c.update({ idleSuspendMin: 120 });      // or null to follow the host
```

### Showing somebody the desktop

Every response that *is* one computer carries the connect surface, so putting a
live desktop in your own page is not a second call:

```ts
const c = await client.computers.get(id);
const vnc = c.vnc;
if (vnc) {
  res.send(`<iframe src="${vnc.embedUrl}" width="1280" height="800"></iframe>`);
}
```

Two credentials, and the difference is enforced by the platform rather than by
the client asking politely:

| | what it grants |
|---|---|
| `vnc.url` / `vnc.token` | full control — keyboard and pointer, **not** the clipboard. Root-equivalent on that machine. |
| `vnc.viewUrl` / `vnc.viewToken` | watch only. The platform *drops input* on this socket, so a patched client still cannot type. |
| `vnc.embedUrl` | the hosted viewer, watch-only, for an `<iframe>`. The credential is in the URL fragment, which browsers never send to a server — so it stays out of access logs and out of `Referer`. |
| `vnc.terminalUrl` | an interactive PTY in the guest, on the *controlling* credential. `''` on Windows; present but refused on a computer that has not been cold-booted since terminals shipped. |

Neither is your API key, which is every computer on the account, forever. Both
end when the computer restarts.

The clipboard does not cross the VNC socket, whatever a noVNC client offers on
it: QEMU carries cut text only through a vdagent channel these guests are not
started with, so a paste arrives and is dropped without an error. Move text with
`exec` and `desktop: true`. Three things about the write are quiet when you get
them wrong: the holder must outlive the command, because an X selection belongs
to a live process; its output must be redirected, or the resident `xclip` holds
the pipe the guest agent reads and the exec runs to its full timeout before
answering; and the text goes over base64, whose alphabet has no quote in it, so
an apostrophe in what you are pasting cannot end the shell word.

Being granted the selection is also asynchronous, so a read straight after the
write returns the *previous* clipboard — poll until it matches, and give up
after a few seconds. Every poll is another billable exec, and the redirection
above swallows xclip's own errors, so a guest without it never changes the
selection at all.

```ts
const read = await c.exec('xclip -o -selection clipboard', { desktop: true });

const b64 = Buffer.from(text, 'utf8').toString('base64');
await c.exec(`printf %s '${b64}' | base64 -d | setsid xclip -selection clipboard >/dev/null 2>&1 &`, {
  desktop: true,
});
```

`vnc` is `undefined` on a computer that came from `list()` — a desktop credential
in every list response is a credential in every log line that ever captured one.
`(await c.refresh()).vnc` is how a listed computer gets one. It is also
`undefined` when the platform could not reach the host, because a URL built over
a missing credential is indistinguishable from a working one and answers 401
forever.

### Readiness

```ts
await c.waitUntilBuilt();      // a clone's disk has finished copying
await c.waitUntilRunning();    // the VM is up — the guest OS is still booting
await c.waitForGuest();        // something inside the guest answers
```

`waitForGuest` is the one you usually want before `exec`, files, windows, or
expecting a screenshot to show a desktop rather than a boot screen. It probes
with `exit 0`, a builtin of both bash and cmd.exe, so it works on either OS.

These throw rather than waiting out the timeout for a state that will not
resolve on its own. A failed build stops all three. A suspended session stops
`waitUntilRunning`, which is the wait it will never resolve for — `waitForGuest`
runs a command in the guest, and a command *resumes* a suspended computer, so it
waits through the resume and returns when the guest answers.

### Computers that are still being built

A clone returns before its disk exists, because copying one can run for minutes:

```ts
const copy = await c.clone('experiment');
console.log(copy.isBuilding);                 // true
await copy.waitUntilBuilt();                  // default timeout is 15 minutes
await copy.start();
```

Until the disk lands there is nothing to boot, and starting, stopping,
snapshotting or cloning it throws `ConflictError`. If the copy dies,
`buildFailed` is true and `buildError` says why — nothing will fix it on its own.

### Snapshots

```ts
const snap = await c.snapshot();                    // disk
const live = await c.snapshot({ memory: true, name: 'before-upgrade' });

const forked = await client.snapshots.clone(live.id, 'twin');
await forked.waitUntilBuilt();                      // resumes, does not boot
```

Naming one is worth the keystrokes. Snapshots outlive the computers they came
from, so an account's listing fills up with generated names that record only when
each was taken — which is the one thing a restore does not need to know.

A memory snapshot forks into a live twin — same processes, same open windows,
same network identity until it is re-identified.

```ts
await client.snapshots.restore(snap.id);            // back onto its source
await client.snapshots.delete(snap.id);
await c.setSchedule({ enabled: true, hour: 4, tz: 'America/New_York' });
```

`restore` is refused on an orphaned snapshot — one whose computer is gone. Clone
is what works there, because a restore puts the disk back on a source that no
longer exists.

### Deleting, and the purge interlock

```ts
await c.delete();                                   // snapshots survive, as orphans
```

To destroy them too, read the holdings first and pass the fingerprint back:

```ts
const held = await c.holdings();
console.log(`${held.count} snapshots, ${(held.sizeBytes / 1e9).toFixed(2)} GB`);

await c.delete({ deleteSnapshots: true, expect: held.fingerprint });
```

The fingerprint names that exact set, and the purge is refused unless it still
does — so a capture that finished between your decision and the call cannot be
swept up in a decision that was never about it. The SDK will not let you purge
without one, and deliberately does **not** fetch it for you: a fingerprint read a
millisecond before the delete binds the purge to whatever the set is *now*, which
is precisely the race the interlock exists for.

### Partial listings

`list()` on computers and snapshots fans out across every hypervisor holding
something of yours. One that cannot be reached makes the answer incomplete, and
the platform **fails closed** about it — you get `UnavailableError`, not a short
list. A short list is not a smaller truth: it reads exactly like the missing rows
were deleted, and the obvious next thing a script does with a computer that has
disappeared is tidy up after it.

Take the short answer knowingly when you want it:

```ts
const { items, incomplete } = await client.computers.listWithStatus({ allowPartial: true });
if (incomplete !== null) {
  console.warn(`fleet read was short — do NOT treat anything absent as deleted`);
}
```

`incomplete` is `null` exactly when the answer was whole. When it is not, it is
how many rows the placement cache could account for — legitimately `0`, because a
computer created during the outage was never cached against the host now holding
it. So branch on `incomplete !== null`, never on the number.

### Errors

```ts
import {
  MandalaError,        // base of everything this SDK throws
  APIError,            //   any unsuccessful response
  AuthenticationError, //     401 — key missing, malformed, revoked
  PlanLimitError,      //     402 — your plan will not allow this. Not a retry.
  PermissionDeniedError,//    403 — the key's role is too low
  NotFoundError,       //     404 — no such computer, snapshot, or route
  ConflictError,       //     409 — right request, wrong moment. Retry this one.
  TooLargeError,       //     413 — more file than one request moves
  RangeNotSatisfiableError,// 416 — that range names no byte the file has
  RateLimitError,      //     429 — retry after retryAfterMs when present
  UnavailableError,    //     503 — a listing would have been short
  GatewayTimeoutError, //     504/524 — a proxy gave up; the work carries on
  OriginResponseError, //     520 — it answered, unreadably; work may have happened
  OriginUnreachableError,//   521-523 — a proxy could not reach it; retry
  OriginTLSError,      //     525/526 — a certificate they cannot agree on
  ConnectionError,     //   the platform could not be reached. Retryable.
  TimeoutError,        //   a wait helper gave up
  isTransient,
} from 'mandala-computer';

try {
  await c.snapshot();
} catch (err) {
  if (isTransient(err)) { /* wait and try again */ }
  else if (err instanceof PlanLimitError) { /* a person has to fix this */ }
  else throw err;
}
```

`ConflictError` is the one that clears itself: a guest still booting, a disk still
being copied, another operation holding the guest agent. The platform's own
message survives onto `err.message` — these are written to be acted on.

`GatewayTimeoutError` is the one that does not clear and is not the platform's
answer at all. The request reached it, and any work it had already started
carries on; what ended was one hop's willingness to hold a connection open with
nothing crossing it, which is why retrying unchanged reproduces it exactly.
After one on an `exec()` the next call may report the guest agent busy; after
one on a read there is nothing left behind. `err.message` carries the response's
own message where it sent a structured one, and this SDK's explanation where the
hop sent an empty or HTML body — which is the usual case, since a 524 is
generated at the edge. See [Long-running commands](#long-running-commands).

`OriginUnreachableError` is its opposite and is why the two are different types.
A gateway timeout means the request arrived and its work carries on; these mean
it never arrived, so nothing was started and there is nothing to account for.
521-523 are usually the platform restarting and clear on their own. 525 and 526
are `OriginTLSError` instead — a handshake that will fail the same way on every
retry, so it is a deployment to fix rather than an outage to wait out.

`TooLargeError` is the one with a door out of it. The 64 MiB ceiling is on a
single transfer, not on the file, so on a download it means *ask for part of it*
— `readFileChunks` pages a file of any size through the same route. On an upload
there is no such door: the body **is** the file, so a write past the ceiling has
to be split by whoever is sending it. `RangeNotSatisfiableError` carries `total`,
the file's real length off the refusal's own `Content-Range` — which is the
entire value of a 416, since you asked about a file whose size you did not know.

`OriginResponseError` is 520 alone, and it is the trap in that range: despite the
neighbouring number it means the platform **was** reached and its answer could
not be read, so the work may have happened in full, in part, or not at all.
Before retrying anything that creates something, check whether the first attempt
took effect.
Neither is in `isTransient` — this SDK decides transience by class, and adding a
retrying status would be a change to retry policy rather than to naming.

## The `mandala` CLI

```sh
npx mandala ssh my-computer                 # an interactive shell in the guest
npx mandala ssh my-computer -s build        # a second, named session
npx mandala scp ./setup.sh my-computer:/tmp/setup.sh
npx mandala scp my-computer:/var/log/app.log ./app.log
```

`ssh` rides the platform's terminal websocket — a PTY kept alive server-side.
Disconnecting **detaches** rather than ending it; running the same command
reattaches and replays recent output.

`scp` rides the files API, so it needs no shell in the guest at all. The side
spelled `<computer>:/path` is the guest, by scp's own rule: a colon marks the
remote side unless a `/` comes before it, so `./odd:name` stays a local file.

A download is paged and written chunk by chunk, so it is not bounded by the
64 MiB a single transfer moves and never holds the file in memory —
`mandala scp vm:/home/user/build.tar .` is the copy the SDK's `readFileChunks`
exists for. A failure part-way leaves what arrived on disk, as scp and curl do.

Both take a computer's name or its id, and authenticate with `MANDALA_API_KEY`.

## Design notes

**One place for every route and every body.** `src/paths.ts` builds all of them.
A URL assembled at a call site is a URL the surface test cannot see — and
anything absent from the platform's allowlist is a 404 in a user's hands rather
than a failure in CI.

**Pinned to the platform's surface.** The platform allowlists routes server-side
and 404s everything else. `test/allowlist.ts` mirrors that table in full,
`test/surface.test.ts` asserts every request this SDK can issue lands inside it,
and `scripts/check-surface.mjs` diffs the mirror against `web/lib/surface.ts`
whenever both repos are checked out. A mirror nobody compares is just a comment:
that is exactly how three routes reached the platform without the Python SDK's
surface test noticing, because "every call lands on an allowlisted route" stays
true when the allowlist is the stale one.

**Pinned to its parameters too, because routes were not enough.** A route table
cannot see a call that lands in the right place without the argument that made
it worth making. Four did: `stop?force`, `screenshot?fresh`, `exec`'s `env` and
a snapshot's `name` were all documented, all on routes this SDK reached, and
none of them sendable — and every surface test was structurally unable to
notice. So `PARAMETERS` mirrors the platform's `DOCS` table as well, the surface
test asserts each one is actually reached, and `check-surface.mjs` diffs both.

**The gap is a number, not a vibe.** Routes the platform exposes that this SDK
cannot call live in `UNIMPLEMENTED`, and parameters it does not send in
`UNIMPLEMENTED_PARAMETERS`. Closing one means deleting its line, which is the
point.

**Validation that saves a round trip, and no more.** Everything refused locally
— a relative guest path, half a coordinate, a `size` next to a `cpu`, a purge
with no fingerprint — is refused by the platform too. It is checked here because
the mistake is knowable without the round trip, not because the platform is
trusted less.

**Permissive about responses.** Unknown fields are preserved in `.raw` rather
than rejected, and unknown SSE event types are skipped rather than thrown on. A
platform that starts returning more must not break older clients.

**No dependencies.** `fetch` and `WebSocket` are both global on Node 22. A
websocket library would have been this package's only runtime dependency, carried
by every user of the library for the sake of one CLI command.

**Only `/api/v1`.** Never the hypervisor daemon's own routes. Its ops endpoints
(`/host`, `/fleet`, `/audit`) and the plan-owned retention writes are not
owner-scoped inside the daemon, because nothing user-facing was ever meant to
reach them. `test/surface.test.ts` asserts the mirror stays clear of them, so
widening it later is a deliberate act rather than a quiet one.

## Relationship to the other clients

| | |
|---|---|
| [`mandala-computer-python`](https://github.com/mandalacomputer/python-sdk) | the Python SDK, sync and async |
| [`mandala-computer-mcp`](https://github.com/mandalacomputer/mcp) | an MCP server, for Claude Code / Claude Desktop |

All three bind to the same `/api/v1` and share the same status-to-error mapping,
deliberately: three clients disagreeing about what a 402 is means the same
failure reads differently depending which one you reached for.

## Development

```sh
npm install
npm test           # vitest, then the route + parameter diff against the platform repo
npm run typecheck
npm run lint
npm run build
```

`npm test` looks for the platform repo next door (or at `MANDALA_PLATFORM_REPO`)
and skips the diff, loudly, when it is not there — failing over its absence would
make the check something people learn to ignore.

## License

MIT
