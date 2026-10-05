# Run notes: plugin v0.12.0 (Handoff 31: per-fixture Pan/Tilt invert; patch-conflict wording)

**Base:** I ran `git pull` first, in your `~/capture-streamdeck` (already up to date at `3b763ea`) and in my clone. This builds on the Handoff 30 commit `ba7a67b` (v0.11.0, bundle 0031), which isn't on GitHub yet. **Apply `capture-streamdeck-0030.bundle`, then `0031`, then `capture-streamdeck-0032.bundle`** (each one needs the one before it). Version **0.12.0** (manifest `0.12.0.0`).

**Followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- no keystrokes, no mouse automation, no fixture-specific names;
- the DMX value itself is never inverted, only the knob direction.

**Not touched:** CITP, the declaration, patch handling, Wake, arming, the last-move-wins rule, pages, the LCD layout, `research/`.

I built and tested everything in a Linux sandbox. **Nothing here has run on your Mac.**

## What changed
### 1. Pan/Tilt invert
- **Which channels.** `src/fixtures/service.ts`, `axisParams()` / `axisOf()` (lines 144–158).
  - The axes are the Pan and Tilt that the existing classifier puts on the **Main page** (dial 1 = the first pan, dial 2 = the first tilt). A coarse/fine pair is one parameter.
  - A second pan or tilt channel (it goes to Other) is not an axis, and neither is "Pan/Tilt Speed".
  - It's generic (channel names only). A type with neither gets no toggles.
- **Storage.** `src/fixtures/setup.ts`:
  - `INVERT_KEY = "fixtureInvert"`, the `Axis` / `Invert` types (lines 26–33);
  - `SetupStore.load()` also reads the flags; malformed entries are ignored and only a boolean `true` counts (lines 164–177);
  - `invert()` / `setInvert()` (lines 183–211).
  - **Layout:** `fixtureInvert: { <show>: { <fixture key>: { invertPan: true, invertTilt: true } } }` in the global settings, next to `fixtureSetup` (the addresses).
  - It's keyed by **show and fixture key**, not by address, so a re-patch keeps it. Only `true` flags are stored, and the default is off.
  - The flags are deliberately **not** inside the address entries: those are replaced or deleted whenever Capture's patch changes, which would lose the flags.
- **Effect.** `service.ts`:
  - `attrRotate()` (lines 899–908) and `rotate()` for the fixed Pan/Tilt dials (lines 809–817) now pass the ticks through `knobTicks()`, which negates them on an inverted axis (`inverted()` at line 913, `knobTicks()` at 921).
  - `stepFraction()` then moves the parameter, so coarse, fine and the 16-bit pair as a whole all follow.
  - **Unchanged:** the values stored and the DMX sent are the true values; home (knob press, strip tap, Home Light); ChBk; last-move-wins.
  - With several fixtures selected, each moves its own way.
- **`src/fixtures/engine.ts`, `adjust()`** (lines 233–243): the value callback also receives the target, `fn(current, p, target)`, so the direction can differ per fixture. What it returns is written unchanged.
- **Strip.**
  - `src/lib/render.ts`: a new `stripLabel(name, inverted)` (lines 169–176) puts ` ⇄` after an inverted parameter's name within the same 15 characters (`Pan ⇄`). Without the invert it is exactly the old truncation.
  - `AttrReadout` / `DialReadout` carry `inverted` for the first selected fixture (`service.ts` lines 116–117, 130–131, 798–806, 889–896).
  - `src/actions/fixtures.ts` (lines 4, 147, 172) uses the new helper; the old local `stripName` is gone.
  - Nothing else on the strip changed.
- **Setup command.** `src/fixtures/setupCommands.ts`: `{cmd: "invert", key, axis: "pan" | "tilt", on}` → `FixtureService.setInvert()` (`service.ts` lines 936–945; `invertView()` for the rows at 926).
  - It works in Capture-patch mode, because it's not an address.
  - It's refused for an unknown fixture, an axis the type doesn't have, or an axis other than pan/tilt.
  - It logs `Fixtures: Ch 202 SolaFrame 750: Pan inverted` / `… Pan normal`.
  - The Setup view rows gain `axes`, `invertPan` and `invertTilt` (lines 64–67, 308).
- **Setup panel** (`ui/setup-core.js`, `ui/fixtures.html`):
  - each row gets `Invert Pan` / `Invert Tilt` checkboxes, only for the axes its type has, and hidden for types with neither;
  - they stay editable in Capture-patch mode while the address cells are read-only;
  - each click sends the `invert` command.

### 2. Patch-conflict wording
- **`setup.ts`, `sharedNotes()`** (lines 85–100): both rows now say `⚠ patch conflict with Ch 205 at 1/285 — fix in Capture`.
- **`service.ts`, `logShared()`** (lines 672–684): logs `Fixtures: patch conflict in Capture: Ch 203 and Ch 205 both at 1/285 (fix the patch in Capture)`, once per pair (per show), at the same place as before.
- **Panel:** the note is now on its own amber line under the row's status line (`.conflict`), instead of being appended to the green "Controllable" text.
- **Behaviour unchanged:** both fixtures stay controllable.

### Docs, version
- README: the patch paragraph is updated, and there's a new "Pan / Tilt invert (v0.12.0, Handoff 31)" section.
- Version 0.12.0: `src/version.ts`, `package.json`, `test/manifest.test.ts` and `test/profile.test.ts`.

