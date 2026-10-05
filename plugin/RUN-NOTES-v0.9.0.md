# Run notes: plugin v0.9.0 (Handoff 27: the deck stays a connected console; Deck only arms the knobs; the last move wins)

**Base:** I ran `git pull` first, in your `~/capture-streamdeck` (already up to date) and in my clone. Both were at **`96f0d22`** (v0.8.0). You had pushed it, so bundle 0027 did not need applying. This delivery is one commit on top. **Use `capture-streamdeck-0028.bundle`.** Version **0.9.0** (manifest `0.9.0.0`).

**Restart brief sections 1–4 were followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- no keystrokes, no mouse automation, no fixture-specific names.

**Not touched:**
- the CITP allowlist and `citp.ts`;
- the declaration bytes and their timing;
- FixtureModify handling and the FixtureList patch fields (Handoff 28);
- Setup's manual addressing;
- home/resume values, pages, colour defaults, the LCD layout and `render.ts`;
- `research/`.

**Evidence I re-read before coding:** your `Claude outputs/log-v0.8.0.txt`. It shows:
- every OFF (key and idle) sends `output terminated, LeaveShow sent, CITP connection closed`;
- the declaration on every ON;
- the `disagree` lines on 201/202 during mouse moves;
- the two single-slot bursts at 14:46:07 (Ch 202, 31 lines) and 14:46:34 (Ch 201).

I built and tested everything in a Linux sandbox. **Nothing here has run on your Mac.**

## What changed (functions and line ranges in the new files)
1. **`src/fixtures/deck.ts`**
   - **What DeckControl can do:** the `DeckOptions` interface is now only `start` and `afterOff` (lines 138–149). `stop`, `release` and `onOff` are gone, so DeckControl can no longer end output or the connection, or clear the selection.
   - **`DeckControl.setOn`** (lines 210–239). ON is as before: it arms, starts the idle timer, logs, and asks for the persistent session (`link.startPersistent()` is a no-op while the session is held). OFF only:
     1. disarms;
     2. stops the idle timer;
     3. redraws;
     4. logs `deck control OFF (<why>): knobs disarmed; output and the CITP connection keep running`;
     5. saves the remembered values.

     The header comment (lines 1–14) says why, citing your log.
2. **`src/runtime.ts`** (lines 104–112): the Deck wiring passes only `start` and `afterOff`. The exit handler is **unchanged**: termination ×3 and LeaveShow on SIGTERM/SIGINT/SIGHUP.
3. **`src/fixtures/link.ts`**: doc comments only (lines 5–7, 109, 122). `stopPersistent()` is still there, but Deck Control no longer calls it. Brief connections are unchanged: before the first arm they run as before; while the session is held, a read is a list request.
4. **`src/actions/fixtures.ts`**
   - **Setup key, Setup panel and Status key** (`FixturesSetup.onKeyDown` / `onPropertyInspectorDidAppear`, lines 269–283; `FixturesStatus.onKeyDown`, line 343): they now check `rt.link.mode === "on"` instead of `rt.deck.on`. While disarmed but connected, they ask the held session for the list and open no second connection.
   - **`FixturesRelease.onKeyDown`** (lines 296–312): disarms only. The flash reads "Disarmed".
5. **`src/fixtures/engine.ts`**
   - **Header comment** (lines 8–17): describes the ownership layers.
   - **`deckSet`** in `FixState` (line 140): now means "the deck owns this parameter". It lives as long as the fixture state, and disarming no longer releases that state, so ownership survives arm/disarm and reconnects. `release()` (LeaveShow, show change, address change, exit) clears it.
   - **`takeFromCapture()`** (lines 380–396) replaces `fromCapture()`. It sets the values, **removes the parameters from the deck's ownership**, and stores them.
   - **`setKnownLevel()`** (lines 397–405) is new.
