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
option for the key. `timeoutMs` on the client is the per-request budget — 60
seconds unless a call knows it needs longer, `0` to disable — and `fetch` takes
an implementation of your own if you have proxies or certificates to configure.
The `timeoutMs` a *wait* takes is a different number and is documented with each:
it bounds the whole loop rather than one request, and can be far longer, because
what those wait for outlives any single request. Each method takes
a `signal` among its options, so any one request can be cancelled.

## Use

```ts
import { Client } from 'mandala-computer';

const client = new Client();                  // reads MANDALA_API_KEY

const c = await client.computers.launch({ template: 'base' });
try {
  await c.open('https://example.com');        // on the screen, not as root
  const png = await c.screenshot();
  await c.click(640, 400);
  await c.type('hello');
} finally {
  await c.delete();
}
```

`launch()` creates once, waits for the disk, starts the computer if needed, and
returns when its guest agent answers. Guest readiness does not guarantee that
the visible desktop has finished logging in. It accepts every `create()` option;
`start: false` is sent unchanged to create, then launch starts the computer after
its disk is ready. An already admitted start is waited on, and failed starts are
reported without retrying them.

Pass `{ timeoutMs: 600_000, signal }` as the second argument for a larger build or
cancellation. The default readiness budget is 180,000 milliseconds, beginning
after create returns. Disk, running and guest waits share the remaining budget,
including elapsed start work. Create and start retain their usual transport
deadlines, so this is not a total wall-clock limit on launch. `pollMs` defaults
to 3,000 for all stages.

The returned computer is persistent. A failed or cancelled launch can leave a
computer behind; SDK errors after creation include its id and keep their type
(including `TimeoutError`). Cancellation preserves the caller's original reason.
No failure automatically deletes the computer. The `finally` above cleans up
after a successful return; use the id in a readiness error to inspect or delete
a computer whose launch failed.

For cleanup tied to a callback, use `ephemeral()`:

```ts
await client.computers.ephemeral({ template: 'base' }, async (c) => {
  await c.waitForGuest();
  await c.open('https://example.com');
});                                           // destroyed here, even if the block threw
```

`create()` returns as soon as provisioning responds and never deletes anything.
Use it when you want to manage each readiness stage yourself.

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

If create returns a `ConflictError` whose body has
`code: "template_image_preparing"`, inspect `body.preparation.state` and
`body.preparation.error` before deciding to continue. The server's valid
`Retry-After` header is exposed as `err.retryAfterMs`; it is undefined when
absent or malformed. After that delay, repeat the original create body,
including the same nonempty `template`, and add `body.template_transfer` as
`templateTransfer`. Preserve the token exactly; it must be a nonblank string
and cannot be combined with `size`.

The token preserves the selected image and is **not an idempotency key**. Stop
after a successful create, and do not automatically replay after an ambiguous
response. `isTransient` returns false for this preparation conflict because
continuing requires the token, and the SDK never retries the create for you.

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

Unreachable, deleted and lost records can have no screen to report. Check
`c.resolution` directly before reading `c.screen`; when it is empty, `c.screen`
throws `ValidationError`:

```ts
if (c.resolution) {
  const { width, height } = c.screen;
  console.log(width, height);
}
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
const liveThumb = await c.screenshot(320, { fresh: true });   // both, and honoured
```

**Pass `fresh` whenever the image is feeding a decision.** A bare screenshot may
be served from a cache up to 1.5 seconds old — which is what makes ten watchers
of one desktop cost a single screendump, and what makes a drive loop read the
screen as it was *before* its own last click. A model handed that frame concludes
the click missed and clicks again, and the second click lands on whatever the
first one revealed. A thumbnail can have the cached frame; a decision cannot.

`fresh` composes with a width. `screenshot(320, { fresh: true })` is a downscaled
JPEG built from a capture taken after the request arrived — the cheap way to watch
a desktop that is actually moving. Earlier versions of this SDK refused that call
on the grounds that a width made the flag a no-op; it is honoured now, so it is
sent. Omit `fresh`, or pass `false`, to ask for the last frame already held.

A suspended computer serves only that cached frame. Asking a suspended computer
for a fresh capture is refused — **409**, telling you to start it first — with or
without a width, so a poller that suspends its own machine should drop `fresh`
rather than treat the 409 as the computer having vanished.

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
if (!res.ok) console.error(res.stderrText);
if (res.truncated) { /* the guest agent capped output at 16 MiB */ }
```

`stdout` and `stderr` are `Uint8Array` — the bytes the command wrote — and
`stdoutText` and `stderrText` are those bytes decoded as UTF-8 for the ordinary
case of reading a line back. The platform sends both streams base64-encoded, and
this SDK hands you the bytes rather than a string, because a string is where the
output used to be quietly damaged: JSON strings are UTF-8 by definition, so a
command that printed a tarball, a PNG or a latin-1 build log came back with every
invalid byte replaced by `U+FFFD`, with a 200 and no flag saying so. The text
accessors do replace — a build log with one stray byte in it is still a log — so
reach for the bytes when the exact ones matter:

```ts
const png = await c.exec('cat /tmp/shot.png');
await writeFile('shot.png', png.stdout);           // bytes, unaltered
console.log(png.stderrText);                       // text, when text is meant
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

Foreground `timeoutS` must be an integer from **1 through 600 seconds**; the
SDK rejects larger or fractional values before sending the command. Use
`execBackground` for longer commands.

**Hosted `exec` requests can still time out after about two minutes.**
The HTTP budget is derived from it and the platform stretches its own deadline
to match, but a proxy in front of the platform abandons a request that has
produced no response for roughly that long and answers 524, which arrives as
`GatewayTimeoutError`. Measured against `app.mandala.computer`:

| command | `timeoutS` | result | wall clock |
|---|---|---|---|
| `sleep 110` | 230 | ok | 110.6s |
| `sleep 130` | 300 | `GatewayTimeoutError` | 125.2s |

The server's 600-second maximum does not extend this hosted proxy deadline.
The command also survives the request that abandoned it, so the
call after one of these often raises `ConflictError` — the guest agent still
busy with it, which is the first failure continuing rather than a second one.

So `execBackground` is not merely the tidier option past a few seconds; past two
minutes it is the only one that works. Strictly better than backgrounding with
`&`, which throws away the exit code and the output:

```ts
const job = await c.execBackground('apt-get install -y build-essential');

for (;;) {
  const s = await c.execPoll(job.pid);
  process.stdout.write(s.stdout);             // only the NEW bytes, as bytes
  process.stderr.write(s.stderr);
  if (!s.running && !s.more) break;
  if (!s.more) await new Promise((r) => setTimeout(r, 1000));
}

await c.execKill(job.pid);                    // if you change your mind
```

A command can stop while several chunks of output remain. Keep polling while
`more` is true, and stop only once it is no longer running and its output is drained.

The output is a **cursor, not a buffer**: each poll gives you only what has been
printed since the last one, so two readers on one pid split the output between
them rather than each seeing all of it.

