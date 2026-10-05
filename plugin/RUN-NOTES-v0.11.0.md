# Run notes: plugin v0.11.0 (Handoff 30: Wake, automatic and by key)

**Base:** I ran `git pull` first, in your `~/capture-streamdeck` and in my clone. GitHub's `main` is at `3b763ea` (v0.10.0). The Handoff 29 commit `3a3c09b` (v0.10.1, bundle 0030) is not on GitHub yet, so this commit sits on top of `3a3c09b`. **Apply `capture-streamdeck-0030.bundle` first if you haven't, then `capture-streamdeck-0031.bundle`.** Version **0.11.0** (manifest `0.11.0.0`).

This is the **replacement Handoff 30** (with point 7, the automatic wake).

**Followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- no keystrokes, no mouse automation, no fixture-specific names.

**Not touched:** CITP, the declaration, patch handling, arming, the last-move-wins rule, how values are stored, pages, the LCD, `research/`.

I built and tested everything in a Linux sandbox. **Nothing here has run on your Mac.**

## ⚠ One point in your test plan will not happen as written (step 4)
Step 4 says: move a woken light with the mouse, press **Wake**, and it should jump back. **It won't.**
- The last-move-wins rule (v0.9.0) stores what Capture reports (ChBk) as that light's value, exactly as a knob move would.
- So after a mouse move, the deck's memory holds the mouse position, and Wake puts the light back **to where the mouse left it**.
- The handoff also says not to change how values are stored, so I left that rule as it is. The sandbox test shows this: after a ChBk sets Ch 201's dimmer to 40, the next automatic wake sends 40, not the old 50 %.

What Wake does restore is what the deck remembers **at the time you press it**. In the reopen case (steps 3–4), that is the state before Capture quit. That's the point of the feature, and it works in the sandbox. If you want Wake to restore a "snapshot" that mouse moves don't overwrite, that needs a separate stored snapshot. It would be a new handoff.

## What changed
1. **`src/fixtures/engine.ts`**
   - `hasStored(key)` (lines 277–279).
   - `wake(targets)` (lines 281–309), quoted:
     ```ts
     wake(targets: Target[]): string[] {
       const woken: string[] = [];
       for (const t of targets) {
         const stored = this.o.resume?.(t.key);
         if (!stored?.size) continue;
         const st = this.touch(t);
         const params: Param[] = [];
         for (const p of t.model.params) {
           const v = stored.get(p.id);
           if (v === undefined) continue;
           st.values.set(p.id, clamp(v));
           st.deckSet.delete(p.id);          // resumed, NOT knob-owned
           params.push(p);
         }
         this.recordDeck(st, params);        // also what Capture is told from now on
         woken.push(t.key);
       }
       if (!woken.length) return woken;
       this.start();                         // Wake counts as a touch: output starts
       this.emit();
       return woken;
     }
     ```
   - **Not gated by the knob arming** (`allowed()`), because Wake is not a knob move.
   - **Writes the stored bytes into the overlay** (`recordDeck`). Without this, an older ChBk level for the same slot (overlay above resumed values in the frame) would hide the woken value.
   - Comments at lines 15–16 and 386.
2. **`src/fixtures/service.ts`**
   - `DeckHooks` gains `autoWake` / `setAutoWake` (lines 164–166).
   - `WakeResult` and `AUTO_WAKE_HINT` (lines 169–180).
   - `setupView().deck` now carries `autoWake` (lines 91 and 294).
   - Pending-state fields (lines 191–194). `onShowGone` and `onLinkClosed` clear the pending automatic wake (lines 352 and 369).
   - **New section (lines 498–553):**
     - `wake(auto)`: the key's and the automatic Wake; quoted above in the handoff's terms.
     - `onShowEntered()`:
       ```ts
       onShowEntered(): void { this.autoWakePending = !!this.deck?.autoWake && !this.engine.active; }
       ```
     - `afterList(type, declared)`: runs a pending automatic wake on the first **declared** full list, after `onPatchList` has applied Capture's patch. When the patch is not available, it falls back to the typed addresses.