6. **`src/fixtures/service.ts`**
   - **`onCaptureLevels()`** (lines 344–403). Every knob parameter a ChBk covers (any byte) is taken over by Capture. For a 16-bit parameter covered on one byte, it first writes the other byte's last-sent value into the overlay. When the deck owned the parameter, it logs `Capture took Ch 201 "Pan" (knob 83.0 % -> Capture 74.9 %)`.
   - **`logTook()`** (lines 405–416): at most one line per parameter per second (`TOOK_LOG_MS`, line 20). Lines held back are counted into the next one: `(+N more not logged)`.
   - **`burstLog()`** (lines 418–435): single-slot messages for the same fixture less than 50 ms apart (`BURST_MS`, line 22) become one line, `Capture levels u1: 31 slot(s) -> Ch 202 (burst)`. A lone single-slot message keeps its normal line, about 50 ms later. Every message is applied at once either way.
   - **`BLACKOUT_WARNING`** (line 23): adds the stays-connected sentence.
   - The `onLinkClosed` comment changed. Its behaviour did not: it still clears the selection when the connection closes.
7. **Texts**
   - Deck key and Release key tooltips (`src/catalog/fixtures.ts` lines 77 and 80; they are copied into the manifest).
   - Setup panel (`ui/fixtures.html`): "Disarm the knobs after [N] s without fixture activity (output keeps running; 0 = never)" (same setting key, default and range), plus a new hint.
   - `ui/setup-core.js`: the ON/OFF state line.
   - README: Deck Control section.
   - Doc comment in `selection.ts`.
8. **Version 0.9.0.** The profile was regenerated: I unzipped the old and new profiles and compared them, and the only difference is the plugin version.

