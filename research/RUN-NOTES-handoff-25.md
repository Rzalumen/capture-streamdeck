# Run notes: Handoff 25 (research probe: CITP SDMX — universe declaration and any DMX talkback)

**Base:** I ran `git pull` first, in my working clone and in your `~/capture-streamdeck`. Both were at **`1e5b088`** (v0.7.3, which you pushed). This delivery is one commit on top of it. **Use `capture-streamdeck-0026.bundle`.**

**Research only.** The changes are in `research/` and in the root `package.json` test script. **The plugin is untouched**: `git diff -- plugin` is empty, and the plugin's own CITP allowlist and `citp.ts` are unchanged.

**Restart brief sections 1–4 were followed:**
- no push;
- nothing from `reports/`, `*.bin`, `*.c2z` or `dist/` is committed;
- no keystrokes and no mouse automation;
- no DMX is sent and no FixtureIdentify is sent.

## What you run
`npm run probe:citp -- --sdmx` runs the probe for 120 s; `--seconds` changes that.

**What it does:** exactly the `--link` flow:
- announces itself as a console (PLoc "LightingConsole");
- connects outbound to Capture and accepts Capture's inbound connection;
- answers GetLaserFeedList with an empty list;
- sends EnterShow after Capture's;
- sends a FixtureListRequest every 10 s;
- NACKs anything else Capture asks for;
- sends LeaveShow at the end.

**In addition:**
- **Every SDMX-layer message received** on any connection is logged with:
  - the time and the connection tag (`out`, `in#1`, or `udp <ip:port>` for the announcement socket);
  - the SDMX type, the full decode, and **the raw hex always**.
- **`--declare`** (opt-in): after **our** EnterShow on each connection, the probe declares where our DMX comes from:
  - one **SXSr** "BSRE1.31/1/1", the base universe of a consecutive series (sent only when the universes are consecutive);
  - one **SXUS** per universe: index u−1 and "BSRE1.31/u/1".

  The universes are 1–16 by default, or `--universes 1,2,5-8`. Without `--declare` the probe only listens and sends no SDMX at all.
- **Report** `reports/citp-sdmx.txt`. It ends with an `== SDMX summary ==` block:
  - SDMX messages received, counted by type;
  - whether the declaration was sent;
  - a list of every SDMX message in and out, with hex;
  - anything that looks like level data (ChBk, ChLs, or an unknown SDMX message with a body) is flagged with a `!!! LEVEL DATA` banner.

**Allowlist:** `isAllowedOutgoing(msg, {sdmxDeclare: true})` accepts **only** our own well-formed SXSr and SXUS messages. "Well-formed" means:
- the declared size equals the real size, and the message is a single part;
- it carries one null-terminated string of the form `BSRE1.31/<u>/1`, with nothing after it;
- for SXUS, the index equals u−1.

Everything else in the SDMX layer is refused even with the option: ChBk and ChLs (DMX levels), Capa, UNam and EnId. **By default every SDMX message is refused**, as before.

## Where the message layouts come from (please read)
The handoff asked me to take the layouts from the published spec and not guess. **I could not open the current CITP specification**:
- citp-protocol.org redirects to lewlight.com/citp-protocol;
- that page points to `bitbucket.org/lars_wernlund/citp`;
- Bitbucket is blocked here: refused by the proxy for curl, and by robots.txt for the web fetcher.

I did not work around that. The layouts come from three secondary sources, and they agree where they overlap:
1. **"CITP protocol suite specification" PA14** (Capture Sweden, 2004-08-21; techref.info/web/prod/cap/data/citp.pdf), SDMX section:
   - `struct CITP_SDMX_Header { struct CITP_Header CITPHeader; unsigned long ContentType; }`;
   - "All SDMX messages use a CITP ContentType value of 'SDMX'. The SMDX protocol is not internally versioned.";
   - it only has EnId, UNam and ChBk. It is too old for SXSr and SXUS.
2. **jwarwick/citp-lib `CITPDefines.h`:**
   - `COOKIE_SDMX 0x584d4453 // 'SDMX'` and `COOKIE_SDMX_SXSR 0x72535853 // 'SXSr'`;
   - `CITP_SDMX_SXSr { ...; ucs1 ConnectionString[]; }` and the ChBk fields.
3. **nannou-org `citp` Rust crate, `src/protocol/sdmx.rs`** (docs.rs/citp). It carries the spec's doc text for the later messages:
   - Capa: capability codes 1 ChLs, 2 SXSr, 3 SXUS, 102 BSR E1.31 external sources;
   - ChLs;
   - SXSr: "can be sent as an alternative to sending ChBk messages when DMX can be received over another protocol… the external source specified should be treated as the base universe of a consecutive series";
   - SXUS: "functions like the Set External Source message, but on a universe level", u8 UniverseIndex (0-based), ucs1 ConnectionString;
   - the sACN connection string `"BSRE1.31/<universe>/<channel>"`, where "BSRE1.31/1/1 is the first channel of the first universe".

