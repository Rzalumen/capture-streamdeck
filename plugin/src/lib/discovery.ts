import type { OscClient } from "./oscClient.js";

/** Requests for camera catalogs/positions — manual §21.4.3 (no other discovery addresses are used). */
export interface PositionInfo {
  nr: number;
  name: string;
}
export interface CatalogInfo {
  nr: number;
  name: string;
  positions: PositionInfo[];
}

const ints = (args: unknown[]): number[] => args.filter((a): a is number => typeof a === "number");

export async function getCatalogNumbers(c: OscClient, timeout = 1500): Promise<number[]> {
  const r = await c.request("/getCatalogs", [], "/catalogs", timeout);
  return ints(r.args);
}

export async function getCatalogName(c: OscClient, n: number, timeout = 1500): Promise<string> {
  const r = await c.request(`/catalog/${n}/getName`, [], `/catalog/${n}/name`, timeout);
  return String(r.args[0] ?? "");
}

export async function getPositionNumbers(c: OscClient, n: number, timeout = 1500): Promise<number[]> {
  const r = await c.request(`/catalog/${n}/getPositions`, [], `/catalog/${n}/positions`, timeout);
  return ints(r.args);
}

export async function getPositionName(c: OscClient, n: number, m: number, timeout = 1500): Promise<string> {
  const r = await c.request(`/catalog/${n}/position/${m}/getName`, [], `/catalog/${n}/position/${m}/name`, timeout);
  return String(r.args[0] ?? "");
}

export async function readCatalog(c: OscClient, nr: number, timeout = 1500): Promise<CatalogInfo> {
  const [name, numbers] = await Promise.all([getCatalogName(c, nr, timeout), getPositionNumbers(c, nr, timeout)]);
  const positions: PositionInfo[] = [];
  for (const m of numbers) {
    let pname = "";
    try {
      pname = await getPositionName(c, nr, m, timeout);
    } catch {
      /* leave blank */
    }
    positions.push({ nr: m, name: pname });
  }
  return { nr, name, positions };
}

/** Full walk: catalogs → names → positions → names. */
export async function walkCatalogs(c: OscClient, timeout = 1500): Promise<CatalogInfo[]> {
  const out: CatalogInfo[] = [];
  for (const nr of await getCatalogNumbers(c, timeout)) out.push(await readCatalog(c, nr, timeout));
  return out;
}

/**
 * Shared, de-duplicated catalog cache so seven Show Position keys in one catalog cause one walk,
 * not seven.
 */
export class CatalogCache {
  private entries = new Map<number, { at: number; info: CatalogInfo }>();
  private inflight = new Map<number, Promise<CatalogInfo>>();
  constructor(
    private client: OscClient,
    private now: () => number = Date.now,
  ) {}

  peek(nr: number): CatalogInfo | undefined {
    return this.entries.get(nr)?.info;
  }

  async get(nr: number, maxAgeMs: number): Promise<CatalogInfo> {
    const e = this.entries.get(nr);
    if (e && this.now() - e.at < maxAgeMs) return e.info;
    let p = this.inflight.get(nr);
    if (!p) {
      p = readCatalog(this.client, nr)
        .then((info) => {
          this.entries.set(nr, { at: this.now(), info });
          return info;
        })
        .finally(() => this.inflight.delete(nr));
      this.inflight.set(nr, p);
    }
    return p;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The k-th (1-based) position of a catalog, in the order Capture lists them. */
export function nthPosition(cat: CatalogInfo | undefined, k: number): PositionInfo | undefined {
  return cat?.positions[k - 1];
}
