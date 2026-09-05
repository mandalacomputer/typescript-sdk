# mandala-computer

TypeScript SDK for [Mandala Computer](https://mandala.computer) — cloud desktops
for AI agents.

A real Linux desktop your code can **see and drive**: screenshots come back as
bytes, clicks go in as coordinates, and a shell in the guest is one call away.

> **Status: alpha.** The surface is settling; expect breaking changes before
> 1.0. Tracks the platform's `/api/v1`, which is itself still moving.

Zero runtime dependencies. Node 22+, and anywhere else with `fetch` — Bun, Deno,
workers, the edge. (The `mandala` CLI is Node-only; the library is not.)

## Install

```sh
npm install mandala-computer
```

Published as ES modules, with type declarations alongside. The install also
puts a `mandala` command on your PATH; see [The `mandala` CLI](#the-mandala-cli).

You need an API key from the dashboard — **Settings → API keys**, a `com_…`
string. It is scoped to your account and it *is* every computer on it, so treat
it the way you would treat a password. Never ship it to a browser.

```sh
export MANDALA_API_KEY=com_…
```

Requests go to `https://app.mandala.computer/api/v1`; `MANDALA_BASE_URL` or
`new Client({ baseUrl })` points them elsewhere, and `apiKey` is the same
option for the key. `timeoutMs` is the per-request budget — 60 seconds unless a
call knows it needs longer, `0` to disable — and `fetch` takes an implementation
of your own if you have proxies or certificates to configure. Each method takes
a `signal` among its options, so any one request can be cancelled.

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

A create takes a `name`, and `start: false` leaves the computer stopped. Finding
one again is `computers.get(id)` or `computers.list()`; a handle you already
hold is re-read with `c.refresh()`, and renamed with `c.rename('staging')`. Every
field on the handle — `status`, `os`, `cpu`, `ramMb`, `createdAt` and the rest —
is what the last payload said, and `c.raw` is that payload.

On a runtime with explicit resource management, `ephemeral` also works as a
disposable:

```ts
await using c = await client.computers.ephemeral({ template: 'base' });
await c.waitForGuest();
```

**If the block throws and the cleanup delete fails too, both errors arrive** —
a `SuppressedError` whose `.suppressed` is the block's own error, the fault to
read first, and whose `.error` is a `MandalaError` naming the machine that is
still billable. Both spellings fill those two fields the same way, so a cleanup
failure is never the thing that goes unmentioned.

Read `.error`, not `.message`: the top-level message is the one field the two
spellings cannot agree on, because the runtime writes its own generic text over
it for `await using`. And on Node 22, where `SuppressedError` is not a global,
the same three fields arrive on a plain `Error` named `SuppressedError` — so
`err.name === 'SuppressedError'` is the portable test and `instanceof` is not.

A 404 from the cleanup is not one of these: the block deleted the machine
itself, and its own error stands alone.

Every computer is a Linux desktop today. Windows guests are not offered on any
plan; where this README mentions Windows it is describing behaviour the client
already supports for when they are.

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

### Your own templates

A template is a `mandala/v1` document — the image family it resolves to, what it
is layered onto, and the shape a computer gets when the create names no numbers.
Publishing one gives it a ref you can launch by name.

```ts
const doc = await readFile('devbox.yaml', 'utf8');

// Worth doing while you iterate: this reports EVERY problem at once, and claims
// no ref. It does not throw for an invalid document — that is the answer.
const check = await client.templates.validate(doc);
if (!check.valid) throw new Error(check.problems.join('\n'));

const t = await client.templates.publish(doc);
const c = await client.computers.create({ template: t.ref });
```

A valid answer carries more than the verdict. `docDigest` identifies the whole
document and changes with any edit at all; `buildDigest` covers only what decides
the image, so comparing it against a previous run tells you whether an edit means
a rebuild.

A document that names a parent in `spec.from` has **no** `buildDigest` — it
cannot be computed without the parent's — and gets `buildDigestNeeds` in its
place, which is a sentence saying what is missing and where to get it. The two
are never both present, so read the second when the first is absent rather than
treating the absence as unexplained:

```ts
if (!check.buildDigest) console.log(check.buildDigestNeeds);
// the contents of acme/base's image, which only a host holding it can supply.
// Run `gorillad -build-template <file> -dry-run` there to see this document's
// build digest
```

`canonical` is the document as the digests were taken over it, key order and
whitespace normalised — hash it yourself to check `docDigest` rather than
trusting the platform to have done it honestly. `template` is the catalogue row
the document describes, in the same shape `templates.list()` answers — so what a
validated document would look like in a picker is readable before it is
published.

**The namespace is your account.** `metadata.namespace` has to be your account
id — anything else is a `403`, `system` included — and this SDK does not rewrite
it, because publishing a ref that is not the one in your file would be worse than
refusing.

**A ref is immutable.** Publishing the identical document again succeeds and
changes nothing, so a pipeline that republishes on every commit is safe.
Publishing a *different* document under the same ref is a `ConflictError`; bump
`metadata.version`. What counts as different is the digest, so a changed label is
a change.

Read one back — yours or `system`, so you can see what you are layering onto:

```ts
// The namespace is your account id — the same one your document's
// `metadata.namespace` names. `ref` is where to read it back off a publish.
const namespace = t.ref.split('/')[0] ?? '';

const base = await client.templates.get('system', 'base');
const pinned = await client.templates.get(namespace, 'devbox', { version: '1.0.0' });
```

Without `version` you get the newest, which is also what a create naming the
unpinned `namespace/name` resolves to.

`templates.list()` is the catalogue — the images a computer can be created
from, each with the `ref` a create names it by — and `templates.schema()` is
the JSON Schema for a `mandala/v1` document, returned as it is so an editor or
a validator can be pointed at it. Its `$id` is the URL it came from, so a `$ref`
to it resolves.

#### Retiring one

```ts
await client.templates.retire(namespace, 'devbox', { version: '1.0.4' }); // one version
await client.templates.retire(namespace, 'devbox');                      // every version
```

Omitting `version` retires the **whole name** — deliberately not `get`'s "the
newest", which on a delete would let a loop walk backwards through a history it
never asked about. An empty string is refused before it is sent, for the same
reason.

**Computers are not affected.** A computer is built from the image the ref
resolved to and holds no reference to the document, so anything already running,
stopped or suspended is untouched. What a retire breaks is resolution: a *new*
create naming the ref is refused.

**The ref stays spoken for, and still counts once.** Publishing it again is a
`ConflictError`, identical bytes included, and `refsClaimed` on the result does
not go down — it is the count against a much larger, separate ceiling than
`templates`. A ref you retired is a `NotFoundError` whose message names the date
it went, rather than claiming the template never existed; read the message before
concluding you mistyped something.

### Building one

A document that declares `spec.build` steps has to be compiled into an image
before anything can launch it. That is minutes of work — an agent image is
roughly fifteen — so it never blocks:

```ts
const build = await client.builds.start(doc);
const out = await client.builds.wait(build.id);

if (out.status !== 'succeeded') {
  const failed = out.steps.find((s) => s.status === 'failed');
  console.error(`step ${failed?.n} (${failed?.kind} ${failed?.label}) failed: ${out.error}`);
}
```

`wait` does **not** throw for a build that failed. `succeeded` and `failed` are
two situations with two remedies — one has an image, the other has a step to fix
— and an exception flattens them into "something went wrong". Read `status`.

Identical documents share an image, which is what makes a repeated build cheap;
`builds.start(doc, { noReuse: true })` builds again regardless. The namespace
and the `spec.family` both have to be yours, and either one that is not is a
`PermissionDeniedError`; a `ConflictError` means the host is busy — one build
runs per host at a time — and is worth retrying. `builds.get(id)` is the job,
`builds.progress(id)` is what it is doing and stays readable after it has
finished, and `builds.list()` is every build the fleet still holds a record of.

For a terminal, stream it instead of polling:

```ts
for await (const p of client.builds.events(build.id)) {
  console.log(`${p.phase} ${p.step}/${p.of} ${p.note}`);
}
```

Each event is news — the platform sends one only when something moved — and the
last one is the `done`, **including for a build that failed**.

The loop above throws for three reasons, all of them about the stream rather than
the build: an `error` event, a final event whose payload is malformed, and a
stream that ends without a final event at all. The last two matter because
returning quietly would make a cut stream indistinguishable from a finished
build. All three say the build is probably still running and point at
`builds.progress`. Breaking out early is not one of them — that closes the stream
and throws nothing. An account may hold eight streams open at once.

**A build that declares its own family is not launchable yet.** The fleet does
not advertise a family it built rather than shipped, so a create naming such a
ref is refused with a `400` — a bare `APIError`, and a permanent answer: the
message says in words that retrying the create changes nothing and that what
would change it is publishing a new version. Deliberately not a `503`, which
arrives as `UnavailableError`, which `isTransient` answers true for — so a
create wrapped in a retry-on-transient loop spent its whole deadline on an
answer that was never going to move. A `503` on this path still means the case
that does come good: a shipped family whose only holder is unreachable.
Publishing the document is worth doing anyway — it claims the ref, and it is
what `builds.start` takes.

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
await c.middleClick(100, 200);
await c.doubleClick(100, 200);
await c.tripleClick(100, 200);                // selects a line in most editors
await c.drag(400, 300, { x: 100, y: 200 });   // one gesture, not two clicks
await c.mouseDown(100, 200);
await c.mouseUp(400, 300);
await c.scroll(640, 400, { direction: 'down', amount: 3 });
await c.scroll(640, 400, { direction: 'right', modifiers: ['shift'] });
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
would say so. Modifiers are a positional on the clicks and an option on
`scroll`, and the wrong spelling of either is refused rather than sent with
nothing held down. A `drag` with no `from` starts where the pointer is, and is
refused if nothing has placed it yet.

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
  console.log(w.id, w.windowClass, w.title, w.focused, w.visible, w.pid);
}
const moved = await c.windowAction('0x2600003', 'move', { x: 100, y: 100 });
console.log(moved.window?.x, moved.window?.y);          // 105, 129, probably

const shut = await c.windowAction('0x2600003', 'close');
shut.gone;                                              // true — there is no window left
```

Match on `windowClass`, not `title`: the class is the application, the title is
whatever page it is showing. `visible` is false for a **minimised** window,
which stays on the list — clicking at the coordinates of one puts the click on
whatever is actually there. Panels, the wallpaper and the rest of the desktop's
furniture are left off by default — a stock guest with one terminal open has
five windows, four of which are not applications — and
`windows({ includeAll: true })` puts them back.

The actions are `focus`, `raise`, `minimize`, `maximize`, `unmaximize`,
`close`, `move` and `resize`; the geometry argument — `x`, `y`, `width`,
`height` — is what `move` and `resize` read.

`pid` is the process that owns the window, and is `undefined` where the guest
did not say — never `0`, which is a pid a guest may genuinely advertise. It
does **not** identify the window: an application that keeps one process for
several windows — `xfce4-terminal` is one — reports the same pid on all of
them, so killing this pid can take windows you never asked about.

`x`, `y`, `width` and `height` are `undefined` on the same rule and for a
sharper reason: `0` is a place a window really is — the top-left corner — so a
coordinate this client could not read must not come back as one. The live route
sends all four on every window, so absent means something is already wrong, and
`w.x ?? 0` is the wrong repair: there is no fallback for a place. A listing
carrying a window with **no `id`** is refused outright rather than handed back,
because every window action takes that id and a row without one names nothing
you can act on.

Prefer `focus` over `raise`: raising without focusing gives a window that is
visibly in front and silently not receiving keystrokes.

The reply is the window *afterwards*, not an acknowledgement — window managers
snap to their own grid, so a move to 300,200 routinely lands at 305,229 —
wrapped in a result rather than returned bare, because two outcomes have no
window to describe and `gone` is the only thing that separates them: `true`
after a close, and `false` when the action happened and the guest could not
describe what it left. The second is an outcome, not a failure, and not a reason
to repeat the action.

**Two desktops answer this, and `c.desktop` says which.** `os` is `linux` for a
Wayland guest and an X11 one alike, so it is the only field that tells them
apart — `'wayland'`, `'x11'`, or `undefined` from a host too old to have been
asked, which is not the same as `'x11'`. Two things change with it:

```ts
c.desktop;                                        // 'wayland' | 'x11' | undefined

// The call is the same on both, and on X11 it simply works. What Wayland adds
// is a refusal: a TILED window's geometry belongs to the compositor's layout,
// so this comes back a 400 rather than a move that quietly changed nothing.
// The message names the way past it — float the window (Super+V in a stock
// Omarchy) and the same call takes.
await c.windowAction('0x2600003', 'move', { x: 100, y: 100 });
```

The other change is what a window's `id` **is**: a Hyprland client address
rather than an X window id. Both are `0x` and hex and both are what
`windowAction` takes, so nothing on this API changes — but an id handed to
`xdotool` or `xprop` through `c.exec()` finds no window on a Wayland guest.

### Clipboard

The desktop's `CLIPBOARD` selection — what Ctrl-C writes and Ctrl-V pastes — read
and written from outside the guest. Linux only, and it needs nothing of the
*hardware*: no cold boot, no permission from a browser. What it does need is
`xclip` in the guest, which every image built since August 2026 carries — so in
practice this is the road that works on every computer, and where it is not, the
refusal says so. (The other road is RFB extended cut text over the desktop
socket, which is live and conditional; see
[Showing somebody the desktop](#showing-somebody-the-desktop).)

```ts
await c.setClipboard('https://mandala.computer');
await c.key(['ctrl', 'v']);                        // into whatever has focus

const onClipboard = await c.clipboard();           // '' is an empty clipboard
```

`setClipboard()` takes at most 64 KiB of UTF-8; `clipboard()` returns at most
128 KiB. They are different bounds on different channels, and the read is
**refused rather than truncated** past its own — half a password is not less of
an answer, it is a wrong one that looks completely normal. Empty text and a NUL
are refused here, before the request goes out.

The platform confirms the write by reading the selection back before it answers,
so `setClipboard()` returning means the desktop is *holding* the text rather
than that a command ran.

**Not every `ConflictError` here is worth retrying, and `err.reason` is how you
tell.** `contention` is the one that clears by itself — *the desktop did not
take the text* means something else claimed the selection in that instant, a
clipboard manager settling, usually — and `starting` clears too, more slowly:
the guest agent has not answered inside its boot window yet. `unavailable` does
not clear at all, because the computer is not running and `start()` is the fix
rather than another attempt. Desktop-session and X-server failures carry **no**
`reason`, deliberately: the platform cannot tell a guest still coming up from a
logged-out desktop or a crashed window manager, so it offers no retry advice
there. Branch on the word, never on the sentence, which is prose and is
rewritten.

`isTransient()` reads it, so it no longer says `true` to the stopped computer —
which is what it used to do, and what a blanket retry loop spun on until its
deadline. An unclassified refusal falls back to the old type answer, so bound a
loop that meets one.

A **400** is the other one to know, because it never clears: a computer built
from an image that predates `xclip` is refused permanently. Install `xclip` in
the guest — you have root there — or create a new computer.

The two differ on one thing worth knowing: `setClipboard()` **resumes a
suspended computer**, because putting text on a clipboard is the first half of
pasting it and that is somebody working on the machine. `clipboard()` does not —
what somebody copied is not worth waking a machine for — so reading a suspended
computer is a 409 rather than a start you did not ask for.

A read failure is an exception, not an empty string. That is the distinction the
`exec` recipe these replace could not make.

#### Why not `exec` and `xclip` yourself

Because `exec` runs a **login shell**: the desktop user's profile is sourced,
and anything it prints lands on the same stdout as your command's output, ahead
of it. That is wanted when you asked to run a command the way the user would,
and fatal when you are reading a value — an `echo` in the guest's `.profile`
corrupts the answer and a deliberate one forges it, and no framing you add
fixes that, since a profile that prints your frame owns everything after it.
The clipboard endpoints do not share that stream. The write is worse still: an
X selection belongs to a live process, so the holder has to outlive the exec,
the text has to travel quoted, and being granted a selection is asynchronous,
so the result has to be polled for — each poll a billable exec. `setClipboard()`
does all of it in one call.

### Running commands

```ts
const res = await c.exec('ls /home/user');
if (!res.ok) console.error(res.stderr);
if (res.truncated) { /* the guest agent capped output at 16 MiB */ }
```

A non-zero exit is returned, not thrown. The guest gets `timeoutS` to finish —
30 seconds unless you say otherwise — and a command that outlives it keeps
running in the guest with its output unreachable. By default the command runs
as `root` with no display; anything with a window needs the desktop session:

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

Linux only, and the platform is what says so. A desktop-session exec on a
Windows guest is refused before the computer is asked whether it is running,
with `reason: "unsupported"` — so `isTransient` reads it as settled and a retry
loop stops rather than starting the computer to ask again. There is no OS check
in the SDK: it knows only what the last payload said, and a computer whose `os`
never arrived would be refused for a command it could have run.

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

### Events

**A computer says what it is doing.** Waiting for something to happen is a
socket, not a screenshot every second that mostly reports that nothing has
changed:

```ts
await c.waitFor('computer.ready');                      // the desktop is up
const done = await c.waitFor('process.exited');         // a background command ended
console.log(done.pid, done.exitCode);
```

or the whole stream:

```ts
for await (const ev of c.events()) {
  if (ev.type === 'window.opened') console.log('opened', ev.window?.title);
  if (ev.type === 'process.exited' && ev.pid === job.pid) break;   // closes the socket
}
```

Windows opening, closing and taking focus; the clipboard changing hands; a
background command exiting; the desktop becoming ready; every power transition.
`ev.data` always holds the payload verbatim, and the fields worth reading are
promoted onto the event: `window`, `windowId`, `pid`, `exitCode`, `lost`,
`selection`, `watch`, `path`, `kind`, `dir`, `armed`, `lostReason`, `status`,
`previous`, `idleSeconds`, `oldestCursor`, `detail`.

**It keeps your place.** Every event carries an opaque cursor, and the position
after the last event you actually *consumed* is what a reconnect resumes from —
so a socket that drops mid-loop does not lose the `process.exited` you were
waiting for. Each reconnect re-reads the computer for a fresh `events_url`,
because a restart rotates that credential and a restart is one of the ordinary
reasons the socket dropped. `stream.cursor` is that position if you want to keep
it across a process restart; pass it back as `since`.

Where the host can no longer replay that far you get a `gap` event rather than
silence. It is not an error and it is not swallowed: it is the signal that what
you missed is unrecoverable, and to reconcile against `windows()` or
`execPoll()` instead of assuming nothing happened.

Reconnecting is on by default and is most of what `events()` is for. `backoffMs`
doubles up to `maxBackoffMs` between attempts, `maxRetries` gives up after that
many *consecutive* failures to reopen (`0`, the default, never does — one
connection that reaches its opening frame resets the count), and
`connectTimeoutMs` bounds the handshake. `maxQueued` is how many frames may sit
unread before the socket is closed and reopened from where you had got to —
nothing dropped, nothing sent twice — because a websocket cannot be paused and
something has to bound a consumer that is not keeping up. `reconnect: false`
ends the iteration when the socket does, for a caller running their own
supervision; `signal` ends it on demand, without throwing. The defaults are
exported as `EVENT_STREAM_DEFAULTS`; `waitFor` takes the same options plus a
`timeoutMs`, three minutes unless you say otherwise.

**`computer.ready` has a trap in it, and this SDK takes it out.** It fires once
per desktop *session*, so a machine that has been up for an hour will never send
it again — a raw socket waiting for it waits forever. The opening frame carries
the state instead, and a stream that joins an already-ready desktop yields a
`computer.ready` marked `synthesized: true` as its first event. That is what
makes `waitFor('computer.ready')` return at once on a computer somebody else
already brought up.

Only where it could not arrive as an event: a stream opened with `since` either
already had the readiness or is about to be handed it out of the backlog, so
nothing is made up there. A resume that *gapped* does get one, because the
backlog it would have been in is what the gap says is gone — **including a
second time**, if the stream gaps again. A desktop can be replaced inside a
running computer, and a gap is exactly where the event saying so went missing,
so one extra readiness per gap is the price of never suppressing a real one.

A *second* `computer.ready` is real news: restarting the display manager inside
a guest destroys the desktop and brings up a new one without the computer ever
leaving `running`. The new desktop's windows arrive as `window.opened` *before*
that second ready, so a client that empties its map when it arrives throws away
the openings it was just handed. Nothing on the wire marks where the
replacement begins — ask `windows()`, which asks the machine.

#### Watching a directory

**`file.changed` is the one event that never arrives unasked.** Nominate the
trees you want on the way in, and only those are reported:

```ts
const stream = c.events({ watch: '/home/user/project' });   // up to four
for await (const ev of stream) {
  if (ev.type !== 'file.changed') continue;
  if (ev.armed) continue;                     // this tree is live from here on
  if (ev.lostReason) continue;                // my picture of this tree is wrong
  console.log(ev.kind, ev.path);              // created | modified | deleted
}
```

Because it is a nomination rather than a filter, it is an option on the stream
and not a `type` to watch for: without one, no `file.changed` can reach the
socket at all. It is fixed for the life of the subscription and re-sent on every
reconnect — a socket that came back without it would be healthy and silent,
which is the one failure you cannot tell from a quiet directory.

**Match on what you were given, not on what you sent.** The host normalises a
nomination — a trailing slash and a `.` segment are cleaned away — and the
cleaned form is what every event carries in `ev.watch`. `stream.watching` is the
answer, one entry per tree — and `onConnect` is where to read it before the
first event, since it is the opening frame that carries it:

```ts
const stream = c.events({
  watch: '/home/user/project/',
  onConnect: (hello) => console.log(hello.watching),
});                                // [{ path: '/home/user/project', armed: false }]
```

**And `armed` is the half that is easy to get wrong.** A tree is *not* being
watched the moment the opening frame accepts it: the guest has to be asked, and
on a computer nobody has opened a terminal on the host installs the watcher
first — seconds, not milliseconds. inotify reports changes and not state, so
anything that happens in that window is never reported and never will be.
`armed: false` in `stream.watching` means wait for that tree's `file.changed`
carrying `armed: true`; `armed: true` there means live **now**, and no event is
coming to say so, because the guest answers a nomination once and somebody else
got there first. `stream.watching` is each tree's state rather than the opening
frame's claim about it: an `armed` moves an entry to live and an `unwatchable`
moves it back, while `flood` and `budget` leave it, because under those the tree
*is* watched and is merely being reported incompletely. `stream.hello.watching`
stays what the connection was told when it joined, the same way `hello.events`
stays the opening vocabulary and `stream.eventTypes` is the live one — read
`stream.watching` to decide what silence means.

Same split as `ready`: state in the opening frame, transitions on the stream.
An `armed` also comes again after anything that re-arms the watch
— a stop and a start, a guest reboot — and means what the first one did:
reporting starts *here*, so re-read the tree if the interruption mattered.

The other shape carrying no `path` is a loss, in `ev.lostReason`. `flood` is
transient — the tree changed faster than the cap allows, so re-read it and keep
listening; a build under a watched path costs one of these rather than thousands
of events. `budget` means the tree is bigger than the directory budget one watch
gets, so part of it is not watched at all: permanent, and the fix is a narrower
path. `unwatchable` is the only one that means the tree is not being watched —
it is not there yet, is not a directory, cannot be read, or is a *symlink*,
which is refused rather than followed because inotify pins whatever the link
resolved to. That one recovers on its own where it can: nominating the directory
a job is about to create is supported, and the watch starts by itself when it
appears, announced by an `armed` and by nothing else.

Renames are a `deleted` and a `created`, not a move. Writes are coalesced, so
what you get is the truth about a path when the window closed rather than a
transcript of every write. Nothing is announced about what is *already* in a
tree when you nominate it — those are not changes.

Nominate the narrowest tree you can. Four *distinct* trees per stream — counted
the way the platform counts them, after normalising, so `['/a/b', '/a/b/']` is
one — and a computer watches at most 32 across every stream open on it; a
nomination past that one is refused on the upgrade. The replay history is per
computer and shared with every other subscriber, so a broad watch spends the
history a client resuming with a cursor needs.

Nominations are checked before a socket is opened, because the platform's `400`
reaches a websocket client as the same empty close a rotated credential gives —
and with `reconnect` on, that is a stream that reopens forever and never says
why. Absolute paths, at most 256 bytes, no control characters, and not the root
however it is spelled: watching everything would spend the directory budget on
`/usr` before reaching anything you care about.

`file.changed` needs only the terminal channel, *not* the X bindings the window
watcher runs on — so it is advertised on Linux computers that emit no
`window.*` at all. The guest half is not one capability; read
`stream.eventTypes` rather than assuming the two travel together.

Three frames are about the *stream* rather than about the computer, and they
arrive as events too, because a client cannot ignore what it was never handed:
`gap`, `closed` (this host ending the socket deliberately, with a sentence
saying why) and `capabilities` (the vocabulary being revised under an open
socket). **Ignore a `type` you do not recognise** — the vocabulary grows.

A `closed` is reopened like any other drop rather than being sorted by its
wording, and the reconnect's own `GET computers/:id` is what sorts it: a
computer that moved to another host hands back that host's URL and the stream
carries on, and one that is gone answers 404 and ends it.

`ev.source` is worth reading. `daemon` means the platform observed it; `guest`
means the machine reported it about itself — every `window.*`,
`clipboard.changed`, `file.changed` and `computer.ready` — and anyone with root
inside that guest can make those say anything.

`waitFor` refuses rather than waiting out three cases. An event type *this*
computer cannot emit: a Windows guest, or an image built without the X bindings
the watcher needs, produces no `window.*` and no `computer.ready`, the opening
frame says so, and `stream.eventTypes` is that list. A `waitFor('file.changed')`
with no `watch` nominated, which the advertised list alone would call reachable
and which nothing would ever satisfy. And a computer that is suspended or
stopped — the stream is the one part of this API that does **not** resume a
suspended computer for you.

That last one is a refusal on the *upgrade*, and no refusal on the upgrade
reaches a websocket client as a status: a 409, a 401 and a TCP reset are the
same 1006 close, so the SDK reads the computer afterwards and says which it was.
A nomination the host will not honour arrives the same silent way, which is why
`watch` is checked before a socket is opened.

`waitFor('file.changed')` ends on a **change**, and not on the arming marker or
a loss. Three shapes share that type and only one of them is a change, so a wait
matched on the name alone came back with the arming on a fresh nomination and
with a real change on a tree somebody else had already armed — the same call
meaning two things depending on who got there first. The markers still arrive on
`events()`; they simply do not answer that question. A timeout says which
nominated tree never armed, because a watch that did not arm is silent in
exactly the way a tree where nothing happened is.

Windows guests have no event stream at all: there is nowhere in the guest to run
the watcher the guest half needs.

### Webhooks

**The other transport for events.** The socket above is for a caller attached
to a computer and waiting. A webhook is for one that is not — CI, a queue
worker, anything that wants to be *woken* rather than to wait. The platform
POSTs one request per event to a URL you name, and its body is the event object
exactly as the socket would frame it, byte for byte, with nothing wrapped around
it.

```ts
const hook = await client.webhooks.create({
  url: 'https://ci.example.com/mandala',
  events: ['process.exited', 'computer.ready'],   // omit for every type
  computers: ['vm-3f9a1c2b7d4e'],                 // omit for every computer
});
await vault.put('mandala-webhook-secret', hook.secret);   // shown ONCE
```

The `secret` on that answer is the only time you will see it. It is not on a
`get` or a `list`, and `rotate()` is the only way to get another — which mints a
new one and keeps honouring the old for 24 hours, so a receiver can switch over
at leisure.

Verifying a delivery is one call. Hand it the secret, the request headers in
whatever shape your framework holds them, and the **raw body** — the bytes as
they arrived, never the parsed object:

```ts
import { verify } from 'mandala-computer';

// Express: express.raw() so req.body is the bytes, not a parsed object.
app.post('/mandala', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!(await verify(process.env.MANDALA_WEBHOOK_SECRET!, req.headers, req.body))) {
    return res.status(401).end();
  }
  res.status(200).end();                        // acknowledge first, then work
  const event = JSON.parse(req.body.toString('utf8'));
  if (event.type === 'process.exited') queue.push(event.computer, event.data);
});

