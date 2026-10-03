# Run notes — Handoff 17: `citp-connect --identify` (research only)

Base `37e49a9` (v0.4.1). Only `research/` (and the test script list in `package.json`, and one README paragraph) changed. **The plugin is untouched.** Tested only against a stub Capture in a Linux sandbox: **nothing here has run against your real Capture.**

## What it does (`npm run probe:citp -- --identify`, 90 s, `--seconds` to change)
1. The `--sync` flow, unchanged (PNam, empty LaserFeedList, EnterShow, FixtureListRequest).
2. After the **first** FixtureList: for every fixture with a 16-byte CaptureInstanceId (identifier type 0x04) the identifier is **100001 + its index in the list**. The full map is printed (index, Capture Channel, model, mode, CaptureInstanceId as received and in spec form, identifier). Fixtures without a usable 0x04 identifier are listed as "NOT identified" with the reason.
3. **One FixtureIdentify** (CAEX 5.6, `0x00020204`): `u16 FixtureCount`, then per fixture the 16 bytes of the CaptureInstanceId **exactly as Capture sent them** (no byte-order conversion) and `u32 FixtureIdentifier`, all little-endian. If no fixture has a usable id, nothing is sent and the report says so.
4. **2 s later** (`--verify-delay <s>` only for tests) a FixtureListRequest. The report says how many fixtures now carry an identifier other than `0xffffffff`, how many match the map (mismatches listed), and whether any Patched / Universe / UniverseChannel field is filled (every such fixture listed).
5. For the rest of the run: every **FixtureSelection** (elapsed time + wall-clock time, the identifiers, and the fixtures they map to as Channel + model; "assigned by us" when the identifier is only known from our map), every **FixtureModify** (all decoded fields, patch fields flagged `PATCH FIELDS`), a FixtureListRequest every 20 s (`--rerequest-seconds`) with every change of identifiers or patch fields versus the previous list reported.
6. LeaveShow at the end. Report `reports/citp-identify.txt` ends with `== Identify summary ==`: identified count, match count, patch fields filled yes/no, patch fields seen anywhere yes/no, selection events (with their lines), modify events, LeaveShow.

## Safety
- The allowlist function got an opt-in: `isAllowedOutgoing(msg, {identify: true})` additionally accepts **one well-formed** FixtureIdentify (declared size = real size, count ≥ 1, body exactly count × 20 bytes). The default is unchanged (still refused everywhere else), and the script itself refuses a second FixtureIdentify. Never built or sent: FixtureList, FixtureModify, FixtureRemove, FixtureSelection, FixtureConsoleStatus, SetFixtureTransformationSpace. No DMX. The plugin's own copy of the allowlist is not touched.
- **It writes an identifier into every fixture of the open show.** Run it on a copy.

## Verified (stub only)
71 research tests pass (64 before + 7): FixtureIdentify byte layout (guid bytes unchanged, identifier little-endian, size field, builder rejects 0 fixtures and a non-16-byte guid); the allowlist (default refuses it, `identify:true` allows only well-formed ones, every forbidden code refused with and without a body); full runs against a stub that applies the identifiers, fills a patch field, and pushes FixtureSelection / FixtureModify (exactly one FixtureIdentify on the wire, verify request ≈ 2 s after it, selection/modify lines, summary), one that ignores it, one that keeps a different id for one fixture and patches later (reported as a change), one with no CaptureInstanceId (nothing sent), and `--sync` still never sends it.

## NOT verified / assumptions
- **The layout of FixtureIdentify** is the one in your brief (read from spec F §5.6). The decode of **FixtureModify** (field order by ChangedFields bits) is still the provisional one from the earlier automated summary: the raw hex of every message is in the report, and if decoding fails the line says so instead of guessing.
- Whether Capture accepts the 0x04 bytes exactly as received: that is the brief's instruction, and what the run on your copy will show (the verify list and the summary).
- Whether Capture sends FixtureSelection / FixtureModify to a peer that only entered the show. `--sync` saw 0 FixtureSelection events earlier.
- The identifier values 100001+ are not checked against anything in Capture.

## Your run (on a COPY of the show)
1. `npm run probe:citp -- --identify`
2. During the 90 s, click 3–4 different fixtures in Capture a few seconds apart, including the Rogue at Ch 203.
3. Paste the `== Identify summary ==` block and the `FIXTURE SELECTION` lines from `reports/citp-identify.txt`.