And it is cut at 1 MiB on a *byte* offset, so a chunk can begin or end part-way
through a multi-byte character. Write the bytes to a stream as above, or join
them and decode once at the end; `s.stdoutText` decodes each chunk on its own,
which is what you want for a line of output and lossy across a cut.

### Independent execution reads

Newer platforms supply `job.executionId` on an accepted background command.
Older replies may omit it; the SDK never fabricates an ID or falls back to a PID
when you request a stable read. PID polling and killing above keep their existing
shared, consuming behavior and can address a newer command after PID reuse.

```ts
if (job.executionId) {
  const signal = new AbortController().signal;
  const observed = await c.execution(job.executionId, { signal });
  console.log(observed.status);
  // Each reader owns two independent byte positions; both are always explicit.
  const first = await c.executionOutput(job.executionId, {
    stdoutOffset: 0, stderrOffset: 0, limit: 65536, signal,
  });
  const next = await c.executionOutput(job.executionId, {
    stdoutOffset: first.stdoutOffset,
    stderrOffset: first.stderrOffset,
    limit: 65536, signal,
  });
  for (const chunk of [first, next]) {
    process.stdout.write(chunk.stdout); // Uint8Array, including NUL or partial UTF-8
    process.stderr.write(chunk.stderr);
  }
  // Another reader can still read from zero, independently of these calls or execPoll.
}
```

`execution()` reports the last observed `running`, `exited`, or `lost` state.
Only `exited` includes `endedAt` and a signed `exitCode`; `running` does not prove
that the computer is awake, and `lost` establishes no success or failure.
`executionOutput()` returns separate `stdoutMore` and `stderrMore` flags. False
means EOF at this instant, not final completion. Decode text with a streaming
`TextDecoder` across chunks to preserve split UTF-8. The separate `diagnostic`
bytes repeat in full on every read, may be truncated (`diagnosticTruncated`), and
never advance either stream offset.

These methods perform one request by default; opt-in safe GET retries reuse the
same offsets. There is no automatic execution, resume, wait, output capture, or
fallback. Output reads perform guest I/O and are unsuitable for passive history
views. The files are mutable guest content, not retained
artifacts. Handles disappear on platform/computer state loss, replacement or
cleanup; observed exits expire after ten minutes. Unavailable reads throw the
normal API error instead of returning an empty successful result.

### Retained results and nominated artifacts

Retained versions are explicit, immutable snapshots with expiry. Background capture
reads the guest's volatile output once; later metadata and byte reads use retained
storage and do not resume the computer or poll a PID. Each explicit capture creates
a new version, even for the same execution.

```ts
if (job.executionId) {
  const captured = await c.retainExecutionOutput(job.executionId, {
    maxBytesPerStream: 1024 * 1024, retentionSeconds: 86400, signal,
  });
  const metadata = await c.result(captured.resultId, { signal });
  const page = await c.resultOutput(metadata.resultId, {
    stream: 'stdout', offset: 0, limit: 65536, signal,
  });
  // page.bytes is authoritative, including invalid UTF-8 and binary data.
  // The next independent read can use page.nextOffset. There is no shared cursor.
  await c.deleteResult(metadata.resultId, { signal });
}

const finished = await c.exec('make test', { retainOutput: true, signal });
if (finished.resultId) {
  const retained = await c.result(finished.resultId, { signal });
  console.log(retained.kind); // synchronous-output
}
```

`retainOutput` is synchronous exec only: absent or `false` keeps the ordinary
request; `true` or `{ maxBytesPerStream, retentionSeconds }` requests retention.
Older servers and unconfirmed optional capture leave `resultId` absent. Missing or
malformed optional retention metadata does not invalidate the executed command.
No helper retries a capture or replays a command after an uncertain response.

`RetainedResult` distinguishes `background-output` from `synchronous-output`.
Background observations can still be running. Page EOF describes the retained
prefix, and `ready` describes stored bytes; neither means the task succeeded or
that all original output was retained. Synchronous prefixes report
`sourceResponseBytes` and `upstreamTruncated` separately from the retained
`endReason`. Their `diagnostic` is null; requesting that stream preserves the
server's 409 rather than fabricating empty output. Background diagnostics are
separate wrapper bytes and are independently paged like stdout and stderr.
Capture limits are 1..4 MiB per stream; retention is 1..604800 seconds (default
86400). A page is at most 65536 bytes. Metadata is finite and excludes unknown
response fields.

Artifact publication requires the caller to already know the exact guest path,
byte count and SHA-256. It does not stat, read, hash or run a guest command to
prepare the nomination. Paths remain byte-for-byte intact; Linux absolute paths,
Windows drive-qualified paths and UNC forms are accepted for backend OS validation.

```ts
const artifact = await c.publishArtifact('/tmp/report.bin', {
  expectedSize: reportSize, expectedSha256: reportSha256,
  maxBytes: 8 * 1024 * 1024, retentionSeconds: 86400, signal,
  // executionId: job.executionId, // optional caller selection, not provenance
});
const info = await c.artifact(artifact.artifactId, { signal });
const bytes = await c.downloadArtifact(info.artifactId, {
  maxBytes: 8 * 1024 * 1024, signal,
});
await c.deleteArtifact(info.artifactId, { signal });
```

`downloadArtifact` reads metadata and, if its size is within the independent
download cap, downloads the whole content. Each GET is one attempt by default;
opt-in transport retries may repeat an interrupted GET from the beginning.
It returns a `Uint8Array` only after exact length and SHA-256 verification
against that invocation's metadata.
The default download cap is 8 MiB; the maximum is 64 MiB. Publication's `maxBytes`
is a separate capture cap with the same default and maximum. Empty artifacts
still require the correct empty digest. Web Crypto SHA-256 support is required
and checked before transfer, including with an injected fetch in a browser or
worker. These helpers never follow a download URL or filename from the response,
write local files, return a partial prefix, use Range, or fall back to guest files.

New manifest and byte transports enforce caps during streaming, including an EOF
check at the exact cap. Invalid framing, incomplete content, hash mismatch,
authority loss and cancellation return no successful bytes. Explicit capture,
publication and the whole-content download request use at least a 90-second
request allowance; a larger configured client timeout remains larger, and
`timeoutMs: 0` still disables the SDK deadline. Caller cancellation remains active.
This is a per-request allowance, not a deadline for a multi-request operation.
A lost publication response leaves its commit unconfirmed. Do not automatically
repeat the POST. `deleteResult` and `deleteArtifact` make one DELETE each; 204
returns void, while a repeated 404 remains unavailable. Activities and their
result-detail convenience methods remain outside this SDK surface.

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

When connecting your own WebSocket client, use the exact returned `events_url`,
including its desktop capability. A REST Bearer key alone is insufficient; a
REST call to the events path returns guidance to use `events_url`.

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
many *consecutive* failures to deliver an event (`0`, the default, never does — a
connection that delivers an event resets the count), and
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

