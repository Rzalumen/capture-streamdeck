# Run notes — plugin v0.4 (Handoff 15: fixture knobs)

Base `4658afd` (Handoff 14). Built and tested in a Linux sandbox. **Nothing here ran against your real Capture, your Stream Deck, or your Mac.** "Verified" below means: unit tests, and an end-to-end test of the built `bin/plugin.js` against a stub CITP server, a synthetic `Library.c2z`, a fake Stream Deck (WebSocket) and a UDP listener standing in for Capture's sACN input.

Handoff 10 (v0.3.1: `...` title resolver, Camera Store page) was already in the plugin (`git log` shows it); `research/` is unchanged.

## What is in v0.4

- **Port of the proven research code** into `src/fixtures/`: `citp.ts` + `citpSync.ts` (read-only show sync, same outgoing allowlist, every send checked), `library.ts` (c2z reader), `modes.ts` (mode-block parser with the Handoff 13 ambiguity rules; the "candidates agree" check now compares every channel the plugin writes, not just pan/tilt/intensity/shutter), `sacn.ts` (E1.31 packet), `attrs.ts` (generic attribute resolver), `engine.ts` (DMX engine).
- **Show model** (`show.ts`): sync at start (and again when OSC becomes reachable if no show was read), show name from EnterShow, channel list parsed once per type, "controllable" = parsed safely + has a valid address. A fixture key is its CaptureInstanceId (identifier type 0x04), falling back to the FixtureList identifier.
- **Fixtures: Setup** key + Property Inspector (`ui/fixtures.html`): pan/tilt fixtures (or *Show all*), Capture Channel / model / mode / position hint, universe 1–16 and address 1–512, saved per show name, *Auto-fill sequential*, overlap / past-512 reporting (an overlapping or out-of-range fixture is not controllable), blackout warning. Pressing the key reads the show again.
- **Dials**: `Fixture: Select`, `Pan`, `Tilt`, `Intensity`, `Zoom`, `Focus`, `Iris`, `Red|Cyan`, `Green|Magenta`, `Blue|Yellow`, `White` (11 actions). Rotate ±1 %/tick, push or touch = fine 0.1 % (toggle, like the existing dials), long touch = home, `—` and no-op when the fixture lacks the attribute. Select rotates (wraps) through controllable fixtures; push/touch toggles single ↔ all of this type. In "all of type" the selected fixture's value is the reference and every fixture of the type is set to the result.
- **Keys**: `Fixtures: Release`, `Home Selected` (pan/tilt 50 %, intensity 100 %), `Status` (show name, "n of m ready", output on/off + universes + blackout reminder).
- **DMX engine**: nothing is sent, and no socket is even created, until a user touch; a universe is sent only after a fixture on it was touched; 40 fps until Release or exit; 3 × Stream_Terminated per universe on Release and on SIGTERM/SIGINT/SIGHUP. First touch starts from defaults (pan/tilt 50 %, intensity 100 %, shutter 255, every additive colour channel full including amber/lime/UV, everything else 0). All other slots of that universe are 0 (disclosed on the Setup page and Status key). **Changing the setup, or reading a different show, releases output first** (my addition: avoids stale addresses staying live). **Release also forgets the fixture states**, so the next touch starts from the defaults again (my interpretation of "first touch").
- **Profile**: HOME slot 8 = **Fixtures**; Look is now the last item of the View chain (View › … › Look ▸). Fixtures folder = 4 pages (More ▸ chain), each with Back · Setup · Release · Home Selected · Status; dials Select·Pan·Tilt·Intensity / Select·Zoom·Focus·Iris / Select·Red|Cyan·Green|Magenta·Blue|Yellow / Select·White + 2 empty. The profile checker now allows a fixture page with fewer than four dials. **The Fixtures pages keep More ▸ in the bottom-right key, with two empty keys before it** (the other folders fill in order).
- **Global settings fix (real hazard)**: `setGlobalSettings` replaces the whole object, so the existing dial value store would have wiped the fixture setup (and vice-versa). Both now go through `src/lib/globals.ts` (read, merge own keys, write, one writer at a time; a failed read never writes).
- Version 0.4.0 (package.json, `src/version.ts`, manifest 0.4.0.0). 169 actions (was 154: 15 new).

## Verified (sandbox)

