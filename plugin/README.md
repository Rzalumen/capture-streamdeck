# Capture for Stream Deck+ — plugin v0.1 (beta)

An interface to **Capture** (macOS lighting visualizer): keys fire Capture's own menu commands and tabs and
recall camera positions; dials adjust the view settings over OSC. UUID `com.rezabehjat.capture`,
Stream Deck SDK v2 manifest, Node 20 runtime, Stream Deck 6.6+, macOS 13+.

## Actions

| Action | What it does |
|---|---|
| **Capture Command** (key) | Fires any Capture menu command (picked from a live list read off the menu bar, or typed). Match `exact`, `prefix` (Undo…/Redo…) or `alternates` (`Enter Full Screen|Exit Full Screen`). Dims when the command is disabled in Capture (checked in one batched call, on appear and every 1.5 s). Hold-to-fire (1 s; short press flashes “Hold”) is on by default for Delete, Unpatch, Remove Filters, Remove Gobos, Cut, Paste. |
| **Capture Tab** (key) | Clicks the Design / Fixtures / Universes / Media / Snapshots / Library tab (the only thing ever clicked in Capture's window). |
| **Camera Slot** (key) | `View › Camera › Position N`; while a **Store Modifier** key is held, `View › Store Camera › Position N` and flashes “Stored”. |
| **Store Modifier** (key) | Held state (auto-releases after 30 s or when it leaves the screen). |
| **Show Position** (key) | OSC camera recall, fixed (catalog + position) or auto (k-th position of a catalog), titled from Capture's names (refreshed on appear and every 15 s). Optional time/damp/curve. |
| **View Dial** (dial) | Adjusts a view setting over OSC. Turn: value += ticks × step (clamped). Push or touch: fine mode (÷10). Long touch: reset. ≤ 30 msg/s, latest value wins. |
| **View Toggle** (key) | Auto Exposure / Laser Flicker Effect, sends `T`/`F`. |
| **Connection** (key) | Connected/Offline (a `/pong` within 10 s of a `/ping` every 5 s), Capture version, Accessibility status, median osascript latency. Press to re-check. |

**Keys show** `Allow Access` (Accessibility/Automation not granted — press opens System Settings), `Capture?`
(not running), or `Error` (anything else; the raw text is in the plugin log).

## OSC properties

Source of truth is the Capture 2026 manual, Appendix §21.4.3 “OSC”
(<https://www.capture.se/Manual/en-UK/2026/Appendix.html>): `ambientLighting`, `bloom`, `contrast`,
`exposureAdjustment`, `fillLighting`, `flare`, `flareAngle`, `flareSize`, `flareStreaks` (int), `hueClamp`,
`saturation`, `whiteBalance` (float32), `automaticExposure`, `laserFlickerEffect` (bool), and
`/view/<live|0|1|2>/position`. Floats are always sent as `f`.

Where the manual and the Companion-module table in the handoff disagree, **the manual wins**:

| Property | Handoff table | Manual (used) |
|---|---|---|
| `bloom` | 0–1 | **0–2** (0–200 %) |
| `fillLighting` | 0–1 | **0–2** (0–200 %) |

Added from the manual (not in the table): `contrast`, `saturation`, `flare`, `flareStreaks`, `flareAngle`, `flareSize`.
The manual's heading calls these properties “getters/setters”, but no getter address is documented, so none is
used: Capture cannot report a value, the dial remembers the last value it sent (in Stream Deck global settings)
and shows it greyed with “~” until it has sent one this session. **Reset values are this plugin's own neutral
defaults, not Capture's** (editable per dial).

## What the plugin never does

No CITP, no DMX/sACN/Art-Net. Never launches or quits Capture (only activates it, if it is running and not
frontmost, when a key is pressed). Never sends mouse or keyboard events. Nothing is clicked except on a key press
(a menu command, or one of the six tab radio buttons). Startup traffic is only `/ping`; discovery and
`getStatus` are queries. Menu reading and enabled-state polling are read-only.

## Build, test, pack

```
cd plugin
npm install
npm test            # build + unit, OSC/AX stub and end-to-end tests (fake Stream Deck, Capture, osascript)
npm run pack        # → dist/com.rezabehjat.capture.streamDeckPlugin (validated with @elgato/cli)
```

Tests never touch a real Capture or a real osascript. `test/integration.test.ts` runs the built plugin
under Node against a fake Stream Deck (WebSocket), a fake Capture (UDP) and a fake `osascript` (records each
script). `node scripts/check-inspector.mjs` (needs Playwright) exercises the inspector page in Chromium.

## Default profile

Not shipped in v0.1: see [DEFAULT-LAYOUT.md](DEFAULT-LAYOUT.md). Build the layout in Stream Deck, export it, then
`npm run add-profile -- Capture.streamDeckProfile && npm run pack`.