3. **`src/fixtures/link.ts`** (lines 66 and 77–78):
   - The `show` handler calls `svc.onShowEntered()` after the show-change handling.
   - The `list` handler chains `svc.afterList(...)` after `svc.onPatchList(...)`.
4. **`src/fixtures/deck.ts`** (`DeckControl`):
   - `autoWake = true` (line 154);
   - `load()` reads `fixtureDeck.autoWake` (lines 172–178);
   - `settings()` / `setAutoWake()` (lines 184–202);
   - `setIdleSeconds` now saves both fields (line 210).
   - Stored as `fixtureDeck: { idleSeconds, autoWake }` in the global settings. A setting saved before v0.11.0 has no `autoWake`, so it reads as **on**.
5. **`src/fixtures/setupCommands.ts`**: a new command, `{cmd: "autowake", on}` (lines 14–15, 19 and 34–35).
6. **`src/actions/fixtures.ts`**: `FixturesWake` (lines 340–360).
   - Face `WAKE`.
   - Flash for 2 s: `Woke N`, or `Waiting` / `Nothing stored` (in red).
   - A `Key press` log line.
   - Registered in `src/plugin.ts` (lines 10 and 45).
7. **`src/catalog/fixtures.ts`**:
   - `FIXTURE_KEY_UUIDS.wake = com.rezabehjat.capture.fixtures.wake`;
   - `WAKE_TOOLTIP` (your text, verbatim);
   - the key entry "Fixtures: Wake", title `WAKE`, icon `fx-wake`;
   - the profile position `"2,0"`.
   - The Deck Control tooltip now says "no DMX until a fixture is touched or woken: see Wake", because it was no longer true.
8. **`src/lib/icons.ts`**: the `fx-wake` glyph (a rising sun). Images were generated for the actions list, the key and the profile.
9. **Profile** (`src/profile/layout.ts` comments, regenerated): the Fixtures page is now **Back · Setup · WAKE · Deck Control / Home Light · (empty) · ◀ Page · Page ▶**.
10. **Setup panel** (`ui/fixtures.html`, `ui/setup-core.js`):
    - Under Deck Control, a checkbox **Wake automatically when Capture opens the show** (on by default), with your hint text under it.
    - The Deck Control hint now ends "…no DMX until a fixture knob or key is used, or a Wake".
11. **Docs:** a new "Wake (v0.11.0, Handoff 30)" section in the README (your tooltip text, verbatim), and the layout lines in the README and `DEFAULT-LAYOUT.md`. While there, I fixed the stale page order in `DEFAULT-LAYOUT.md` (it still said Colour · Beam · Shutters).
12. **Version 0.11.0:** `src/version.ts`, `package.json`, `test/manifest.test.ts` and `test/profile.test.ts`.