`hello.watchingIncomplete` and `hello.windowsIncomplete` are the opening frame's
version of a listing's short answer, one per collection: `null` when every entry
of that collection was usable, and a count of the entries that were not. An
entry this client cannot use — a row that is not an object, or one that names no
window and no tree — is dropped rather than allowed to end the connection (a
stream is worth more than one malformed row), so the count is the only trace it
was there. `hello.watchingIncomplete` is what to check before reading
`hello.watching.length` as what the host accepted; a window the host could not
describe moves the other one and says nothing about your nominations, which is
why there are two counts and not one.

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
remember: **record every accepted `webhook-id` before processing and refuse
repeats.** How long for is `replayRetentionS()` — **twice the tolerance from the
moment of acceptance, inclusively**: keep the id while the elapsed time is less
than or equal to it, and drop it only once past.

```ts
import { replayRetentionS } from 'mandala-computer';

const keepFor = replayRetentionS();          // 600 seconds, with the default tolerance
const custom = replayRetentionS(60);         // 120, if you overrode toleranceS
```

A function rather than a sentence because the obvious reading of the window gives
half the right answer. A timestamp can be one tolerance *ahead* of your clock when
you first accept it, and the same bytes still verify one tolerance *behind* it, so
the gap a retention has to span is two tolerances. An id remembered for one is
forgotten while its signature is still good, and whoever captured the request
replays it then.

**Expire the id on the same clock `verify` reads, and on one that never goes
backwards.** That clock is the wall clock unless you pass `now`, so a TTL measured
on a monotonic clock is a second clock and the bound is only as good as their
disagreement. One clock is not enough by itself either: an eviction cannot be
undone, so a clock stepped back after the record expired leaves the capture inside
the window with nothing left to refuse it. No multiple of the tolerance covers an
unbounded adjustment — use a nondecreasing clock. A margin is only a substitute if
it covers the *total* backward displacement the clock can accumulate after an
eviction: two one-second steps defeat a one-second margin exactly as a two-second
step does. A wall-clock TTL (Redis `EXPIREAT`, a database
`expires_at`) is already reading the same clock as the default.

That expiry bounds a captured signature. A retry can carry the same id with a
fresh timestamp and signature, so retain **durable idempotency records across
the full delivery retry horizon**, or longer if your application needs it.
Timestamp verification alone does not prevent processing retries twice.

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

Ten clicks stop being ten images in *your* context. `maxSteps` bounds the loop,
and bounds what your key is billed only loosely: a step is one **action on the
desktop**, not one exchange with the model, and the two do not line up in either
direction. One reply may ask for several actions and spends a step on each,
while a reply that asks for none — or a paused turn, resubmitted — costs tokens
and no step. Nor does every step take a screenshot; a `bash` call or a cursor
read does not. Omit it for the platform's default of 20; 100 is the ceiling,
and a larger value is refused before the call.
`system` carries standing instructions into the run and `model` overrides the
one the platform would pick. The computer must already be running.

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

**A run can be refused part-way through, after billed steps.** Authorization is
not settled once at the start of a call this long: the API rechecks the
credential, the role, the account's standing and the plan before each model call
and each tool, so a key revoked, a member demoted, an account suspended or a plan
downgraded mid-run stops the loop with a **401**, **403** or **402**. The steps
already taken stand — on your key, and on that desktop.

The refusal reports what was already spent and already done, and this SDK hands
that over rather than flattening it into a sentence:

```ts
for await (const ev of c.agentStream({ prompt, modelKey })) {
  if (ev.type === 'error') {
    console.warn(`stopped with ${ev.status}: ${ev.error}`);
    console.warn(`${ev.steps.length} steps done, ${ev.usage.inputTokens} input tokens spent`);
  }
}
```

