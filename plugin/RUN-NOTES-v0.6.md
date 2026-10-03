# Run notes: plugin v0.6 (Handoff 20: knob pages built from the selected fixture's channels)

**Base:** I ran `git pull` first, in your `~/capture-streamdeck`: "Already up to date". GitHub's `main` is still `9e9f3ef` (Handoff 17). **v0.5 was never pushed.** It only exists in `capture-streamdeck-0018.bundle` (`a4893a5`). You chose to have me build on that bundle, so this work is `a4893a5` + one new commit. **Bundle 0019 holds both commits** (Handoff 18 = v0.5, and Handoff 20 = v0.6) on top of `9e9f3ef`. Pull 0019 and you get both; you don't need 0018. (There is no bundle 0017.)

**Restart brief sections 1–4 were followed:** `git pull` first; no push (commits and bundle only); nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or Capture's library is committed; no fixture-specific names or channel numbers (only generic name rules); no CITP changes (the `citp*.ts`, `link.ts`, `identify.ts` and `sacn.ts` files are untouched); no new keystrokes and no mouse automation; addresses still come from Setup and FixtureModify only.

I built and tested everything in a Linux sandbox against a stub CITP server and a synthetic library. **Nothing here has run on your Capture, your Stream Deck or your Mac.**

## What changed
1. **Attribute pages** (new `src/fixtures/pages.ts`). Every channel of a fixture type becomes a knob, using only its name (whole words, case-insensitive). The groups, in order: **Position** · **Intensity** · **Colour** · **Beam** · **Shutters** · **Gobo/Prism/FX** · **Other**, using the handoff's rules.
   - A name with a speed/time/mode/macro/control word always goes to Other.
   - A framing shutter ("Shutter 1A", "Shutter A", "Shutter1A", "Blade …", "Framing …", "Shutter Rotation") goes to Shutters, not Intensity. Plain "Shutter" and "Shutter/Strobe" stay in Intensity.
   - Only non-empty groups become pages, 3 channels per page, with extra pages numbered `Shutters 1/3`.
   - Fine channels are never knobs: they ride with their coarse channel (16-bit).
   - Colour cells (`Red 1`…`Red 5`) are one knob. Two colour wheels stay two knobs.
   - A duplicate channel name gets ` #2`.
   - **Small extensions to the handoff's word list, all generic:** `frame` counts as framing; `ctc`, `fx`, `rot` and `anim` are recognised; a trailing number on a word is ignored (`Frost2` = frost).
2. **Generic dials:** `Fixture: Attribute 1 / 2 / 3`.
   - Each strip shows the current page's channel name (cut to 15 characters with "…") and its value in raw %.
   - Rotate ±1 % per tick (16-bit aware). **Push = home that channel.** Tap = fine (0.1 %).
   - `—` when the page has nothing on that dial; turning it then sends nothing.
   - The v0.5 named dials (Pan, Tilt … White) are still in the action list for hand-placed layouts and work as before.
3. **Page keys:** `Fixtures: ◀ Page` and `Fixtures: Page ▶` cycle the pages and wrap around. The title is `Page ▶` plus the page name on the next line(s), e.g. "Page ▶ / Shutters / 1/3".
   - The page resets to **Position** when the first selected fixture is of a different type, and is kept within the same type.
   - With several fixtures selected, pages come from the **first** selected fixture's type. Each selected fixture's channel **of the same name** moves, relative to its own value. A fixture without that channel is skipped.
