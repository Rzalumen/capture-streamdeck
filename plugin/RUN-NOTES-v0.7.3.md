# Run notes: plugin v0.7.3 (Handoff 24: LCD status line, a Deck key you can read, Status and Next Fixture out)

**Base:** I ran `git pull` first, in my working clone and in your `~/capture-streamdeck`. Both were at **`df3fb78`** (v0.7.2, which you pushed). This delivery is one commit on top of it. **Use `capture-streamdeck-0025.bundle`.** Version **0.7.3** (manifest `0.7.3.0`).

**Restart brief sections 1–4 were followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- no keystrokes and no mouse automation.

**Not touched:**
- `layouts/dial.json` and the view dials;
- CITP: the allowlist, `citp.ts`, `identify.ts`, `sacn.ts`;
- the engine's sending;
- home/resume values, colour defaults, page grouping;
- the selection rules from Handoff 23;
- every UUID. No action was removed.

I built and tested everything in a Linux sandbox. **Nothing here has run on your Mac or a real Stream Deck+.** The preview pictures were made with Chromium from the same layout and colours. The Stream Deck app draws them itself, so fonts and spacing will differ slightly.

## What changed
1. **New layout `layouts/attr.json`** for the four **Fixture: Attribute** dials. It is 200 × 100:
   - `header`: 0,0, 200 × 20; a text item with a `background`.
   - The body moved down: `name` 10,24; `mark` 132,24; `value` 10,42 (26 px); `unit` 142,50; `bar` 10,82, 180 × 10.
   - The manifest generator (`src/catalog/manifest.ts`, run by `npm run gen`) points Attribute 1–4 at it. The named fixture dials and the Select dial keep their layouts.

   **How the coloured line is done:** Elgato's layout reference gives every layout item, text items included, a `background` property: "Background color represented as a named color, hexadecimal value, or gradient". The same page says only `key`, `rect` and `type` cannot change at runtime. So the header is a plain text item, and its `value`, `color` and `background` are set with `setFeedback`. No pixmap is needed.
   - Source: *Layouts | Stream Deck SDK*, https://docs.elgato.com/streamdeck/sdk/references/touch-strip-layout/
   - The same property is in the SDK's own schema in the repo: `node_modules/@elgato/schemas/streamdeck/plugins/layout.json`, `Text.background`.
   - `streamdeck validate` accepts the file.

2. **The status line** (`render.ts`: `deckState`, `headerText`, `attrStripFeedback`). The background colour runs across all four strips:

   | State | Slot 1 | Slot 2 | Slot 3 | Slot 4 | Colours |
   |---|---|---|---|---|---|
   | **off** | `DECK OFF` | | | | grey text on #2A2E33 |
   | **click** (ON, nothing selected) | `CLICK A LIGHT` | `Click a light` | `in Capture` | | dark text on amber |
   | **driving** | `DECK ON` | `Ch 202 · 1/444` (or `Ch 202 +2`, or the position hint for Ch 0) | model, `Model ×2` or `3 fixtures`, clipped to 18 characters with `…` | page + `n/N`, e.g. `Main 1/8` | dark text on green #3DD68C |

   - The body under the line is exactly what it was: `—` dimmed for a missing channel, `~` and grey for an untouched value, ×N. A test compares it with the old function for the same input.
   - Only FINE changed: it is now drawn in the state colour (green or amber). When OFF it uses the grey of the off line, because the track colour would be invisible on the dark strip.
   - The dials redraw on fixture/selection changes **and** on every Deck Control change.
   - Slot 4 uses the page title as the page keys show it. A group split over several pages therefore reads, for example, `Shutters 1/3 5/8`.

3. **The Deck key** (`deckKeySvg`): the whole 144 × 144 key is the state colour, with big centred text:
   - grey `DECK` / `OFF`;
   - amber `CLICK` / `A LIGHT`;
   - green `DECK ON` / `Ch 202`.

   Further details:
   - With several lights selected, the second line reads `Ch 202 +1`.
   - The key sets an empty title once. Its manifest state and its profile entry are `ShowTitle: false`, so the old static "Deck OFF" title no longer competes.
   - The key redraws on Deck changes and on selection changes.
   - Font sizing uses `keySvg`'s `charW` approach, with a slightly wider width per character: with `charW` alone, "DECK ON" touched the key edges in the first preview.

