# Run notes: plugin v0.7 (Handoff 21 + addendum: Deck Control on/off, resume values, knob and page fixes, SolaFrame "Dim") + `dmx-proof --pap`

**Base:** I ran `git pull` first, both in my working clone and in your `~/capture-streamdeck`. Both are at **`d9287ca`** (v0.6, which you pushed). Bundle 0020 has not been pushed yet, so the addendum is a second commit on top of it.

**Use `capture-streamdeck-0021.bundle`:** it holds both commits (Handoff 21 and the addendum) on top of `d9287ca`, and it replaces 0020. The plugin file in `Claude outputs` is the new one with the addendum (still v0.7.0).

**Restart brief sections 1–4 were followed:**
- no push (commit and bundle only);
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- generic name rules only;
- **the CITP allowlist is unchanged** (`citp.ts` untouched). The session only gained a "one attempt, no reconnect" mode for the brief connections;
- no keystrokes and no mouse automation;
- no DMX while OFF.

I built and tested everything in a Linux sandbox against a stub Capture. **Nothing here has run on your Capture, Stream Deck or Mac.**

## What changed

### 1. Deck Control
- **OFF is the default at start-up.** No CITP session is held and no DMX is sent. The command keys and view dials work as before.
- **Brief connections read the fixture list:** PNam → EnterShow → FixtureList → FixtureIdentify (only for fixtures at 0xffffffff) → LeaveShow → close.
  - They happen at start-up, when the Setup panel opens, and when **Setup** or **Status** is pressed.
  - Each is logged with its duration: `Fixtures: brief sync (start-up): 412 ms, 23 fixture(s), connection closed`.
  - A brief connection waits up to 8 s for the list.
  - If Capture isn't there it tries **once**, shows the reason in Setup, and doesn't retry.
  - Our own close keeps the fixture list; it doesn't count as an error.
- **ON** is the v0.6 persistent session (follows the selection, picks up FixtureModify) plus DMX.
- **New key `Fixtures: Deck Control`:** amber with title "Deck ON", grey with title "Deck OFF". It replaces Release in the profile (same slot).
- **What switches it ON:** any fixture knob turn (Attribute 1–3, Select, the named dials), a strip tap (home), Home Selected, ◀ Page / Page ▶.
  - A knob **push** (fine mode) sends no DMX, so it doesn't switch ON; it only restarts the idle timer while ON.
  - Setup, Status and opening the panel only make brief connections, as the handoff lists them.
- **Idle switch-off:** "Switch OFF after N s without fixture activity" in the Setup panel. Default **120 s**, 0 = never, 0–3600 accepted, saved in the global settings.
- **Switching OFF:** Stream_Terminated ×3 on every universe in use (the DMX stops immediately), then LeaveShow, then close. Logged: `Fixtures: deck control OFF (idle 120 s): output terminated, LeaveShow sent, CITP connection closed (12 ms)`.
- **`Fixtures: Release`** is still in the action list for keys you placed earlier, but now it simply switches Deck Control OFF. It's no longer in the profile.

### 2. Resume instead of snapping to home
- The last value the deck sent for every channel of every fixture is stored **per show name** in the global settings (key `fixtureValues`). It's saved about 1 s after a change, on OFF and on exit.
- When output restarts for a fixture (after OFF, or after a plugin restart) it starts from those values. Home values are used only for channels never touched in that show.
- Home Selected and the strip-tap home store the home values.
- While OFF, the dial strips show the remembered value, marked `~`.

### 3. Knob gestures
**Push = fine mode on/off; tap the strip = home that channel.** This applies to Attribute 1–3 and the named dials. A long touch still does nothing. The manifest trigger descriptions are updated.

### 4. Main page first
Page order is now **Main · Colour · Beam · Shutters · Gobo/FX · Strobe/Shutter · Other**.
- **Main** = Attribute 1 the first pan, 2 the first tilt, 3 the first dimmer/intensity (whole word).
- A missing one shows `—`, with the name "Pan", "Tilt" or "Intensity" on its strip.
- A type with no dimmer logs its channel names once (`no dimmer/intensity channel …; channels: 1 "Pan", …`).
- Shutter/strobe channels have moved to **Strobe/Shutter**.
- The page keys show the page name only ("Main", "Colour" / "1/2"). With no fixture they show "◀ Page" / "Page ▶".
- The page resets to **Main** on a type change.

### Addendum: the real SolaFrame 750 "Standard" layout (47 ch)
- **Intensity also accepts the whole word `dim`** (after `dimmer` and `intensity`). This is generic: "Dim Coarse" is now the Main page's Intensity.
  - The named v0.5 `Fixture: Intensity` dial finds it too.
  - Names with a speed/mode/curve word ("Dim Curve") still don't count.
  - **Effect on the SolaFrame:** its dim channel now starts at 100 % (the intensity home value). In v0.7 before the addendum it was an "Other" channel at 0.