### Things to know
- **The 16-bit "no jump":** the explicit write of the other byte is defensive. For a parameter the deck owns, the overlay already holds both of its sent bytes (from v0.8.0's `recordDeck`). So removing the new write alone changes no test. Removing both fails 2 tests. Either one prevents the jump.
- **The bursts in your log** (14:46:07 on 202, 14:46:34 on 201, about 1.2 s after selecting 201) set the whole fixture to pan/tilt 50 %, dimmer full and so on. They look like a reset or home done in Capture. I can't tell from the log whether you did something in Capture or Capture sent it by itself. With "last move wins", such a burst now takes every channel of that fixture. If you see a light jump to home without touching it, look for a `(burst)` line at that moment.
- **Hidden Release key:** its badge still means "output active", which now stays on after the first touch.

## Verified (sandbox)
**356 plugin tests pass, 0 fail** (352 before: 4 new, and 13 rewritten for the new behaviour, listed below). Research: 81 pass. Typecheck is clean. `streamdeck validate` and `npm run pack` passed: the packed manifest says **0.9.0.0**. The fixtures inspector check passes.

**Tests rewritten on purpose** (each asserted the old OFF or "deck value kept"):
- `deck.test`: the idle-OFF steps, the key/Release steps, the "OFF stops DMX before CITP" test (now: disarm only), and the onLinkClosed test (now service-level).
- `integration-deck`: idle OFF, and resume after OFF→ON.
- `integration-fixtures`: Release, and after Release.
- `integration-selection`: OFF/ON.
- `integration-sdmx`: the disagree step and the OFF→ON step.
- `sdmx.test`: the engine fromCapture test and the service test.

**Verify list from the handoff:**
- **Disarm by key** (`integration-sdmx`): no Stream_Terminated, no LeaveShow, the stub keeps the connection, **`/proc` shows the plugin still holds its CITP socket**, and the frames are identical.
- **Disarm by idle 1 s** (`integration-deck`): the same, with `/proc` plus at least 15 frames in 600 ms, all identical.
- **Disarm by the Release key** (`integration-fixtures`): the same, with at least 30 identical frames in 1.2 s, and the Status key still shows output on.
- **While disarmed:** a ChBk on B's dimmer reaches the frames and the stored values (saved). A turn re-arms it on the same connection: still **one EnterShow and one declaration**.
- **Plugin exit (SIGTERM)** sends termination ×3 on universe 1, then LeaveShow. Checked in both `integration-deck` (restart test) and `integration-sdmx`.
- **Capture's LeaveShow:** output is released (termination ×3, as before) and the selection is cleared. After EnterShow and a new touch, B's and the spare slots are 0 again, so Capture's levels were cleared. Ownership being cleared is checked in the `sdmx.test` service test.
- **Stub drops the connection** (`integration-selection`): frames keep going with identical values and no termination, it reconnects, **declares again**, and the selection is cleared. Capture's levels are kept: checked in the engine test.
- **Last move wins:**
  - **e2e:** the knob sets A's pan; a ChBk on the pan puts Capture's value in the frames and on the strip, with exactly one `took` line. The next knob turn continues +1 % from Capture's value, not from 65 %.
  - **Service unit test:** the same steps, plus the store taking the value.
  - **16-bit, coarse only:** the fine byte stays at the knob's last-sent byte, and the other way round for fine only.
  - **Rate limit:** a second take within 1 s is held back, and the next line carries `(+1 more not logged)`.
- **Selection** survives disarm and re-arm (`integration-selection`, `integration-deck`) and is cleared when the connection closes.
- **Burst:** 31 single-slot ChBk in under 20 ms are all applied, with one summary line. Checked in a unit test, and end to end as one 31-message TCP write.
- **ChBk alone never starts a universe:** a unit test, and the e2e frames are unchanged until a touch.

**Mutation checks** (each change restored afterwards; I re-checked for leftovers):

| Mutation | Tests failed |
|---|---|
| Disarm sends termination | 6 |
| Disarm sends LeaveShow and closes | 5 |
| Selection cleared on disarm | 5 (including `integration-selection`) |
| ChBk doesn't take ownership (engine) | 2 |
| ChBk skips knob-owned parameters (service) | 3 (including e2e) |
| A universe started by ChBk | 1 |
| No burst summary | 2 |
| No took rate limit | 1 |

**Still flaky, as in v0.8.0:** `test/integration.test.ts` (AX/OSC). Unmodified v0.7.3 fails it 3 times in 8 runs. The final full run here was clean.

## NOT verified (Mac only)
- **Whether Capture keeps the lights when the deck disarms but stays connected.** This is the whole point of this version. Nothing that went to Capture changes on disarm: the frames are byte-identical and there is no LeaveShow.
- **The reset on plugin exit:** quitting the Stream Deck app still sends termination ×3 and LeaveShow, which is very likely to reset the deck-driven lights, as Deck OFF did in v0.8.0.
- **When Capture itself quits:** whether it sends LeaveShow first (then we release) or just closes (then output keeps going and we keep trying to reconnect, as in v0.5–v0.8).
- **"(Automatic)":** whether *Project console link* keeps "(Automatic)" now that there is one long connection instead of many.
- **The real bursts:** whether bursts like 14:46:07 come from something you do in Capture.
- **Rate-limit tuning:** whether one `took` line per second per parameter is the right amount during a long mouse drag.

## Your test (show COPY)
1. **Install and set up.**
   - Pull, install, and check the manifest says `0.9.0.0`. Delete and re-import the **Capture** profile.
   - Restart Capture fresh and check that *Project console link* shows **(Automatic)**.
   - Check that Setup has 201 = 1/397 and 202 = 1/444.
2. **Deck ON.** Click 201 and turn Pan: it moves. Click 202 and move it with the mouse: it holds.
3. **The fix: Deck OFF.** 201 and 202 should **stay exactly where they are**: no blackout, no home. Watch for 30 s.
4. **While OFF,** move 202 with the mouse to a new position. It should follow and hold.
5. **Deck ON,** click 201 and turn: 202 should stay where the mouse left it (no snap-back).
6. **Last move wins.** Turn 201's Pan on the deck, then move 201's pan with the mouse: it should follow the mouse. Turn the knob again: the knob takes over from the mouse position.
7. **Idle.** Leave the deck for 2 minutes: the key goes grey, and the lights stay.
8. **Exit.** Quit the Stream Deck app. Expect the deck-driven lights to reset at that moment (known); note whether they do.
9. **Log.** Save it and upload `log-v0.9.0.txt`:
   ```
   grep -h -E "Fixtures|CITP|Dial|Key press|Deck" ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/com.rezabehjat.capture.sdPlugin/logs/*.log > ~/capture-streamdeck/"Claude outputs/log-v0.9.0.txt"
   ```
