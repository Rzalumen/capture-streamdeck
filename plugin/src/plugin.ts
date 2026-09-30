import streamDeck from "@elgato/streamdeck";
import { CameraSlot } from "./actions/slot.js";
import { CaptureCommand, NamedCommand } from "./actions/command.js";
import { CaptureTab, NamedTab } from "./actions/tab.js";
import { Connection } from "./actions/connection.js";
import { ShowPosition } from "./actions/position.js";
import { StoreModifierKey } from "./actions/store.js";
import { NamedDial, ViewDial } from "./actions/dial.js";
import { NamedToggle, ViewToggle } from "./actions/toggle.js";
import { ENTRIES, isTab, uuidOf } from "./catalog/index.js";
import type { TabName } from "./lib/applescript.js";
import { dialUuid, toggleUuid } from "./lib/named.js";
import { BOOL_PROPERTIES, NUMBER_PROPERTIES } from "./lib/properties.js";
import { rt } from "./runtime.js";
import { VERSION } from "./version.js";

streamDeck.logger.setLevel("info");

// Generic actions (configured in the Property Inspector).
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
for (const p of NUMBER_PROPERTIES) streamDeck.actions.registerAction(new NamedDial(dialUuid(p), p));
for (const p of BOOL_PROPERTIES) streamDeck.actions.registerAction(new NamedToggle(toggleUuid(p), p));

rt.log.info(`Capture plugin v${VERSION} starting: ${ENTRIES.length} named commands, ${NUMBER_PROPERTIES.length} named dials, ${BOOL_PROPERTIES.length} named toggles`);

await streamDeck.connect();
await rt.init();
