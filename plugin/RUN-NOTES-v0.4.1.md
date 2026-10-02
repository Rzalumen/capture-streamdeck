# Run notes — plugin v0.4.1 (Handoff 16: Fixture setup opens in the browser)

Base `2349f81` (v0.4). Built and tested in a Linux sandbox. **Nothing here ran against your real Capture, Stream Deck or Mac.**

## Why
Your v0.4 test: the show read worked (`FixtureList received: 101 fixture(s)`, 16/16 types parsed safely, Rogue R2X Wash included), but the `Fixtures: Setup` Property Inspector never appeared in the Stream Deck app, so no address was saved. I do not know why the inspector did not show; v0.4.1 does not depend on it.

## What changed
- **Pressing `Fixtures: Setup` opens a local web page** in the default browser (macOS `open`). The plugin serves it from an HTTP server bound to **127.0.0.1 only**, random port, random 24-byte token in the address (`/?t=<48 hex>`). **Every request needs the token** (403 otherwise, also for unknown paths); a Host header other than `127.0.0.1:<port>` is refused too (DNS rebinding); POST must be `application/json`, max 64 KB; only four fixed files are served. The server starts on the first press (nothing listens before). The token is never logged.
- **The page** (dark, same style): show name, fixtures (pan/tilt types first, *Show all* toggle) with Capture Channel, model, mode, position hint, **Universe/Address inputs saved immediately on change**, inline error under the row (range / overlap / past 512), *Auto-fill sequential* per type, *Read the show again*, blackout warning. It refreshes itself every 2 s.
- **One code path**: the page and the Property Inspector use the same commands (`setupCommands.ts` → `FixtureService`: validation, storage, overlap check) and the same table code (`ui/setup-core.js`). Nothing else about the storage changed.
- **Inspector kept**, and now logs `Fixtures: setup inspector opened` (Stream Deck's `propertyInspectorDidAppear` event), so the next log tells us whether it ever appears.
- **Logs**: every setup change, e.g. `Fixtures: set Ch 203 Rogue R2X Wash -> 1/285`, `Fixtures: cleared Ch 204 …`, auto-fill (one line per fixture, `(auto-fill)`), and refused ones (`… -> 1/600 rejected: …`). Also `Fixtures: setup page: listening on 127.0.0.1:<port> …` and `Fixtures: setup page opened in the browser (http://127.0.0.1:<port>/)`.
- **Key text**: while nothing is configured the Setup key says `Setup ▸ press`, the Select strip `No fixture` / `Press Setup`. After a save the Select dial updates at once; with exactly one controllable fixture it is selected (the selection always falls to the first controllable fixture).
- Pressing Setup also reads the show if it has not been read yet (idle or failed); *Re-read* is on the page.
- Version 0.4.1 (manifest 0.4.1.0). No change to CITP (still read-only, same allowlist) or to DMX (nothing before a touch).

## Verified (sandbox)
- **261 plugin tests pass** (7 new end-to-end in `test/integration-setup-page.test.ts`: key press opens a loopback URL with a 48-hex token and the token is not logged; 403 without/with a wrong token on every route incl. API and unknown paths, wrong Host refused; loopback-only bind (127.0.0.2 and any LAN address refuse the connection); page + assets served with the token, 404/405/415/400/413 on bad requests; save/validate round trip over HTTP (range error, Ch 203 → 1/285, overlap, auto-fill, clear) stored in the same global setting the Inspector uses, with the log lines; the Select strip updates at once, auto-selects the only fixture and goes back to `Press Setup`; then a Pan turn starts the output; Re-read; the Inspector still works). I also broke the bind (0.0.0.0) and the token check in the built bundle once each to confirm the tests fail then.
- Research tests unchanged (64), typecheck, `streamdeck validate`, `npm run pack`.
- The page was driven in Chromium against the real server (`node --import tsx scripts/check-setup-page.mjs`): typing Universe then Address saves at once, inline error, auto-fill, show-all, re-read, 2 s refresh, wrong token → 403; screenshots looked right. The Inspector check still passes.

## NOT verified
- On your Mac: that `/usr/bin/open` opens the page, that your browser accepts `http://127.0.0.1:<port>/` (a browser or security tool that blocks local pages would show an error instead), and that the Stream Deck app lets the plugin listen on a local port.
- Everything listed as not verified in `RUN-NOTES-v0.4.md` (real sACN into Capture, CaptureInstanceId format, position-hint orientation, exit signals, strip layout on the hardware).
- The token sits in the browser's address bar/history for the life of this plugin run (a new one each time the plugin starts).

## Your test
1. Install v0.4.1.
2. Press **Setup** on the deck. The browser opens. Next to **Channel 203** type **1** and **285**.
3. The Select strip shows the Rogue. Turn Pan, Tilt and Intensity. Press **Release** when done.

If nothing opens: send the log lines starting `Fixtures:` (look for `setup page: listening` and `could not open the setup page`).