### Behaviour details (my choices where the handoff was silent)
- **Which fixtures:** those that are controllable: an address (Capture's patch, or typed in fallback), a safely parsed type, and no address problem. An addressed fixture whose type didn't parse can't be driven, so it isn't woken or named.
- **`Waiting`** shows when the session isn't connected **or no show has been entered**.
- **`Nothing stored`** shows when none of the show's controllable fixtures has stored values.
- **When the automatic wake can fire:**
  - It is armed on every EnterShow, if the setting is on **and the engine is not running**.
  - It runs once, on the next declared Type 0 list.
  - LeaveShow and a show change release output, so they always allow a wake.
  - A reconnect while output runs never does.
  - A dropped connection before the list arrives cancels it, and the next EnterShow decides again.
- **The automatic wake with nothing stored** logs `Wake (automatic): nothing stored for show "…" (N addressed fixture(s)): nothing sent` once per show for the life of the plugin. The key logs every press.
- **Log lines** (the `Fixtures:` prefix comes from the logger):
  - `Fixtures: Wake: 3 fixture(s) restored on universe(s) 1, 2`
  - `Fixtures: Wake: no stored values for Ch 204 Rogue R2X Wash (not woken)`
  - `Fixtures: Wake (automatic): 3 fixture(s) restored on universe(s) 1, 2`

## Tests
**New: `test/wake.test.ts` (unit, 6 tests).** These use the real `CitpSession`, `CitpLink`, `FixtureService`, `DmxEngine`, `DeckControl` and `ValueMemory` against the stub Capture over TCP:
- the setting: default on, saved beside the idle time, loaded, and pre-v0.11 settings read as on;
- `engine.wake`:
  - exact bytes per stored parameter, home values for unstored channels, and the unstored fixture's slots at 0;
  - only the woken universes;
  - started while disarmed;
  - not deck-owned, and recorded in the overlay;
  - a second Wake gives identical frames on the next tick, with one transport;
- Wake on a knob-owned fixture gives up ownership;
- `service.wake` against Capture's patch:
  - Woke 3 on u1+u2, with the Ch 204 line;
  - not armed, selection unchanged;
  - twice gives the same frames;
  - a ChBk afterwards is taken by Capture, with no "Capture took" line;
  - waiting, and nothing stored;
- the automatic wake: plugin start → one; drop + reconnect while running → none; LeaveShow + EnterShow + declared list → one; a different show with nothing stored → none, logged once; setting off → none;
- the automatic wake on typed addresses (fallback).

**New: `test/integration-wake.test.ts`** (the real built plugin, the fake Stream Deck app, the stub Capture with patch, a UDP sACN listener, `/proc`; 7 tests):
- start-up with the setting off: no wake, no sACN, no sACN socket;
- Wake key:
  - face `WAKE`, flash `Woke 3` (still there at 1.3 s, gone by about 2 s);
  - u1 and u2 frames carry exactly the stored values; Ch 204 is at 0 and logged;
  - the Deck key stays grey, there's no "deck control ON", and the selection strip is unchanged;
  - `/proc` shows **no sACN socket before, exactly one after**;
- Wake twice: identical frames, still one socket;
- a ChBk on a woken channel reaches the frames and the store, with no "Capture took";
- automatic:
  - setting saved;
  - drop + reconnect while running → none;
  - LeaveShow + EnterShow → exactly one, with frames = stored values (Ch 201's dimmer is now Capture's 40, see the ⚠ above);
  - setting off → none and nothing sent;
- another show with nothing stored: `Nothing stored`, nothing sent;
- plugin restart with stored values and the setting on: exactly one; then the stub closes and Wake shows `Waiting`.

**Existing tests changed** (expected by the new behaviour):
- `integration-deck`:
  - the panel's deck view and the saved `fixtureDeck` now include `autoWake: true`;
  - the "resume after a plugin restart" test now expects the automatic wake to send the stored 75 % at start (not armed), and the first turn still continues from it (→ 70 %).
- `integration-fixtures` "connection lost": after LeaveShow + EnterShow it now expects exactly one automatic wake (before: "no DMX until a touch").
- `integration-sdmx` "LeaveShow clears Capture's levels": switches the automatic wake off first, because that test is about the overlay being forgotten. Otherwise the wake would legitimately put the stored values back.
- Action counts 177 → 178 (`manifest.test`, `integration.test`), the fixture key name list, the profile's Fixtures page test, and the `deck.test` saved-settings object.
- `scripts/check-fixtures-inspector.mjs` (dev check, not in `npm test`):
  - new checks for the checkbox, its label, the hint, and the `autowake` commands;
  - **one stale expectation fixed.** It still expected the v0.10.0 page title `Beam · Shutters` for "Shutter 1B". I confirmed it fails the same way on the untouched `3a3c09b` (it should have been updated in Handoff 29); it now expects `Shutters 1/2`.

**Results:**
- `npm test` in `plugin/` (gen + build + all suites): **377 pass, 0 fail**;
- research `npm test`: **81 pass**;
- `tsc --noEmit`: clean;
- `scripts/check-fixtures-inspector.mjs`: OK;
- `streamdeck validate`: successful;
- `npm run pack`: **0.11.0.0**.

## Mutation checks
Each was applied alone, then `test/wake.test.ts` and (after a rebuild) `test/integration-wake.test.ts` were run, then the code was restored and rebuilt.

| Mutation | Unit fails | Integration fails |
|---|---|---|
| automatic wake also fires on a plain reconnect (`&& !this.engine.active` removed) | 1 | 1 |
| automatic wake fires with the setting off (both `autoWake` checks removed) | 2 | 2 |
| Wake doesn't start the universe (`this.start()` removed) | 3 | 5 |
| Wake marks values knob-owned (`deckSet.add` instead of `delete`) | 3 | 1 |
| Wake arms the knobs (`deck.activity("Wake key")` added) | 2 | 2 |

**A note on the knob-owned mutation.** Since v0.9.0, a ChBk takes a parameter **whether or not** the deck owns it (`takeFromCapture`). So with this mutation the frames still follow Capture.
- **What fails:** the ownership flag (`isDeckSet`, unit) and the `Capture took …` log line, which only appears for deck-owned parameters (integration).
- I confirmed the integration failure is that assertion (`no 'Capture took': the woken value was not knob-owned`).

## Profile
I unzipped the old (`3a3c09b`) and new profiles, normalised the version, and ran `diff -rq`. The only differences:
- the Fixtures page's `manifest.json`: one new key at `Keypad 2,0`, "Fixtures: Wake", UUID `com.rezabehjat.capture.fixtures.wake`, title `WAKE`;
- that key's image (one new PNG);
- the version.

Page count 27, keys 194 (one more).

## NOT verified
- **Nothing ran on your Mac.** The stub Capture is mine. It reports the patch only after the declaration, like your Capture did in v0.10.0.
- **What Capture sends when it quits, or closes the show.** Your logs in `Claude outputs/` don't show this.
  - **If Capture sends LeaveShow:** output is released, and the reopen gives one automatic wake.
  - **If it only drops the connection:** output keeps running, and by the handoff's rule ("not on a mere reconnect while output is running") **no** automatic wake runs. The lights should then come back from the frames that never stopped. Those frames carry the deck's values and Capture's last reported levels for the touched fixtures.
  - **What to look for in the log:** `Fixtures: Capture left the show` (LeaveShow) or only `CITP: connection to Capture closed`, followed by whether `Fixtures: Wake (automatic)` appears.
- **That Capture applies the woken values as soon as the show opens.** The automatic wake runs right after the first declared FixtureList, and the timing on the real Capture is unknown. If Capture only starts accepting sACN a little later, the first frames are ignored; output then keeps sending at 40 fps anyway.
- **How long the flash text `Nothing stored` looks on the real key.** It is drawn at the minimum flash size (14 px).
- **The known limit:** lights on a woken universe that the deck has no memory of, and that Capture hasn't reported since the connection, go to 0.

## Reza's test plan (show COPY)
1. Pull. If needed, apply `capture-streamdeck-0030.bundle`, then `capture-streamdeck-0031.bundle`. Install `com.rezabehjat.capture.streamDeckPlugin`, check that the manifest says `0.11.0.0`, and **re-import the profile**. The Fixtures page should read Back · Setup · **WAKE** · Deck Control.
2. Open **Setup**. Under Deck Control, **Wake automatically when Capture opens the show** should be ticked, with the hint under it.
3. **Position the lights.** With the deck, move 201 and 202 somewhere obvious. Also move one more patched light with the mouse.
4. **Reopen.** Quit Capture **without saving**, then reopen the show copy.
5. **Don't touch anything.** 201, 202 and the mouse-moved light should go back to where they were by themselves. The log should show `Fixtures: Wake (automatic): N fixture(s) restored on universe(s) …`.
6. **Press Wake.** The key flashes `Woke N`, and the lights stay where they are.
   - **Then move one of them with the mouse and press Wake again.** Per the ⚠ above, I expect it to **stay where the mouse put it**, because the mouse move is now the stored value. Please tell me what you see.
7. Note which other lights on universe 1 went dark when the show opened (the known limit).
8. Optional: untick the setting, quit and reopen Capture. Nothing should move by itself until you press Wake.
9. Save the log and upload it:
   ```
   grep -h -E "Fixtures|CITP|Dial|Key press|Deck" ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/com.rezabehjat.capture.sdPlugin/logs/*.log > ~/capture-streamdeck/"Claude outputs/log-v0.11.0.txt"
   ```

## Delivered (in `Claude outputs/`)
- `capture-streamdeck-0031.bundle` (`3a3c09b..main`, one commit);
- `com.rezabehjat.capture.streamDeckPlugin` (0.11.0.0);
- `run-notes-plugin-v0.11.0.md` (this file).
