# Run notes: plugin v0.10.0 (Handoff 28: connect and declare at start-up; take fixture addresses from Capture's patch)

**Base:** I ran `git pull` first, in your `~/capture-streamdeck` (already up to date) and in my clone. Both were at **`17a7ee1`** (v0.9.0). You had pushed it, so bundle 0028 did not need applying. This delivery is one commit on top. **Use `capture-streamdeck-0029.bundle`.** Version **0.10.0** (manifest `0.10.0.0`).

**Followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- no keystrokes, no mouse automation, no fixture-specific names;
- the CITP allowlist is unchanged (no new message types, no FixtureModify/FixtureList/DMX over CITP);
- no sACN before the first fixture touch, and a ChBk never starts a universe.

**Not touched:** the declaration bytes, arming, last-move-wins, home/resume values, pages, the LCD, `research/`.

I also read your `Claude outputs/log-v0.9.0.txt` before coding:
- one persistent connection for the session;
- disarm keeps everything running;
- a 32-slot `(burst)` line on 202 at 15:59:06.

I built and tested everything in a Linux sandbox. **Nothing here has run on your Mac.**

## What changed (functions and line ranges in the new files)
1. **Persistent session from start-up**
   - **`src/runtime.ts`** (`Runtime.init`, lines 153–159): attaches the link and calls `link.startPersistent()` at plugin start. This replaces the start-up brief sync. Deck still starts disarmed. The comments (lines 61–67, 105–106) were updated, and the `CAPTURE_TEST_BRIEF_MS` hook is gone.
   - **`src/fixtures/link.ts`**, rewritten without the brief path:
     - `LinkMode` is now `"off" | "on"`.
     - **Removed:** `briefSync`, `brief`, `briefs`, `briefRun`, `briefListWaiter`, `BRIEF_TIMEOUT_MS`, and `stopPersistent` (nothing called it after v0.9.0).
     - `startPersistent()` (line 102) is a no-op while the session is held.
     - `stop()` (line 114), for plugin exit, sends LeaveShow as before.
     - `requestList()` (line 121) and `reconnect()` (line 126) act on the held session.
     - The `list` handler (lines 73–75) passes the keyed list and its `declared` flag to `svc.onPatchList()`.
   - **`src/fixtures/citpSession.ts`**
     - **Removed:** the `once` mode and `whenStopped()`. `start()` is at line 149.
     - **Declaration on every connection:** `declare()` (line 404) always runs after our EnterShow. When all 17 messages have gone out on the current socket, it sets `declarationSent` (lines 109, 304, 413).
     - **The `declared` flag:** every FixtureList event now carries `declared: declarationSent` (`FixtureListEvent`, line 68; emit at line 363). A list that arrives in the same chunk as Capture's EnterShow, before our declaration can have left, is marked `false` and is not used as the patch.
     - **No log flood:** `loop()` (lines 210–231) logs `retrying in …` once per run of failed attempts, not on every retry. The failure reason itself was already logged only when it changes.
   - **`src/fixtures/show.ts`**
     - `WAITING = "Waiting for Capture"` (line 14). `setConnected` (line 124) and the other not-connected texts now read `Waiting for Capture: <reason>`.
     - `applyList()` (line 168) returns its keyed fixtures so the service can read their patch fields.
   - **`src/actions/fixtures.ts`**
     - `FixturesSetup.onKeyDown` (lines 269–285) sends a list request on the held session. When not connected, it flashes "Waiting" and reconnects at once.
     - `onPropertyInspectorDidAppear` (lines 287–292): same behaviour.
     - `FixturesStatus.onKeyDown` (lines 347–357): same behaviour.
   - **`src/lib/render.ts`**: the Status key's head reads "Waiting" when not connected (`FixtureStatusView.waiting`, line 214; line 229).
