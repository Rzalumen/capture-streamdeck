/**
 * The Setup commands, shared by the Property Inspector and the browser page: one code path for reading, saving and validating
 * addresses (FixtureService does the checking, the storage and the logging).
 */
import type { FixtureService } from "./service.js";

export interface SetupCommand {
  cmd?: string;
  key?: string;
  universe?: number;
  address?: number;
  keys?: string[];
}

/**
 * Runs one command: get | resync | set | clear | autofill (anything else = get). Returns an error text, or null when it worked.
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
    case "autofill":
      return svc.autoFill(Array.isArray(m.keys) ? m.keys.map(String) : [], { universe: Number(m.universe), address: Number(m.address) });
    default:
      if (svc.show.status === "idle") void svc.show.sync();
      return null;
  }
}
