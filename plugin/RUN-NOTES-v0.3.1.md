# Run notes — plugin v0.3.1 (Handoff 10)

Base `9248148` (v0.3). Built and tested in a Linux sandbox: **nothing here ran against a real Mac, Stream Deck app, Capture
or System Events.** The fix below is proven against the real `ax/worker.js` running in Node with a fake System Events that
matches titles exactly (as the real worker does), not against Capture itself.

## What was wrong (from your v0.3 log)

Capture's live titles use `...`; the catalog used `…`. The startup comparison and `MenuCache.effective()` compared titles
leniently ("found"), but the click and the enabled polling sent the catalog string literally to a worker that compares
exactly → `-1728` for every title ending in an ellipsis. Two code paths, two answers.

## What changed

1. **One resolver** — `src/lib/resolve.ts`. Each path segment is matched against the cached live menu tree
   (`…` ≡ `...`, whitespace collapsed, trim, case-insensitive) and **Capture's exact live title is what is sent**.
   Used by: key press, enabled polling, the startup report (`MenuCache.resolve` / `diffCatalog`), and the generic
   *Capture Command* key. The old lenient `diffCatalog` / `resolveMissing` / `MenuCache.effective` are gone.
   - `prefix` (Undo, Redo) stays a prefix; `alternates` (Enter/Exit Full Screen) keep both candidates (each replaced by its
     live title when it exists). Parents are always replaced by live titles.
   - Order: the entry's path → its `fallbackPaths` → the one same-named command in the same top menu (exact-title commands
     only; never a guess between two).
   - **Tree not cached yet:** the first press builds it (read-only) and then resolves; polling uses the catalog path
     until the tree arrives, then redraws. If the tree can't be read at all (no permission, Capture closed) the catalog
     path is sent as before, so the real error still shows.
   - **No match:** the key shows **`?`**, nothing is clicked, the key flashes `?`, and the log says
     `Edit > Sequential > Channel... not found in Capture's menus; closest live titles: …`. A missing command is no longer
     polled.
   - If a click still gets `-1728` (tree out of date), the tree is re-read once and the click retried (nothing was clicked
     by a `-1728`).
2. **Catalog** — every `…` is now `...` (`commands.json` has no `…` left; the resolver accepts either).
3. **Catalog fixes** — `File: Import Project Content` = `File > Import Project Content...` (id kept, so UUID and profile
   references are unchanged; hold-to-fire still on; the old `Import > Project…` is now its fallback). Four new Edit actions:
   `Edit: Hide Distracting Edges`, `Edit: Convert Lines to Pipes`, `Edit: Model Edit...`, `Edit: Scale Drawing Unit...`
   (paths `Edit > Model > …`). Manifest: 150 → **154** actions. I set hold-to-fire **off** for all four (you didn't say;
   Convert Lines to Pipes changes the model, so say if you want it to hold).
4. **Camera folder** — the first Camera page is now *Swing to Top · Front · Right · Left · Selection · **Positions ▸** · More ▸*,
   the second *Focus Selection · Focus All*. **Positions ▸** is a page of its own: *Position 1–5 · Store Modifier · Show ▸*
   (Show ▸ = Show Position 1–8 and Store Camera 1–5, as before). Position 1–5 and Store Modifier are on the same page with
   no More ▸ between them. I put *Positions ▸* on the first page (one press away) rather than after the Swing keys; say if
   you'd rather it be reached via More ▸. Profile regenerated (26 pages, 186 keys); `DEFAULT-LAYOUT.md` regenerated.
5. **Startup report = click path.** `diffCatalog` calls the same `resolveEntry` as the click. New log wording:
   `Catalog entries not found in this Capture's menus (n): <path> (closest: …)`, plus a new line
   `Catalog entries found at a different path (n): A -> B (fallback|name)`, and the unchanged
   `Capture commands with no catalog entry (n): …`.

Version 0.3.1 (manifest 0.3.1.0). No change to `worker.js`, `applescript.ts`, DMX/CITP, or input synthesis.

## Verified here (automated)

- `npm test` in `plugin/`: **216 pass** (209 before; new: resolver, prefix/alternates, unknown path → "?" with
  suggestions, startup-report vs click agreement, `…`-free catalog, Import/Model entries, Camera page, one end-to-end
  press/poll/"?" test; the old lenient-diff tests were replaced). `npm test` in the repo root: 22 pass. `streamdeck validate` passes against the live schemas.
  `check-inspector` (Chromium) passes. `npm run pack` → 0.3.1.0, 154 actions, profile inside.
- **The agreement test** (`test/resolve.test.ts`): builds a live tree for every catalog entry with deliberately different
  spellings (Unicode `…`, different case/spacing, a command at its fallback path, one command missing), asks the report
  which are found, and then clicks every found one with the **real `worker.js`** using the resolved title — all succeed;
  the missing one gives `-1728`. I broke the report on purpose (lenient compare, i.e. the v0.3 bug) and the test failed,
  so it does catch a divergence. A second test reproduces your failure (`Patch…` literal → `-1728`; resolved → OK, and the
  poll finds it).
- Four older integration tests changed, for a reason you should know: their fake Capture menu lacked some commands
  (Wireframe, Copy, Cut), which now — correctly — show `?`, aren't polled and aren't clicked. I added those three to the test
  dump; nothing else in those tests was loosened.

## NOT verified (needs your Mac)

1. **That real Capture/System Events accept the resolved title.** They should — it is the title the dump read from the same
   menu — but I can't test that here.
2. **The other File import/export paths.** I have no live menu dump, so I did not change `Import Model…`, `Import Fixture
   Data…`, the six `Export …` paths beyond `…` → `...`; they are still marked `unverified` with their fallback paths. Your
   v0.3 log only flagged `Import Project…`, and its comparison was the lenient one. **The new startup lines settle it**:
   anything in `not found (…)` or `found at a different path (…)` needs a catalog edit.
3. The Stream Deck app importing the regenerated profile (unchanged format from v0.3).
4. Everything in v0.3's "not verified" list that isn't about ellipses.

## Reza's test plan

1. Install `com.rezabehjat.capture.streamDeckPlugin` (0.3.1.0) over v0.3 and accept the profile again (or double-click
   `Capture.streamDeckProfile`). Open Capture on a **copy** of a show.
2. **Patch & Focus** folder: press Sequential Unit, Circuit, Patch, Channel, P3, Focus, Fixture Details. Each should open
   its dialog in Capture — cancel it. **File:** press and hold *Import Project Content* (1 s) — the import dialog opens; cancel.
3. **Camera › Positions ▸**: hold *Store Modifier* and press *Position 1*, then release and press *Position 1* again
   (should store, then recall). Also look at the Camera pages and the four new *Edit: …* keys (Edit folder, last page).
4. Send the plugin log lines: `Menu tree cached…`, `Catalog entries not found…`, `Catalog entries found at a different
   path…`, `Capture commands with no catalog entry…`, and any `not found in Capture's menus; closest live titles` or
   `AX click … failed` lines.
