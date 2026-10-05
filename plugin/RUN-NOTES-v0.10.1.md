# Run notes: plugin v0.10.1 (Handoff 29: page order with Shutters second; one page count in the header)

**Base:** I ran `git pull` first, in your `~/capture-streamdeck` (already up to date) and in my clone. Both were at **`3b763ea`** (v0.10.0), which you had pushed, so bundle 0029 did not need applying. This delivery is one commit on top. **Use `capture-streamdeck-0030.bundle`.** Version **0.10.1** (manifest `0.10.1.0`).

**Followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- no fixture-specific names (the order is a generic group order).

**Not touched:** CITP, the declaration, patch handling, arming, last-move-wins, home/resume values, which group a channel belongs to, the LCD layout, colours, `research/`.

I built and tested everything in a Linux sandbox. **Nothing here has run on your Mac.**

## What changed
1. **`src/fixtures/pages.ts`**
   - `GROUP_ORDER` (lines 25–26) is now `main, shutters, beam, colour, gobo, other` (was `main, colour, beam, shutters, gobo, other`).
   - The comment in `buildModel` (line 259) was updated.
   - **Unchanged:** which channel goes to which group, 4 per page filled across groups, the order inside a group, Main, home values, and the reset to Main on a type change.
2. **`src/lib/render.ts`, `headerText` slot 4** (lines 275–277 and 289–290): shows the page title **without its own ` k/m`**, then the overall `n/N`. So `Shutters 2/8` instead of `Shutters 1/3 2/8`, and `Shutters · Beam 4/8` for a mixed page.
   - **How:** the trailing ` k/m` is removed from the title the header gets. Group labels never end in digits, so nothing else can be cut off.
   - **The page keys keep their titles with `k/m`** (`Shutters` / `1/2`).
3. **Texts:** the ◀ Page / Page ▶ tooltips list the new order (`src/catalog/fixtures.ts`, lines 81 and 83). The README paragraph on pages was updated.
4. **Version 0.10.1.** The profile was regenerated: I unzipped the old and new profiles and compared them, and the only difference is the plugin version. The manifest differs in the version and the two tooltips.

## Page lists (made with the plugin's own `buildModel`)
Before (v0.10.0):
```
SolaFrame 750 (synthetic, 47 ch): 7 pages
  1. Main                   Pan | Tilt | Dim | Zoom
  2. Colour                 Red | Green | Blue | CTO
  3. Colour · Beam          Static Color Position | Frost | Focus | Iris
  4. Beam · Shutters        Shutter/LED | Blade 1 Angle A | Blade 1 Angle B | Blade 2 Angle A
  5. Shutters               Blade 2 Angle B | Blade 3 Angle A | Blade 3 Angle B | Blade 4 Angle A
  6. Shutters · Gobo/FX     Blade 4 Angle B | Frame Rotation | Gobo 1 Position | Gobo 1 Rotate
  7. Gobo/FX · Other        Prism Rotate | LED Animation Position | LED Animation Rotate | Mspeed

37-ch framing spot (synthetic): 8 pages
  1. Main                   Pan | Tilt | Dimmer | Zoom
  2. Colour                 Cyan | Magenta | Yellow | CTO
  3. Colour · Beam          Colour Wheel | Shutter/Strobe | Frost | Iris
  4. Beam · Shutters        Focus | Shutter 1A | Shutter 1B | Shutter 2A
  5. Shutters               Shutter 2B | Shutter 3A | Shutter 3B | Shutter 4A
  6. Shutters · Gobo/FX     Shutter 4B | Shutter Rotation | Gobo Wheel 1 | Gobo 1 Rotation
  7. Gobo/FX                Gobo Wheel 2 | Prism | Prism Rotation | Animation Wheel
  8. Gobo/FX · Other        Animation Rotation | Pan/Tilt Speed | Effects Speed

Rogue-like wash (synthetic movingHead, 14 ch): 3 pages
  1. Main                   Pan | Tilt | Dimmer | Zoom
  2. Colour                 Red | Green | Blue | White
  3. Colour · Beam · Other  Amber | Shutter | Pan/Tilt Speed
```
After (v0.10.1):
```
SolaFrame 750 (synthetic, 47 ch): 7 pages
  1. Main                   Pan | Tilt | Dim | Zoom
  2. Shutters 1/2           Blade 1 Angle A | Blade 1 Angle B | Blade 2 Angle A | Blade 2 Angle B
  3. Shutters 2/2           Blade 3 Angle A | Blade 3 Angle B | Blade 4 Angle A | Blade 4 Angle B
  4. Shutters · Beam        Frame Rotation | Frost | Focus | Iris
  5. Beam · Colour          Shutter/LED | Red | Green | Blue
  6. Colour · Gobo/FX       CTO | Static Color Position | Gobo 1 Position | Gobo 1 Rotate
  7. Gobo/FX · Other        Prism Rotate | LED Animation Position | LED Animation Rotate | Mspeed

37-ch framing spot (synthetic): 8 pages
  1. Main                   Pan | Tilt | Dimmer | Zoom
  2. Shutters 1/2           Shutter 1A | Shutter 1B | Shutter 2A | Shutter 2B
  3. Shutters 2/2           Shutter 3A | Shutter 3B | Shutter 4A | Shutter 4B
  4. Shutters · Beam        Shutter Rotation | Shutter/Strobe | Frost | Iris
  5. Beam · Colour          Focus | Cyan | Magenta | Yellow
  6. Colour · Gobo/FX       CTO | Colour Wheel | Gobo Wheel 1 | Gobo 1 Rotation
  7. Gobo/FX                Gobo Wheel 2 | Prism | Prism Rotation | Animation Wheel
  8. Gobo/FX · Other        Animation Rotation | Pan/Tilt Speed | Effects Speed

Rogue-like wash (synthetic movingHead, 14 ch): 3 pages
  1. Main                   Pan | Tilt | Dimmer | Zoom
  2. Beam · Colour          Shutter | Red | Green | Blue
  3. Colour · Other         White | Amber | Pan/Tilt Speed
```

