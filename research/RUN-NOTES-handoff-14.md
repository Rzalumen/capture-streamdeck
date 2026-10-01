# Run notes — Handoff 14 (dmx-proof: set extra channels, e.g. colour, during the test)

Base `78f517b` (pulled; it is what GitHub has). `research/` only: **the plugin and the CITP allowlist are untouched, no new CITP sends.** Built and tested in a Linux sandbox; **nothing here ran against your Capture.**

## What changed

- **`--set <ch>=<value>`**, repeatable. `<ch>` is the **1-based channel number within the fixture** (offset + 1, the numbering of Capture's patch view and of the "channel" column the tool prints), value 0–255.
  A **coarse channel also sets its fine partner** to the same value. A fine channel given on its own sets only itself (and says so). Giving the same channel twice with different values is an error.
- **`--color-full`**: every **coarse or 8-bit** channel whose name has one of the whole words `red green blue white amber lime uv` (case-insensitive; "Warm White" / "Cool White" match through "white") is set to **255**, its fine partner to 255 too.
  **Never** applied to names containing cyan, magenta, yellow, CTO, CTB (also ctc, cmy), or correction/balance/minus/plus/tint/temperature words, and **not** to names that also say strobe, shutter, flash or speed/time/macro/mode/curve/control/... (so "Red Strobe" and "Red Speed" are skipped).
- **Printed plan:** a table "Extra channels held at a fixed value for the whole run (N)" with channel, offset, DMX address, name, value and where it came from (`--set`, `--set 7 (fine partner)`, `--color-full`, ...), plus notes (e.g. `--set` winning over `--color-full`, or `--color-full` finding nothing). The "Slots sent" line now says "except the extra channels listed above".
- **Refused, no DMX sent:** a channel number outside the fixture's channels; a channel the test drives itself (pan, tilt, dimmer, shutter and their fine partners; use `--shutter-value` for the shutter); a channel where the candidate channel lists disagree (the Handoff 13 NOTE). `--color-full` silently skips those. Bad syntax (`--set 5`, value > 255) is an argument error.
- Everything else (mapping, safety checks, sequence, termination, sACN) is as before. The driven attributes are written after the extras, so an extra can never override pan/tilt/dimmer/shutter.
- New: `research/lib/extras.mjs` (the planning, unit-tested), `NOT_THE_VALUE` exported from `lib/modes.mjs` (no behaviour change), `frameSlots` takes `extras`.

## Tests (64 total, was 58; pass normally, with `FORCE_COLOR=1` and with a symlinked `TMPDIR`)

- `extras.test.mjs` (5): whole-word additive names; `--color-full` on a 28-channel made-up fixture sets exactly the additive channels (+ fine partner) and never Cyan, Magenta, Yellow, CTO, CTB, Green Correction, White Balance, Red Strobe, Red Speed or any driven channel; `--set` 1-based mapping with fine partner; the refusals; ambiguity offsets.
- `dmx-proof.test.mjs` (1 new, end to end on the stub): `--color-full` and `--set` appear in the printed plan with the right channel/offset/DMX address; the right slots are 255 / 64+64 / 128 in **every** packet, Cyan/Magenta/CTO and all other slots stay 0, the dimmer is still driven, nothing extra without the options; refusals send no UDP.
- I checked the tests can fail: making "cyan" additive fails 3 of them.

## Not verified

That the missing colour is why the Rogue went dark. It is your hypothesis and still just that: the first run with `--color-full` is the check. If it stays dark with the colours at 255, the next suspects are channels the tool leaves at 0 (e.g. the final `Control` channel, offset 55, or a strobe/lamp channel) — `--set <ch>=<v>` is there to try those one at a time, and the printed table tells you the names.

## Your run

```
git pull
npm run probe:dmx -- --fixture 62 --universe 1 --address 285 --color-full
```

Watch the Rogue at 1.285: it should stay lit (white) while it pans and tilts. Paste the output, in particular the "Extra channels held at a fixed value" table: check that it lists Red/Green/White/Blue 1–5 (and the others you expect) and nothing you don't.