- **Labels:** a 16-bit knob whose name ends in the word "Coarse" is labelled without it ("Focus Coarse" → **Focus**, "Zoom Coarse" → **Zoom**, "Dim Coarse" → **Dim**).
  - **The pairing still comes from the library's role/pair records, not from the names.** The new test checks that, for this layout, the name-implied pairs ("X Coarse" ↔ "X Fine") agree with the records.
  - Knob names are also what multi-selection matches on. A SolaFrame's "Focus" and another type's "Focus" now move together.
- **SolaFrame Main page:** Pan (1) · Tilt (3) · **Dim** (41, 16-bit with 42).
- **Test data from your patch view** (`solaFrame750()` in `test/fixtures/synth.ts`): your 38 start channels and the 9 fine channels in the gaps (2, 4, 16, 26, 30, 33, 35, 37, 42).
  - Capture truncates the names, so everything after each truncated prefix is my guess ("Color Mix Funct…" → "Color Mix Function").
  - New tests:
    - the Setup **Channels** list gives exactly your start channels, with names matching Capture's prefixes, and 16-bit pairs exactly where Capture shows gaps;
    - Main is Pan · Tilt · Dim with the right channels.
  - This 47-channel layout also runs the parser out of its search budget, the same "uniqueness is not proven" note your real SolaFrame gives.
- **Shutter/LED is unchanged, as you asked.** "Shutter/LED F…" (39) and "Shutter/LED" (40) stay on the **Strobe/Shutter** page with the existing defaults: **the first shutter/strobe channel at 255, every later one at 0.**
  - On the SolaFrame that means **39 = 255 and 40 = 0** at first touch.
  - Their real ranges are unknown, so if the SolaFrame stays dark at Dim 100 %, these two are the first suspects. Check them on the Strobe/Shutter page.
- **Where the other SolaFrame channels land** (with my guessed full names):
  - "… Function" channels (Color Mix, Static Color, Gobo 1, Gobo 1 Rotate, Animation, Prism, LED Animation) go to **Other**, because "function" is one of the existing "not the value" words.
  - Mspeed and Control also go to Other.
  - The blades and Frame Rotation make Shutters 1/3–3/3.
  - If the real names differ from my guesses, the pages may differ. Your Channels list in Setup will show it.
- `research/` is untouched by the addendum: `dmx-proof` still doesn't know "Dim". It isn't needed for the `--pap` test on the Rogue.

### Part B: `dmx-proof --pap` (research only, no plugin change)
- After each live level frame (START code 0x00) it sends a **per-address-priority frame (START code 0xDD)**: same CID, same universe, the same sequence counter.
- Priority 100 on the test fixture's slots, **0 ("ignore my level")** on all other slots, at 40 fps.
- No 0xDD frame goes with the termination frames: Stream_Terminated ends the whole source.
- The printout says what is sent and cites the source.
- **Sources for the format:**
  - ETC sACN library docs, "Per Address Priority": https://etclabs.github.io/sACNDocs/2.0.1/per_address_priority.html (start code 0xDD, values 1–200, 0 = the receiver ignores that address's level, falls back to the packet priority if 0xDD stops);
  - ETC support, "Difference between sACN per-address and per-port priority": https://support.etcconnect.com/ETC/Networking/General/Difference_between_sACN_per-address_and_per-port_priority (an ETC **extension** to ANSI E1.31, not part of the standard; receiver support varies).
- I didn't read the E1.31 PDF itself; the packet layout is the existing level packet with only the START code and slot values changed.

## Decisions I made where the handoff didn't say (please check)
1. **While OFF, Capture's clicks don't reach the deck** (no link). The knob turn that switches ON drives the deck's **last known** selection right away: the selection from the previous ON period, or the first controllable fixture. Clicking in Capture after that works as before.
   - I don't know whether Capture sends its current selection when a console connects.
   - **If it doesn't, the first turn after OFF can move a different light than the one you just clicked.**
   - Option if that's a problem: the first turn only switches ON and moves nothing.
