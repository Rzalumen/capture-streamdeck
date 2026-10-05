# Run notes: plugin v0.8.0 (Handoff 26: declare sACN universes over CITP SDMX; use Capture's ChBk levels)

**Base:** I ran `git pull` first, in your `~/capture-streamdeck` (already up to date) and in a fresh clone from GitHub. Both were at **`f2f1645`** (Handoff 25, the research SDMX probe), which is already on GitHub's `main`, so bundle 0026 did not need applying. This delivery is one commit on top of it. **Use `capture-streamdeck-0027.bundle`.** Version **0.8.0** (manifest `0.8.0.0`).

**Followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- no keystrokes, no mouse automation, no fixture-specific names;
- no DMX over CITP, and no DMX while Deck is OFF;
- the live CAEX patch addresses are not used (Handoff 27), and Setup's manual addressing is unchanged;
- home/resume rules, pages, selection rules and the LCD line are unchanged. The one exception is the strip values, as the handoff allows;
- `research/` is untouched.

**Evidence I checked before writing code:** I read your real `reports/citp-sdmx.txt` from 2026-10-05 on your Mac. I read it only and did not commit it. All tests use its bytes as literal vectors:
- the Capa;
- all 17 declaration messages;
- the six ChBk messages.

I built and tested everything in a Linux sandbox. **Nothing here has run on your Mac, a real Capture or a real Stream Deck+.**

## What changed
1. **Allowlist** (`citp.ts`): `isAllowedOutgoing(msg, {sdmxDeclare: true})` accepts **only** our own well-formed SXSr and SXUS. Well-formed means:
   - the declared size equals the real size;
   - a single part;
   - one null-terminated `BSRE1.31/<u>/1` with nothing after it;
   - universe 1–256 and sACN channel exactly 1;
   - for SXUS, index = u − 1.

   It is tighter than the research copy, which allowed universes up to 63999 for SXSr. The default is unchanged: every SDMX message is refused.

   Never sent, with or without the option: ChBk, ChLs, Capa, UNam, EnId, and every CAEX code that was refused before.

   The plugin's allowlist never had an `identify` option. FixtureIdentify is gated only by being well-formed, as before. The test passes `{identify: true}` anyway and checks that it is refused.
2. **Declaration** (`citpSession.ts`): on the **persistent (Deck ON) session only**, right after our EnterShow, it sends:
   - SXSr `BSRE1.31/1/1`;
   - SXUS for universes 1–16.

   It goes once per connection, and again after a reconnect's EnterShow. Brief connections send no SDMX. Only this path passes `{sdmxDeclare: true}`.

   Log lines:
   - `CITP: SDMX Capa received: 2, 3, 4, 101, 102, 105`. This one also appears on brief connections; nothing is sent back.
   - `CITP: declared sACN universes 1-16 (SXSr + 16 SXUS)`.
3. **ChBk** (`citp.ts` decode, `citpSession.ts` → `link.ts` → `service.ts` → `engine.ts`): ChBk is used only on the ON session.
   - **Malformed** (truncated, trailing bytes, count 0, past slot 512): logged with its hex (`CITP: SDMX ChBk malformed (…); ignored. hex: …`). Nothing is applied and nothing throws.
   - **Blind=1:** `Fixtures: Capture levels u1 a449 Blind=1: blind (preview) levels, ignored`.
   - **Engine overlay:** each universe keeps Capture's last known levels. A frame is built in three layers:
     1. the touched fixtures' channels the deck did *not* move this ON period, at their stored values;
     2. Capture's known levels on top (0 where nothing is known);
     3. the channels the deck moved this ON period on top of everything.

     The overlay survives Deck OFF→ON and reconnects. LeaveShow and a show change clear it.
   - **Value store:** a ChBk on a configured fixture updates the stored values (`fixtureValues`) of every channel the deck did not move this ON period. A 16-bit channel is stored exactly when its coarse and fine bytes are known. Channels the deck moved keep the deck's value. If Capture's value is different, this is logged:

     `Fixtures: Capture levels u1 a285-288 disagree with channels the deck set (deck value kept; possibly Capture echoing our sACN): Ch 203 "Pan": Capture 0.4 %, deck 65.0 %`

     An exact echo of the deck's own value is not logged.
   - **Strips:** untouched channels show the ChBk value as the remembered `~` value. No render code changed: the strips already read the stored value.
   - **Logs:** `Fixtures: Capture levels u1 a444-447 = 22,179,220,176 -> Ch 202 ch 1-4`, and `Fixtures: Capture levels u1 a50-53 = 5,6,7,8 (no configured fixture) -> overlay only`. A block that partly overlaps a fixture adds `; N slot(s) on no configured fixture -> overlay only`.
4. **Version 0.8.0** in `package.json`, `src/version.ts` and the generated manifest. The profile was regenerated: I unzipped the old and new profiles and compared them, and the only difference is the plugin version in the key entries. The README has the SDMX and ChBk paragraphs.