`agent()` and `agentOnce()` throw instead, and the same accounting is on the
error's `body`. None of those three statuses is a transport failure: the
credential is no longer valid for that account, so replaying the same request
with the same key spends again and is refused again. `isTransient` answers false
for a mid-run refusal, and cannot be talked out of it by the frame — a `reason`
word arriving on a stream is retry advice about one request, which a run that has
already clicked things is not, so it is withheld from the thrown error (the
streaming `error` event's `raw` still has it).

The long writes are refused the same way and at the same kind of point — `create`,
`move`, a template publish, and the webhook create and update can all stop after
the body has been read and the work prepared. For those the durable write has
**not** happened; for an agent run the completed steps have.

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

`await c.start({ resumeOnly: true })` resumes only if a saved session still
exists. If the computer is stopped without one, the request succeeds without
booting it. Success therefore does not guarantee a running computer. The handle
is refreshed when the API returns only an acknowledgement, so inspect `c.status`
before treating it as running. Omitting `resumeOnly` or passing `false` keeps
the normal start behavior.

What to do next depends on what the platform is holding for the computer, and
both waits read the same field to decide. `waitUntilRunning()` and
`waitForGuest()` each refuse a stopped computer the platform reports it is
holding nothing for — which is the ordinary outcome of a no-op — and say to call
`start()`. Where the platform does not report the figure at all, neither refuses:
they wait, and spend the whole timeout. So a no-op followed by a wait costs you
an error quickly or a timeout slowly, and neither is a substitute for reading
`c.status` — or `c.runningRamMb`, which is the figure they are reading. When the
intent was to boot the computer, call ordinary `start()`.

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
required. A `Move` carries no id, so its `startedAt` — or an RFC3339 `startedAt`
a restarted process persisted — is what says which move a wait is watching, and
a row of this computer's is that move exactly when its `startedAt` is the same
string. Equality and not a window: the platform keys its moves table by computer
id and writes a move with `INSERT OR REPLACE`, so at most one row is ever this
computer's, and the stamp on it is the same stored string the 202 handed back.
There is nothing to choose between and no second clock to be off by. A persisted
anchor must therefore be that value verbatim, not the same instant re-formatted.

The day of finished moves the listing keeps is real, but it is a fact about the
ACCOUNT and not about one computer, so it is not what the anchor guards against.
What it guards against is the other half of `INSERT OR REPLACE`: a second
relocate on this same computer overwrites this move's row while the wait is
running, and without an anchor the wait would report the new move's outcome as
this one's. When that happens the wait fails at once with a `MandalaError`
naming both stamps — the replacement does not un-happen, so there is nothing to
wait out.

A listing with **no** row for this computer ends the wait the same way, on the
first poll. The row is written inside the transaction that precedes the 202 and
the 202 is a read-back of it, so by the time you hold a move to wait on the row
exists: absence is not a listing catching up, it is a row that has left, which
happens when the computer is deleted and when a finished move is dismissed. The
one exception is a listing this client could not read whole — a row it could not
decode might be this very move, so nothing is claimed and the deadline is what
ends the wait.

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

**`snapshot()` waits for the capture, and the request does not.** A capture is
minutes, and scales with how much has been written to the disk — longer than any
HTTP request survives, so the platform answers `202` the moment it accepts one
and copies the disk afterwards. What comes back at that point is a placeholder
row in state `capturing`, carrying the id the snapshot will keep. `snapshot()`
polls the snapshot listing for that id and returns when the row stops reading
`capturing`, which is the point the snapshot can be restored, cloned or deleted.
It does not wait for `durable` by name — that is backup replication, it can
happen between two polls, and nothing you can do with a snapshot is gated on it.

Every refusal is still immediate and still the exception it always was: a
`ConflictError` for a capture already running or a disk still being copied, a
`PlanLimitError` for an allowance that will not stretch, a `MandalaError` for a
memory snapshot of a computer that is not running.

**Returning is the snapshot being usable, not the computer being free.** The
capture's claim on the *computer* is released only after the snapshot has been
pushed to backup storage — the step that turns `pending` into `durable` — so for
as long as that push runs, a second `c.snapshot()` and a
`c.delete({ deleteSnapshots: true })` are both still `ConflictError`. Restoring,
cloning and deleting the snapshot itself work from `pending`.

Pass `wait: false` to hold the id and poll on your own schedule:

```ts
const held = await c.snapshot({ name: 'before-upgrade', wait: false });
held.capturing;                                     // true — and held.id is final

for (;;) {
  const { items, incomplete } = await client.snapshots.listWithStatus();
  // `raw.id`, not `id`. The decoded field has been through a string coercion,
  // and `String(['snap-1'])` is `'snap-1'` — so matching on it lets a malformed
  // row stand in for your capture and be read as the one that landed.
  const row = items.find((s) => s.raw.id === held.id);
  if (row && !row.capturing) break;                 // landed
  // A row that has gone from a listing read WHOLE is a capture that failed. On
  // a short one it says nothing — the rows nobody could read might have held it.
  // A row whose `id` is a non-string that still coerces (`['snap-1']`, `42`) is
  // the second way to be short: it is kept, so `incomplete` does not count it,
  // and it cannot be matched, so it might be this one. One that coerces to
  // nothing (`null`, absent, `''`) never reaches here at all — `listWithStatus`
  // refuses a snapshot with no id and throws.
  const blind = incomplete !== null || items.some((s) => typeof s.raw.id !== 'string');
  if (!row && !blind) throw new Error('the capture failed: no snapshot and no row');
  await new Promise((r) => setTimeout(r, 5_000));
}
```

That missing row is a capture that failed: it leaves no snapshot and no row, and
the absence is the only thing there is to tell it from one still running — which
is why the loop asks without `allowPartial` and checks `incomplete` before
concluding anything. Without the flag a hypervisor that did not answer arrives as
a 503 rather than as a row that has gone; `incomplete` is what says the rest of
the time whether the answer was one this client could read whole.

`snapshot()`'s two failures read differently for the same reason. A
`TimeoutError` means the *wait* stopped and not the capture — the id is in the
message and the snapshot is still coming. A `MandalaError` saying the capture
failed means the row went and nothing took its place; there is nothing to find
and nothing being billed.

```ts
try {
  await c.snapshot({ name: 'before-upgrade', timeoutMs: 600_000 });
} catch (err) {
  if (err instanceof TimeoutError) { /* still capturing; poll for the id it names */ }
}
```

A memory snapshot forks into a live twin — same processes, same open windows,
same network identity until it is re-identified.

```ts
await client.snapshots.restore(snap.id);            // back onto its source
await client.snapshots.delete(snap.id);             // waits for the row to go
```

**`delete()` waits too, and what it waits for is the row's absence.** It blocks
for up to **30 minutes** by default, polling at up to 5s — `timeoutMs` and
`pollMs` change both, and `{ wait: false }` opts out entirely. That deadline is
for the case that needs it: a deletion scales with the chain, and a lone snapshot
is seconds even at multi-gigabyte sizes, so
the poll interval ramps from 250ms and the ordinary call returns in about the
time the deletion takes. But a deletion that stalls at the flatten — the one
conflict the platform cannot refuse up front — holds the call for the full half
hour, so `delete()` inside a request handler wants a `timeoutMs` of its own. The
route
answers 202 with the snapshot's row the moment the deletion is accepted, and the
work happens afterwards: flattening every dependent, committing the index, then
walking both the local files and the bucket objects, which scales with the chain
and with what is stored. There is no state that means deleted — `client.snapshots.list()`
no longer carrying the id is the deletion having finished — so that is what the
wait polls for, and it asks with `includeUnfinished` because a row that reached
`deleting` is left out of a bare listing.

That flag is not optional in a loop of your own. Without it, a deletion that
stalled reads as one that finished, and you record a snapshot as gone while it
is still holding objects and still being billed.

Every refusal still arrives on the request and still carries the status it did:
404 for no such snapshot, `ConflictError` for a capture reading through it, for a
clone or migration holding it, and for a deletion of the same id already running.
That last one is progress rather than a fault, and a second `delete()` against a
row whose deletion stalled is accepted again and finishes the job — so a retry is
worth making.

A retry can also land on `NotFoundError`, and after a `TimeoutError` from
`delete()` that is the success arriving as an exception: the platform's own sweep
may have finished the deletion between the wait giving up and you acting on it.
The 404 is the same class a bad id answers, so it is worth reading in context —
the snapshot is gone, not never there.

**The polarity is the opposite of a capture's.** A capture that fails leaves no
row; a deletion that fails leaves one. So a `TimeoutError` here means the row was
still listed, and the message says which of the two that is, because the remedies
differ. Still `deleting` is a stall the platform sweeps up itself every fifteen
minutes. Still in its ordinary state is a deletion that stopped at the flatten
having destroyed nothing — the one conflict that arrives after the 202, when a
dependent is itself being deleted — and the sweep never picks those up, so what
finishes it is another `delete()` once that dependent has gone. Deleting a chain
one link at a time, waiting for each row to leave the listing, never meets it.

`{ wait: false }` returns as soon as the 202 lands, for a caller who would rather
poll on their own schedule:

```ts
await client.snapshots.delete(snap.id, { wait: false });

const { items, incomplete } = await client.snapshots.listWithStatus({
  includeUnfinished: true,
});
// Two ways this listing can be short, and absence means nothing under either:
// rows this client could not read at all, which `incomplete` counts, and a row
// whose `id` is a non-string that still coerces, which it does not — that one is
// kept, and cannot be matched, so it might be this snapshot. (An `id` that
// coerces to nothing never gets this far: `listWithStatus` throws on it.)
const blind = incomplete !== null || items.some((s) => typeof s.raw.id !== 'string');
// `raw.id`, not `id`: the decoded field has been through `str()`.
const gone = !blind && !items.some((s) => s.raw.id === snap.id);
```

Taking them on a timer is a property of the computer:

```ts
await c.setSchedule({ enabled: true, hour: 4, tz: 'America/New_York' });
```

`c.schedule()` reads the daily schedule back. `setSchedule({ enabled: false })`
keeps the chosen time so toggling it on again restores it; `c.clearSchedule()`
returns the computer to never having had one.

`client.snapshots.list()` is every snapshot on the account;
`{ computerId }` narrows it to one computer's, and `{ includeUnfinished: true }`
adds deletions that began and did not finish — nothing can be restored or
cloned from one, but they still hold storage and are still billed.

The `{ computerId }` filter drops a row whose `computer_id` is not a string,
since a strict comparison is the whole of what keeps another computer's
snapshots out of the answer — and `listWithStatus()` counts that row into
`incomplete`, so a list one row shorter than the estate never comes back
claiming to be whole. That matters most where these listings are usually read:
just before a purge.

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

### Account quota

`client.account.read()` returns an `AccountQuota`: instantaneous plan ceilings,
per-computer maxima, capabilities, consumption and remaining headroom. It uses
one read-only `GET /account` with no selectors. Viewer access is enough, and
workspace-scoped keys receive the same **account-wide aggregates**. Use
[`client.usage.read()`](#usage) for historical metering instead.

```ts
import { Client } from 'mandala-computer';

const client = new Client(); // MANDALA_API_KEY
const quota = await client.account.read();
console.log(quota.plan.label, quota.observedAt, '(advisory)');
if (quota.complete.computers) {
  console.log('Configured vCPU headroom:', quota.remaining.configuredVcpu);
  console.log('Running/reserved RAM headroom (MB):', quota.remaining.runningOrReservedRamMb);
} else {
  console.log('Current computer consumption and headroom are unknown.');
}
if (quota.complete.snapshots) {
  console.log('Indexed snapshot byte headroom:', quota.remaining.snapshotStorageBytes);
} else {
  console.log('Current snapshot consumption and headroom are unknown.');
}
```

`complete.computers` and `complete.snapshots` are independent. An incomplete
group has explicit `null` for **every** related `usage` and `remaining` field;
the other group and verified plan ceilings remain usable. A complete empty
inventory has numeric zeros. Missing or malformed required fields raise
`MandalaError`; the SDK never turns them into an empty account. Unknown future
fields remain available in `raw`.

Configured vCPU and disk GB include all kept computers, including stopped ones;
disk is provisioned capacity, not filesystem occupancy. Running/reserved RAM MB
includes pending reservations and excludes released stopped RAM. The separate
running/reserved computer and vCPU totals describe that active subset. Snapshot
storage is **indexed stored bytes**, including pending/deleting rows and stored
copies during handover; it excludes in-flight capture reservations. Its remaining
bytes do not predict whether a new capture will be admitted.

Zero ceilings, including a no-plan account, are real limits. Retained resources
can exceed a ceiling: usage stays visible and remaining headroom is clamped at
zero. `advisory` is always true. `observedAt` is the UTC collection completion
time, not a consistency token; concurrent changes can make it stale immediately.
The read creates no reservation, promises no later operation will fit, and is
not a check of host capacity. Read again for a fresh observation; pass
`{ signal }` to cancel through the normal transport.

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

`incomplete` is `null` exactly when the answer was whole. When it is not, the
number is one of three things and does not distinguish them: how many rows the
placement cache could account for — legitimately `0`, because a computer created
during the outage was never cached against the host now holding it — or, when
the platform called the answer whole, how many rows this client received and
could not decode, which it drops rather than hands back as junk — or `0` for a
response that carried no body at all, which is a list nothing can size and which
no list route on this platform produces. Any of the three leaves the array short
by rows that still exist, which is the part a caller has to act on. So branch on `incomplete !== null`, never on the number, and do not log it
as a count of anything in particular.

Builds are the third of these and the one where the status is always all you
get. The platform keeps no record of which hypervisor ran which build, so a
partial build listing appends nothing: the missing ones are simply not there,
and `incomplete` is `0` rather than a count. Use `builds.listWithStatus()`
rather than `builds.list()` whenever you pass `allowPartial`.

Computers and snapshots do append a row for each one they could not reach, so a
partial answer is visible in the rows themselves. A snapshot's is the bare
`{ id, unreachable: true }` stub, and it arrives only for a key that spans the
account: naming the missing ids means reading them out of a placement cache with
no workspace column, and handing a confined credential ids from the workspaces
it is confined away from is not something the platform will do. So on a
workspace-scoped key a snapshot listing is the status and nothing else, exactly
as a build listing always is.

A computer's unreachable row is fuller, and is the one exception to that scoping.
It carries `unreachable: true` plus the identity the control plane keeps on
record — `name`, `os`, `template`, the size, the workspace and `createdAt` — and
nothing only its host knows, so `status` is `''` on it and `state` reads
`unreachable`. The record has the workspace column the cache lacks, so a
workspace-scoped key sees these rows too.

### The lifecycle of a computer

`status` is what a computer's host says it is **doing** — `running`, `stopped`,
`suspended`. `state` is what the control plane's own record says about whether
it **exists**:

| `state` | meaning |
| --- | --- |
| `live` | a host listed it |
| `unreachable` | no host answered for this request; nothing has happened to the computer |
| `deleting` | a delete was sent and has not been answered |
| `deleted` | a delete that was answered |
| `lost` | an operator wrote off the host it was on |

The listing carries it; a route that serves one computer does not, because such
a response comes from the host and a computer that answered is live by
construction. `deletedAt` and `lostAt` are RFC 3339 and set with the matching
state.

`deleted` and `lost` are terminal, and no host holds one to list — so asking for
them by name is the only way to see them at all:

```ts
const gone = await client.computers.list({ state: 'deleted' });
for (const c of gone) console.log(c.id, c.deletedAt);
```

The filter is the control plane's, not a host's: it is read where the record is,
and never forwarded. A word outside the five is refused here rather than at the
platform's 400.

### Optional retries for reads

Retries are off by default. Opt in when constructing the client:

```ts
const client = new Client({ retries: { idempotent: 2 } }); // up to two additional attempts per read
```

`idempotent` must be a nonnegative finite integer; zero keeps a single attempt.
The client copies this setting at construction. Only GET and HEAD can retry,
on connection failures or HTTP 502, 503 and 504. Legacy `execPoll` reads are
excluded because reading them advances a shared output cursor. HTTP 429 is
never retried, including when its error body is interrupted;
`RateLimitError.retryAfterMs` still carries a usable server delay. Other
statuses and local validation, decoding, size or integrity failures do not
permit retries.

Backoff starts at 250 ms, doubles after each failure, and caps at 30 seconds.
A valid `Retry-After` is a lower bound on that delay, including HTTP dates and
zero. Very large valid delays never fall back to a shorter wait. Finite requests
retain one composed deadline across every attempt and backoff; retries do not
restart it. The caller's `signal` remains active throughout. Cancellation and
timeout failures end the operation without another attempt.

Finite JSON, listings, files and retained downloads buffer each complete attempt
before returning anything. An interrupted read discards its partial bytes and
cancels its response before retrying from the beginning; retained size and hash
checks still apply. An SSE GET can retry only before its first application event
is exposed. After that event, failures end the stream without replay. Desktop
websocket reconnection behavior is unchanged.

POST, PUT, PATCH and DELETE are never retried, even on a connection failure.
A lost answer does not prove a mutation did not happen: another create or exec
can duplicate work. Creates, template preparation, retained publication and POST
agent streams therefore remain single attempts. Check an uncertain mutation's
outcome explicitly before deciding what to do next.

### Errors

```ts
import {
  MandalaError,        // base of everything this SDK throws
  APIError,            //   any unsuccessful response
  AuthenticationError, //     401 — a credential was refused
  PlanLimitError,      //     402 — your plan will not allow this. Not a retry.
  PermissionDeniedError,//    403 — the key's role is too low
  NotFoundError,       //     404 — no such computer, snapshot, guest file, or route
  MethodNotAllowedError,//    405 — method unsupported; see err.allow
  ConflictError,       //     409 — right request, wrong moment. `err.reason` says
                       //           whether retrying it helps
  MoveRequiredError,   //       409 — …except this one: the size needs a new host
  TooLargeError,       //     413 — more file than one request moves
  RangeNotSatisfiableError,// 416 — that range names no byte the file has
  RateLimitError,      //     429 — retry after retryAfterMs when present
  UnavailableError,    //     503 — a listing would have been short
  GatewayTimeoutError, //     504/524 — a proxy gave up; work may carry on
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

Every `APIError` exposes optional `requestId`, `allow` and `wwwAuthenticate`
properties. `requestId` uses a nonblank `X-Request-ID` response header first,
then a nonblank top-level `request_id` in the body. It is an opaque diagnostic,
not an idempotency key. HEAD errors and unreadable error bodies can still carry
header metadata; older servers and connection failures may supply none. `allow`
and `wwwAuthenticate` preserve the received headers and are never inferred from
the body. A 405 does not trigger an automatic method change or retry.

```ts
try {
  await c.readFile('/tmp/report.txt');
} catch (err) {
  if (err instanceof APIError) {
    console.error(err.status, err.message, {
      requestId: err.requestId,
      reason: err.reason,
      allow: err.allow,
      wwwAuthenticate: err.wwwAuthenticate,
      retryAfterMs: err.retryAfterMs,
    });
  }
  throw err;
}
```

A missing guest file uses the existing `NotFoundError`, just like a missing
computer or route, with the response's own message. Permission failures retain
the status the server sent.

For 401, `reason` may say `missing`, `invalid` or `revoked`; unknown string values
are retained too. A nested finite chat error exposes its string message and
reason while `body` keeps the entire envelope, including usage, steps and native
agent evidence. A valid top-level reason takes precedence over a nested one.
An unclassified 401, including a model-provider refusal, does not by itself
identify which credential failed. Check the supplied classification and challenge
before changing credentials, and inspect recorded work before starting another
run. No 401, 402, 403, 404 or 405 is transient, even with a contradictory reason.
Nested run reasons never grant replay permission. Stream error frames keep their
full evidence in `raw`; thrown stream errors expose their request ID without
turning frame reasons or the successful stream's headers into retry advice.
The CLI JSON error envelope remains `{code, message, status}`.

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
prose and is rewritten. For ordinary request refusals, `contention` and `starting` clear on their
own, `unavailable` means the computer is not running and only starting it helps,
`unsupported` means this computer cannot do it at all, and `revoked` is about the
caller rather than the computer — the authority the request arrived with no
longer holds, so sending it again unchanged is refused the same way (a 401 means
present a credential again; a 403 means the role changed and signing in again
will not help). `isTransient` reads it before it looks at the type, which is how
a clipboard call against a stopped computer stopped being told to retry.

**Absent means no classification was given**, and so does a word you do not
recognise — not every refusal has one, and the platform reserves the right to
add classifications. Treat both as "no answer" and fall back to whatever you did before,
which is exactly what `isTransient` does.

`MoveRequiredError` is the exception, and it is a subclass so that code matching
on the family keeps working. It means the size you asked for is more RAM than the
host this computer is on can run, and it does **not** clear — the host will not
grow, so the same request answers the same way for as long as the computer is
where it is. `isTransient` says false for it. `movePossible` is the branch: true
means somewhere else in the region can run that size and `relocate()` takes the
offer up, false means nowhere can and the size is the thing to change. See
**Growing past the host**.

`GatewayTimeoutError` reports a proxy timeout, rather than the platform's own
answer. The request may have reached it, and any work it had already
started carries on; the status alone cannot establish the outcome. What ended
was one hop's willingness to hold a connection open with nothing crossing it,
which is why retrying unchanged can reproduce it.
After one on an `exec()` the next call may report the guest agent busy; after
one on a read there is nothing left behind. `err.message` carries the response's
own message where it sent a structured one, and this SDK's explanation where the
hop sent an empty or HTML body — which is the usual case, since a 524 is
generated at the edge. See [Long-running commands](#long-running-commands).

`OriginUnreachableError` covers 521-523, when a proxy could not reach the platform.
The request usually never arrived, but that is not a guarantee: a 522 can happen
after a connection was established, so work may already have started. Check
whether the first attempt took effect before repeating anything that creates.
These failures can clear on their own. 525 and 526
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
These proxy failures are not in `isTransient`, including 502, 504 and 520-526.
That predicate is exported, so its caller may be wrapping a `create`. Several
of these statuses leave the outcome unknown, which is how one computer becomes
two; TLS failures require a configuration fix before retrying.
Its default retryable classes are `ConflictError`, `RateLimitError`,
`UnavailableError` and `ConnectionError`. It excludes `MoveRequiredError` and
`ConnectionInterruptedError` (including request timeouts), and honors recognized
API error reasons that identify temporary or permanent failures.

The wait helpers do not ask it. They replay idempotent reads under a deadline
you set, so they can ride out 502, 504 and 520-523. They stop on 524 (a proxy
timeout that retrying unchanged will not fix) and 525/526 (TLS failures), as well
as permanent request failures. Two audiences, two predicates: the internal
`isTransientForPoll` can retry an uncertain read that the public `isTransient`
cannot safely recommend replaying for an arbitrary operation.

## The `mandala` CLI

The same package provides commands for computers, templates, snapshots, webhooks,
and agent runs. The CLI requires Node 22+; importing the SDK does not import the
CLI or its terminal dependencies. Use `npx mandala` from a project with the package
installed, or prefix the commands below with `npx --package=mandala-computer`.

```sh
npx --package=mandala-computer mandala --help
npx --package=mandala-computer mandala manifest
npx --package=mandala-computer mandala computers list --json
```

Requests use `MANDALA_API_KEY`, with `MANDALA_BASE_URL` as an optional server
override. Agent runs also require `MANDALA_MODEL_KEY`, your model-provider key.
There is no CLI login, credentials file, profile selection, account command, or
usage command in this release; those commands are deferred. The SDK's
[`client.usage.read()`](#usage) remains available.

### Discover commands and flags

`mandala --help`, `mandala computers --help`, and
`mandala computers exec --help` show progressively narrower help. Every command
accepts `--help` (`-h`) and `--json`. Help, manifest, and completion need neither
credentials nor network access and never prompt for input.

| Command group | Available commands |
| --- | --- |
| `computers` | `list`, `create`, `get`, `start`, `stop`, `suspend`, `restart`, `delete`, `clone`, `screenshot`, `exec`, `wait` |
| `templates` | `list`, `get`, `validate`, `publish`, `build`, `watch`, `retire` |
| `snapshots` | `list`, `create`, `restore`, `clone`, `delete`, `holdings`, `schedule get`, `schedule set`, `schedule clear`, `retention` |
| `webhooks` | `list`, `create`, `get`, `update`, `delete`, `rotate`, `test`, `deliveries` |
| `agent` | `run` |
| Top-level commands | `ssh`, `scp`, `manifest`, `completion` |

Command-specific flags follow the command name. Flags with values accept
`--name value` or `--name=value`; boolean flags take no value. Repeat only flags
marked repeatable, such as `--env`, `--event`, and webhook `--computer` filters.
Use `--` before a positional argument beginning with a dash. Unknown commands,
unknown flags, and conflicting arguments fail instead of being ignored.

`mandala manifest` prints a JSON command tree by default. Its `schemaVersion` is
`1`; each entry in `commands` describes the command's `path` array, required
`arguments`, `flags` with types and constraints, and `jsonMode` (`finite`,
`ndjson`, or `unsupported`). Flags with aliases, choices, repetition, or conflicts
carry those properties. Conditional SDK requirements also appear in command help
and the sections below. The manifest reports `ssh` as unsupported in JSON mode:
`ssh --json` returns an error before resolving a computer or connecting.
`mandala manifest --json` wraps the tree in the finite result envelope below.

Shell completion scripts come from the same command inventory:

```sh
mandala completion bash
mandala completion zsh
mandala completion fish
```

Each command prints a script to stdout. Save or source it according to your shell's
completion setup; the CLI does not edit shell files or install completions.
`--json` returns the script as `data.script` alongside `data.shell`.

### Computers and remote commands

Computer operands accept an ID or a unique name. An exact ID takes precedence,
including IDs absent from the default inventory. When no listed ID matches,
the CLI checks the direct ID endpoint before accepting a name. Only a 404 from
that lookup permits name fallback, and the inventory must be complete. Other
lookup failures stop the command. Ambiguous names fail with the matching IDs so
you can select one explicitly.
Listing filters and webhook filters that say `--computer` take IDs.

```sh
mandala computers list --json
mandala computers create --name workbench --template base --cpu 2 --ram-mb 4096 --disk-gb 40
mandala computers wait workbench --until guest --timeout-ms 180000 --poll-ms 2000
mandala computers get workbench
mandala computers screenshot workbench -o screen.png --fresh
mandala computers exec workbench -c 'uname -a' --timeout 60
printf 'pwd\nls -la\n' | mandala computers exec workbench
mandala computers exec workbench -c 'make build' --cwd /home/user/project --background --json
```

Create starts the computer by default; `--no-start` leaves it stopped. It returns
after provisioning responds. Use `computers wait` for readiness: `built` waits
for the disk copy, `running` waits for the VM, and `guest` waits for the guest
agent. The default is `running`. `--timeout-ms` bounds the readiness wait and
`--poll-ms` controls its polling interval; neither changes the initial computer
lookup's request budget. The SDK also provides [`computers.launch()`](#use) for
creating and waiting in one call.

`--size` selects a named size and cannot be combined with `--template`, `--cpu`,
`--ram-mb`, `--disk-gb`, or `--template-transfer`. A preparation token is accepted
only with the original nonempty `--template`; see [Your own templates](#your-own-templates)
for how to handle a preparation refusal.

Exec accepts either `-c`/`--command` text or piped stdin. It preserves that command
text, rejects empty input, and rejects a command combined with nonempty stdin.
It does not prompt on a terminal. `--timeout` is a foreground execution limit in
**seconds**, defaults to 30, and accepts integers from 1 through 600. It cannot
be combined with `--background`. `--cwd`, repeatable `--env NAME=VALUE`, and
`--desktop` apply to either execution mode.

Without `--json`, foreground exec writes the guest's stdout and stderr bytes to
the corresponding local streams. With `--json`, both are inside the result:
`stdoutBase64` and `stderrBase64` preserve bytes; `stdoutText` and `stderrText`
provide UTF-8 decoding. Foreground results also include `exitCode`, `timedOut`,
`outTruncated`, `errTruncated`, `truncated`, and `ok`. Truncation is reported even
when the remote command exits zero; success does not mean all output was captured.
Background exec returns a handle including `pid`, `running`, output, and available
execution metadata. Starting it successfully does not mean the command has
finished. Use the SDK's [background execution methods](#long-running-commands)
to poll or stop it.

Screenshot always writes the image bytes to the required `-o`/`--output` file.
Its JSON result reports `{ "path": "screen.png", "bytes": 12345 }`; it never
embeds or JSON-encodes the image. `--width` scales the requested image, and
`--fresh` requests a new capture.

Lifecycle commands act on the specified computer. `computers stop --force`
forces power off. `computers delete` keeps snapshots unless you pass both
`--delete-snapshots` and `--expect FINGERPRINT`. Obtain and inspect the fingerprint
with `snapshots holdings`; the CLI never selects a purge fingerprint for you.

### Templates, snapshots, and webhooks

```sh
mandala templates list
mandala templates validate ./devbox.yaml
mandala templates publish ./devbox.yaml --json
mandala templates get system base --version 1.0.0
mandala templates build ./devbox.yaml --no-reuse --json
mandala templates watch bld-example --json
mandala snapshots list --computer vm-example --include-unfinished --json
mandala snapshots create workbench --name before-upgrade
mandala snapshots schedule set workbench --hour 4 --minute 30 --tz UTC
mandala webhooks create https://hooks.example.com/mandala --event computer.ready --json
mandala webhooks deliveries whk-example --json
```

Template validate, publish, and build read a file, or `-` for piped stdin. Build
returns a job immediately; pass the returned `id` to `templates watch` to stream
its progress. Invalid validation results and failed builds exit nonzero. Get and
retire take separate namespace and name operands; `--version` selects a specific
version. Retire without `--version` retires every version of that template name.

Snapshot create and delete wait for completion by default. Both accept
`--timeout-ms`, `--poll-ms`, and `--no-wait`. With `--no-wait`, capture may return
`state: "capturing"`; deletion reports `accepted: true, waited: false`. Acceptance
is not proof of completion. `snapshots restore` restores the specified snapshot;
`snapshots clone SNAPSHOT --name NAME` creates a new computer from one. Schedule set uses
04:00 UTC when time flags are omitted; `--disabled` disables the specified window.
`schedule clear` removes it. Retention is read-only.

Webhook create accepts repeatable `--event` and `--computer` filters,
`--description`, and `--disabled`. Update replaces supplied filters; use
`--all-events` or `--all-computers` to clear one, and `--enable` or `--disable`
to change delivery state. Create and rotate print the newly returned signing
secret **once** in the result, with a reminder on stderr. Save that result: get
and list do not return the secret. `webhooks test` queues a delivery; inspect
`webhooks deliveries` to learn whether it was delivered.

### Agent runs and cancellation

```sh
mandala agent run 'Open the browser and find the documentation' --computer workbench --max-steps 20
mandala agent run 'Summarize the visible page' --computer workbench --json
```

Set `MANDALA_MODEL_KEY` before running these commands. `--computer` is required;
the CLI never guesses which desktop to use. `--max-steps` bounds desktop actions
from 1 through 100; `--model` selects a model and `--system` supplies standing
instructions. Human output includes timestamped action/text lines and a final
summary with `steps`, `stop`, `finished`, and token `usage`.

Only `finished: true` (`stop: "end_turn"`) exits zero. A step limit, refusal, rate
limit, error frame, or stream ending without a final result exits nonzero. An
agent error frame preserves the server's reported completed steps and token
usage under `data.error.details`; those actions may already have happened.

For noninteractive commands, Ctrl-C (`SIGINT`) or `SIGTERM` aborts pending SDK
work and exits 130, restoring the CLI's signal listeners. Cancellation stops
waiting and asks an active agent request to abort. It does not roll back actions,
delete a created computer, or prove that an accepted remote mutation stopped.
An interactive `ssh` session passes Ctrl-C to the guest terminal instead.

### JSON results and exit status

`--json` puts machine output on stdout and diagnostics on stderr. Finite commands
emit one newline-terminated JSON object. A successful screenshot, for example,
has this version 1 envelope:

```json
{"schemaVersion":1,"command":"computers screenshot","ok":true,"data":{"path":"screen.png","bytes":12345},"exitCode":0}
```

A request or CLI error uses `error` instead of `data`:

```json
{"schemaVersion":1,"command":"ssh","ok":false,"error":{"code":"unsupported_mode","message":"Interactive ssh does not support --json; use computers exec for machine-readable output"},"exitCode":1}
```

`command` is the space-separated command path, without operands. It is empty
when argument parsing fails before an invocation is established. `error` always
has string `code` and `message` fields, and may include numeric HTTP `status` or
command-specific `details`. CLI codes include `invalid_arguments`,
`ambiguous_computer`, `missing_credentials`, `unsupported_mode`, and `cancelled`;
SDK failures use their error-class names, such as `AuthenticationError`.

`ok` reflects the process exit status. A remote nonzero exec result or invalid
template document keeps its `data` with `ok: false` and a nonzero `exitCode`.
Consumers should distinguish an unsuccessful result from a request that raised
an `error` and tolerate additional fields within version 1. Resource payloads
retain their API field names. Exec and agent summaries use the SDK's camelCase
fields described above. Computer results omit desktop credentials.

Computer, template, and snapshot listings return `data.items` and
`data.incomplete`. `null` means complete; any number, **including zero**, means
incomplete. Computer and snapshot lists accept `--allow-partial` to opt into a
partial server response; the CLI preserves the shortfall instead of presenting
it as a complete inventory.

`agent run --json` and `templates watch --json` emit **NDJSON**: one JSON frame
per line. Every frame has `schemaVersion`, `command`, `type`, an ISO-8601 UTC
`timestamp` recorded by the CLI, and `data`. Agent frame types are `step`, `text`,
`done`, and `error`; build frame types are `progress`, `done`, and `error`.
For example:

```jsonl
{"schemaVersion":1,"command":"agent run","type":"step","timestamp":"2026-09-16T12:00:00.000Z","data":{"n":1,"tool":"computer","action":"left_click","detail":"clicked"}}
{"schemaVersion":1,"command":"agent run","type":"done","timestamp":"2026-09-16T12:00:01.000Z","data":{"steps":1,"stop":"end_turn","finished":true,"text":"Done","usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":0,"cacheWriteTokens":0},"exitCode":0}}
```

A terminal `done` frame includes `data.exitCode` and the final result. A terminal
`error` frame contains `data.error` and `data.exitCode`. Require a terminal frame
and check its exit status; progress alone is not success. Argument parsing errors
use the finite error envelope even for a requested streaming command. After
successful parsing, streaming-command failures use an `error` frame.

`ssh --json` is deliberately unsupported and fails before connecting, keeping
terminal traffic out of machine output. `scp --json` emits a finite copy result
with `source`, `destination`, `bytes`, and `confirmed`. For downloads, `bytes`
is the number written locally and `confirmed` is true. For uploads it is the
number sent; `confirmed` says whether the server acknowledged that byte count,
and `accounting` labels an unacknowledged count as `"N bytes sent"`. A short
acknowledged write is an error.

The process exits zero on success and 1 on ordinary errors, invalid template
validation, failed builds, or unfinished agent runs. Foreground exec preserves
integer remote exit codes from 0 through 255, uses 124 for a timeout, and 1 when the
reported code cannot be represented or is unknown. Cancellation exits 130.
Running `mandala` without arguments prints help and exits 2. CLI-generated output uses no
color escapes, including with `NO_COLOR` or piped output. Guest terminal and
foreground exec output passes through unchanged. TTY detection affects terminal
presentation and whether stdin can be read without prompting.

### Interactive terminals and file copies

```sh
npx --package=mandala-computer mandala ssh my-computer          # an interactive shell
npx --package=mandala-computer mandala ssh my-computer -s build # a named session
npx --package=mandala-computer mandala scp ./setup.sh my-computer:/tmp/setup.sh
npx --package=mandala-computer mandala scp my-computer:/var/log/app.log ./app.log
```

`ssh` rides the platform's terminal websocket — a PTY kept alive server-side.
Disconnecting **detaches** rather than ending it; running the same command
reattaches and replays recent output.

Output waiting for stdout is limited to 16 MiB, including writes stdout has
accepted but has not yet finished. If a
slow consumer exceeds that limit, the CLI detaches and reports a nonzero exit
code. Output that cannot drain during shutdown also reports a nonzero exit code;
pending output is discarded when the terminal is restored.

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
and `scripts/check-surface.mjs` diffs the mirror against the platform's
published surface manifest — a file the platform generates from its own tables
and commits like a lockfile — whenever the platform repository is checked out
beside this one. A manifest it cannot read is a failure, never a comparison of
nothing. A mirror
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

**Only `/api/v1`.** Never the platform's internal operator routes: nothing
user-facing was ever meant to reach them, and this client does not know they
exist. The retention WRITES are kept out for a different reason worth not
confusing with that one: `PUT /retention`
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
