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
- `npm run probe` runs both in sequence.