### Two things I added beyond the letter of the handoff (please check you agree)
- **The overlay is also fed by values the deck sets, not only by ChBk.** With ChBk alone there is a bug:
  1. Capture reports fixture B's dimmer = 200.
  2. The deck then sets B's dimmer to 50, so Capture now shows 50.
  3. Deck OFF → ON, and the deck drives only A.
  4. B's slots come from the overlay, which still says 200, so B jumps back to 200.

  Capture keeps the last levels it received (verified on your Mac). So when the deck sets a channel, that value is written into the overlay at once.

  Channels the deck did **not** set are not recorded. A fixture touched for the first time still starts from its stored or home values, as before. I tried recording whole frames, and it broke that rule: the existing resume test caught it.
- **Setup panel warning text:** it said every slot not set by a touched fixture is 0, which is no longer true. It now says such slots are sent at Capture's last reported level, or 0 if nothing was reported since the deck connected.

### Hidden channels
Hidden channels (Handoff 22) are not knob parameters, so the deck never writes them. On a universe the deck drives, a hidden channel now carries Capture's reported level when known, and 0 otherwise. Before this version it was always 0. Sending Capture its own value back changes nothing in Capture, while forcing 0 would be exactly the stomping this handoff removes. Hidden channels are still never stored.

## Verified (sandbox)
**352 plugin tests pass, 0 fail** (337 before: 15 new). Research: 81 pass. Typecheck is clean. `streamdeck validate` and `npm run pack` passed: the packed manifest says **0.8.0.0**, and the bundled `bin/plugin.js` contains the declaration and ChBk code. The fixtures inspector check (`scripts/check-fixtures-inspector.mjs`) passes.

New unit tests (`test/sdmx.test.ts`, 10):
- **Bytes:** `buildSxsr(1)`, `buildSxus(1..16)` and the whole `buildDeclaration()` are byte-identical to the 17 hex lines in your real report. They are compared against literal hex, not the builder.
- **Allowlist:** each of the 17 is refused by default and with `{}`, `{sdmxDeclare:false}`, `{identify:true}` and a truthy non-boolean. Each is accepted only with `{sdmxDeclare:true}`.

  With the option on, all of these are still refused:
  - the wrong SXUS index, both ways;
  - a declared size ±1;
  - a trailing byte, a second string, a missing terminator;
  - an Art-Net string, sACN channel 2 or 0;
  - universe 0, 257, 999 or 1000;
  - a leading zero, a lower-case prefix, an empty or missing string;
  - a multi-part header, part 1, a bad cookie;
  - the real ChBk, ChLs, the real Capa, UNam, EnId, an unknown type;
  - FixtureList, FixtureModify, FixtureRemove and FixtureSelection.

  The old CAEX allowlist and FixtureIdentify behave as before.
- **Decoder:** the six real ChBk messages decode exactly as the research decoder printed them, and the real Capa decodes to 2, 3, 4, 101, 102, 105. Truncated, trailing, past-512 and count-0 messages are reported. 2000 random SDMX bodies never throw.
- **Session against a stub Capture that sends Capa:**
  - the exact order is PNam, LaserFeedList, EnterShow, SXSr, 16 × SXUS, FixtureListRequest, with exact bytes;
  - a second EnterShow on the same connection does not declare again;
  - a reconnect declares again, after its own EnterShow;
  - the real ChBk and a Blind one become events; the truncated one is logged with its hex; UNam is logged as not used.
- **Brief connections:** both `start({once:true})` and the link's `briefSync` send no SDMX.
- **Engine:**
  - the frame layering;
  - a deck-set value replacing an older ChBk value for good;
  - the overlay surviving release() and being cleared by clearCapture();
  - a fixture touched for the first time starting from store/home;
  - fromCapture never changing a deck-set parameter.
- **Service:**
  - ChBk on an untouched configured fixture reaches the overlay, the store (16-bit exact) and the strip (`~`);
  - a block over the deck-set pan and the untouched tilt: pan stays the deck's, tilt follows Capture, and the disagreement is logged;
  - an echo produces no disagreement line;
  - Blind changes nothing;
  - unconfigured slots go to the overlay only;
  - the straddling block is logged;
  - LeaveShow clears the overlay.

End to end on the built plugin (`test/integration-sdmx.test.ts`, 5 steps). The stub Capture sends Capa and ChBk, and Deck control goes through the real Deck key:
1. The start-up brief connection and the Setup panel's brief connections send no SDMX.
2. Deck ON: the declaration follows our EnterShow with exact bytes, once. The deck drives A (Ch 203, 1/285).
3. The real ChBk for B (Ch 202, 1/444) plus B's dimmer. In the frame diff, **only** B's reported slots changed; A keeps the knob value while it keeps turning. Both log lines are present.
4. ChBk on A's pan and tilt: pan stays the deck's, tilt follows Capture, and the disagreement is logged.

   Blind=1 and a truncated ChBk change no slot; the truncated one is logged with its exact hex.

   Unconfigured slots 50–53 ride along, logged as overlay only.

   With B selected, the strips show `~8.9` (pan) and `~50.2` (dimmer), Capture's values.
