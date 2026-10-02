/**
 * Read the show from Capture over CITP: the CAEX spec F show-sync handshake, READ-ONLY, behind the outgoing allowlist
 * (`isAllowedOutgoing` refuses anything else): PINF/PNam, LaserFeedList (empty), EnterShow, FixtureListRequest, NACK (Reason 3)
 * and LeaveShow. Ported from research/lib/citp-sync.mjs (proven on Capture 2026.1.6; the research copy is unchanged).
 *
 * What it returns: the show name (from Capture's EnterShow) and the fixture list (model, mode, ChannelCount, Capture Channel,
 * AtlaBaseFixtureId / AtlaBaseModeId / CaptureInstanceId and position). Capture does NOT send the patch over CITP (Patched=0
 * for every fixture), so addresses come from the plugin's own setup, never from here. Nothing in Capture is changed.
 */
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CAEX, CitpFramer, buildEnterShow, buildFixtureListRequest, buildLaserFeedList, buildLeaveShow, buildNack, buildPNam, decodeMessage, isAllowedOutgoing, type CaexFixture } from "./citp.js";

export const SYNC_NAME = "capture-streamdeck";
const GROUPS = ["239.224.0.180", "224.0.0.180"];
const CITP_UDP = 4809;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errStr = (e: NodeJS.ErrnoException): string => `code=${e.code} message=${e.message}`;

export function localIPv4(): { name: string; address: string }[] {
  const r: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4") r.push({ name, address: i.address });
  }
  return r;
}

interface Found {
  port: number;
  from?: string;
}

/** Listen on UDP 4809 (multicast) for up to `ms`; resolve with the first PLoc of Type "Visualizer" (or null). */
async function discover(ifaces: { address: string }[], ms: number, log: (s: string) => void): Promise<Found | null> {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let found: Found | null = null;
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<Found | null>((resolve) => {
    sock.on("error", (e) => {
      log(`discovery socket error: ${errStr(e)}`);
      resolve(null);
    });
    sock.on("message", (msg, rinfo) => {
      if (found || msg.length < 4 || msg.toString("latin1", 0, 4) !== "CITP") return;
      const d = decodeMessage(msg);
      if (d.ploc && d.ploc.type === "Visualizer") {
        found = { port: d.ploc.port, from: rinfo.address };
        resolve(found);
      }
    });
    timer = setTimeout(() => resolve(found), ms);
  });
  const bound = await new Promise<boolean>((res) => {
    const onErr = (e: NodeJS.ErrnoException): void => {
      log(`discovery bind failed: ${errStr(e)}`);
      res(false);
    };
    sock.once("error", onErr);
    sock.bind(CITP_UDP, () => {
      sock.removeListener("error", onErr);
      res(true);
    });
  });
  if (!bound) {
    clearTimeout(timer);
    try {
      sock.close();
    } catch {
      /* ignore */
    }
    return null;
  }
  for (const g of GROUPS)
    for (const i of ifaces) {
      try {
        sock.addMembership(g, i.address);
      } catch {
        /* interface without multicast */
      }
    }
  const r = await done;
  clearTimeout(timer);
  try {
    sock.close();
  } catch {
    /* ignore */
  }
  return r;
}

function lsofPorts(): number[] {
  const ls = spawnSync("lsof", ["-nP", "-a", "-c", "Capture", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
  if (ls.error) return [];
  const ports: number[] = [];
  for (const l of (ls.stdout || "").split("\n")) {
    const m = l.match(/TCP\s+\S+:(\d+)\s+\(LISTEN\)/);
    if (m) ports.push(+m[1]);
  }
  return [...new Set(ports)];
}

function tryConnect(host: string, port: number, timeoutMs = 3000): Promise<{ socket?: net.Socket; err?: Error }> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      resolve({ err: new Error(`connect timeout after ${timeoutMs} ms`) });
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(t);
      s.removeAllListeners("error");
      resolve({ socket: s });
    });
    s.once("error", (e) => {
      clearTimeout(t);
      resolve({ err: e });
    });
  });
}

export interface SyncOptions {
  host?: string;
  port?: number;
  /** Total wait for a FixtureList (default 45 s). */
  timeoutMs?: number;
  /** Wait for Capture's UDP announcement (default 5 s). */
  discoverMs?: number;
  log?: (s: string) => void;
}
export type SyncResult = { ok: true; fixtures: CaexFixture[]; showName: string | null; log: string[] } | { ok: false; error: string; fixtures: []; showName: null; log: string[] };

