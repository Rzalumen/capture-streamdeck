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
  `--lib <path>`; pick fixtures with `--fixture "<model substring>"`, repeatable).
  Read-only. Writes `reports/library-*.txt` and `reports/library-summary.txt`.
- `npm run probe:network` probes Capture's OSC port (UDP 4004) and passively
  listens for CITP on UDP 4809. Sends nothing on 4809, opens no TCP connections.
  Writes `reports/network-report.txt`.
- `npm run probe` runs both in sequence.
