/**
 * CITP network helpers for the persistent session (citpSession.ts): local interfaces, Capture discovery (UDP 4809 multicast PLoc,
 * lsof fallback) and a TCP connect with timeout. Ported from research/lib/citp-sync.mjs (proven on Capture 2026.1.6).
 * Nothing here sends anything onto the CITP connection.
 */
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { decodeMessage } from "./citp.js";

export const SYNC_NAME = "capture-streamdeck";
const GROUPS = ["239.224.0.180", "224.0.0.180"];
const CITP_UDP = 4809;
const errStr = (e: NodeJS.ErrnoException): string => `code=${e.code} message=${e.message}`;

export function localIPv4(): { name: string; address: string }[] {
  const r: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4") r.push({ name, address: i.address });
  }
  return r;
}

export interface Found {
  port: number;
  from?: string;
}

/** Listen on UDP 4809 (multicast) for up to `ms`; resolve with the first PLoc of Type "Visualizer" (or null). */
export async function discover(ifaces: { address: string }[], ms: number, log: (s: string) => void): Promise<Found | null> {
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

/** TCP ports Capture listens on, from lsof (asynchronous: a slow lsof must never stall the DMX timer). */
export function lsofPorts(): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", "-a", "-c", "Capture", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", timeout: 4000 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const ports: number[] = [];
      for (const l of String(stdout).split("\n")) {
        const m = l.match(/TCP\s+\S+:(\d+)\s+\(LISTEN\)/);
        if (m) ports.push(+m[1]);
      }
      resolve([...new Set(ports)]);
    });
  });
}

export function tryConnect(host: string, port: number, timeoutMs = 3000): Promise<{ socket?: net.Socket; err?: Error }> {
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