4. **Home Selected is renamed Home Light.** The name is `Fixtures: Home Light` and the title `Home Light`. The UUID and the behaviour are unchanged. The Deck key's and Home Light's tooltips were rewritten. The Deck-ON log line now says `(Home Light key)`.
5. **Status and Next Fixture** are `VisibleInActionsList: false` in the generated manifest, so they are hidden from the actions list. They stay registered, so a key you placed by hand still works: the end-to-end tests still press the Status key and the Next Fixture key.
6. **The Fixtures page** has explicit positions now:
   - row 0: Back · Setup · (empty) · **Deck Control**;
   - row 1: **Home Light** · (empty) · ◀ Page · Page ▶.

   The profile checker allows a missing title **only on the Deck Control key**; every other key still needs a visible title. The profile and `DEFAULT-LAYOUT.md` were regenerated. `describe-layout.mjs` now names a key that has no title.

## Verified (sandbox)
**337 plugin tests pass, 0 fail** (research: 73 pass). Typecheck is clean, `streamdeck validate` and `npm run pack` both passed (**0.7.3.0**: the packed manifest says 0.7.3.0 and contains `layouts/attr.json`), and the Setup panel check passes.

Unit tests:
- `deckState` in all three states;
- the header text and colours per slot for off, click and driving: single light, ×2 of the same model, several models, the Ch 0 position hint, a long model clipped at 18 characters, and the page n/N;
- the body is identical to `fixtureStripFeedback` for the same input, and FINE is in the state colour;
- `deckKeySvg` has a full-size background rect in the state colour and the right text in each state;
- the manifest: Attribute 1–4 use attr.json, the named dials use dial.json, the attr.json rects are as specified, Status and Next Fixture are hidden but present, Home Light keeps the old UUID, and only the Deck key has `ShowTitle: false`;
- the profile: the Fixtures page has exactly the positions above, with no Status, Next Fixture or Release;
- the checker refuses a hidden or empty title on Setup, Home Light, ◀ Page and Page ▶ (each tried), and passes the generated profile.

End to end on the built plugin against the stub (`test/integration-lcd.test.ts`). Each step is checked in the `setFeedback` and `setImage` payloads:
1. At start-up (OFF), all four headers read the off line on grey and the key is the grey DECK OFF image; `setTitle("")` is sent once.
2. Deck ON by the key: headers and key go amber (CLICK A LIGHT) with **no selection event**.
3. A FixtureSelection turns them green: `DECK ON · Ch 202 · 1/444 · Rogue R2X Wash · Main 1/N`, and the key shows `DECK ON / Ch 202`.
4. Page ▶: slot 4 changes to page 2.
5. An empty selection: amber again.
6. Deck OFF: grey.

Across the run, the order of states in the header payloads and in the key images is off → click → driving → click → off.

A second end-to-end test (`test/integration-lcd-offline.test.ts`) runs with nothing listening on the CITP port. There, switching Deck ON produces no CITP traffic at all, and it checks that the line and the key still turn amber at once.

Mutation checks:
- **Header not redrawn on a Deck change: the offline test fails.** The header has two redraw paths: the dial's own Deck listener, and the runtime passing Deck changes on to the fixture service. Removing only one of them changes nothing visible, because the other still redraws. The mutation removed both, and that failed the test.
- **Deck key not redrawn on a selection change:** 2 tests fail (driving, and the order of states).
- **Status back in the profile:** 5 tests fail: the page layout, the checker (a hidden action), the visible-actions check, the title-exemption test, and the bundled-profile check.

Every mutation was restored, and `grep` confirmed no `MUT` mark was left. The full suite was rerun afterwards.

## Pictures (attached in the chat)
- `strips-off.png`, `strips-click.png`, `strips-driving.png`: the four strips side by side (800 × 100) in each state, drawn from `attr.json` and the plugin's own feedback on the plugin's strip background.
- `deck-key-states.png`: the Deck key off, click and driving.

## NOT verified
- On the real Stream Deck+: whether the app paints a text item's `background` exactly edge to edge, so the four strips join into one line, and how its fonts fit 13 px bold in 20 px.
- How the Stream Deck app treats an imported profile key with `ShowTitle: false` and an empty title. The plugin also sends `setTitle("")`.
- That a Status or Next Fixture key you placed by hand still appears after the update. The actions stay registered, but the Stream Deck app is what decides how it shows hidden actions on existing keys.

## Your test
1. Install. Check that the manifest says `0.7.3.0`.
2. Delete the old **Capture** profile and re-import the new one.
3. Deck OFF: the strip line and the Deck key are grey.
4. Press Deck: both go amber, "CLICK A LIGHT".
5. Click 202 in Capture: both go green; the strip shows Ch 202 · 1/444, the model and the page.
6. Click empty space in Capture: amber again.
7. Press Deck: grey.
8. Send me the `Fixtures:` and `CITP:` lines from
   `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.rezabehjat.capture.sdPlugin/logs/`.
