# Run notes — Handoff 11 (fixture-agnostic DMX proof + library export)

Base `67a4970`. Work is in `research/` only; **the plugin is untouched**. Built and tested in a Linux sandbox: **nothing here ran against
a real Capture, a real library or a real fixture.** Everything below "verified" means against synthetic data built from the layouts
you verified earlier, and a stub CITP server.

## What is new

- `npm run probe:dmx` → `research/dmx-proof.mjs`. No `--fixture`: lists the **patched** fixtures (`#`, manufacturer, model, mode, channels,
  universe/address 1-based, number of other patched fixtures in that universe) and exits without sending anything. With
  `--fixture <#>` (the `#` is Capture's FixtureList index, the same `#` as in `citp-connect --sync`): reads the fixture's library object,
  finds the mode block, parses the channels, **aborts without DMX unless parsed count = block channelCount = CAEX ChannelCount**,
  prints the channel table, maps pan / tilt / dimmer-intensity / shutter-strobe by name (16-bit when the pair says so), then sends the sequence.
  Options: `--seconds` (default 6), `--shutter-value` (default 255, printed as a guess), `--force`, `--sacn-universe`, `--lib`, `--host/--port`,
  `--sacn-port`, `--no-multicast`, `--fps`. It also writes `reports/dmx-proof.txt` (the same text it prints).
- `npm run export:objects` → `research/export-objects.mjs`. Reads the live patch over CITP and writes the library object of every distinct
  fixture type in the open show (patched or not) to `reports/objects/<manufacturer>-<model>__<guid>.bin` (inflated bytes, unchanged) plus
  `manifest.txt` (model, modes used in the show with their mode GUIDs, guid, size, size check). `--guid <raw>` (repeatable) exports named objects without CITP.
- `research/lib/`: `sacn.mjs` (E1.31 packet), `modes.mjs` (mode-block parser + name mapping), `citp-sync.mjs` (read-only patch reader, same outgoing
  allowlist as `citp-connect --sync`), `dmx-seq.mjs` (the move sequence), `main.mjs` (`isMain`, see Part B1).
- `.gitignore`: added `*.bin` (`reports/` was already ignored; checked with `git check-ignore`, and a test does it).

## The sequence it sends

40 fps. Hold 1 s (intensity 100 %, shutter at `--shutter-value`, pan/tilt 50 %). Then **pan**: a glide 50 % → 0 % (at the sweep's own speed, `seconds/3`),
then the sweep 0 → 100 → 50 % taking `--seconds`; then the same for **tilt**. The glide is my addition so the head does not jump from 50 % to 0 %; the printed timeline shows it.
Every other slot of the universe is 0, **including this fixture's channels that are not mapped** (their defaults are not decoded). sACN priority 100, fixed CID, source
`capture-streamdeck dmx-proof`; sent to unicast `127.0.0.1:5568` **and** `239.255.<hi>.<lo>:5568` on every local IPv4 interface (each logged); at the end 3 frames with
Stream_Terminated (also on Ctrl-C). If other patched fixtures share the universe it prints them and refuses unless `--force`.
Because it sends to several destinations on one machine, Capture may receive the same packet more than once (same sequence number); E1.31 receivers normally drop that.

## Part B1 — the failing mode-probe test

Cause (reproduced here by pointing `TMPDIR` at a symlink, which is what `/var` → `/private/var` is on macOS): the script decided whether it was "the main module" by comparing
`import.meta.url` (a real path) with `process.argv[1]` (not resolved). Under a symlinked temp dir they differ, the script silently did nothing, so no report existed → ENOENT. Fix:
`research/lib/main.mjs` `isMain()` compares real paths, used by `mode-probe`, `dmx-proof`, `export-objects`; `mode-probe` got `--out <dir>`; the test now runs the script in place
with `--out` in a temp dir and **prints the temp dir, its real path, the report path it expects and the script's last output line**. It passes normally and with `TMPDIR` set to a symlink.
Not run on your Mac.

## Verified here (automated, `npm test` in the repo root: 46 pass; also with a symlinked TMPDIR)

- E1.31 packet: byte-for-byte against a vector written out field by field in the test (not made by the builder); flags/lengths 622/600/523; multicast address; argument checks.
- Channel parser: exact count with decoy strings inside every record; decoys that look like records but fail the role/pair/partner rules; 60 seeded random tails (all 60 parsed exactly; the test would also accept a refusal but never a wrong list); raw-order GUID accepted with a warning; two blocks in one object; absent GUID, wrong count, truncated object, non-ASCII name → refusal;
  a deliberately ambiguous object → refusal.
- Abort on mismatch (parsed ≠ block count ≠ CAEX count), missing library object, missing pan/tilt, missing identifiers, unknown `#` → no packet is sent in any of them.
- Attribute mapping on "Pan", "Pan Coarse", "Pan Fine", "Beam Dimmer", "Intensity", "TILT", "SHUTTER/STROBE", "Strobe", camelCase; "Pan/Tilt Speed", "Dimmer Curve", "Shutter Mode" are not taken as the value channel.
- `dmx-proof` end to end against a stub CITP server + a UDP listener, on **two differently laid-out synthetic fixture types** (16-bit pan/tilt, and 8-bit pan/tilt in another order): list, parsed
  table, universe, 40.3–40.4 fps (median gap 20–30 ms checked), constant CID, incrementing sequence, 16-bit values (50 % = 0x8000, fine byte carries the low byte), pan before tilt, the other axis held at
  50 %, every other slot 0, 3 terminated frames last, refusal without `--force` (and sending with it), Ctrl-C still terminates, multicast destinations logged for every interface (here `lo` and `eth0`, all
  received). Only allowlisted CITP messages reach the stub.
- `export-objects` against the stub: distinct types (an unpatched fixture counts, a fixture without AtlaBaseFixtureId is reported), bytes identical to the object, manifest content, `--guid`, a missing object is reported (exit 3).

## NOT verified

1. **Anything on a real Capture.** The mode-block parser has only seen blocks I built from the layout in the handoff; real records have an undecoded tail. If a real mode does not give a unique exact parse, the tool
   says so and sends nothing — that is the expected failure and is why `export:objects` exists.
2. **sACN spec.** The ESTA E1.31-2016 PDF answered HTTP 403, so the field table was taken from libe131 and Hundemeier/sacn source, not read from the PDF. I did **not** quote section numbers. Please compare once.
3. **Universe number.** I send sACN universe = Capture's 0-based universe + 1. That is an assumption. Capture's sACN input must be enabled for that universe; I don't know where that setting lives, so the tool only prints the
   number and offers `--sacn-universe`.
4. **Shutter 255** is a guess (open on many fixtures, full strobe on some). Other channels at 0 may mean a fixture without a lamp-on/other control value shows nothing; the dimmer is at 100 %.
5. **Fixture names with non-ASCII characters** in a channel name make the parser refuse (safe, but you'd get no DMX).
6. macOS multicast behaviour (interface selection, sandbox/firewall prompts) — only Linux was tried.

## Your run

1. In a **copy** of a show, patch one moving light of any type, ideally alone on its universe. Open Capture on it.
2. `cd ~/capture-streamdeck && git pull`
3. `npm run probe:dmx` → the numbered list.
4. `npm run probe:dmx -- --fixture <#>` → watch the light pan, then tilt, in the 3D view. Paste the printed channel table (and anything that says ERROR/NOTE). The same text is in `reports/dmx-proof.txt`.
   If nothing moves: check Capture's sACN input for the printed universe, then try `--sacn-universe <n>`. If the shutter is the problem, try `--shutter-value 0` / `--shutter-value 128`.
5. `npm run export:objects`, then upload everything in `reports/objects/` (the `.bin` files and `manifest.txt`) to Claude.
