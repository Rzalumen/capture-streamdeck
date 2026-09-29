# capture-streamdeck

A Stream Deck+ plugin for Capture (macOS lighting visualizer).

**Status: research phase.** The only code here is two read-only probe tools that
inspect Capture's installed fixture library and its network interfaces.

**No Capture library data or report output is ever committed.** The `reports/`
folder holds extracts of a licensed Capture library and is gitignored, as are
`*.c2z` files.

## Commands (Node 20+, no dependencies)

- `npm run probe:library` decodes fixture DMX definitions from
  `~/Library/Application Support/Capture 2026/Library.c2z` (override with
  `--lib <path>`; pick fixtures with `--fixture "<exact model string>"`, repeatable).
  Read-only. Writes `reports/library-*.txt` and `reports/library-summary.txt`.
- `npm run probe:network` probes Capture's OSC port (UDP 4004) and passively
  listens for CITP on UDP 4809 for 30 s. Passive mode sends nothing on 4809 and opens no TCP connections.
  Writes `reports/network-report.txt`.
- `node research/network-probe.mjs --announce` additionally announces a fake lighting console over CITP
  (PINF/PLoc, both multicast groups) and listens on an ephemeral TCP port, logging whatever Capture sends.
  Observation only: nothing is ever sent back over TCP. Writes `reports/network-report-announce.txt`.
- `npm run probe:citp -- --observe|--hello|--caex` connects to Capture's CITP TCP port as a client
  (port discovered from Capture's PLoc announcement, falling back to `lsof`) and logs everything Capture
  sends. `--observe` sends nothing; `--hello` sends one PINF/PNam; `--caex` also sends a read-only CAEX
  FixtureListRequest and decodes the reply. Writes `reports/citp-<phase>.txt`.
- `npm run probe:citp -- --sync` (45 s) follows CAEX spec F's show-sync rules: replies to Capture's
  GetLaserFeedList with an empty LaserFeedList, sends its own EnterShow when Capture enters a show, then a
  FixtureListRequest, NACKs (refused) other requests, prints every fixture of the FixtureList as tables, logs
  every FixtureSelection, and sends LeaveShow before closing. It only ever sends PNam, LaserFeedList (empty),
  EnterShow, FixtureListRequest, NACK and LeaveShow (enforced in code). Writes `reports/citp-sync.txt`.
- `npm run probe:modes [-- --fixture <rawGuid> --mode <rawGuid> [--name <text>] [--expect <n>] ...]` opens a
  fixture's library object directly by its AtlaBaseFixtureId (GUID bytes in the order Capture sends them, which
  is how the library names `<guid>.c2o`) and looks for each DMX mode's GUID and name inside it, then lists the
  length-prefixed strings between mode markers. With no arguments it runs three built-in test rows. Exploration
  only. Writes `reports/modes-<first 8 of fixture guid>.txt`.
- `npm run probe` runs the library and network probes in sequence.
- `npm test` runs the unit and stub-server tests (synthetic data only).
