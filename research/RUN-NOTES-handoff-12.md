# Run notes — Handoff 12 (manual address for dmx-proof; `citp-connect --link`)

Base `bc3e873` (pushed by Reza). `research/` only; **the plugin and `lib/citp.mjs` (the outgoing allowlist) are untouched.** Built and tested in a Linux sandbox:
**nothing here ran against your Capture.** Everything "verified" is against stubs.

## 1. `dmx-proof`: manual address

- `npm run probe:dmx` now lists **all** fixtures (not only patched ones): `#`, manufacturer, model, mode, `ch`, **Channel** (Capture's own number), and three columns
  labelled **from CAEX**: patched yes/no, universe/address (1-based; when Patched=no it shows `- (raw u0 a0)`, i.e. the raw 0-based values Capture sent), and how many *other*
  fixtures report Patched=1 in that universe.
- New `--universe <1..>` and `--address <1..512>`; **both are required together** (one alone is an error), and they need `--fixture`. They override the CAEX patch, and the tool prints
  `USING A MANUAL ADDRESS: universe U address A …` (and, if there was a CAEX patch, which one it overrides). The sACN universe number sent is the `--universe` you gave (still an assumption — see below);
  `--sacn-universe` still overrides that number. The printed channel table's "DMX addr" column uses the manual address.
- Without them: a fixture with Patched=1 behaves as before; **a fixture with no CAEX patch is refused** ("Capture sent no patch for this fixture over CAEX (Patched=0)…") and nothing is sent.
- The "other fixtures in this universe" check cannot be trusted while CAEX sends no patch, so in manual mode it prints
  `WARNING: manual address. Capture's CAEX data carries no patch for N of the other M fixture(s) … Make sure universe U holds ONLY this test fixture … or accept that every other channel of universe U is sent as 0`.
  It does **not** refuse on that warning (it can't know). It still refuses (unless `--force`) when another fixture that *does* report Patched=1 sits in that universe. In CAEX-patch mode, fixtures with Patched=0
  get a shorter warning that they could be in the universe unseen.
- Unchanged: channel parsing, abort-on-mismatch, sACN packet/priority/CID/40 fps, termination frames, Ctrl-C.

## 2. Test fix (`isMain …`)

Cause (matches what you saw): Node's `console.log` colours a boolean when `FORCE_COLOR` is set, so the child printed `\x1b[33mtrue\x1b[39m`. The child now writes `String(x)`, the test removes colour variables from the child's
environment, and strips ANSI codes from the output anyway. I confirmed the **old** test fails under `FORCE_COLOR=1` and the new one passes with it.

## 3. `citp-connect --link`

`npm run probe:citp -- --link` (120 s; `--seconds <n>` to change; report `reports/citp-link.txt`).

- **Announces** PINF/PLoc every 1 s, Type `LightingConsole`, name `capture-streamdeck probe`, State `Running`, `ListeningTCPPort` = our TCP listener, to both CITP multicast groups on every local IPv4 interface
  (same as `probe:network -- --announce`; sent from a socket bound to UDP 4809 with reuseAddr, as that probe did). The announcement starts **before** looking for Capture and continues until the end.
- **Accepts any inbound TCP connection** and logs every chunk, message, hex and decode, tagged `[in#N]`. On it: PNam when it connects, then the same rules as the outbound session — empty LaserFeedList for
  GetLaserFeedList, our EnterShow + a FixtureListRequest after Capture's EnterShow, NACK (3) for Capture's requests. Only allowlisted messages (`isAllowedOutgoing` is applied to every TCP send).
- **Outbound session** to Capture exactly as `--sync` (found by PLoc discovery, lsof fallback), tagged `[out]`.
- **Re-request:** a FixtureListRequest every 10 s on every open connection for the whole run (`--rerequest-seconds` exists for tests).
- **Per FixtureList** (either connection) one line: time, connection, list number, count, Type, `patched(Patched=1)=n` and the first 3 patched rows (model, universe/address 1-based, channel). Full tables only for
  the first list and the first list with any Patched=1.
- **End:** LeaveShow on every connection that entered the show, 500 ms, close everything, stop announcing. A **Link summary** block gives announcement rounds/sends, inbound connection count, per-connection list counts
  and `Patched=1 seen in any FixtureList: YES/NO`.
- The only non-allowlist thing ever sent is that UDP announcement (checked by `isConsoleAnnouncement()` before the send). No DMX. `sync`, `caex`, `hello`, `observe` still behave as before (the existing tests pass; a
  before/after run of `--sync` against one stub differs only in TCP chunking timing and the random SourceKey).

## Verified here (automated: `npm test` = 52 pass; also with `FORCE_COLOR=1`, and with a symlinked `TMPDIR`)

- dmx-proof: full list including unpatched rows; refusal without patch/override (no packets); manual override → packets go to the given sACN universe and slots (address 285 → slot 285…, other slots 0, 3 terminate
  frames, only allowlisted CITP); override of a real CAEX patch; `--sacn-universe` precedence; one-of-two options, range, doesn't-fit-in-512, CAEX-patched neighbour refusal and `--force`.
- link: announcement content and ~1 s spacing; ListeningTCPPort constant; re-requests; inbound connection answered only by allowlisted messages (PNam first, empty LaserFeedList, NACK 3, EnterShow, FixtureListRequest,
  LeaveShow); never any FixtureList/Modify/Remove/Identify/Selection/ConsoleStatus/SetFixtureTransformationSpace; summary lines with Patched=1 counts; full table printed exactly twice; "no inbound, never patched" reported plainly.
- By hand, through the real multicast discovery path (a fake Visualizer announcing on both groups): discovery, connect, 24 announcements heard on the groups, summaries as above.

## NOT verified

1. Anything against your Capture — whether it opens an inbound connection once linked, whether its FixtureList then carries patch fields, what "View Fixture Patch…" shows.
2. How Capture reacts to **PNam/EnterShow/FixtureListRequest on a connection it opened to us** (I send them by the same rules as outbound; if Capture dislikes that, the log will show it).
3. macOS multicast (interface selection) — only Linux was tried.
4. The sACN universe assumption (sACN number = 1-based universe) and that Capture's sACN input is enabled for it, and the 255 shutter guess — unchanged from Handoff 11.

## Your runs

**A.** Capture open on the copy with the Rogues. `git pull`, then `npm run probe:dmx` → find the Rogue with Channel 203 (the `#` column) →
`npm run probe:dmx -- --fixture <that #> --universe 1 --address 285`. Make sure universe 1 holds only that fixture in the copy (everything else in the universe is sent as 0). Watch it pan, then tilt; paste the output.

**B.** `npm run probe:citp -- --link`. During the 120 s: (1) Universes → confirm *Project console link* shows **capture-streamdeck probe (127.0.0.1)** (pick it from the dropdown if it only says "(Automatic)");
(2) click **View Fixture Patch…** and take a screenshot — **don't press any transfer/apply button**. Paste the FixtureList summary lines (and the Link summary) from the report, plus the screenshot.
