import streamDeck from "@elgato/streamdeck";
import { CameraSlot } from "./actions/slot.js";
import { CaptureCommand, NamedCommand } from "./actions/command.js";
import { CaptureTab, NamedTab } from "./actions/tab.js";
import { Connection } from "./actions/connection.js";
import { NamedShowPosition, ShowPosition } from "./actions/position.js";
import { StoreModifierKey } from "./actions/store.js";
import { NamedDial, ViewDial } from "./actions/dial.js";
import { NamedToggle, ViewToggle } from "./actions/toggle.js";
import { FixtureSelect, FixturesHome, FixturesRelease, FixturesSetup, FixturesStatus, fixtureDialActions } from "./actions/fixtures.js";
import { ENTRIES, isTab, uuidOf } from "./catalog/index.js";
import { SHOW_POSITION_COUNT, showPositionUuid } from "./catalog/extras.js";
import type { TabName } from "./lib/applescript.js";
import { dialUuid, toggleUuid } from "./lib/named.js";
import { BOOL_PROPERTIES, NUMBER_PROPERTIES } from "./lib/properties.js";
import { rt } from "./runtime.js";
import { VERSION } from "./version.js";

streamDeck.logger.setLevel("info");

// Generic actions (configured in the Property Inspector). Hidden from the action list since v0.3 (VisibleInActionsList: false);
// still registered so keys placed earlier keep working.
streamDeck.actions.registerAction(new CaptureCommand());
streamDeck.actions.registerAction(new CaptureTab());
streamDeck.actions.registerAction(new CameraSlot());
streamDeck.actions.registerAction(new StoreModifierKey());
streamDeck.actions.registerAction(new ShowPosition());
streamDeck.actions.registerAction(new ViewDial());
streamDeck.actions.registerAction(new ViewToggle());
streamDeck.actions.registerAction(new Connection());

// Named actions: one handler instance per catalog entry / dial / toggle, each with its preset baked in.
// (manifest.json is generated from the same catalog by scripts/gen-manifest.mjs.)
for (const e of ENTRIES) {
  streamDeck.actions.registerAction(isTab(e) ? new NamedTab(uuidOf(e), e.tab as TabName) : new NamedCommand(uuidOf(e), e));
}
for (let k = 1; k <= SHOW_POSITION_COUNT; k++) streamDeck.actions.registerAction(new NamedShowPosition(showPositionUuid(k), k));
for (const p of NUMBER_PROPERTIES) streamDeck.actions.registerAction(new NamedDial(dialUuid(p), p));
for (const p of BOOL_PROPERTIES) streamDeck.actions.registerAction(new NamedToggle(toggleUuid(p), p));

// v0.4 fixture control: Select + attribute dials, and the Setup / Release / Home Selected / Status keys.
streamDeck.actions.registerAction(new FixtureSelect());
for (const a of fixtureDialActions()) streamDeck.actions.registerAction(a);
for (const a of [new FixturesSetup(), new FixturesRelease(), new FixturesHome(), new FixturesStatus()]) streamDeck.actions.registerAction(a);

rt.log.info(`Capture plugin v${VERSION} starting: ${ENTRIES.length} named commands, ${NUMBER_PROPERTIES.length} named dials, ${BOOL_PROPERTIES.length} named toggles, ${SHOW_POSITION_COUNT} named show-position keys`);

await streamDeck.connect();
await rt.init();