2. A second pan, tilt or dimmer channel (e.g. cell dimmers "Dimmer 2…") goes to **Other** (a dimmer's home is still 100 %). Names with a speed/mode/curve word ("Dimmer Curve") are never the Intensity. A type with no pan, tilt or dimmer at all has no Main page.
3. Brief connections don't wait for a verifying list after FixtureIdentify. The next brief connection or the ON session sees the identifiers. If Capture forgets identifiers when a console disconnects, each brief connection simply identifies again; that's logged and harmless.

## Verified (sandbox)
- **312 plugin tests pass** (was 296; the addendum added 2); **73 research tests pass** (was 71).
- Addendum mutation checks: without `dim` and without the "Coarse" label cleanup, the new tests fail.
- **`test/deck.test.ts`** (9 tests):
  - OFF at start; activity switches ON at once;
  - the idle timer switches OFF in the order termination → LeaveShow + close → save;
  - the key toggle; idle validation, save and load; 0 = never;
  - DMX stops synchronously on OFF, and a turn straight after still works;
  - the value memory (per show, debounced save, load, malformed entries dropped);
  - the engine sends nothing while OFF;
  - resume (pan and dimmer kept, untouched channels at home);
  - every knob and key goes through Deck Control;
  - Main "—" for a type without a dimmer, and the one-time channel-name log line;
  - **the link over real TCP sockets against the stub:** exact brief sequence, the connection closed, no reconnect over 400 ms, the list kept; the second brief connection doesn't re-identify; ON holds the session and selection arrives; OFF sends LeaveShow and closes with no reconnect; a missing Capture makes one attempt only.
- **`test/integration-deck.test.ts`** (5 tests, the built plugin):
  - start-up brief connection in the exact order, then **no socket to the stub's CITP port in the plugin process (read from `/proc`)** and no sACN for 1.8 s. The same `/proc` check sees the socket while ON, so the 0 means something;
  - Setup panel, Setup key and Status key each make a brief connection without switching ON;
  - ON by a knob turn (the turn applies at once);
  - idle 1 s → Stream_Terminated ×3, LeaveShow, close; `/proc` shows no socket afterwards; no DMX while OFF;
  - resume after OFF→ON (60 % → 65 %, not from 50 %);
  - push = fine, tap = home;
  - OFF by key; ON by Home Selected;
  - **resume after a plugin restart** (a new process continues from the stored 75 %).
- **The v0.5/v0.6 end-to-end tests still pass**, run with Deck Control ON from the start through a test-only setting. The Release test now also checks LeaveShow, close and no reconnect. The old "starts from defaults again" test is now a resume test.
- **The pages end-to-end test** now starts OFF, switches ON with the key, and uses the new page names and gestures.
- **`--pap`:**
  - byte layout: START code at byte 125 = 0xDD, 513 property values, header identical to the level packet apart from the sequence number, 100/0 slots;
  - end to end on the stub: alternating 0x00 / 0xDD frames with one sequence counter, the same CID and universe, 0xDD slots 285–292 = 100 and every other slot 0, termination on level frames only.
- **Mutation checks** (each made the tests fail, then I restored it): no release on OFF; the brief connection left open; the DMX gate ignored; no resume; activity not switching ON; the brief connection reconnecting.
- The Setup panel in Chromium: the Deck Control line, the idle field sending `{cmd:"idle"}`, and the Channels list showing "Main".
- Typecheck, `streamdeck validate`, `npm run pack`.

## NOT verified
- **On your Mac:** that the Control Pane unlocks after the deck's OFF (your `--hello` test showed disconnecting frees it; the plugin now disconnects the same way); how long brief connections take on the real Capture; whether Capture sends the selection on connect (see decision 1); whether Capture keeps the identifiers after a brief connection closes; the Deck key's look on the hardware.
- **Whether Capture honours 0xDD at all.** That's what your `--pap` run answers.
- The idle timer counts only fixture activity. Using command keys or view dials doesn't keep Deck Control ON.

## Your test
1. Get the code (this pushes v0.7 to GitHub):
   ```
   cd ~/capture-streamdeck && git pull && git pull "Claude outputs/capture-streamdeck-0021.bundle" main && git push origin main
   ```
2. Install the plugin over v0.6:
   ```
   open ~/capture-streamdeck/"Claude outputs/com.rezabehjat.capture.streamDeckPlugin"
   ```
3. Re-import the profile. In the Stream Deck app, delete the old **Capture** profile, then run:
   ```
   open ~/capture-streamdeck/plugin/com.rezabehjat.capture.sdPlugin/profiles/Capture.streamDeckProfile
   ```
   The Fixtures page should show Setup · **Deck OFF** · Home Selected · Status · ◀ Page · Page ▶.
4. Deck OFF: the mouse should work in Capture's Control Pane.
5. Click the Rogue in Capture, then turn **Attribute 1 (Pan)**. The key should turn "Deck ON" and the light should move; the pane is locked while ON. Click the light again in Capture if a different one moved (decision 1).
6. Press **Deck Control**, or wait 2 minutes. The key turns "Deck OFF" and the mouse should work again.
7. Turn Pan again. The light should continue from where you left it, not snap to home.
7b. **SolaFrame:** click it in Capture (with Deck ON). The page keys should read **Main**, and the dials **Pan · Tilt · Dim**. Turn Dim. If it stays dark, go to **Strobe/Shutter** and try "Shutter/LED" (40). In Setup → Channels, compare the full names with Capture's patch view.
8. With other fixtures on universe 1 lit by the Control Pane (and Deck OFF), run:
   ```
   cd ~/capture-streamdeck && npm run probe:dmx -- --fixture 62 --universe 1 --address 285 --color-full --pap
   ```
   Do the **other** fixtures stay as they were while the Rogue moves?
9. Send me the log lines:
   ```
   grep -E "Fixtures|CITP|Dial|Key press" ~/Library/Logs/ElgatoStreamDeck/com.rezabehjat.capture.0.log | tail -100
   ```