## Tests
**New: `test/invert.test.ts`** (unit, 5 tests):
- **axes:** a 16-bit Pan and Tilt; a second pan or "Pan/Tilt Speed" is not an axis; a conventional has none; the synthetic SolaFrame 750 has both;
- **Invert Pan on A with A+B selected:**
  - both start at 60 % (so an inverted *value* would show);
  - +3 gives A 57 % and B 63 %; fine +3 gives A 56.7 % and B 63.3 % (16-bit frames);
  - the readout is the true value with `inverted`, and the label is `Pan ⇄`;
  - Tilt is not inverted;
  - the fixed Pan dial follows the same rule;
  - strip-tap home still gives 50 %;
  - a ChBk sets Capture's true value, and the next turn continues from it in the inverted direction;
  - "normal" moves the right way again, and the log lines are checked;
- **`stripLabel`:** short and long names, 15 characters;
- **persistence:**
  - stored by key with only true flags;
  - kept through a FixtureModify re-patch (still inverted at the new address);
  - kept after a restart (new store, same globals) and a show reload;
  - not inherited by another show;
- **Setup:** toggles per axis; editable in patch mode while the addresses are refused; bad commands refused; malformed stored flags ignored.

**New: `test/integration-invert.test.ts`** (the real built plugin, the fake Stream Deck app, the stub Capture with patch, a UDP sACN listener; 3 tests):
- the conflict wording on both rows and logged once per pair over several lists; the old wording is gone; toggles per type (none for the conventional);
- Invert Pan on 201 through the panel in patch mode:
  - the address is refused and unchanged; the invert is logged and saved by key;
  - the strip reads `Pan ⇄`;
  - +3 → 201 at 57 %, 202 at 63 % in the frames, and the strip shows `57.0`;
  - fine +3 → 56.7 / 63.3;
  - Tilt both +2;
  - with 202 selected first, the strip reads plain `Pan`;
- persistence:
  - a FixtureModify re-patch to 2/1 → still inverted (frames on u2);
  - a LeaveShow + EnterShow → kept;
  - a plugin restart → still inverted (frames);
  - another show → not inherited;
  - "Pan normal" is logged.

**Existing tests changed:**
- the `patch.test` and `integration-patch` expectations for the new conflict wording (log and rows);
- `scripts/check-fixtures-inspector.mjs`:
  - rows have toggles per axis and send `invert`;
  - no toggles for a type without Pan/Tilt; Invert Pan only for a Pan-only type;
  - the toggles are editable in patch mode;
  - the conflict line is on both rows and absent elsewhere.

**Results:**
- `npm test` in `plugin/`: **385 pass, 0 fail**;
- research `npm test`: **81 pass**;
- `tsc --noEmit`: clean;
- the fixtures inspector check: OK;
- `streamdeck validate`: successful;
- `npm run pack`: **0.12.0.0**.

## Mutation checks
Each was applied alone (typecheck still clean), then `test/invert.test.ts` and (after a rebuild) `test/integration-invert.test.ts` were run, then the code was restored and rebuilt.

| Mutation | Unit fails | Integration fails |
|---|---|---|
| invert applied to the DMX value (`1 − value` instead of negated ticks) | 1 | 2 |
| invert stored by address (`u/a` instead of the fixture key) | 2 | 2 |
| invert ignored in fine mode | 1 | 2 |

## Profile
Regenerated. I unzipped the old (`ba7a67b`) and new profiles, normalised the version, and ran `diff -rq`: **only the version differs**. The manifest also differs only in its version.

## NOT verified
- **Nothing ran on your Mac.**
- **Whether the `⇄` glyph renders in the Stream Deck LCD font.** It's a standard Unicode arrow (U+21C4), and macOS has it in its system fonts, but I couldn't check the strip itself. If it shows as a box, tell me and I'll use a plain-ASCII mark instead.
- **Which direction is "wrong" on your rig** is up to you (test plan step 2); the plugin only flips the knob.
- **Classifier edge case:** the axis is the type's first Pan/Tilt by name. A type whose real pan channel is named differently (no word "pan") has no Invert Pan toggle; that's the same limit as the Main page.

## Reza's test plan (show COPY)
1. Pull. If needed, apply bundles 0030 → 0031 → 0032. Install `com.rezabehjat.capture.streamDeckPlugin`, check that the manifest says `0.12.0.0`, and re-import the profile.
2. **Find a mismatched pair.** Turn Pan the same way on 201 and on 202, and note which one moves the "wrong" way.
3. **Invert it.** Open Setup and tick `Invert Pan` on that light; the toggle works even though the addresses are read-only. Turn again: both should now go the same direction. The strip shows `Pan ⇄`, and the % shown is the real DMX %. Do the same for Tilt if needed.
4. **Persistence.** Quit and restart the Stream Deck app: the invert is still on.
5. **Conflict wording.** If an overlap exists in the patch (Ch 203 / 205 at 1/285 in your show), Setup shows `⚠ patch conflict with Ch 205 at 1/285 — fix in Capture` on both rows. The log has one `Fixtures: patch conflict in Capture: …` line per pair.
6. Save the log and upload it:
   ```
   grep -h -E "Fixtures|CITP|Dial|Key press|Deck" ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/com.rezabehjat.capture.sdPlugin/logs/*.log > ~/capture-streamdeck/"Claude outputs/log-v0.12.0.txt"
   ```

## Delivered (in `Claude outputs/`)
- `capture-streamdeck-0032.bundle` (`ba7a67b..main`, one commit);
- `com.rezabehjat.capture.streamDeckPlugin` (0.12.0.0);
- `run-notes-plugin-v0.12.0.md` (this file).
