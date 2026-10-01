# Run notes — Handoff 13 (dmx-proof: proceed when the ambiguity doesn't touch the driven channels)

Base `69c45d9`. `research/lib/modes.mjs`, `research/dmx-proof.mjs` and tests only. **The plugin, `lib/citp.mjs` (allowlist), the count checks, the abort-on-mismatch rule and `--link` are untouched.**
Built in a Linux sandbox; **nothing here ran against your Capture.** "Verified" below means against synthetic blocks and the CITP/UDP stubs.

## What changed

1. **Several consistent readings no longer mean an automatic refusal.** For every candidate channel list the attribute mapping (pan, tilt, intensity, shutter and their fine partners) is computed
   (offset, name, role, pair of each). If **every candidate gives the same result for every mapped channel, dmx-proof proceeds** and prints
   `NOTE: N candidate channel lists differ only at offsets [...] (not used by this test): <offset>: "A" vs "B"`. If they disagree on **any** mapped channel it refuses exactly as before, naming the attribute
   (`... disagree on a channel that would be driven: pan: not found vs offset 3 "Pan"`).
2. **Which list is printed:** the first candidate in file order. Only mapped channels are ever driven, so a slot at a differing offset stays 0 (checked in code, and in the end-to-end test: every slot that isn't a driven one is 0 in every packet).
3. **Which alternatives are candidates** (this is the judgement call; please read it):
   - The first sequence found is the reference. If the other readings differ from it **only in the final channel record** (your Rogue case: `Control` vs `Pan/Tilt Speed`), every reading of that final record is a candidate, **except** those that start at or beyond
     the next mode-block header in the object. Those lie in a different block, so they are ignored (counted, and reported as `N other reading(s) of the final channel record lie at or beyond byte X, where the next mode block starts … ignored`).
     If that leaves one reading, the parse is unique and there is no NOTE. This is how "followed by valid data that isn't a channel record (end of block)" is decided: it is decided by where the next block starts, because a record's tail is undecoded and so
     "end of the final record" cannot be located from the bytes. I believe your `Pan/Tilt Speed` is the first record of the next block (not verified).
   - If a record in the tail of the final record looks like a record and *is* inside this block, the candidates are compared as per point 1 and the first in file order is printed (the end-of-block rule can't prefer either).
   - If the readings differ **earlier** than the final record, nothing is relaxed: all readings (up to 32) are enumerated and compared strictly, more than 32 refuses.
   - More than 500 readings of the final record refuses.
4. **Information line (does not decide anything):** when the final-record rule was used, the parser also counts every consistent reading of the whole list, including shifted ones, and prints either
   `all N consistent readings ... agree on every driven channel` or `WARNING (information, not used to decide): a strict comparison ... does NOT agree ...`. This tells you whether the "final record only" shortcut hides disagreement.
   Under that second line there is always `alternatives were compared for the final channel record only (...)`.

## Residual risk (not verified, please check)

The rule above compares alternatives for the **final record only**. A decoy string inside an *earlier* record's tail could in principle make the parser take one wrong record and shift later offsets; the comparison would not see it (the information line above would).
On your Rogue data the first sequence matched Capture's patch view in all 56 channels, so this is not a known problem there, but **check the printed table's pan/tilt/dimmer/shutter offsets against Capture's patch view before looking at the fixture.**
If those match, pan and tilt should move the Rogue at 1.285.

## Tests (58 total, was 52; all pass; also under `FORCE_COLOR=1` and with a symlinked `TMPDIR`)

- `modes.test.mjs`: in-tail decoy (Rogue-like, 11 channels): right mapping, 2 candidates, proceeds, NOTE text exact; three candidates; 41 candidates; identical lists at two byte positions = one candidate; **refusals** when pan is missing in one candidate, when
  the pan offset is the same but the name differs, and when the ambiguity is in a non-final record; next-block case (alternative outside the block ignored, unique); >500 readings refuse; the original 9 still pass (the `Shutter`/`Strobe` ambiguity test refuses, as it must).
- `dmx-proof.test.mjs`: end to end on the stub with manual `--universe 1 --address 285`: proceeds, NOTE printed, table shows the first candidate, mapped slots right (pan 0x8000 etc.), the differing slot (offset 10) and every non-driven slot stay 0 in every packet, only allowlisted CITP sent;
  a second fixture whose candidates differ on pan refuses with the pan message and sends **no** UDP.

## Your run

```
git pull   # (or apply capture-streamdeck-0012.bundle)
npm run probe:dmx -- --fixture 62 --universe 1 --address 285
```

Watch the Rogue at 1.285: pan, then tilt. Paste the output, including any `note:` / `NOTE:` / `WARNING` lines, and say whether the printed channel table still matches Capture's patch view.
