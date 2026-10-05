/**
 * The Setup commands, used by the Property Inspector: one code path for reading, saving and validating
 * addresses (FixtureService does the checking, the storage and the logging).
 */
import type { FixtureService } from "./service.js";

export interface SetupCommand {
  cmd?: string;
  key?: string;
  universe?: number;
  address?: number;
  keys?: string[];
  seconds?: number;
  /** v0.11.0: "autowake" — wake automatically when Capture opens the show; v0.12.0: "invert" — the axis on/off. */
  on?: boolean;
  /** v0.12.0: "invert" — "pan" | "tilt". */
  axis?: string;
}

/**
 * Runs one command: get | resync | set | clear | autofill | idle | autowake | invert (anything else = get). Returns an error text, or null when it worked.
 * `interim` is called once before a (slow) re-read of the show so the caller can show "Reading…".
 */
export async function runSetupCommand(svc: FixtureService, m: SetupCommand, interim?: () => Promise<void>): Promise<string | null> {
  switch (m.cmd) {
    case "resync":
      await interim?.();
      await svc.show.sync();
      return null;
    case "set":
      return svc.setAddress(String(m.key), { universe: Number(m.universe), address: Number(m.address) });
    case "clear":
      return svc.setAddress(String(m.key), null);
    case "idle":
      return svc.deck ? svc.deck.setIdleSeconds(Number(m.seconds)) : "Deck Control is not available";
    case "autowake":
      return svc.deck ? svc.deck.setAutoWake(m.on === true) : "Deck Control is not available";
    case "invert": // v0.12.0: allowed in Capture-patch mode too (not an address)
      return svc.setInvert(String(m.key), m.axis as "pan" | "tilt", m.on === true);
    case "autofill":
      return svc.autoFill(Array.isArray(m.keys) ? m.keys.map(String) : [], { universe: Number(m.universe), address: Number(m.address) });
    default:
      if (svc.show.status === "idle") void svc.show.sync();
      return null;
  }
}