**SolaFrame 750 (synthetic):**
- page 2 starts with the framing blades (`Blade 1 Angle A`);
- Frost, Focus and Iris come right after the Shutters group (`Frame Rotation` is the last Shutters channel);
- Colour comes after Beam.

**37-ch spot:** its Beam group starts with `Shutter/Strobe`, because Shutter/Strobe value channels belong to Beam (membership unchanged). So there, Frost and Iris come one place later.

**Rogue-like wash:** it has no Shutters group, so Beam (its Shutter/Strobe) comes first after Main.

**Page counts are unchanged:** SolaFrame 7, spot 8, wash 3.

## Verified (sandbox)
**364 plugin tests pass, 0 fail** (the same count: no tests added, some expected page lists updated). Research: 81 pass. Typecheck is clean. `streamdeck validate` and `npm run pack` passed (**0.10.1.0**).

- **Every coarse/8-bit channel on exactly one page:** `assertComplete` runs on the wash, the spot and the SolaFrame. The page counts are asserted.
- **SolaFrame test:** checks page 2 starts with a blade and is all Shutters; Frost, Focus and Iris come right after `Frame Rotation`; Beam comes after Shutters, and Colour after Beam.
- **Updated expected page lists:** `pages.test` (wash, spot, the no-dimmer/CMY cases, excluded channels, service paging, the Setup channel list) and `integration-pages`. **Page ▶ once now shows `Shutters` / `1/2`, with Shutter 1B on Attribute 2** (it was on Attribute 3 of page 4).
- **Header slot 4** (`render.test`): `Shutters 2/8` for a split group, `Shutters · Beam 4/8` for a mixed page, `Gobo/FX · Other 7/8` for a repeated mixed title, `Main 1/7` on Main, and a check that no header string contains more than one count.
- **Mutation checks** (each restored afterwards):

  | Mutation | Tests failed |
  |---|---|
  | The old group order | 12 (`pages.test` + `integration-pages`) |
  | The `k/m` left in the header | 1 (`render.test`) |

**Flaky, as before:** `integration.test.ts` (AX/OSC). It failed in one full run here, in the same tests as before. The final full run was clean.

## NOT verified (Mac only)
- The real SolaFrame's page list. The plugin builds it from your library, and the synthetic one above uses guessed full names.
- How `Shutters 2/7` fits on the real strip.

## Your test
1. Pull, install, and check that the manifest says `0.10.1.0`.
2. Click the SolaFrame in Capture. **Page ▶ once:** the blades should be there. Keep pressing Page ▶: Frost, Focus and Iris should come right after the blades, then Colour.
3. Check the strip header's page text: there should be one count only, e.g. `Shutters 2/7`.
4. Click a Rogue: its pages should follow the same order, skipping any group it doesn't have.
