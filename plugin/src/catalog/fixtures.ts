/** The v0.4 fixture actions: Select + attribute dials ("Fixture: …") and the four "Fixtures: …" keys. UUIDs, names, icons. */
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
  tooltip: `Turn to change ${what} of the selected fixture(s) (Fixture: Select) by 1 % per tick, 16-bit aware. Push or touch: fine (0.1 %). Long touch: home value. The first touch starts DMX output for that fixture's universe.`,
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
export const FIXTURE_SELECT = {
  uuid: FIXTURE_SELECT_UUID,
  name: "Fixture: Select",
  icon: "fx-select",
  tooltip: "Turn to step through the fixtures that are set up (Fixtures: Setup) and parsed safely. Push or touch: single fixture ↔ all of this type.",
};

export const FIXTURE_KEY_UUIDS = {
  setup: `${BASE_UUID}.fixtures.setup`,
  release: `${BASE_UUID}.fixtures.release`,
  home: `${BASE_UUID}.fixtures.home`,
  status: `${BASE_UUID}.fixtures.status`,
} as const;
export const FIXTURE_KEYS = [
  { uuid: FIXTURE_KEY_UUIDS.setup, name: "Fixtures: Setup", title: "Setup", icon: "fx-setup", pi: true, tooltip: "Reads the show from Capture (read-only) and lets you enter the universe and DMX address of each fixture. Press to read the show again." },
  { uuid: FIXTURE_KEY_UUIDS.release, name: "Fixtures: Release", title: "Release", icon: "fx-release", pi: false, tooltip: "Stops all DMX output: Stream_Terminated is sent on every universe in use." },
  { uuid: FIXTURE_KEY_UUIDS.home, name: "Fixtures: Home Selected", title: "Home Selected", icon: "fx-home", pi: false, tooltip: "Pan and tilt 50 %, intensity 100 % on the selected fixture(s)." },
  { uuid: FIXTURE_KEY_UUIDS.status, name: "Fixtures: Status", title: "Status", icon: "fx-status", pi: false, tooltip: "Shows the show name, how many fixtures are controllable and whether DMX output is active. Press to read the show again." },
] as const;

export const FIXTURES_PI = "ui/fixtures.html";
