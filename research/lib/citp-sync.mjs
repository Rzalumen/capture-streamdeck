// Read the live patch from Capture: the CAEX spec F show-sync handshake, read-only, same outgoing allowlist as
// citp-connect.mjs --sync (isAllowedOutgoing refuses anything else): PINF/PNam, LaserFeedList (empty), EnterShow,
// FixtureListRequest, NACK (Reason 3) and LeaveShow. Used by dmx-proof.mjs and export-objects.mjs.
// citp-connect.mjs stays as it is (its own copy of this flow, with the full message log).
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  CAEX, CitpFramer, buildEnterShow, buildFixtureListRequest, buildLaserFeedList, buildLeaveShow, buildNack, buildPNam,
  decodeMessage, isAllowedOutgoing,
} from './citp.mjs';

export const PROBE_NAME = 'capture-streamdeck probe';
const GROUPS = ['239.224.0.180', '224.0.0.180'];
const CITP_UDP = 4809;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errStr = (e) => `code=${e.code} message=${e.message}`;

export function localIPv4() {
  const r = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' || i.family === 4) r.push({ name, address: i.address });
  }
  return r;
}

/** Listen on UDP 4809 (multicast) for up to `ms`; resolve with the first PLoc of Type "Visualizer" (or null). */
async function discover(ifaces, ms, log) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let found = null, timer;
  const done = new Promise((resolve) => {
    sock.on('error', (e) => { log(`discovery socket error: ${errStr(e)}`); resolve(null); });
    sock.on('message', (msg, rinfo) => {
      if (found || msg.length < 4 || msg.toString('latin1', 0, 4) !== 'CITP') return;
      const d = decodeMessage(msg);
      if (d.ploc && d.ploc.type === 'Visualizer') { found = { ...d.ploc, from: rinfo.address }; resolve(found); }
    });
    timer = setTimeout(() => resolve(found), ms);
  });
  const bound = await new Promise((res) => {
    const onErr = (e) => { log(`discovery bind failed: ${errStr(e)}`); res(false); };
    sock.once('error', onErr);
    sock.bind(CITP_UDP, () => { sock.removeListener('error', onErr); res(true); });
  });
  if (!bound) { clearTimeout(timer); try { sock.close(); } catch { /* ignore */ } return null; }
  for (const g of GROUPS) for (const i of ifaces) { try { sock.addMembership(g, i.address); } catch { /* interface without multicast */ } }
  const r = await done;
  clearTimeout(timer);
  try { sock.close(); } catch { /* ignore */ }
  return r;
}

function lsofPorts() {
  const ls = spawnSync('lsof', ['-nP', '-a', '-c', 'Capture', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (ls.error) return [];
  const ports = [];
  for (const l of (ls.stdout || '').split('\n')) { const m = l.match(/TCP\s+\S+:(\d+)\s+\(LISTEN\)/); if (m) ports.push(+m[1]); }
  return [...new Set(ports)];
}

function tryConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve({ err: new Error(`connect timeout after ${timeoutMs} ms`) }); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.removeAllListeners('error'); resolve({ socket: s }); });
    s.once('error', (e) => { clearTimeout(t); resolve({ err: e }); });
  });
}

/**
 * Connect to Capture, do the show-sync handshake and return its patch.
 * opts: {host, port} skip discovery; timeoutMs (default 45000, total wait for a FixtureList); discoverMs (default 5000); log(fn).
 * Resolves {ok, fixtures[], showName, target, log[]}; on failure {ok:false, error, fixtures: []}. Never throws.
 */
