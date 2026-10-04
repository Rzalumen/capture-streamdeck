# Run notes: plugin v0.7.1 (Handoff 22: home values, hidden channels, fewer pages)

**Base:** I ran `git pull` first, both in my working clone and in your `~/capture-streamdeck`. GitHub is at **`7ee6218`** (v0.7 + the SolaFrame addendum, which you pushed). Bundle 0022 (my first v0.7.1) was not pushed.

**This delivery follows your revised Handoff 22.** It's two commits on top of `7ee6218`: the first v0.7.1, plus the change that fills pages across groups to reach **at most 8 pages**. **Use `capture-streamdeck-0023.bundle`**: it holds both commits and replaces 0022.

**Restart brief sections 1–4 were followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- generic name rules only, no fixture names in the code;
- **CITP and the DMX engine's sending are unchanged**;
- no keystrokes and no mouse automation.

I built and tested everything in a Linux sandbox. **Nothing here has run on your Mac.**

## What changed
1. **Home values: your table, applied by channel name.** These are used at first touch, by Home Selected and by the strip-tap home.

   | Channel | Home |
   |---|---|
   | pan, tilt | 50 % |
   | dimmer, intensity, dim | 100 % |
   | **shutter value channels** ("Shutter", "Shutter/LED", "Shutter/Strobe") | **100 % (open)**, every one of them (the old "first shutter = 255" rule is gone) |
   | strobe-only ("Strobe") | 0 |
   | shutter mode/function channels | 0 |
   | zoom, iris, focus | 50 % |
   | frost, diffusion, edge | 0 |
   | framing blades (insertion) | 0 (out) |
   | blade angle, frame rotation, shutter rotation | 50 % |
   | additive colour | 100 % |
   | subtractive, CTO, CTB, colour wheel | 0 |
   | gobo, prism, animation, effect and their rotate/index | 0 |
   | everything else | 0 |

   16-bit channels get the same % on both bytes: 50 % = 0x8000, a 16-bit shutter at 100 % = 0xFFFF.

2. **Hidden channels.** A name with the whole word *function*, *functions*, *control* or *auto* goes on no page and is always sent at **0**. Its fine partner is hidden too.
   - Hidden channels are never stored, resumed or homed.
   - Setup → Channels lists them greyed out as **"hidden (0)"**.
   - On the SolaFrame that hides channels 5, 10, 12, 14, 27, 28, 36/37 (Auto Focus), 39 (Shutter/LED Functions), 43 and 47 (Control). The ones other than Auto Focus, 39 and 47 depend on my guessed full names.