2. **Addresses from Capture's patch**
   - **`src/fixtures/setup.ts`**
     - `Address.src?: "capture"` (lines 13–18). Entries taken from Capture's patch are stored with this mark, and `cleanAddress` (line 119) and `setMany` keep it.
     - `checkSetup()` (line 48) no longer refuses an overlap between two Capture entries. An overlap that involves a typed entry is still refused.
     - **New:** `sharedNotes()` (line 75) returns the `shares 1/285 with Ch 205` notes.
   - **`src/fixtures/service.ts`**
     - **`onPatchList()`** (lines 496–520) ignores undeclared lists. A declared Type 0 list with at least one Patched=1 makes Capture's patch the source for the current show. A declared list with none changes nothing and is logged once. Type 1/2 lists update their fixtures while the patch is active.
     - **`applyPatch()`** (lines 529–571) gives each fixture Capture's universe+1 / address+1, or no address for Patched=0, and stores them as Capture's in one save. It logs each change once (`address from Capture's patch Ch 202 … -> 1/444 (was 2/1, typed)`). A universe above 16 or a fixture past 512 is not controllable: logged, and shown on its Setup row.
     - **`logShared()`** (lines 574–587) logs each shared-slot pair once.
     - **`onModify()`** (lines 593–653): while the patch is active, a re-patch or unpatch goes through `applyPatch` (overlaps accepted). Otherwise it is unchanged.
     - **Read-only Setup:** `setAddress` and `autoFill` answer `PATCH_READ_ONLY` (line 20) while the patch is active.
     - **Show change:** `onShowGone` resets the patch state.
     - **`setupView()`** (line 239) adds `patch`, `connected`, and per row `fromCapture` and `shared`.
     - **Release first:** a driven fixture whose address changes is released by the existing `reconcile()`, as before.
3. **Setup panel** (`ui/fixtures.html`, `ui/setup-core.js`)
   - **With Capture's patch:**
     - the Universe/Address cells are read-only and marked `from Capture`;
     - Auto-fill and Clear are hidden;
     - there is one line at the top: `Addresses come from Capture's patch (N patched). Re-patch in Capture to change them.`;
     - rows show `· shares 1/285 with Ch 205`;
     - a fixture with no address reads "Not patched in Capture".
   - **Without the patch (fallback):** the panel is unchanged, except that its hint now says Capture's patch was not available.
   - **When not connected:** the show line reads "Waiting for Capture…".
   - **Texts:** the Deck key tooltip and the panel hint now say the deck connects at plugin start.
4. **Version 0.10.0.** The profile was regenerated: I unzipped the old and new profiles and compared them, and the only difference is the plugin version. The README has the patch paragraph and the start-up session.

### Things to know
- **A fixture re-patched away from its old slots:** after the release, the old slots keep the last level the deck sent there. Capture holds that level anyway, so it changes nothing in Capture. The deck no longer moves those slots.
- **A second plugin start before Capture answers:** Capture's addresses are stored. If the plugin restarts and Capture hasn't sent its list yet, the stored Capture addresses are used meanwhile, and the panel shows typed mode for that second or so.
- **Re-patching causes a reset:** the release when a driven fixture's address changes sends termination ×3 (behaviour as before). Given what Deck OFF did in v0.8.0, that may reset that light in Capture. It only happens on a re-patch while the light is being driven.

## Verified (sandbox)
**364 plugin tests pass, 0 fail** in the final run. Research: 81 pass. Typecheck is clean. `streamdeck validate` and `npm run pack` passed (**0.10.0.0**). The fixtures inspector check passes, now including patch mode, read-only, shared notes and "Waiting".

**New tests:** `test/patch.test.ts` (5) and `test/integration-patch.test.ts` (4).

**Tests rewritten because the brief path is gone:**
- `deck.test`: 3 link tests, now persistent from start, selection on close, and "no Capture at start";
- `integration-deck`: start-up and Setup/Status;
- `integration-sdmx`: start-up and Deck ON;
- `sdmx.test`: the brief test was replaced by a `declared`-flag test;
- waits in `integration-lcd`, `-lcd-offline`, `-pages` and `-selection`.

**Verify list from the handoff:**
- **Start-up** (`integration-deck`): the plugin connects and declares with no Deck press, in the exact order PNam, LaserFeedList, EnterShow, SXSr + 16 SXUS, FixtureListRequest, FixtureIdentify.
  - The session is held, and `/proc` shows one TCP socket.
  - There is no sACN, and **`/proc` shows no new UDP socket until the first knob turn**. The turn adds exactly one.
  - Setup panel, Setup key and Status key are list requests on the same connection: one EnterShow, no new PNam, no `brief sync` in the log.