The layouts are quoted in comments in `research/lib/citp.mjs` and in the test file. **SXUS is only in the Rust crate**: I have not seen it in an official spec text. If Capture expects something else, the declaration will simply be ignored, and the report will show that nothing changed.

**Assumption:** Capture universe *u* takes its DMX from sACN universe *u*. The plugin already sends sACN universe = Capture universe number. So SXUS index u−1 is paired with "BSRE1.31/u/1".

## Verified (sandbox)
**All 81 research tests pass** (8 new; the existing 73 are unchanged).

Unit tests:
- **SXUS byte layout:**
  - `CITP`, version 1.0, MessageSize equal to the length, 1 part;
  - "SDMX" (equal to citp-lib's cookie 0x584d4453);
  - "SXUS", then u8 index u−1, then "BSRE1.31/u/1\0";
  - universe 0 and universe 257 are refused when building.
- **SXSr byte layout:** "SDMXSXSr" (cookie 0x72535853 as in citp-lib), then "BSRE1.31/1/1\0".
- **Allowlist:**
  - SXSr and SXUS are refused by default, and still refused with `{identify: true}`; they are accepted only with `{sdmxDeclare: true}`.
  - With the option on, these are still refused: a wrong SXUS index, a wrong size, a trailing byte, a missing terminator, an Art-Net string, an sACN channel other than 1, universe 0, a multi-part header, ChBk, ChLs, Capa, UNam and EnId.
  - The old allowlist is unchanged, and the new option does not open FixtureIdentify.
- **Decoder:** ChBk and ChLs levels are decoded and flagged as level data; Capa, UNam, SXSr and SXUS decode; an unknown SDMX type with a body is flagged; a truncated message is reported and does not throw.
- **`--universes` parsing:** 1–16 by default, lists and ranges, 1–256 only.

End to end, the real script against a stub Capture:
- **(a) A stub that sends a fabricated ChBk and Capa.** Both are logged with full decode and raw hex. ChBk carries the `<<<<< LOOKS LIKE DMX LEVEL DATA >>>>>` mark and the summary's `!!! LEVEL DATA` banner. Listen-only mode sends no SDMX and no FixtureIdentify.
- **(b) A stub that sends nothing SDMX, with `--declare`.**
  - The stub receives, after our EnterShow, SXSr (base 1) and then SXUS for universes 1–16 (indices 0–15, strings "BSRE1.31/1/1" … "/16/1"), each well-formed.
  - No ChBk, ChLs or FixtureIdentify is sent.
  - The report says `SDMX messages RECEIVED: 0 -- no SDMX received on any connection` and `level data …: NONE received`.
- `--universes 1,3` (not consecutive): only SXUS is sent, with no SXSr base.

## NOT verified / things to know
- **Nothing ran against your real Capture.** Whether Capture answers SDMX, whether it sends levels to a console at all, and whether the declaration changes the popup are exactly what your two runs will tell us.
- **`--declare` may change Capture's settings.** I don't know if Capture stores an external source it is told about in the show, for example as that universe's DMX input. **Use a show copy**, and after run 2 check Capture's universe and DMX-input settings before you save anything.
- The probe declares universes on every connection where it sent EnterShow, outbound and inbound. Which connection Capture listens to for SDMX is unknown. The report shows when and where each declaration went.
- The Capa capabilities message is not sent: the spec text only requires it before ChLs, which we never send. If Capture sends us a Capa, it is decoded and listed.
- SDMX on the UDP socket is logged only when the probe could bind port 4809 itself. It does when discovering; it doesn't with `--port`.

## Your run (show COPY, Stream Deck app closed)
1. `npm run probe:citp -- --sdmx` (listen only, 120 s). During it, move a light with the mouse in Capture, and note whether the popup "One or more project fixtures are patched to universes not in control by the console…" appears.
2. `npm run probe:citp -- --sdmx --declare` (declares sACN universes 1–16). Do the same: move a light, and watch whether the popup still appears.
3. Paste both `== SDMX summary ==` blocks (from `reports/citp-sdmx.txt`; run 2 overwrites run 1, so copy the first one before starting the second) and tell me when the popup showed.

## What the outcomes mean
- **The declaration makes the popup go away:** the plugin's ON session should declare its universes the same way (a small plugin handoff next).
- **Capture sends any SDMX level data** (ChBk or ChLs flagged): that is the talkback we need. The deck can read Capture's state, and the reset problem has a real fix.
- **Neither:** Capture doesn't share levels. We then pick the least-bad resume behaviour (deck-owned lights, or start from home on ON); that's your call.
