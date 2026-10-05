/**
 * The fixture actions: Select + the three generic Attribute dials (v0.6) + the named attribute dials of v0.4/v0.5 (kept for hand-placed
 * layouts), and the "Fixtures: …" keys (Setup, Release, Home Light, Status, ◀ Page, Page ▶, Deck Control, Next Fixture). UUIDs, names, icons.
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
  tooltip: `(Fixed dial, kept for hand-placed layouts; the default profile uses Attribute 1–3.) Turn to change ${what} of the selected fixture(s) (Fixture: Select) by 1 % per tick, 16-bit aware. Push: fine mode (0.1 %) on/off. Tap the strip: home this attribute on the selected fixture(s). The first touch starts DMX output for that fixture's universe.`,
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
/** The generic dials that show and drive the current page's channels (v0.6: dials 2–4; v0.7.1: Attribute 1–4 on all four dials). */
export interface FixtureAttrDialDef {
  slot: number;
  uuid: string;
  name: string;
  label: string;
  icon: string;
  tooltip: string;
}
export const FIXTURE_ATTR_DIALS: FixtureAttrDialDef[] = [0, 1, 2, 3].map((slot) => ({
  slot,
  uuid: `${BASE_UUID}.fixture.attr${slot + 1}`,
  name: `Fixture: Attribute ${slot + 1}`,
  label: `Attribute ${slot + 1}`,
  icon: "fx-attr",
  tooltip: `Shows and drives channel ${slot + 1} of the current attribute page (◀ Page / Page ▶) of the selected fixture(s): turn ±1 % per tick (16-bit aware), push = fine mode (0.1 %) on/off, tap the strip = home that channel. With several fixtures selected, each one's channel of the same name moves relative to its own value. The first touch starts DMX output for that fixture's universe.`,
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
  deck: `${BASE_UUID}.fixtures.deck`,
  next: `${BASE_UUID}.fixtures.next`,
} as const;
export const FIXTURE_KEYS = [
  { uuid: FIXTURE_KEY_UUIDS.setup, name: "Fixtures: Setup", title: "Setup", icon: "fx-setup", pi: true, tooltip: "Press to read the show from Capture again. The universe and DMX address of each fixture are in this key's inspector panel (addresses re-patched in Capture are picked up automatically)." },
  { uuid: FIXTURE_KEY_UUIDS.release, name: "Fixtures: Release", title: "Release", icon: "fx-release", pi: false, tooltip: "Kept for keys placed earlier: switches Deck Control OFF, i.e. disarms the knobs. The deck stays connected and keeps sending what Capture shows; only quitting the Stream Deck app (or Capture closing the show) lets go." },
  { uuid: FIXTURE_KEY_UUIDS.home, name: "Fixtures: Home Light", title: "Home Light", icon: "fx-home", pi: false, tooltip: "Puts the light selected in Capture back to its home values (pan/tilt 50 %, intensity 100 %, shutter open, additive colours full, the rest 0)." },
  { uuid: FIXTURE_KEY_UUIDS.status, name: "Fixtures: Status", title: "Status", icon: "fx-status", pi: false, hidden: true, tooltip: "Shows the show name, how many fixtures are controllable and whether DMX output is active. Press to read the show again." },
  { uuid: FIXTURE_KEY_UUIDS.deck, name: "Fixtures: Deck Control", title: "Deck OFF", icon: "fx-deck", pi: false, showTitle: false, tooltip: "Press to arm (ON) or disarm (OFF) the fixture knobs. The key's colour says the state: grey = OFF (knobs disarmed); amber = ON, click a light in Capture; green = ON and driving the light shown (Ch …). The first ON connects to Capture as a console; after that the deck stays connected: while OFF it keeps sending what Capture shows (changes made in Capture are kept), and only quitting the Stream Deck app (or Capture closing the show) lets go. Any fixture knob or key arms it; it disarms after the idle time set in Setup." },
  { uuid: FIXTURE_KEY_UUIDS.pagePrev, name: "Fixtures: ◀ Page", title: "◀ Page", icon: "fx-page-prev", pi: false, tooltip: "Previous attribute page (Main, Colour, Beam, Shutters, Gobo/FX, Other) of the selected fixture for the Attribute dials. The title shows the current page." },
  { uuid: FIXTURE_KEY_UUIDS.next, name: "Fixtures: Next Fixture", title: "Next Fixture", icon: "fx-next", pi: false, hidden: true, tooltip: "Selects the next controllable fixture (like turning the Select dial); Capture's next click overrides it. The title shows the fixture now selected." },
  { uuid: FIXTURE_KEY_UUIDS.pageNext, name: "Fixtures: Page ▶", title: "Page ▶", icon: "fx-page-next", pi: false, tooltip: "Next attribute page (Main, Colour, Beam, Shutters, Gobo/FX, Other) of the selected fixture for the Attribute dials. The title shows the current page." },
] as const;

export type FixtureKeyDef = (typeof FIXTURE_KEYS)[number] & { hidden?: boolean; showTitle?: boolean };
/** A fixture key's definition by UUID. */
export const fixtureKey = (uuid: string): FixtureKeyDef => {
  const k = FIXTURE_KEYS.find((x) => x.uuid === uuid);
  if (!k) throw new Error(`no fixture key ${uuid}`);
  return k;
};
/**
 * The Fixtures page of the default profile (v0.7.3, Handoff 24): Setup, Deck Control, Home Light, ◀ Page, Page ▶ at fixed positions
 * (Status and Next Fixture left the profile and the actions list; their actions still work on keys placed by hand).
 */
export const PROFILE_FIXTURE_KEY_POSITIONS: [string, string][] = [
  ["1,0", FIXTURE_KEY_UUIDS.setup],
  ["3,0", FIXTURE_KEY_UUIDS.deck],
  ["0,1", FIXTURE_KEY_UUIDS.home],
  ["2,1", FIXTURE_KEY_UUIDS.pagePrev],
  ["3,1", FIXTURE_KEY_UUIDS.pageNext],
];
export const PROFILE_FIXTURE_KEYS = PROFILE_FIXTURE_KEY_POSITIONS.map(([, u]) => fixtureKey(u));

export const FIXTURES_PI = "ui/fixtures.html";
