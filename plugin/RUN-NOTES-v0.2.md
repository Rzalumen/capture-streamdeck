# Run notes — plugin v0.2.0 (Handoff 08)

Base `d0919e9` (v0.1). Built and tested in a Linux sandbox: **nothing here ran against a real Mac, Capture, or
System Events.** What was and wasn't verified is listed below.

## What changed

- **Catalog → named actions.** `src/catalog/commands.json` (120 entries, 9 categories) is the single source. `npm run gen`
  writes `manifest.json` (142 actions: 120 commands + 12 dials + 2 toggles + the 8 generic ones). One handler instance per
  UUID, preset baked in; the inspector shows only *Hold to fire* / *Dim when disabled*.
- **Grouping method used:** manifest order (category order) + the `"<Category>: "` name prefix. The manifest schema has no
  per-action group/category field (only the plugin-level `Category`) — confirmed in Elgato's manifest reference.
- **Speed.** One persistent `osascript -l JavaScript` worker (`ax/worker.js`, NDJSON on stdin/stdout), auto-restart, per-call
  fallback. Priority queue (press 0 < poll 2 < background 3); a press drops any waiting poll; one poll in flight at most.
  Polling: on key appear (batched 25 ms), 300 ms after a press, otherwise every 5 s, only visible keys, one request.
  Menu tree read one top-level menu per request at the lowest priority, cached per Capture pid, built at start,
  *Refresh* button in the generic action's inspector.
- **View dials.** All 12 number properties from manual §21.4.3 as named dials (`flareStreaks` sends `i`, integer steps 1–7;
  everything else `f`; ranges as in the manual table), plus the generic *View Dial*, plus named toggles.
- **Logging.** Every key/dial event (UUID, settings, result); every inspector change; `no command configured`; errors
  verbatim; one `AX summary:` line per 60 s instead of per-poll lines. Dial rotation is logged once per gesture (sum of
  ticks + final value after 400 ms of quiet), not once per tick.
- **Also:** `manifest.base.json` (generic actions + metadata), `scripts/gen-manifest.mjs`, 360 generated PNGs
  (`imgs/icons`, `imgs/keys`; original line icons, one per category + specific glyphs), version 0.2.0.0.

## Press latency: before / after

| | Median |
|---|---|
| **Before** (Reza's v0.1 log): `View › Camera › Position 1` ×10 | ~400 ms per click |
| Before: Tab Design ×9 | ~200 ms per click |
| Before: every osascript call | 450–650 ms median; 2 polling keys kept the queue busy ~⅓ of the time |
| Before: menu dump for the inspector | 7.7 s (blocked the queue) |
| **After** | **not measured — cannot be measured in the sandbox.** Target < 150 ms; the plugin now logs it (below). |

The v0.1 numbers are dominated by starting a process per call; the worker removes that, but I have no measurement of what
real System Events takes per call inside a long-lived process, so I am not predicting one. After a test session, the log
shows it directly:

- each press: `AX press click View > Plot: 38 ms (queued 0 ms, 38 ms via worker)` — first number is key event → result;
- every minute: `AX summary: press n=…, median … ms p95 … ms (service median … ms) | poll … | bg … | via worker`.

If `via osascript` (or `N fallback calls`) appears, the worker isn't in use — the log will say why (`AX worker …` lines).

## Verified here (automated)

`npm test` in `plugin/` (174 tests) and in the repo root (22) pass; `streamdeck validate` passes (note: it printed
`Failed to load remote schema` for the two Elgato schema URLs — the sandbox can't fetch them, so the schema part of
validation is weaker than on a Mac); the real `ax/worker.js` runs in Node against a fake System Events (click/enabled/tab/dump
logic, error mapping, stdin/stdout framing); the plugin runs end to end against a fake Stream Deck, Capture (OSC) and worker
(startup reads, batching, presses-first, pid cache, crash recovery, permission errors).

## NOT verified (needs a Mac)

1. **The JXA calls themselves** (`menuBars[0].menuBarItems.name()`, `menuItems.enabled()`, `p.frontmost = true`,
   `windows[i].tabGroups[0].radioButtons.byName(...)`, `NSFileHandle.availableData`…) — written from the JXA/System Events
   object model, exercised only against a mock of it. Protection: at start the plugin sends a read-only `check`; a JS-level
   (TypeError/ReferenceError…) worker error makes that call fall back to per-call osascript and two in a row switch the worker
   off (logged verbatim as `AX worker internal error …` / `AX worker disabled: …`). A click is never repeated after the
   worker died or errored mid-click.
2. **Real error text/numbers from JXA** for a missing Accessibility grant. The worker sends `errorNumber`/parsed `(-25211)`
   and text; the plugin classifies text first, numbers second (as in v0.1). An unclassified error on a *read* is re-asked of
   the real osascript so the authoritative wording is logged.
3. **"Dial: …" and "View Dial" visibility.** v0.1's "7 actions" is exactly the seven keypad actions; View Dial is the only
   `Controllers: ["Encoder"]` action, so it is consistent with Stream Deck hiding dial-only actions while a key slot is
   selected. Elgato's docs don't say either way, so it is **unconfirmed** — please select a dial/touch-strip slot in the
   Stream Deck app and check for *View Dial* and the twelve *Dial: …* entries. (The manifest for the dial is valid and
   unchanged in shape.)
4. **Catalog gaps** — the Handoff 07 dump didn't give these, so they are not guessed silently:
   - *Edit › Model ›* items: contents unknown → **no named keys** for them (use the generic Capture Command).
   - *File › Import / Export*: nesting/names unknown. Entries (Import Project/Model/Fixture Data; Export Project/Model/Fixture
     Data/Focus Sheets/Documentation/Presentation) are marked `unverified` in the catalog with a fallback path
     (`File › Export Focus Sheets…` etc.); if the primary path isn't in the live menus the key uses the fallback, else the one
     same-named command in the same menu, else it shows `?`. The inspector warns on these keys.
   - *Tools* menu: not in the handoff's category list → not catalogued.
   - Names of *Select Only ›* items (`Front/Centre/Tail Annotations`) and menu names generally are taken from Handoff 07's
     summary; any that differ are caught by the same fallback and logged.
   After the first run the log has two lines that settle all of this: `Catalog entries not found in this Capture's menus (N): …`
   and `Capture commands with no catalog entry (K): …` (printed once per Capture launch, when the menu tree is cached).
5. **Timing of the worker's activation wait** (polls `frontmost` for up to 0.4 s rather than a fixed 0.2 s delay).

## Reza's test plan

1. Uninstall v0.1, install `com.rezabehjat.capture.streamDeckPlugin` (v0.2.0.0). Open Capture on a **copy** of a show.
2. In the action list, confirm the named actions appear grouped/prefixed by category (View:, Camera:, Select:, Edit:,
   Patch & Focus:, Navigate:, Window:, File:, Tabs:, Dial:, Toggle:), and that *View Dial* + the *Dial: …* entries appear
   when a **dial slot** is selected (see item 3 above — say if they never appear).
3. Drag *View: Plot*, *View: Live*, *Camera: Swing to Front*, *Tabs: Fixtures*, *Edit: Undo* onto keys and *Dial: Bloom* onto a
   dial; use each a few times.
4. Send back the plugin log (the same one you sent after the v0.1 test):
   the `AX press …` lines, the `AX summary:` lines, the two catalog lines, and any `AX worker …` lines — plus your impression
   of the speed compared with v0.1.