5. Deck OFF → ON:
   - B's values are stored from ChBk;
   - the declaration is sent again on the new connection;
   - B's levels and the unconfigured slots are still in the frames;
   - turning B's tilt by one tick: tilt = Capture's value + 1 %, pan and dimmer = Capture's values (**not** home 50 % / 100 %), and A keeps its value.

**One existing test changed on purpose:** `integration-fixtures` asserted that the persistent session sends only PINF and CAEX. It now also accepts SDMX, but only well-formed declarations, and checks there are exactly 17 of them.

**Mutation checks** (each change restored afterwards; the git diff was identical before and after):
- **Allowlist checks**, each loosened one at a time: size; part count/part; nothing after the string; channel exactly 1; universe ≤ 256; SXUS index; SXSr/SXUS only; option must be exactly `true`; option ignored. **Every one fails a test.**
- **Decoder:** accepting trailing bytes or levels past 512 fails a test.
- **Session:**
  - declaring on brief connections: fails;
  - declaring before our EnterShow: fails;
  - no declaration at all: fails 5 tests.
- **Engine:**
  - no recordDeck: fails;
  - deck-set channels not on top: fails 4;
  - overlay not used in frames: fails 6;
  - fromCapture overriding deck-set: fails.
- **Link:** levels never reaching the service fails 3.
- **Service:**
  - deck-set channels updated from ChBk: fails;
  - Blind applied: fails;
  - LeaveShow keeping the levels: fails.
- **Two mutations changed nothing, because they don't change behaviour:**
  - removing the `declared` guard: the declaration is already inside the once-per-connection EnterShow branch;
  - drawing deck-set channels in the bottom layer too: the top layer redraws them anyway.

**Flaky test I did not cause:** `test/integration.test.ts` (accessibility/OSC named commands, the permission test) sometimes fails on timing. I ran the **unmodified v0.7.3 commit** 8 times: 3 runs failed (5, 6 and 1 tests). With v0.8.0, 1 of 5 runs failed. In full-suite runs, 2 of 6 had failures there, all in that file and in the same tests. The final full run was clean, 352/352.

## NOT verified (Mac only)
- **Echo:** whether Capture sends ChBk for levels it receives from *our* sACN. If it does, you will see `Capture levels` lines on Ch 203's channels while you turn the knob. They only become `disagree` lines when the echo lags our value.
- **The popup:** whether the "universes not in control by the console" popup stays away when declared *and* sending sACN. The probe sent no DMX.
- **"(Automatic)":** whether *Project console link* keeps its "(Automatic)" entry over several ON/OFF cycles.

  Also, in the declared probe run, Capture itself sent LeaveShow and closed the connection at +67 s of a 120 s run. The report doesn't say why: it may have been something you did in Capture. If it happens during the plugin test, the log will show `Capture left the show`, and the plugin then clears Capture's levels.
- **Real ChBk timing and size:** the probe saw roughly one message per second during drags, 2–4 channels each. Whether a fast drag sends more often is unknown. Every application is logged, so the log can get busy during a drag.
- **Strips:** that 16-bit channels reported coarse-only or fine-only look right on the strips.
- **Delta-only, by design:** a light already lit when the deck connects still drops to 0 on a universe the deck drives, until Capture next reports its channels. No way to ask Capture for its current levels is known, so none was invented.
- **Already in place since Handoff 12, now with real data:** a FixtureModify with the patch bit already updates Setup addresses. Capture sends real patch data once we declare, so if you re-patch in Capture during the ON session, the address may now arrive this way. The new FixtureList patch fields are still not used (Handoff 27).

## Your test (show COPY)
1. Pull the usual way (or apply `capture-streamdeck-0027.bundle`). Install `com.rezabehjat.capture.streamDeckPlugin` and check the manifest says `0.8.0.0`. Delete the old **Capture** profile and re-import the new one. Start Capture fresh, and check that the console link shows **(Automatic)**.
2. Deck ON, click Ch 203 (Rogue), turn Pan, as before. The log shows `CITP: declared sACN universes 1-16` and `CITP: SDMX Capa received: …`.
3. **The fix:** with the deck still ON and driving 203, move **Ch 202 with the mouse**.
   - Does 202 respond and **hold** its mouse state (no blackout, no snap-back) while 203 keeps moving on the deck?
   - Grab the `Fixtures: Capture levels …` lines.
4. Deck OFF, wait, Deck ON, click 203 and turn: 202 should still be where the mouse left it (resume from ChBk).

   Also click 202: its strips should show the mouse values with `~`.
5. Watch for the "universes not in control" popup at any point while ON.
6. After several ON/OFF cycles: does *Project console link* still show **(Automatic)** without restarting Capture?
7. Send me the `Fixtures:` and `CITP:` lines from
   `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.rezabehjat.capture.sdPlugin/logs/`.
   - Any `disagree` lines tell us about echo.
   - Any `Capture left the show` lines tell us about the LeaveShow seen in the probe.