/** Connect to Capture, do the show-sync handshake and return the fixture list. Never throws. */
export async function readShow({ host, port, timeoutMs = 45000, discoverMs = 5000, log = () => undefined }: SyncOptions = {}): Promise<SyncResult> {
  const lines: string[] = [];
  const say = (s: string): void => {
    lines.push(s);
    log(s);
  };
  const fail = (error: string): SyncResult => ({ ok: false, error, fixtures: [], showName: null, log: lines });
  let sock: net.Socket | null = null;
  try {
    const ifaces = localIPv4();
    const hosts: string[] = [];
    let ports: number[] = port ? [Number(port)] : [];
    if (host) hosts.push(host);
    if (!ports.length) {
      say(`looking for Capture: UDP ${CITP_UDP} multicast, up to ${discoverMs / 1000} s`);
      const found = await discover(ifaces, discoverMs, say);
      if (found) {
        ports = [found.port];
        if (found.from) hosts.push(found.from);
        say(`Capture announced CITP TCP port ${found.port} from ${found.from}`);
      } else {
        ports = lsofPorts();
        say(ports.length ? `no announcement seen; lsof shows Capture listening on TCP ${ports.join(", ")}` : "no announcement seen and lsof found no listening Capture TCP port");
      }
    }
    if (!ports.length) return fail("No CITP TCP port known: Capture did not announce itself and no listening Capture port was found. Is Capture running with a show open?");
    const cands: { h: string; p: number }[] = [];
    for (const h of ["127.0.0.1", ...hosts, ...ifaces.map((i) => i.address)]) for (const p of ports) if (!cands.some((c) => c.h === h && c.p === p)) cands.push({ h, p });
    let target: { h: string; p: number } | null = null;
    for (const c of cands) {
      const r = await tryConnect(c.h, c.p);
      if (r.socket) {
        sock = r.socket;
        target = c;
        break;
      }
    }
    if (!sock || !target) return fail(`could not connect to Capture's CITP port (tried ${cands.map((c) => `${c.h}:${c.p}`).join(", ")})`);
    say(`connected to ${target.h}:${target.p}`);
    const s = sock;

    const framer = new CitpFramer();
    const sourceKey = randomBytes(4).readUInt32LE(0);
    const REQUESTS = new Set<number>([CAEX.GetLiveViewStatus, CAEX.GetLiveViewImage, CAEX.FixtureListRequest, CAEX.FixtureIdentify]);
    let weEntered = false;
    let requests = 0;
    let closed = false;
    let showName: string | null = null;
    let latest: CaexFixture[] | null = null;
    let closing = false;
    let chain: Promise<void> = Promise.resolve();
    const send = (label: string, buf: Buffer): Promise<void> => {
      chain = chain.then(
        () =>
          new Promise<void>((res) => {
            if (!isAllowedOutgoing(buf)) {
              say(`REFUSED to send ${label}: not on the outgoing allowlist`);
              res();
              return;
            }
            if (closed || s.destroyed) {
              res();
              return;
            }
            s.write(buf, () => res());
          }),
      );
      return chain;
    };
    const requestFixtures = (): void => {
      if (requests < 4) {
        requests++;
        void send("FixtureListRequest", buildFixtureListRequest());
      }
    };
    let gotList: (v: boolean) => void = () => undefined;
    const listPromise = new Promise<boolean>((res) => {
      gotList = res;
    });
    s.on("data", (d) => {
      for (const m of framer.push(d).messages) {
        const dm = decodeMessage(m);
        switch (dm.code) {
          case CAEX.GetLaserFeedList:
            void send("LaserFeedList (empty)", buildLaserFeedList(sourceKey, []));
            break;
          case CAEX.EnterShow:
            showName = dm.showName ?? showName;
            if (!weEntered) {
              weEntered = true;
              void send("EnterShow", buildEnterShow(SYNC_NAME));
            }
            requestFixtures();
            break;
          case CAEX.FixtureList:
            if (dm.fixtures && !dm.fixtures.error) {
              latest = dm.fixtures.fixtures;
              gotList(true);
            } else say(`FixtureList did not decode: ${dm.fixtures?.error ?? "unknown error"}`);
            break;
          default:
            if (dm.layer === "CAEX" && dm.code !== null && REQUESTS.has(dm.code)) void send("NACK (refused)", buildNack(3));
        }
      }
    });
    s.on("error", () => undefined);
    s.on("close", () => {
      closed = true;
      gotList(false);
    });
    await send("PNam", buildPNam(SYNC_NAME));
    say("sent PNam; waiting for Capture to enter its show and send the FixtureList");
    const retry = setTimeout(() => {
      if (!latest && !closing) requestFixtures();
    }, 5000);
    const timeout = setTimeout(() => gotList(false), timeoutMs);
    const ok = await listPromise;
    clearTimeout(retry);
    clearTimeout(timeout);
    if (ok) await sleep(200); // let a second FixtureList that follows directly replace the first
    closing = true;
    await chain;
    if (weEntered && !closed && !s.destroyed) {
      await send("LeaveShow", buildLeaveShow());
      await sleep(200);
    }
    try {
      s.end();
    } catch {
      /* ignore */
    }
    s.destroy();
    const got = latest as CaexFixture[] | null;
    if (!got) return fail(closed ? "Capture closed the connection before sending a FixtureList" : `no FixtureList from Capture within ${timeoutMs / 1000} s (is a show open?)`);
    say(`FixtureList received: ${got.length} fixture(s)`);
    return { ok: true, fixtures: got, showName, log: lines };
  } catch (e) {
    try {
      sock?.destroy();
    } catch {
      /* ignore */
    }
    return fail(`CITP error: ${(e as Error).message}`);
  }
}