export async function readPatch({ host, port, timeoutMs = 45000, discoverMs = 5000, log = () => {} } = {}) {
  const lines = [];
  const say = (s) => { lines.push(s); log(s); };
  const fail = (error) => ({ ok: false, error, fixtures: [], log: lines });
  let sock = null;
  try {
    const ifaces = localIPv4();
    const hosts = [];
    let ports = port ? [Number(port)] : [];
    if (host) hosts.push(host);
    if (!ports.length) {
      say(`looking for Capture: UDP ${CITP_UDP} multicast, up to ${discoverMs / 1000} s ...`);
      const found = await discover(ifaces, discoverMs, say);
      if (found) { ports = [found.port]; if (found.from) hosts.push(found.from); say(`Capture announced CITP TCP port ${found.port} from ${found.from}`); }
      else { ports = lsofPorts(); say(ports.length ? `no announcement seen; lsof shows Capture listening on TCP ${ports.join(', ')}` : 'no announcement seen and lsof found no listening Capture TCP port'); }
    }
    if (!ports.length) return fail('No CITP TCP port known: Capture did not announce itself and no listening Capture port was found. Is Capture running with a show open?');
    const cands = [];
    for (const h of ['127.0.0.1', ...hosts, ...ifaces.map((i) => i.address)]) for (const p of ports) if (!cands.some((c) => c.h === h && c.p === p)) cands.push({ h, p });
    let target = null;
    for (const c of cands) {
      const r = await tryConnect(c.h, c.p);
      if (r.socket) { sock = r.socket; target = c; break; }
    }
    if (!sock) return fail(`could not connect to Capture's CITP port (tried ${cands.map((c) => `${c.h}:${c.p}`).join(', ')})`);
    say(`connected to ${target.h}:${target.p}`);

    const framer = new CitpFramer();
    const sourceKey = randomBytes(4).readUInt32LE(0);
    const REQUESTS = new Set([CAEX.GetLiveViewStatus, CAEX.GetLiveViewImage, CAEX.FixtureListRequest, CAEX.FixtureIdentify]);
    let weEntered = false, requests = 0, closed = false, showName = null, latest = null, closing = false;
    let chain = Promise.resolve();
    const send = (label, buf) => {
      chain = chain.then(() => new Promise((res) => {
        if (!isAllowedOutgoing(buf)) { say(`REFUSED to send ${label}: not on the outgoing allowlist`); res(); return; }
        if (closed || sock.destroyed) { res(); return; }
        sock.write(buf, () => res());
      }));
      return chain;
    };
    const requestFixtures = () => { if (requests < 4) { requests++; send('FixtureListRequest', buildFixtureListRequest()); } };
    let gotList;
    const listPromise = new Promise((res) => { gotList = res; });
    sock.on('data', (d) => {
      for (const m of framer.push(d).messages) {
        const dm = decodeMessage(m, '', { maxFixtures: 0 });
        switch (dm.code) {
          case CAEX.GetLaserFeedList: send('LaserFeedList (empty)', buildLaserFeedList(sourceKey, [])); break;
          case CAEX.EnterShow:
            showName = dm.showName ?? showName;
            if (!weEntered) { weEntered = true; send('EnterShow', buildEnterShow(PROBE_NAME)); }
            requestFixtures();
            break;
          case CAEX.FixtureList:
            if (dm.fixtures && !dm.fixtures.error) { latest = dm.fixtures; gotList(true); }
            else say(`FixtureList did not decode: ${dm.fixtures?.error ?? 'unknown error'}`);
            break;
          default:
            if (dm.layer === 'CAEX' && REQUESTS.has(dm.code)) send('NACK (refused)', buildNack(3));
        }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { closed = true; gotList(false); });
    await send('PNam', buildPNam(PROBE_NAME));
    say('sent PNam; waiting for Capture to enter its show and send the FixtureList ...');
    // one retry of the request after 5 s without a list, as citp-connect --sync does
    const retry = setTimeout(() => { if (!latest && !closing) requestFixtures(); }, 5000);
    const timeout = setTimeout(() => gotList(false), timeoutMs);
    const ok = await listPromise;
    clearTimeout(retry); clearTimeout(timeout);
    if (ok) await sleep(200); // let a second FixtureList that follows directly replace the first
    closing = true;
    await chain;
    if (weEntered && !closed && !sock.destroyed) { await send('LeaveShow', buildLeaveShow()); await sleep(200); }
    try { sock.end(); } catch { /* ignore */ }
    sock.destroy();
    if (!latest) return fail(closed ? 'Capture closed the connection before sending a FixtureList' : `no FixtureList from Capture within ${timeoutMs / 1000} s (is a show open?)`);
    say(`FixtureList received: ${latest.fixtures.length} fixture(s)`);
    return { ok: true, fixtures: latest.fixtures, showName, target, log: lines };
  } catch (e) {
    try { sock?.destroy(); } catch { /* ignore */ }
    return fail(`CITP error: ${e.message}`);
  }
}

/** Fixtures that are patched, in FixtureList order, with the extras dmx-proof/export need. */
export function patchedFixtures(fixtures) {
  const patched = fixtures.filter((f) => f.patched);
  return patched.map((f) => ({
    ...f,
    fixtureGuid: f.ids.find((d) => d.type === 0x02)?.guidRaw ?? null,
    modeGuid: f.ids.find((d) => d.type === 0x03)?.guidRaw ?? null,
    universe1: f.universe + 1, address1: f.universeChannel + 1,
    sharing: patched.filter((o) => o !== f && o.universe === f.universe).length,
  }));
}

/**
 * EVERY fixture of the FixtureList with the identifiers pulled out. The CAEX patch fields are kept as Capture sent them:
 * `caexPatched` (Patched=1), `caexUniverse1`/`caexAddress1` (1-based) are only meaningful when caexPatched is true.
 * `channel` is Capture's own Channel number. `sharing` counts OTHER fixtures that report Patched=1 in the same universe.
 */
export function describeFixtures(fixtures) {
  const patched = fixtures.filter((f) => f.patched);
  return fixtures.map((f) => ({
    ...f,
    fixtureGuid: f.ids.find((d) => d.type === 0x02)?.guidRaw ?? null,
    modeGuid: f.ids.find((d) => d.type === 0x03)?.guidRaw ?? null,
    caexPatched: !!f.patched,
    caexUniverse1: f.universe + 1, caexAddress1: f.universeChannel + 1,
    sharing: f.patched ? patched.filter((o) => o !== f && o.universe === f.universe).length : 0,
  }));
}