// fetch-shaped runtimes (Workers, Deno, Bun, Next route handlers):
export async function POST(request: Request) {
  const raw = await request.text();
  if (!(await verify(secret, request.headers, raw))) return new Response(null, { status: 401 });
  return new Response(null, { status: 200 });
}
```

The scheme is [Standard Webhooks](https://www.standardwebhooks.com) v1,
verbatim — HMAC-SHA256 over `webhook-id.webhook-timestamp.body` — so any of
that specification's libraries verifies a Mandala delivery too; this one holds
the platform's own test vector and needs no dependency. It is async because it
uses WebCrypto, which is what lets it run on the edge, where webhook receivers
tend to live.

Three things the verifier does for you, and one it cannot. A delivery whose
`webhook-timestamp` is more than five minutes from your clock is refused before
the signature is checked. A header carrying two signatures — every delivery
inside the rotation window — passes under either secret. And a secret pasted
without its `whsec_` prefix throws rather than returning `false` forever, since
that is a configuration error and not a bad delivery. What it cannot do is
remember: **keep every `webhook-id` you accept for at least five minutes and
refuse a repeat.** A retry carries the same id and a fresh signature, and
verifies. The timestamp bounds how long a captured request can be replayed; the
id is what stops a legitimate retry being processed twice; together they close
every replay with a memory that is finite by construction.

**Acknowledge with a 2xx before doing the work.** An attempt is cut at ten
seconds and counted as a failure. Anything else — a non-2xx, a timeout, a
redirect (never followed) — is retried eight times over about fourteen hours,
then the delivery is `exhausted` and visible in `deliveries()`, never dropped
silently. No ordering is promised: order by `seq` per computer if you care. An
endpoint that runs out of attempts and has accepted nothing for a day is
disabled with `disabledReason: 'failing'`; `update(id, { enabled: true })`
starts it fresh.

```ts
const d = await client.webhooks.test(hook.id);            // one synthetic delivery, 202
const rows = await client.webhooks.deliveries(hook.id);   // newest hundred, newest first
for (const row of rows) {
  if (row.state === 'exhausted') console.warn(row.id, row.eventType, row.lastError);
}
```

`cursor` on every delivery — and on the event body itself — is the bridge back
to the stream: a job woken by `process.exited` that wants everything since can
open the socket with `since:` that cursor. `file.changed` never arrives here; it
exists only because a socket nominated a tree, and a subscription has nothing to
nominate against. Every paid plan allows ten subscriptions; the eleventh is a
`ConflictError` naming the cap. Deleting one drops its pending deliveries with
it.

### Files

```ts
await c.writeFile('/home/user/.env', 'TOKEN=secret');   // never echoed through a shell
const bytes = await c.readFile('/home/user/out.bin');
const text = await c.readTextFile('/home/user/out.txt');
```

Paths are absolute, inside the guest. There is no shell and no working directory
behind a transfer, so a relative path is refused before the request is made.
Works while the computer is running or suspended.

`writeFile` takes a string, bytes, or a `ReadableStream` — so a large local
file goes up as the request body rather than living as one Buffer first; pass
`contentLength` when you know it — and answers with how many bytes the platform
says it wrote, or `undefined` if it did not say. Every transfer takes a
`timeoutMs` for the one request, since a big file can legitimately outlive the
default 60 seconds; `0` disables the deadline for that transfer.

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
a loop bound. `system` carries standing instructions into the run and `model`
overrides the one the platform would pick. The computer must already be
running.

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

`agent()` is itself the stream, read to its `done`. `agentOnce()` is the same
run as a single non-streaming request — simpler, and worse for anything long,
since nothing is reported until the whole run is over and a proxy between you
and the platform may well close a request held open for minutes. There is also
an OpenAI-shaped door onto the same loop, `POST /chat/completions`, which this
SDK deliberately does not wrap: a caller who wants it already has an OpenAI
client and points its `baseURL` here.

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

### Growing past the host

A resize is refused when the size asks for more RAM than the host the computer
happens to be on can run. That refusal is an offer rather than an ending: another
host in the same region may be able to run it, and the computer can be moved
there.

```ts
try {
  await c.update({ ramMb: 32768 });
} catch (err) {
  if (err instanceof MoveRequiredError && err.movePossible) {
    const move = await c.relocate({ ramMb: 32768 });  // 202 — the copy runs behind it
    const outcome = await c.waitForMove(move);        // anchored to THAT move
    if (outcome.state !== 'done') console.log(outcome.state, outcome.detail);
  } else throw err;
}
```

**It is a separate call on purpose.** `relocate()` copies the computer's disk to
different hardware. A resize that did that without being asked is exactly what
neither this SDK nor the platform will do, so there is no option on `update()`
that quietly relocates a machine.

**The computer must be stopped**, and suspended is not stopped here — unlike a
resize, which accepts it. A saved desktop only loads on the host that wrote it,
so it cannot travel: resume and stop the computer, or discard the session, first.

**`waitForMove()` takes the move `relocate()` returned**, and that argument is
required. A `Move` carries no id and `GET /moves` keeps every move that finished
in the last day beside the one running now, so the record from the 202 — or an
RFC3339 `startedAt` a restarted process persisted — is the only thing that says
which move a wait is watching. A listing with no row at or after that instant is
one that has not caught up yet, so the wait goes on polling and its deadline,
rather than yesterday's row, is what ends it. The row NEAREST that instant is
the move; a minute of slack sits under it, because the 202 and the listing are
two renderings of the same platform clock and one of them printing whole seconds
must not put a move's own row below its own floor. Nearest and not earliest, so
that the minute admits this move's own rounded-down row without also handing the
wait to a move that really did start within it — one that finished seconds
earlier would otherwise answer straight away, on a disk still crossing between
hosts.

A row that was listed and then is not, on two consecutive polls of a listing
this client could read whole, ends the wait with a `MandalaError`: a move's row
leaves that listing when its computer is deleted, and when a finished move is
dismissed. Two polls rather than one because the listing is eventually
consistent, and a replica running behind can drop a row that is still there.

**`waitForMove()` does not throw for a move that ended badly**, because the ways
it can end are not one thing:

| `state` | what happened |
|---|---|
| `done` | on the new host, at the new size |
| `moved` | on the new host, at its **old** size — the move landed and the resize did not. An ordinary `update()` finishes it where it now is |
| `failed` | nothing happened; the computer is where it was, untouched |
| `lost` | we stopped watching. It may well have completed — read the computer |

`moved` is the one to read carefully: the computer really has changed hardware,
so treating it as "the move failed" sends you looking for a machine that is no
longer where it was.

One move runs per account at a time. `client.moves.list()` is the account-wide
view — where a move you did not start is found, and how a "another computer on
this account is being moved right now" refusal gets a name.

```ts
for (const m of await client.moves.list()) {
  console.log(m.computerId, m.state, m.live ? 'running' : m.finishedAt);
}
```

The target is ours to choose and is never in the request: you are told a host in
this region, not which one.

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
| `vnc.url` / `vnc.token` | full control — keyboard and pointer, and the clipboard where `vnc.clipboard` says the bridge was provisioned; see below. Root-equivalent on that machine. |
| `vnc.viewUrl` / `vnc.viewToken` | watch only. The platform *drops input* on this socket, so a patched client still cannot type — and takes the clipboard capability out of the connection as it is negotiated, so what the person at the desktop copies does not come back over it either. |
| `vnc.embedUrl` | the hosted viewer, watch-only, for an `<iframe>`. The credential is in the URL fragment, which browsers never send to a server — so it stays out of access logs and out of `Referer`. |
| `vnc.terminalUrl` | an interactive PTY in the guest, on the *controlling* credential. `''` on Windows; present but refused on a computer that has not been cold-booted since terminals shipped. |
| `vnc.eventsUrl` | the event stream — what this computer *does*, pushed rather than polled for, on the *controlling* credential. `''` on Windows and for a viewer, because a window title is content. See [Events](#events); `events()` reads it for you. |

Neither is your API key, which is every computer on the account, forever. Both
end when the computer restarts.

**`vnc.clipboard` says whether the clipboard crosses this socket**, so it is
read rather than worked out. It is true where the platform provisioned both
halves it controls: the vdagent channel QEMU was given at the computer's last
cold boot, and an original image verified to ship `spice-vdagent`. It is always
false on the watch-only credential, where the daemon takes the capability out of
the connection as it is negotiated — there it is about the credential rather
than about the computer.

A **provisioning** signal, not a live check. Somebody with root in the guest can
install, remove, disable or stop the agent afterwards and this does not move, so
treat it as stale after anything that modified the guest.

`true` means the transport is open, which is not the same as a copy or a paste
succeeding. The first paste of a session is often dropped, because the guest
*pulls* the text and vdagent may not own the selection yet, and a browser will
not hand over the guest's clipboard without focus and permission. A client also
has to negotiate the extended-clipboard pseudo-encoding — that is QEMU's only
door to the guest's clipboard, so an RFB client of your own that does not offer
it receives nothing however the guest is configured.

`false` means a paste reaches QEMU and stops, silently, and what to do about it
depends on which half is missing. The **channel** is hardware and comes from a
*cold* start: stop the computer and start it again, or start one that is already
stopped. Restarting a *running* computer does not do it — that resets the guest
rather than rebuilding the machine QEMU was given — and a computer back from a
suspend or a snapshot keeps whatever the capture had, so it can lose the channel
and need a stop and a start to get it back. The **agent** comes from the image
the computer was created from, which nothing moves it off: installing the
package yourself can make the bridge work but does not change this field, an
unverified image reads false even where the agent is present, and Windows guests
never have it whatever the hardware says. Keep the route below whichever you
get.

[`clipboard()` and `setClipboard()`](#clipboard) are the route to build on — the
reliable one, not merely the fallback — because they need nothing of the
*hardware*: no cold boot, no permission from a browser. They ask one thing of
the image (`xclip`, in every image built since August 2026) and say so in the
answer when it is missing, which is one condition stated instead of two inferred. Where
the socket *does* carry the clipboard the two do not fight over it: those
methods write the same X `CLIPBOARD` selection the agent then offers onward.

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

For the *desktop* rather than the guest agent, `await c.waitFor('computer.ready')`
is the machine telling you — see [Events](#events). It costs one socket instead
of a screenshot every second, and it returns at once on a desktop that is
already up.

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

`c.schedule()` reads the daily schedule back. `setSchedule({ enabled: false })`
keeps the chosen time so toggling it on again restores it; `c.clearSchedule()`
returns the computer to never having had one.

`client.snapshots.list()` is every snapshot on the account;
`{ computerId }` narrows it to one computer's, and `{ includeUnfinished: true }`
adds deletions that began and did not finish — nothing can be restored or
cloned from one, but they still hold storage and are still billed.

A schedule says when they are taken and not how long they survive. That is your
plan's, account-wide, and read-only:

```ts
const r = await client.snapshots.retention();
console.log(`keeps ${r.daily} daily, ${r.weekly} weekly, ${r.monthly} monthly`);
```

What survives is the newest automatic snapshot in each of the last `daily` days
**that have one**, and likewise for ISO weeks and calendar months — periods that
contain a capture, not periods on the calendar, so a computer switched off for a
month still has the history it had. Boundaries are cut in UTC whatever timezone
the schedule runs in. A zero turns that tier off. Only snapshots with `auto` set
are ever aged out: one you took by hand is yours until you delete it, which is
also how you keep something past the window.

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

### Usage

What the account has spent, in the same figures the dashboard shows and the
invoice bills on. This is the read to build a spend check around: a loop that
launches computers is the caller that can run up a bill without noticing.

```ts
const u = await client.usage.read();

