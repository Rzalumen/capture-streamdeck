import streamDeck from "@elgato/streamdeck";
import { CameraSlot } from "./actions/slot.js";
import { CaptureCommand } from "./actions/command.js";
import { CaptureTab } from "./actions/tab.js";
import { Connection } from "./actions/connection.js";
import { ShowPosition } from "./actions/position.js";
import { StoreModifierKey } from "./actions/store.js";
import { ViewDial } from "./actions/dial.js";
import { ViewToggle } from "./actions/toggle.js";
import { rt } from "./runtime.js";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new CaptureCommand());
streamDeck.actions.registerAction(new CaptureTab());
streamDeck.actions.registerAction(new CameraSlot());
streamDeck.actions.registerAction(new StoreModifierKey());
streamDeck.actions.registerAction(new ShowPosition());
streamDeck.actions.registerAction(new ViewDial());
streamDeck.actions.registerAction(new ViewToggle());
streamDeck.actions.registerAction(new Connection());

await streamDeck.connect();
await rt.init();