3. **Pages:**
   - **all four dials are Attribute dials** (Attribute 1–4), with 4 channels per page;
   - **Main = Pan · Tilt · Intensity · Zoom** ("—" when missing);
   - Strobe/Shutter is merged into **Beam**;
   - after Main, the channels run in group order **Colour · Beam · Shutters · Gobo/FX · Other**, and **every page is filled with 4** (revised in this delivery). The end of one group shares a page with the start of the next.
   - A page is titled by the groups on it ("Colour · Beam"; on the key it's two lines). A title that repeats is numbered ("Shutters 1/2").
   - The page keys show that title.
4. **The Select dial has left the profile** (it's still in the action list). A new **`Fixtures: Next Fixture`** key is in the last free slot. It cycles the controllable fixtures, like one tick of the old dial, and it switches Deck Control ON like any fixture key. **Its title shows the fixture selected now ("Next / Ch 207")**, because the Select strip that used to show it is gone. The profile's Fixtures page now uses all 8 key slots.
5. **One-time migration:**
   - On the first start of v0.7.1 every stored fixture in `fixtureValues` is marked (logged: `values migration (v0.7.1): N stored fixture(s) will lose…`).
   - The first time a fixture's channel names are read, its stored **shutter/strobe** values are deleted. Framing blades are kept. Logged: `… removed the stored shutter/strobe value(s) of channel(s) 39, 40 for fixture …`.
   - Until then that fixture starts from home, so the old 255 can't come back.
   - The marks are kept in the global settings key `fixtureValuesMigration`, so the migration never runs twice.

## What I did about the two open points from the first v0.7.1
1. **Page count: now 7 for the synthetic SolaFrame (at most 8, as the revised handoff asks again).** With every group on its own pages it was 10. The only way to reach 8 or fewer, with 4 channels per page and the group order kept, is to let pages run across groups, so that's what I did:
   ```
   Main: Pan · Tilt · Dim · Zoom
   Colour: Red · Green · Blue · CTO
   Colour · Beam: Static Color Position · Frost · Focus · Iris
   Beam · Shutters: Shutter/LED · Blade 1 Angle A · Blade 1 Angle B · Blade 2 Angle A
   Shutters: Blade 2 Angle B · Blade 3 Angle A · Blade 3 Angle B · Blade 4 Angle A
   Shutters · Gobo/FX: Blade 4 Angle B · Frame Rotation · Gobo 1 Position · Gobo 1 Rotate
   Gobo/FX · Other: Prism Rotate · LED Animation Position · LED Animation Rotate · Mspeed
   ```
   - The test prints this list and asserts at most 8 (it's 7).
   - The other made-up spot (37 channels) has 8 pages, and the Rogue-like wash has 3.
   - **The trade-off:** a group no longer always starts on a fresh page. For example, Shutter/LED shares a page with the first blades.
2. **The SolaFrame's blades (unchanged from the first v0.7.1).** Your table says "blade angle → 50 %", and your SolaFrame check says "blades 0". A blade name with an **end letter** ("Blade 1 Angle A", "Blade 1A") is treated as an insertion end and gets **0**. "Blade 1 Angle", "Frame Rotation" and "Shutter Rotation" get **50 %**. Both of your checks pass with that rule.
   - **Please read the full names of channels 17–24 in Setup → Channels.** If they're actually angle channels with separate insertion channels elsewhere, this rule needs changing.

**One small difference from the revised table:** it no longer lists "shutter mode/function channels → 0".
- "Shutter … Function(s)" names are hidden (0) anyway.
- **I kept "Shutter Mode" / "Shutter Speed"-style names at 0**, as "not the value" channels in Other, rather than 100 %. Opening a mode channel to full could select an odd mode.
- Tell me if you want them at 100 %.

## Verified (sandbox)
- **313 plugin tests pass** (I replaced the "v0.5 frame identical" test, because the defaults changed on purpose; added the migration test and a page-numbering test). **73 research tests pass.**
- Under the load of the full run, a few older AX/menu integration tests failed once on timing. They passed on two separate reruns and on a second full run (313/313). They don't touch anything changed here.
- **Home values per row** on synthetic names: "Shutter/LED" 100 %, "Shutter/LED Functions" hidden (0), "Shutter/Strobe" 100 %, "Strobe" 0, "Strobe Rate" 0, "Blade 1 Angle" 50 %, "Blade 1A" 0, "Frame Rotation" 50 %, "Focus Coarse" 50 %, "Iris" 50 %, "Zoom Coarse" 50 %, and every other row of the table. 16-bit bytes are checked too.
- **SolaFrame layout (from the addendum), first-touch frame:**
  - 39 = 0 and 40 = 255;
  - Dim 0xFFFF; pan/tilt 0x8000;
  - Focus and Zoom 0x8000, Iris 128;
  - blades 17–24 = 0; Frame Rotation 0x8000;
  - RGB 255 (white), CTO 0, Frost 0;
  - every hidden channel 0.
- **Hidden rule:** whole words only ("Automatic", "Controller" stay visible); hidden channels stay 0 even with a stored value.
- **Migration:**
  - only shutter/strobe ids are removed (pan, dim and the blade are kept);
  - a fixture whose names aren't known yet starts from home;
  - it's logged, saved, and not repeated after a restart.
  - End to end: a plugin restart with a v0.7-style stored Shutter value of 30 % comes up open at 255, and logs the removal of channel 7.
- **Next Fixture end to end:** the title reads "Next / Ch 207"; a press moves to Ch 203 (the wash); a second press goes back.
- **Pages end to end:**
  - Attribute 1–4 on Main show Pan · Tilt · Dimmer · Zoom (zoom `~50.0`);
  - Page ▶ ×3 gives the title "Beam / Shutters", with Focus · Shutter 1A · Shutter 1B · Shutter 2A;
  - a blade turn changes only its own slot; the next page "Shutters" works the same;
  - Shutter Rotation is 128 and Control is 0.
- **Pages unit tests:** pages fill across groups; a repeated title is numbered (12 blades → "Shutters 1/3 … 3/3"; 9 blades → "Shutters 1/2", "Shutters 2/2", "Shutters · Gobo/FX").
- Setup panel in Chromium: hidden rows read "hidden (0)" and are greyed out.
- **Mutation checks** (each made the tests fail, then I restored it, on the first v0.7.1): the shutter home at 0; hidden channels shown; the migration removing nothing; the end-letter rule off; 3 per page.
- Typecheck, `streamdeck validate`, `npm run pack`.

## NOT verified
- **On your Mac:** the real SolaFrame names, so which channels end up hidden and how the blades are treated (see above); whether the light is lit and white after Home; how "Next / Ch 207" looks on the key.
- I assume Shutter/LED at 100 % means open on the SolaFrame. That's your rule, and I haven't seen it proven.

## Your test
1. Get the code (this pushes v0.7.1 to GitHub):
   ```
   cd ~/capture-streamdeck && git pull && git pull "Claude outputs/capture-streamdeck-0023.bundle" main && git push origin main
   ```
2. Install the plugin:
   ```
   open ~/capture-streamdeck/"Claude outputs/com.rezabehjat.capture.streamDeckPlugin"
   ```
3. Re-import the profile. In the Stream Deck app, delete the old **Capture** profile, then run:
   ```
   open ~/capture-streamdeck/plugin/com.rezabehjat.capture.sdPlugin/profiles/Capture.streamDeckProfile
   ```
4. Select the SolaFrame. Turn on Deck Control (any knob does it), then click the SolaFrame in Capture. Press **Home Selected**. It should be lit, white, with the blades open and zoom/iris/focus at half.
4b. Page through with **Page ▶**. There should be at most 8 pages (7 expected), and no Function, Control or Auto Focus knobs.
5. Setup → expand the SolaFrame's **Channels**. Check the names of 17–24 and which rows say "hidden (0)".
6. Send me the log lines (including the `values migration` ones):
   ```
   grep -E "Fixtures|CITP|Dial|Key press" ~/Library/Logs/ElgatoStreamDeck/com.rezabehjat.capture.0.log | tail -100
   ```
