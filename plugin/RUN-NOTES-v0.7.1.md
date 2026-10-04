# Run notes: plugin v0.7.1 (Handoff 22: home values, hidden channels, fewer pages)

**Base:** I ran `git pull` first, both in my working clone and in your `~/capture-streamdeck`. Both are at **`7ee6218`** (v0.7 + the SolaFrame addendum, which you pushed). This work is one new commit, delivered as **`capture-streamdeck-0022.bundle`**.

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
   - the order is Main · Colour · Beam · Shutters · Gobo/FX · Other.
4. **The Select dial has left the profile** (it's still in the action list). A new **`Fixtures: Next Fixture`** key is in the last free slot. It cycles the controllable fixtures, like one tick of the old dial, and it switches Deck Control ON like any fixture key. **Its title shows the fixture selected now ("Next / Ch 207")**, because the Select strip that used to show it is gone. The profile's Fixtures page now uses all 8 key slots.
5. **One-time migration:**
   - On the first start of v0.7.1 every stored fixture in `fixtureValues` is marked (logged: `values migration (v0.7.1): N stored fixture(s) will lose…`).
   - The first time a fixture's channel names are read, its stored **shutter/strobe** values are deleted. Framing blades are kept. Logged: `… removed the stored shutter/strobe value(s) of channel(s) 39, 40 for fixture …`.
   - Until then that fixture starts from home, so the old 255 can't come back.
   - The marks are kept in the global settings key `fixtureValuesMigration`, so the migration never runs twice.

## Two places where your handoff and the result don't match (please decide)
1. **Page count: 10, not "at most 8".** With 4 per page and every group on its own pages, the synthetic SolaFrame needs 10 pages:
   ```
   Main: Pan · Tilt · Dim · Zoom
   Colour 1/2: Red · Green · Blue · CTO
   Colour 2/2: Static Color Position
   Beam: Frost · Focus · Iris · Shutter/LED
   Shutters 1/3: Blade 1 Angle A · Blade 1 Angle B · Blade 2 Angle A · Blade 2 Angle B
   Shutters 2/3: Blade 3 Angle A · Blade 3 Angle B · Blade 4 Angle A · Blade 4 Angle B
   Shutters 3/3: Frame Rotation
   Gobo/FX 1/2: Gobo 1 Position · Gobo 1 Rotate · Prism Rotate · LED Animation Position
   Gobo/FX 2/2: LED Animation Rotate
   Other: Mspeed
   ```
   The overflow is 5 colour, 9 shutter and 5 gobo/FX channels, each needing one more page for a single channel. The test prints this list and asserts **10**, so the number is honest.
   - **If you want 8 or fewer**, one rule change would do it: let small groups share pages (fill every page with 4, groups in order, a page title like "Colour · Beam"). That gives 7 pages here.
   - I didn't do that, because the handoff says to keep the groups.
2. **The SolaFrame's blades.** Your table says "blade angle → 50 %", but your SolaFrame check says "blades 0". Capture truncates those 8 names to "Blade 1 Angle…" twice per blade, so they're probably the A/B **ends** of each blade, whose depths make the angle. At 50 % they'd cut half the beam. I made one generic rule that satisfies both:
   - a blade name with an **end letter** ("Blade 1 Angle A", "Blade 1A") counts as an insertion end and gets **0**;
   - "Blade 1 Angle", "Frame Rotation" and "Shutter Rotation" get **50 %**.

   **Please read the full names of channels 17–24 in Setup → Channels** and tell me if they're different.

## Verified (sandbox)
- **312 plugin tests pass** (I replaced the "v0.5 frame identical" test, because the defaults changed on purpose, and added the migration test). **73 research tests pass.**
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
- **Pages end to end:** Attribute 1–4 on Main show Pan · Tilt · Dimmer · Zoom (zoom `~50.0`); a blade turn changes only its own slot; Shutter Rotation is 128 and Control is 0.
- Setup panel in Chromium: hidden rows read "hidden (0)" and are greyed out.
- **Mutation checks** (each made the tests fail, then I restored it): the shutter home at 0; hidden channels shown; the migration removing nothing; the end-letter rule off; 3 per page.
- Typecheck, `streamdeck validate`, `npm run pack`.

## NOT verified
- **On your Mac:** the real SolaFrame names, so which channels end up hidden and how the blades are treated (see above); whether the light is lit and white after Home; how "Next / Ch 207" looks on the key.
- I assume Shutter/LED at 100 % means open on the SolaFrame. That's your rule, and I haven't seen it proven.

## Your test
1. Get the code (this pushes v0.7.1 to GitHub):
   ```
   cd ~/capture-streamdeck && git pull && git pull "Claude outputs/capture-streamdeck-0022.bundle" main && git push origin main
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
5. Setup → expand the SolaFrame's **Channels**. Check the names of 17–24 and which rows say "hidden (0)".
6. Send me the log lines (including the `values migration` ones):
   ```
   grep -E "Fixtures|CITP|Dial|Key press" ~/Library/Logs/ElgatoStreamDeck/com.rezabehjat.capture.0.log | tail -100
   ```