- Plugin: **254 tests pass** (28 new unit tests in `test/fixtures.test.ts`, 8 end-to-end in `test/integration-fixtures.test.ts`, existing ones updated for the new layout/counts). Research: 64 pass, unchanged. `npm run typecheck` clean. `streamdeck validate` passes; `npm run pack` → `com.rezabehjat.capture.streamDeckPlugin` 0.4.0.0.
- Unit: address setup saved/reloaded per show and keyed by instance id; ranges; overlaps; 512 limit; auto-fill (wrap, universe 16 limit); selection stepping and single/type toggle; additive vs subtractive resolution (and "both present → additive"); whole-word / not-the-value rules; dial maths (1 %, 0.1 %, clamp, no drift, 16-bit coarse+fine); default state; nothing sent / no socket before a touch; termination ×3 on every universe on Release and nothing afterwards; release on setup change; global settings merge.
- End to end: the plugin reads the stub show over CITP (only allowlisted messages sent), no DMX for 500 ms and while setting addresses and selecting; Setup via the PI messages (range error, `1/285` for Channel 203, overlap reported, auto-fill → 285 / 299); strips (`Rogue R2X Wash` / `Ch 203 · 1/285`, `—` for Focus, `ALL`/`FINE` marks); first touch → sACN universe 1, priority 100, ≈ 40 fps, defaults on the right slots, pan 16-bit, every other slot 0; fine mode, long-touch home, colour dial, all-of-type, Home Selected; Release → 3 terminated frames then silence; new touch restarts from defaults; SIGTERM → termination frames.
- Setup page checked in Chromium (`node scripts/check-fixtures-inspector.mjs`): listing, *Show all*, set/clear/auto-fill/resync messages.

## NOT verified — please check on the Mac

1. **Real Capture**: the show read, the library parse of your actual Rogue, and whether Capture's sACN input actually takes this stream. The research proof (`dmx-proof`) showed it does, with sACN universe = Capture universe number and unicast `127.0.0.1` + multicast; the plugin uses the same packet builder and destinations, but this exact code path has not run against it.
2. **CaptureInstanceId** format: assumed identifier type 0x04, keyed by its GUID/value. If your Capture sends something else, the key falls back to the FixtureList identifier (which may not be stable across show reopen).
3. **Position hint orientation** (`SL`/`SR`, `DS`/`US`): from the CAEX description (right-handed, Z downstage, Y up → +X = stage left), not checked against a real show.
4. **Exit**: termination frames go out on SIGTERM/SIGINT/SIGHUP. If Stream Deck kills the plugin with SIGKILL they cannot; receivers drop an sACN source after ~2.5 s without data anyway. I do not know which signal Stream Deck uses.
5. **Strip layout** on the real hardware (`layouts/select.json`, text sizes) and the key art were checked only as rendered images.
6. The **profile** was only structurally checked (`checkProfile`), as in earlier versions; re-add it (or double-click it) to get the new HOME layout. Existing profiles are not changed.
7. Plugin-side CITP sync runs `lsof` (blocking, short) when Capture's UDP announcement is not heard within 5 s, as in the research tool.

## Residual risks

- **Blackout**: while output is on, every slot of a touched universe that is not a touched fixture is 0 — including other fixtures in Capture's patch on that universe. Use *Release* when done.
- A channel named in an unusual way (no pan/tilt/dimmer word) is simply not controllable; there are no fixture-specific rules by design. Fixtures with an unreadable channel list can never be controlled.
- Shutter is fixed at raw 255 on first touch (a guess that is "open" on most fixtures; some fixtures treat 255 as strobe). There is no shutter dial.
- "All of type" groups fixtures with the same model **and** mode **and** channel count.

## Your test

1. Install `com.rezabehjat.capture.streamDeckPlugin` (0.4.0.0) and add the new profile.
2. Open the show copy in Capture. In **Fixtures: Setup** (select that key, look at its Inspector) wait for the show to appear, enter the Rogue at Channel 203 → universe **1**, address **285**.
3. Fixtures folder (HOME bottom-right): turn **Select** to that Rogue, then turn **Pan / Tilt / Intensity**. It should stay lit and respond.
4. Press **Release**.

Please paste the plugin log (`~/Library/Logs/ElgatoStreamDeck/com.rezabehjat.capture.0.log`, lines starting `Fixtures:` / `CITP:`), especially if the Setup page shows no fixtures or "not read safely".
