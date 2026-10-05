# Run notes: plugin v0.7.2 (Handoff 23: the deck drives only what Capture selected in the current connection)

**Base:** I ran `git pull` in my working clone. It was at **`5b731b5`**, as the handoff says. This is one commit on top of it. **Use `capture-streamdeck-0024.bundle`.**

**`git pull` in your `~/capture-streamdeck`:** at first only its `Claude outputs` subfolder was connected to this session. I asked for access to the whole folder, you granted it, and the pull there said "Already up to date" at `5b731b5`. The pull left an empty lock file, `.git/ORIG_HEAD.lock`, that it could not remove. With the delete permission you granted, I removed that one file, so your next `git pull` won't be blocked. Nothing else there was touched.

**The version is 0.7.2 (manifest `0.7.2.0`).** From now on every delivery gets a new number, so the Stream Deck app replaces the plugin instead of saying "already installed".

**Restart brief sections 1–4 were followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z`, `dist/`, `*.streamDeckPlugin` or the library is committed;
- generic name rules only;
- **CITP, the allowlist, `citp.ts`, `identify.ts`, `sacn.ts`, the engine's sending, the resume/home values, the colour defaults, the pages and the profile layout are unchanged** (the profile was only regenerated to carry the new version number);
- no new CITP messages, and no way of asking Capture for its selection.

I built and tested everything in a Linux sandbox. **Nothing here has run on your Mac.**

## What changed
1. **No fallback fixture** (`selection.ts`, `view()`). Before, with nothing selected, the deck drove the first controllable fixture in channel order. That is how your 18:31:07 turn moved Ch 201 to 79 %. Now, with nothing selected:
   - the dials and Home move nothing;
   - the strip reads **`Click a light`** / **`in Capture`** (with or without controllable fixtures).
2. **An empty selection in Capture clears.** Deselecting in Capture now clears the deck selection; it no longer keeps the last one. The "stale" state and `(not selected in Capture)` are gone: the `stale` field and `STALE_NOTE` were removed. Outside the tests, that touched only `selection.ts`; nothing else in `src/` used them. The old tests for that behaviour were rewritten (not weakened).
3. **`FixtureService.onLinkClosed(why)`**: clears the selection, logs `<why>: selection cleared` and redraws. **Output is not released here**: a dropped connection keeps output, as in v0.5. Only the selection goes.
4. **Deck Control OFF clears the selection on every path** (Deck Control key, idle, Release key). `DeckControl` got an `onOff` hook. It is called at the moment of switching OFF, before the DMX release, and `runtime.ts` wires it to `onLinkClosed("deck control OFF")`. Log: `Fixtures: deck control OFF: selection cleared`.
5. **The ON connection closing clears it too.** This covers Deck Control OFF, Capture quitting or reopening, and a dropped socket. In `link.ts`, when the session reports the connection closed while the link is in ON mode, it calls `onLinkClosed("CITP connection closed")`. Log: `Fixtures: CITP connection closed: selection cleared`.
   - **Brief connections never clear the selection.** Neither does a failed connection attempt (that one never connected).
   - LeaveShow and a different show still clear the selection, as before.
6. Log line for an empty selection from Capture: `Capture's selection is empty: nothing selected on the deck`.
7. **Next Fixture key / Select dial: unchanged.** They still pick a fixture by hand; from nothing selected they start at the first fixture (backwards: the last). Capture's next click overrides that.

Because Capture does not send its current selection when a console connects, after Deck ON you must click the light in Capture once before the knobs move it.

When you switch OFF, both lines are logged. "deck control OFF: selection cleared" comes first, then "CITP connection closed: selection cleared" when the persistent connection actually closes. That is expected.

## Verified (sandbox)
**324 plugin tests pass, 0 fail** (research: 73 pass). Typecheck is clean, `streamdeck validate` and `npm run pack` both passed (**0.7.2.0**, and the packed manifest says 0.7.2.0), and the Setup panel check passes.

Unit tests:
- with no selection, `view().targets` is empty and the strip reads "Click a light / in Capture" (also with no controllable fixture at all);
- an empty FixtureSelection clears, and a turn then drives nothing;
- `onLinkClosed` clears and logs; output stays on; afterwards a turn and Home change no slot;
- Deck OFF clears on the key, idle and Release paths (and not again when already OFF);
- a persistent-session close clears: a dropped socket, and OFF. After the reconnect it stays cleared;
- **a brief connection's close does not clear:** a hand-picked fixture survives a brief sync, and while ON with Capture's selection, a brief sync (only a list request then) leaves it alone;
- Next Fixture / Select dial still pick a fixture by hand, wrap both ways, and Capture's next click overrides them;
- with nothing selected, the attribute pages are empty and the page keys do nothing.

End to end on the built plugin against the stub (new `test/integration-selection.test.ts`): two controllable fixtures, **A (Ch 201, first in channel order)** at 1/1 and **B (Ch 202)** at 1/15.
- Deck ON, select B, turn Pan: only B's slots are non-zero.
- Deck OFF, then **Deck ON by a knob turn**: **not a single sACN packet** is sent, and the strip reads "Click a light / in Capture".
- Select B, turn Pan: only B's slots change, continuing from B's stored 60 % to 65 %.
- The stub drops the connection and the plugin reconnects with no selection: a turn changes no slot of A or B. Output was still running, so frame-by-frame comparison was possible.
- LeaveShow, then EnterShow again with no selection (your 18:29–18:31 case): a turn moves nothing.
- An empty FixtureSelection, then a turn: nothing moves. Home changes nothing either.

The existing end-to-end tests (Deck Control, Release, resume after a restart, a connection lost) now send a FixtureSelection before turning. Each also checks that the turn that switches Deck Control ON sends nothing.

Mutation checks (each made tests fail, then I restored the file and checked it was identical):
- restoring the `ctl[0]` fallback: 13 tests fail;
- removing the OFF clear: 7 fail;
- making the brief close clear: the brief-connection test fails.

## NOT verified
- Anything on your Mac: Capture's real message order on connect and on show reopen, and the strip text layout on the hardware.
- The timing on the real network. In the sandbox I selected only after the persistent connection was up. If you click a light in Capture in the split second between Deck ON and the connection being up, Capture's message can't reach the plugin and nothing is selected: just click again.

## Your test
1. Install v0.7.2 (it replaces 0.7.1: new version number) and re-import the profile.
2. Deck ON, click **202** in Capture, turn Pan: 202 moves.
3. Deck OFF. With the mouse, click and move **201** in Capture. Then Deck ON **by turning Pan**: **nothing moves**, and the strip says **"Click a light"**.
4. Click **202**, turn Pan: only 202 moves.
5. Send me the log lines (`Fixtures:` and `CITP:`). The plugin log is in:
   `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.rezabehjat.capture.sdPlugin/logs/` (not `~/Library/Logs/...`).