4. **Home values** (first touch, Home Selected, knob press):
   - pan/tilt 50 %; dimmer/intensity 100 %;
   - the **first** shutter/strobe channel 255 (as in v0.5), other shutter/strobe channels 0;
   - additive colours 100 %; subtractive, CTO and colour wheels 0;
   - zoom/focus/iris/frost 0; blades 0 (out); everything else 0.

   For the v0.5 test fixtures, the first-touch frame is byte-identical to v0.5 (there's a test for it).
5. **Setup panel:** every fixture row has an expandable **Channels** list: number (1-based), name, `8-bit` / `16-bit (fine N)` / `fine of N`, and the page the channel is on.
   - A type whose parse is "consistent but uniqueness not proven" gets a visible amber note, and its list title says "check against Capture".
   - The list stays open when the panel refreshes.
6. **Profile:** the Fixtures folder is now **one page**: Back · Setup · Release · Home Selected · Status · ◀ Page · Page ▶, with dials **Select · Attribute 1 · 2 · 3**. The four fixed-dial pages are removed. (Handoff 19 will move things around later.)
7. Engine: values are now kept per channel ("parameter") instead of per named attribute. sACN output itself is unchanged: same rate, priority, termination, and still nothing before a touch.
8. New icons `fx-attr`, `fx-page-prev`, `fx-page-next`, drawn in the same style as the others; existing images are unchanged. Version 0.6.0 (manifest 0.6.0.0). `README.md` and `DEFAULT-LAYOUT.md` are updated.

## A deviation from the handoff you should know about
"Every coarse or 8-bit channel appears on exactly one page" holds **except** for channels where the parser found several possible readings that disagree (the Handoff 13 case). Those channels are on **no page and are never driven**, which keeps the Handoff 13 safety rule. Their Setup row reads "on no page: the candidate parses disagree here", and the log names them. This doesn't affect the SolaFrame, whose note is the different "uniqueness not proven" case. A type with that note **is** fully paged and driven (as in v0.5), and is only marked in Setup.

## Verified (sandbox)
- **296 plugin tests pass** (was 281).
- **New `test/pages.test.ts` (12 tests):**
  - the grouping rules on ~50 names;
  - four made-up fixtures with every channel on exactly one page and fine channels paired: a Rogue-like wash, a SolaFrame-like spot (37 ch: 8 blades "Shutter 1A…4B" plus Shutter Rotation, 2 gobo wheels plus rotation, prism plus rotation, animation plus rotation, CMY, CTO, colour wheel, 16-bit dimmer/zoom/focus), a conventional (intensity only) and a CMY head;
  - blades named "Blade … / Framing …"; multi-cell colour as one knob; wheels not merged;
  - disagreeing channels excluded; home values per group; the v0.5 first-touch frame identical;
  - page cycling and wrapping, reset on a type change, kept within a type;
  - multi-selection of the same type (relative) and of different types (same name driven, others skipped, pages from the first selected);
  - the Setup channel list and the unproven mark.
- **The synthetic 37-channel spot runs the parser out of its search budget**, producing exactly the SolaFrame note (`search budget used up … uniqueness is not proven`). So the "check against Capture" mark is tested against a real parser result, not a hand-set flag.
- **New end-to-end test `test/integration-pages.test.ts` (3 tests) on the built plugin:**
  - Setup panel: addresses saved; the spot's Channels list (37 rows, `Shutter 1B` = 8-bit on "Shutters 1/3", the 16-bit dimmer with its fine channel); the unproven flag.
  - Select the spot (Ch 207, 1/420) in the stub → Page ▶ ×6 → title "Page ▶ / Shutters / 1/3", dial strips "Shutter 1A / 1B / 2A" → turn Attribute 2. The first frame is the defaults: pan/tilt 50 %, Shutter/Strobe 255, 16-bit dimmer full, all blades 0, every slot outside the spot 0. On the next turn **only slot 447 (Shutter 1B) changes**, compared frame to frame.
  - A blade on "Shutters 2/3" changes only its own slot; pushing its knob sends it back to 0; Shutter 1B keeps its value.
  - Selecting the wash resets to Position; driving the wash changes only its slots.
- Mutation checks (each made the tests fail, then I restored it): fine channels as their own knobs; blades homing to full; no page reset on a type change; driving by dial position instead of name; framing shutters falling into Intensity; colour cells not merged.
- Setup panel in Chromium (`node --import tsx scripts/check-fixtures-inspector.mjs`): the Channels list is collapsed by default, opens to 37 rows, rows are correct, the unproven note appears only on the spot, and the list stays open after an update. I looked at the screenshot: it fits the 320 px panel.
- Typecheck, `streamdeck validate` and `npm run pack` pass. `research/` is untouched.

## NOT verified / things to know
- **On your Mac:** everything above ran against a stub. In particular:
  - the **real SolaFrame 750 channel names**: whether its blades are called something my rules recognise. If one lands in "Other" it is still reachable there; send me the Channels list.
  - how the page title (2–3 lines, e.g. "Gobo/Prism/FX" + "2/3") fits on the real key;
  - whether 15 characters fit the strip's name field on the hardware.
- **The parse of the SolaFrame is still "uniqueness not proven"**: the Channels list is there so you can check it. If any row differs from Capture's patch view, the knobs will drive the wrong channels for that type.
- Values are raw % of the DMX range. Wheels (gobo, colour, prism, animation) are plain value knobs: no slot snapping, no names, no rotation ranges yet.
- The page is per deck, not per fixture: going back to a type you used earlier starts at Position again.
- The "first shutter/strobe = 255" rule now skips framing blades. In v0.5, a fixture whose first "shutter" word was a blade (e.g. "Shutter 1A" before "Shutter/Strobe") would have had that blade at 255. Now blades are 0, as the handoff asks.
- A `MaxListenersExceededWarning` (11 "change" listeners) shows in the stub run. It comes from the OSC monitor listeners of the existing view dials, toggles, positions and connection, which I didn't change; it's only a warning.

## Your test
1. Get the code (this pushes v0.5 and v0.6 to GitHub):
   ```
   cd ~/capture-streamdeck && git pull && git pull "Claude outputs/capture-streamdeck-0019.bundle" main && git push origin main
   ```
2. Install the plugin over v0.5:
   ```
   open ~/capture-streamdeck/"Claude outputs/com.rezabehjat.capture.streamDeckPlugin"
   ```
3. Re-import the profile. In the Stream Deck app, delete the old **Capture** profile, then run:
   ```
   open ~/capture-streamdeck/plugin/com.rezabehjat.capture.sdPlugin/profiles/Capture.streamDeckProfile
   ```
   HOME › **Fixtures** should show Setup · Release · Home Selected · Status · ◀ Page · Page ▶ and the dials Select · Attribute 1 · 2 · 3.
4. Press **Setup** and open its panel in the Stream Deck app. Expand **Channels** on the SolaFrame (Ch 207) and compare every row with Capture's patch view. If anything differs, send a screenshot of both.
5. Click the SolaFrame in Capture. Press **Page ▶** until its title reads **Shutters** (1/3), then turn Attribute 1–3: the blades should move. Page ▶ again for the next blades. Push a knob: that blade goes back out.
6. Click the Rogue (Ch 203): the title goes back to Position, and the dials show Pan / Tilt.
7. Send me the log lines:
   ```
   grep -E "Fixtures|CITP|Dial|Key press" ~/Library/Logs/ElgatoStreamDeck/com.rezabehjat.capture.0.log | tail -80
   ```