- **Patch from a stub with Patched=1:**
  - **e2e:** the typed `2/1` stored in the global settings is replaced by Capture's `1/444` and logged; Patched=0 and universe 17 are not controllable; the knob drives 202 at 1/444 in the frames; typing is refused.
  - **unit:** the same, plus the stored `src: "capture"`, nothing logged on a repeat list, and the reset on a show change.
- **FixtureModify:**
  - **e2e:** a re-patch to 1/100 is logged; the driven fixture is released first (termination ×3); Setup shows 1/100; the knob drives it there; then back to 1/444.
  - **unit:** the same, plus an unpatch clearing it, a Type 1 list, and a modify without the patch bit doing nothing.
- **Overlap:** 203 and 205 both at 1/285 are both controllable, both rows show the shared note, it is logged once, and a knob on either drives 1/285 (e2e and unit).
- **Fallback:** a stub that never sends Patched=1 keeps the typed entries, logged once. The typed-overlap refusal still applies (unit, and every older integration test, whose stubs send Patched=0).
- **Universe 17 and past 512:** not controllable, logged once, shown on the row.
- **No Capture at start** (unit, real sockets): repeated back-off attempts; `Waiting for Capture: could not connect…` shown; the reason and `retrying` each logged **once**; the connection comes up and declares when the stub appears on that port.
- **`declared` flag:** a list in the same chunk as EnterShow is `false`; the list after the last SXUS is `true`; it resets and is set again after a reconnect.

**Mutation checks** (each change restored afterwards; I re-checked for leftovers):

| Mutation | Tests failed |
|---|---|
| Patch ignored | 9 |
| Typed entry wins over Capture's | 4 |
| Overlap refused for Capture's patch | 4 |
| sACN before the first touch (output started at plugin start) | 6 |
| A brief connection still opened at start-up | 5 |
| Lists before the declaration count as the patch | 1 |
| `retrying` logged on every attempt | 1 |

A first version of the sACN mutation only started the engine at plugin start. It survived, because with nothing touched the engine sends no frame and Node opens no UDP socket. The version in the table also sends a frame.

**Flaky test I did not cause:** `test/integration.test.ts` (AX/OSC; it runs with CITP off). Over the session, 3 full runs failed in that file only, and alone it failed 1 time in 5. That matches unmodified v0.7.3 (3 failures in 8). The final full run was clean.

## NOT verified (Mac only)
- **That Capture really sends Patched=1 from the plugin's own session** (as it did for the probe), including the Ch 203/205 overlap at 1/285 and the 35-of-103 count.
- **That a declared but quiet console** (from start-up, before any touch) keeps the Control Pane mouse working with no popup, over a whole session.
- **The FixtureModify contents for a re-patch while declared:** whether Capture sends the patch bit with the new address, as the plugin expects.
- **Capture quitting or reopening the show:** what Capture sends when it quits; whether the patch comes back after a reconnect.
- **"(Automatic)":** whether *Project console link* keeps "(Automatic)" with the session held from start-up.
- **A re-patch while driving:** whether the release (termination ×3) resets the re-patched light in Capture.

## Your test (show COPY)
1. **Install and set up.** Pull, install, check the manifest says `0.10.0.0`, and re-import the profile. Restart Capture fresh, and check that the console link shows **(Automatic)**.
2. **Without pressing Deck,** open Setup. The addresses should be filled from Capture with nothing typed: 201 1/397, 202 1/444, 203 and 205 1/285 (both marked as sharing), 204 1/229, 206 1/341.
3. **Also before Deck,** move a light with the mouse in Capture. It should work normally, and no popup should appear.
4. **Deck ON,** click 202 and turn Pan: 202 moves.
5. **Re-patch 202 in Capture** to a free address. Setup should show the new address by itself, and the knob should drive it there. Then patch 202 back to 1/444.
6. **Click 203 and turn Pan.** 205 shares its address, so both should move. That's expected.
7. **Log.** Save it and upload `log-v0.10.0.txt`:
   ```
   grep -h -E "Fixtures|CITP|Dial|Key press|Deck" ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/com.rezabehjat.capture.sdPlugin/logs/*.log > ~/capture-streamdeck/"Claude outputs/log-v0.10.0.txt"
   ```