console.log(`${u.usage.vcpuHours} vCPU-hours since ${u.from}`);
for (const c of u.usage.computers) {
  console.log(`  ${c.name || c.id}${c.gone ? ' (deleted)' : ''}  ${c.runHours}h`);
}
```

With no arguments the window is the account's **current billing period**, which
is what makes the numbers comparable with an invoice. Name a window for one that
has closed — the billing period is always the current one, and by the time an
invoice arrives the period it covers is not:

```ts
await client.usage.read({
  from: new Date(Date.UTC(2026, 6, 1)),
  to: new Date(Date.UTC(2026, 7, 1)),
});
```

One window at a time, and at most 62 days of it: every hypervisor replays its
ledger a day at a time to answer, so a longer span is refused rather than quietly
shortened. Records reach back 399 days, so an older period is read by naming both
bounds rather than by widening one. And send `from` **with** `to` when the period
has closed — `to` on its own is measured from the current period's start, which
is after it.

Pass `Date`s rather than strings where you can. A string is accepted, but it must
carry a time zone — `2026-08-01T00:00:00Z`, not `2026-08-01T00:00:00` — and a
zoneless one is refused here rather than sent. The platform refuses it too, and
for the reason that matters: the zone it would otherwise have to assume is the
server's, and a window silently shifted by a few hours is the worst possible
failure on the one call whose output somebody checks against a bill.

**Read `degraded` and `unmetered` before you use the numbers.** Every figure is a
sum across the hypervisors your computers are on, so a host that did not
contribute does not leave a hole you could notice — it leaves a total that is
quietly too small.

```ts
if (u.degraded || u.unmetered) {
  // Short, and saying so. `degraded` clears when the host comes back;
  // `unmetered` is a host running a daemon older than the meter and never does.
  console.warn('these totals may be low — do not reconcile them against an invoice');
}
```

This is why the call answers rather than throwing, unlike a partial listing
below: the caveat travels in the same object, so it cannot be missed the way a
missing row can — and one of the two shortfalls would never clear by retrying.

Two more fields worth knowing:

- `reportedThrough` — the last UTC day whose usage has settled for billing, as a
  contiguous prefix. Not a caveat on the totals, which are live and true through
  `to`; it is the boundary to check before comparing anything with an invoice.
  `undefined` while none of the window has settled.
- `breakdown` — false when the API key is scoped to a workspace. Usage is metered
  and billed per **account**, so `usage.computers` would name computers outside
  such a key's scope and the platform withholds it; the account-wide totals still
  arrive. The array is empty either way, and this flag is what tells "no
  computers ran" from "this key may not see which did".

### Partial listings

`list()` on computers, snapshots and builds fans out across every hypervisor
holding something of yours. One that cannot be reached makes the answer
incomplete, and the platform **fails closed** about it — you get
`UnavailableError`, not a short list. A short list is not a smaller truth: it
reads exactly like the missing rows were deleted, and the obvious next thing a
script does with a computer that has disappeared is tidy up after it.

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

Builds are the third of these and the one where the status is always all you
get. The platform keeps no record of which hypervisor ran which build, so a
partial build listing appends nothing: the missing ones are simply not there,
and `incomplete` is `0` rather than a count. Use `builds.listWithStatus()`
rather than `builds.list()` whenever you pass `allowPartial`.

Computers and snapshots do append an `{ id, unreachable: true }` stub for each
row they could not reach, so a partial answer is visible in the rows themselves
— but only for a key that spans the account. A key scoped to one workspace gets
no stubs from any of the three, because naming the missing ids means reading
them out of a placement cache with no workspace column, and that would hand a
confined credential ids from the workspaces it is confined away from. On such a
key, read the status on every listing.

### Errors

```ts
import {
  MandalaError,        // base of everything this SDK throws
  APIError,            //   any unsuccessful response
  AuthenticationError, //     401 — key missing, malformed, revoked
  PlanLimitError,      //     402 — your plan will not allow this. Not a retry.
  PermissionDeniedError,//    403 — the key's role is too low
  NotFoundError,       //     404 — no such computer, snapshot, or route
  ConflictError,       //     409 — right request, wrong moment. `err.reason` says
                       //           whether retrying it helps
  MoveRequiredError,   //       409 — …except this one: the size needs a new host
  TooLargeError,       //     413 — more file than one request moves
  RangeNotSatisfiableError,// 416 — that range names no byte the file has
  RateLimitError,      //     429 — retry after retryAfterMs when present
  UnavailableError,    //     503 — a listing would have been short
  GatewayTimeoutError, //     504/524 — a proxy gave up; the work carries on
  OriginResponseError, //     520 — it answered, unreadably; work may have happened
  OriginUnreachableError,//   521-523 — a proxy could not reach it. NOT in
                       //     `isTransient`: the outcome is unknown, not "nothing happened"
  OriginTLSError,      //     525/526 — a certificate they cannot agree on
  ConnectionError,     //   the request never left: DNS, a refused socket, a
                       //     failed handshake. Retryable, `create` included.
  ConnectionInterruptedError,// a subclass, and the opposite answer: the request
                       //     WAS on the wire and the reply was lost. NOT in
                       //     `isTransient` — replaying a create here makes two.
  TimeoutError,        //   a wait helper gave up
  ValidationError,     // a TypeError: your argument, refused before it was sent
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

**Read `isTransient` rather than the comments above when it matters.** Three
entries in that list are things a caller must not replay blind, and two of them
look retryable from their names: `OriginUnreachableError` is a proxy failing to
reach the platform *after* the request left, and `ConnectionInterruptedError` is
a `ConnectionError` whose subclass carries the opposite verdict from its parent.
The predicate knows; a table read at a glance does not.

`ValidationError` is the odd one out and is deliberately **not** a
`MandalaError`: it is a `TypeError`, because a relative guest path or half a
coordinate is a mistake in your own code rather than something the platform
said. Nothing was sent when you get one. Catching `TypeError` still works and
always did — the class is exported so the narrower catch can be written too.

`ConflictError` is the one that usually clears itself: a guest still booting, a
disk still being copied, another operation holding the guest agent. The
platform's own message survives onto `err.message` — these are written to be
acted on.

`err.reason` is what says which kind you have, where the platform sent a word
for it, and it is the part a program is allowed to depend on — `err.message` is
prose and is rewritten. Four words: `contention` and `starting` clear on their
own, `unavailable` means the computer is not running and only starting it helps,
`unsupported` means this computer cannot do it at all. `isTransient` reads it
before it looks at the type, which is how a clipboard call against a stopped
computer stopped being told to retry.

**Absent means no classification was given**, and so does a word you do not
recognise — not every refusal has one, and the platform reserves the right to
add a fifth. Treat both as "no answer" and fall back to whatever you did before,
which is exactly what `isTransient` does.

`MoveRequiredError` is the exception, and it is a subclass so that code matching
on the family keeps working. It means the size you asked for is more RAM than the
host this computer is on can run, and it does **not** clear — the host will not
grow, so the same request answers the same way for as long as the computer is
where it is. `isTransient` says false for it. `movePossible` is the branch: true
means somewhere else in the region can run that size and `relocate()` takes the
offer up, false means nowhere can and the size is the thing to change. See
**Growing past the host**.

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
Neither is in `isTransient`, and nor are 502, 504 or 521-523. That predicate is
exported, so its caller may be wrapping a `create` — and every one of those
statuses means the outcome is unknown, which is how one computer becomes two.
What it names is the four classes that both clear on their own and are safe to
replay blind: `ConflictError`, `RateLimitError`, `UnavailableError`,
`ConnectionError`.

The wait helpers do not ask it. They replay idempotent reads under a deadline
you set, so they ride out every status above — including the ones here — and
give up only on a failure that describes the *request* rather than the moment.
Two audiences, two predicates; the same three classes and the same four
answer identically in the Python SDK and the MCP server.

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

The guest's PTY is sized from the first of stdin, stdout and stderr that is a
terminal — stdin first, since that is the one raw mode is set from — and the
size travels on the upgrade URL, so the login prompt and any replayed scrollback
are drawn at the real width rather than at the broker's 80x24 default. Resizing
the window re-sends it. That holds for `mandala ssh my-computer | tee out.log`
too: a piped stdout is still a session in a window somebody is watching.

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
and `scripts/check-surface.mjs` diffs the mirror against the platform's own
table whenever the platform repository is checked out beside this one. A mirror
nobody compares is just a comment: that is exactly how three routes reached the
platform without the Python SDK's surface test noticing, because "every call
lands on an allowlisted route" stays true when the allowlist is the stale one.

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
websocket library would have been this package's only runtime dependency,
carried by every user of the library for the sake of one CLI command and the
event stream. Both take a factory (`events({ webSocket })`) for anyone who wants
a different implementation.

**An event is one flat shape, not a discriminated union.** A union needs a
member for "a type this build has never heard of", and in TypeScript that
member's discriminant can only be `string` — which puts it back inside every
narrowing, so `ev.type === 'process.exited'` stops implying `ev.pid`. It would
buy exactness on the types named today and lose it on every type added after,
which is the wrong way round for a stream whose reference says the vocabulary
grows.

**A refused websocket says nothing, so the SDK asks.** Measured on Node 22 and
26: a 409, a 401 and a TCP reset all arrive as an `error` carrying a `TypeError`
with an empty message and a `close` with code 1006. The status line and body are
not exposed anywhere on the `WebSocket` API. So a failed upgrade is followed by
one `GET computers/:id`, and the state it answers with is what the message says
— inference, named as such, and better than "the connection failed" about a
machine somebody suspended.

**Only `/api/v1`.** Never the hypervisor daemon's own routes. Its ops endpoints
(`/host`, `/fleet`, `/audit`) are not owner-scoped inside the daemon, because
nothing user-facing was ever meant to reach them. The retention WRITES are kept
out for a different reason worth not confusing with that one: `PUT /retention`
is owner-scoped — it sets the calling tenant's own policy — but the plan owns
retention, so a tenant setting its own would be granting itself history it has
not paid for. `test/surface.test.ts` asserts the mirror stays clear of the ops
endpoints and that `retention` is reached with `GET` and nothing else, so
widening either is a deliberate act rather than a quiet one.

## Relationship to the other clients

| | |
|---|---|
| [Python SDK](https://github.com/mandalacomputer/python-sdk) | `pip install mandala-computer` — sync and async |
| [MCP server](https://github.com/mandalacomputer/mcp) | `mandala-computer-mcp`, for Claude Code / Claude Desktop |

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

Two scripts talk to the real platform instead of a mock, both opt-in and both
skipped without a key:

```sh
MANDALA_API_KEY=com_... npm run smoke:live     # read-only: the template store
MANDALA_API_KEY=com_... npm run smoke:events   # CREATES a computer, ~15s, deletes it
```

They exist because a fixture written from the same reading of the reference that
produced the code asserts a wrong reading rather than catching it. `smoke:events`
found `windows()` broken against the live platform on its first run.

## License

MIT
