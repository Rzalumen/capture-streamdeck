/**
 * The fixture actions: Select + the three generic Attribute dials (v0.6) + the named attribute dials of v0.4/v0.5 (kept for hand-placed
 * layouts), and the "Fixtures: …" keys (Setup, Release, Home Selected, Status, ◀ Page, Page ▶). UUIDs, names, icons.
 */
import type { DialId } from "../fixtures/attrs.js";
import { BASE_UUID } from "../lib/named.js";

export const FIXTURE_SELECT_UUID = `${BASE_UUID}.fixture.select`;
export const fixtureDialUuid = (id: DialId): string => `${BASE_UUID}.fixture.${id}`;

export interface FixtureDialDef {
  id: DialId;
  uuid: string;
  name: string;
  /** Strip title when the fixture lacks the attribute (or nothing is selected). */
  label: string;
  icon: string;
  tooltip: string;
}
const dial = (id: DialId, label: string, icon: string, what: string): FixtureDialDef => ({
  id,
  uuid: fixtureDialUuid(id),
  name: `Fixture: ${label}`,
  label,
  icon,
  tooltip: `(Fixed dial, kept for hand-placed layouts; the default profile uses Attribute 1–3.) Turn to change ${what} of the selected fixture(s) (Fixture: Select) by 1 % per tick, 16-bit aware. Push: home this attribute on the selected fixture(s). Tap the strip: fine (0.1 %). The first touch starts DMX output for that fixture's universe.`,
});
export const FIXTURE_DIALS: FixtureDialDef[] = [
  dial("pan", "Pan", "fx-pan", "Pan"),
  dial("tilt", "Tilt", "fx-tilt", "Tilt"),
  dial("intensity", "Intensity", "fx-intensity", "Intensity"),
  dial("zoom", "Zoom", "fx-zoom", "Zoom"),
  dial("focus", "Focus", "fx-focus", "Focus"),
  dial("iris", "Iris", "fx-iris", "Iris"),
  dial("red-cyan", "Red|Cyan", "fx-colour", "Red (additive) or, on a fixture without it, Cyan (subtractive)"),
  dial("green-magenta", "Green|Magenta", "fx-colour", "Green (additive) or, on a fixture without it, Magenta (subtractive)"),
  dial("blue-yellow", "Blue|Yellow", "fx-colour", "Blue (additive) or, on a fixture without it, Yellow (subtractive)"),
  dial("white", "White", "fx-white", "White"),
];
/** v0.6: the generic dials that show and drive the current page's channels (Attribute 1 = dial 2 … Attribute 3 = dial 4). */
export interface FixtureAttrDialDef {
  slot: number;
  uuid: string;
  name: string;
  label: string;
  icon: string;
  tooltip: string;
}
export const FIXTURE_ATTR_DIALS: FixtureAttrDialDef[] = [0, 1, 2].map((slot) => ({
  slot,
  uuid: `${BASE_UUID}.fixture.attr${slot + 1}`,
  name: `Fixture: Attribute ${slot + 1}`,
  label: `Attribute ${slot + 1}`,
  icon: "fx-attr",
  tooltip: `Shows and drives channel ${slot + 1} of the current attribute page (◀ Page / Page ▶) of the selected fixture(s): turn ±1 % per tick (16-bit aware), push = home that channel, tap the strip = fine (0.1 %). With several fixtures selected, each one's channel of the same name moves relative to its own value. The first touch starts DMX output for that fixture's universe.`,
}));

export const FIXTURE_SELECT = {
  uuid: FIXTURE_SELECT_UUID,
  name: "Fixture: Select",
  icon: "fx-select",
  tooltip: "Shows the fixture(s) selected in Capture (the deck follows Capture's selection). Turn to pick one fixture by hand; Capture's next click overrides it.",
};

export const FIXTURE_KEY_UUIDS = {
  setup: `${BASE_UUID}.fixtures.setup`,
  release: `${BASE_UUID}.fixtures.release`,
  home: `${BASE_UUID}.fixtures.home`,
  status: `${BASE_UUID}.fixtures.status`,
  pagePrev: `${BASE_UUID}.fixtures.page-prev`,
  pageNext: `${BASE_UUID}.fixtures.page-next`,
} as const;
export const FIXTURE_KEYS = [
  { uuid: FIXTURE_KEY_UUIDS.setup, name: "Fixtures: Setup", title: "Setup", icon: "fx-setup", pi: true, tooltip: "Press to read the show from Capture again. The universe and DMX address of each fixture are in this key's inspector panel (addresses re-patched in Capture are picked up automatically)." },
  { uuid: FIXTURE_KEY_UUIDS.release, name: "Fixtures: Release", title: "Release", icon: "fx-release", pi: false, tooltip: "Stops all DMX output: Stream_Terminated is sent on every universe in use." },
  { uuid: FIXTURE_KEY_UUIDS.home, name: "Fixtures: Home Selected", title: "Home Selected", icon: "fx-home", pi: false, tooltip: "Puts the selected fixture(s) (only) at full home: pan/tilt 50 %, intensity 100 %, additive colours full, the rest 0." },
  { uuid: FIXTURE_KEY_UUIDS.status, name: "Fixtures: Status", title: "Status", icon: "fx-status", pi: false, tooltip: "Shows the show name, how many fixtures are controllable and whether DMX output is active. Press to read the show again." },
  { uuid: FIXTURE_KEY_UUIDS.pagePrev, name: "Fixtures: ◀ Page", title: "◀ Page", icon: "fx-page-prev", pi: false, tooltip: "Previous attribute page (Position, Intensity, Colour, Beam, Shutters, Gobo/Prism/FX, Other) of the selected fixture for the Attribute dials. The title shows the current page." },
  { uuid: FIXTURE_KEY_UUIDS.pageNext, name: "Fixtures: Page ▶", title: "Page ▶", icon: "fx-page-next", pi: false, tooltip: "Next attribute page (Position, Intensity, Colour, Beam, Shutters, Gobo/Prism/FX, Other) of the selected fixture for the Attribute dials. The title shows the current page." },
] as const;

export const FIXTURES_PI = "ui/fixtures.html";
