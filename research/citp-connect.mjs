// CITP TCP probe: connects to Capture's CITP listening port as a client and logs what Capture sends.
//
//   node research/citp-connect.mjs [--observe]   (default) connect, send NOTHING, log 20 s
//   node research/citp-connect.mjs --hello        connect, send one PINF/PNam, log 30 s
//   node research/citp-connect.mjs --caex         --hello, then CAEX FixtureListRequest; decode FixtureList
//   node research/citp-connect.mjs --sync         CAEX spec F show-sync handshake, 45 s (see below)
//   node research/citp-connect.mjs --link         --sync PLUS announce as a lighting console and accept Capture's inbound TCP, 120 s (see below)
//   node research/citp-connect.mjs --identify     --sync, then ONE FixtureIdentify giving every fixture an identifier, 90 s (see below). WRITES into the show: use a COPY.
//
// Read-only toward the show. The ONLY messages this script may ever send (enforced by isAllowedOutgoing() in
// lib/citp.mjs, which refuses everything else) are: PINF/PNam, CAEX LaserFeedList (empty), EnterShow,
// FixtureListRequest, NACK and LeaveShow. Nothing that changes the patch, selection, DMX or state is built
// anywhere (no FixtureList/Modify/Remove/Identify/Selection/ConsoleStatus, no SetFixtureTransformationSpace).
// EnterShow and LeaveShow are only ever sent in --sync.
//
// --sync (CAEX spec F, rules of interaction): send PNam; answer Capture's GetLaserFeedList with an empty
// LaserFeedList; when Capture sends EnterShow, send our own EnterShow then a FixtureListRequest (one retry
// after 5 s without a FixtureList); NACK (Reason 3, refused) any other request from Capture; log every message,
// print every fixture of each FixtureList as tables, log every FixtureSelection with a timestamp; before
// closing send LeaveShow (only if we sent EnterShow), wait 500 ms, close.
//
// --link (Handoff 12): everything --sync does on the outbound connection, and at the same time
//   * announces a fake lighting console: PINF/PLoc (Type "LightingConsole", name "capture-streamdeck probe", ListeningTCPPort = our own
//     TCP listener) every 1 s to both CITP multicast groups on every local IPv4 interface (exactly what network-probe --announce does);
//   * accepts ANY inbound TCP connection and logs everything it sends; on it we answer only with allowlisted messages, by the same
//     rules as the outbound session (PNam on connect, empty LaserFeedList, our EnterShow after Capture's + a FixtureListRequest, NACK 3);
//   * sends a FixtureListRequest again every 10 s (--rerequest-seconds) on every open connection for the whole run;
//   * logs a one-line summary for EVERY FixtureList (time, connection, count, Type, how many Patched=1, first 3 patched rows) and the full
//     tables only for the first list and for the first list that holds a patched fixture.
//   At the end: LeaveShow, close everything. Report: reports/citp-link.txt. No DMX. The allowlist (isAllowedOutgoing) is unchanged;
//   the UDP announcement is the only other thing ever put on the wire and is checked by isConsoleAnnouncement().
//
// --identify (Handoff 17): the --sync flow, and after the FIRST FixtureList
//   * every fixture that has a CaptureInstanceId (identifier type 0x04, 16 bytes) is given FixtureIdentifier = 100001 + its index in the list;
//     the full map is printed, then ONE FixtureIdentify (CAEX 5.6, 0x00020204) with all of them is sent. It is the ONLY new outgoing message
//     and only in this phase (isAllowedOutgoing(msg, {identify: true}), and the script itself refuses a second one);
//   * 2 s later a FixtureListRequest: how many fixtures now carry a non-0xffffffff identifier, whether they match the map, and whether any
//     Patched/Universe/UniverseChannel field is now filled (listed);
//   * for the rest of the run (default 90 s): every FixtureSelection (timestamp, identifiers, fixtures), every FixtureModify (all fields,
//     patch fields flagged), FixtureListRequest every 20 s (--rerequest-seconds) with every change of identifiers / patch fields reported.
//   Still never sent: FixtureList, FixtureModify, FixtureRemove, FixtureSelection, FixtureConsoleStatus, SetFixtureTransformationSpace. No DMX.
//   Report: reports/citp-identify.txt with an "== Identify summary ==" block.
//
// Test/dev options: --host <ip> --port <n> (skip discovery), --duration <s> or --seconds <s> (override log time),
//   --announce-dest <ip:port> (--link: send the announcement ONLY there instead of the multicast groups),
//   --report-dir <dir> (default ./reports), --citp-version <maj.min> (default 1.0; only bytes 4-5 change).
// Report: reports/citp-<phase>.txt

import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  CAEX, CitpFramer, buildEnterShow, buildFixtureIdentify, buildFixtureListRequest, buildLaserFeedList, buildLeaveShow, buildNack, buildPNam,
  buildPLoc, decodeMessage, formatFixtureTables, fourcc, hexOf, isAllowedOutgoing, textTable,
} from './lib/citp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const PHASE = flag('--identify') ? 'identify' : flag('--link') ? 'link' : flag('--sync') ? 'sync' : flag('--caex') ? 'caex' : flag('--hello') ? 'hello' : 'observe';
const DEFAULT_MS = { observe: 20000, hello: 30000, caex: 30000, sync: 45000, link: 120000, identify: 90000 }[PHASE];
const durArg = opt('--seconds') ?? opt('--duration');
const DURATION_MS = durArg ? Math.round(parseFloat(durArg) * 1000) : DEFAULT_MS;
const isIdentify = PHASE === 'identify';
const REREQUEST_MS = Math.round(parseFloat(opt('--rerequest-seconds') ?? (isIdentify ? '20' : '10')) * 1000);
const IDENTIFY_BASE = 100001; // FixtureIdentifier = IDENTIFY_BASE + index in the FixtureList
const VERIFY_DELAY_MS = Math.round(parseFloat(opt('--verify-delay') ?? '2') * 1000);
const ANNOUNCE_MS = 1000;
const REPORT_DIR = opt('--report-dir') ? path.resolve(opt('--report-dir')) : path.join(ROOT, 'reports');
const [VMAJ, VMIN] = (opt('--citp-version') || '1.0').split('.').map(Number);
const HDR_OPTS = { major: VMAJ, minor: VMIN };
const GROUPS = ['239.224.0.180', '224.0.0.180'];
const CITP_UDP = 4809;
const DISCOVER_MS = 5000;
const PROBE_NAME = 'capture-streamdeck probe';
const isLink = PHASE === 'link';

const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const since = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
const errStr = (e) => `code=${e.code} errno=${e.errno} syscall=${e.syscall} message=${e.message}`;

function localIPv4() {
  const r = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' || i.family === 4) r.push({ name, address: i.address });
  }
  return r;
}

/** Listen on UDP 4809 (multicast) for up to DISCOVER_MS; resolve with the first PLoc of Type "Visualizer". */
async function discover(ifaces) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let found = null;
  const done = new Promise((resolve) => {
    sock.on('error', (e) => { out(`  discovery socket error: ${errStr(e)}`); resolve(null); });
    sock.on('message', (msg, rinfo) => {
      if (found || msg.length < 4 || msg.toString('latin1', 0, 4) !== 'CITP') return;
      const d = decodeMessage(msg);
      if (d.ploc) {
        out(`  discovery ${since()}: PLoc from ${rinfo.address}:${rinfo.port}: port=${d.ploc.port} type=${JSON.stringify(d.ploc.type)} name=${JSON.stringify(d.ploc.name)} state=${JSON.stringify(d.ploc.state)}`);
        if (d.ploc.type === 'Visualizer') { found = { ...d.ploc, from: rinfo.address }; resolve(found); }
      }
    });
    setTimeout(() => resolve(found), DISCOVER_MS);
  });
  const bound = await new Promise((res) => {
    const onErr = (e) => { out(`  discovery BIND FAILED: ${errStr(e)}`); res(false); };
    sock.once('error', onErr);
    sock.bind(CITP_UDP, () => { sock.removeListener('error', onErr); res(true); });
  });
  if (!bound) { try { sock.close(); } catch { /* ignore */ } return null; }
  for (const g of GROUPS) for (const i of ifaces) {
    try { sock.addMembership(g, i.address); } catch (e) { out(`  join ${g} on ${i.name} (${i.address}) FAILED: ${errStr(e)}`); }
  }
  const r = await done;
  try { sock.close(); } catch { /* ignore */ }
  return r;
}

function lsofTcpPorts() {
  const ls = spawnSync('lsof', ['-nP', '-a', '-c', 'Capture', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (ls.error) { out(`  lsof could not run: ${ls.error.code} ${ls.error.message}`); return []; }
  out(`  lsof -nP -a -c Capture -iTCP -sTCP:LISTEN (exit ${ls.status}):\n${(ls.stdout || '').trimEnd() || '  (no rows)'}`);
  const ports = [];
  for (const l of (ls.stdout || '').split('\n')) { const m = l.match(/TCP\s+\S+:(\d+)\s+\(LISTEN\)/); if (m) ports.push(+m[1]); }
  return [...new Set(ports)];
}

function tryConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => { s.destroy(); resolve({ err: new Error(`connect timeout after ${timeoutMs} ms`) }); }, timeoutMs);
    s.once('connect', () => { clearTimeout(timer); s.removeAllListeners('error'); resolve({ socket: s }); });
    s.once('error', (e) => { clearTimeout(timer); resolve({ err: e }); });
  });
}

/** The ONLY UDP datagram --link may send: PINF/PLoc of Type "LightingConsole" (checked before every send). */
function isConsoleAnnouncement(b) {
  return b.length > 30 && b.toString('latin1', 0, 4) === 'CITP' && b.toString('latin1', 16, 24) === 'PINFPLoc' && b.toString('latin1', 26, 41) === 'LightingConsole';
}

/**
 * --link: announce a console on UDP 4809. The socket is bound to 4809 (reuseAddr, like network-probe --announce) when `discover` is
 * set so it can also hear Capture's own PLoc; otherwise it is an ephemeral socket. Sends every ANNOUNCE_MS to both groups on every
 * interface, or only to `dest` ("ip:port") when given.
 */
async function startAnnouncer({ ifaces, tcpPort, discover: wantDiscover, dest }) {
  const pkt = buildPLoc(tcpPort, 'LightingConsole', PROBE_NAME, 'Running');
  if (!isConsoleAnnouncement(pkt)) throw new Error('internal: announcement packet failed its own check');
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const A = { sock, pkt, rounds: 0, ok: 0, fail: 0, bound: false, visualizer: null, waiters: [], timer: null, seenErr: new Set() };
  sock.on('error', (e) => out(`  announce socket error: ${errStr(e)}`));
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 4 || msg.toString('latin1', 0, 4) !== 'CITP' || A.visualizer) return;
    const d = decodeMessage(msg);
    if (d.ploc && d.ploc.type === 'Visualizer') {
      A.visualizer = { ...d.ploc, from: rinfo.address };
      out(`  discovery ${since()}: PLoc from ${rinfo.address}:${rinfo.port}: port=${d.ploc.port} type=${JSON.stringify(d.ploc.type)} name=${JSON.stringify(d.ploc.name)} state=${JSON.stringify(d.ploc.state)}`);
      A.waiters.splice(0).forEach((w) => w(A.visualizer));
    }
  });
  await new Promise((res) => {
    const onErr = (e) => { out(`  announce socket bind to ${wantDiscover ? CITP_UDP : 'an ephemeral port'} FAILED: ${errStr(e)}`); res(); };
    sock.once('error', onErr);
    sock.bind(wantDiscover ? CITP_UDP : 0, () => { sock.removeListener('error', onErr); A.bound = true; res(); });
  });
  if (!A.bound) { // fall back to an ephemeral socket so the announcement still goes out
    await new Promise((res) => sock.bind(0, () => res()));
  }
  if (wantDiscover && A.bound) for (const g of GROUPS) for (const i of ifaces) { try { sock.addMembership(g, i.address); } catch (e) { out(`  join ${g} on ${i.name} (${i.address}) FAILED: ${errStr(e)}`); } }
  const round = async () => {
    A.rounds++;
    let ok = 0, fail = 0;
    const note = (k, msg) => { if (!A.seenErr.has(k)) { A.seenErr.add(k); out(msg); } };
    if (dest) {
      const [h, pt] = dest.split(':');
      await new Promise((res) => sock.send(pkt, Number(pt), h, (err) => { if (err) { fail++; note(`d${err.code}`, `  announce to ${dest} FAILED: ${errStr(err)}`); } else ok++; res(); }));
    } else {
      for (const i of ifaces) {
        try { sock.setMulticastInterface(i.address); } catch (e) { note(`i${i.name}`, `  setMulticastInterface(${i.address}) FAILED: ${errStr(e)}`); fail += GROUPS.length; continue; }
        for (const g of GROUPS) {
          await new Promise((res) => sock.send(pkt, CITP_UDP, g, (err) => {
            if (err) { fail++; note(`${i.name}|${g}|${err.code}`, `  announce ${g}:${CITP_UDP} via ${i.name} (${i.address}) FAILED: ${errStr(err)}`); } else ok++;
            res();
          }));
        }
      }
    }
    A.ok += ok; A.fail += fail;
    if (A.rounds === 1) out(`  ${since()} announce round 1: ${ok} sends ok, ${fail} failed${dest ? ` (to ${dest} only)` : ` (${ifaces.length} interfaces x ${GROUPS.length} groups)`}`);
  };
  A.waitVisualizer = (ms) => new Promise((res) => { if (A.visualizer) return res(A.visualizer); A.waiters.push(res); setTimeout(() => res(A.visualizer), ms); });
  A.start = () => { round(); A.timer = setInterval(round, ANNOUNCE_MS); };
  A.stop = () => { clearInterval(A.timer); try { sock.close(); } catch { /* ignore */ } };
  return A;
}

async function main() {
  out(`CITP connect probe   phase=${PHASE}   ${new Date().toISOString()}   node ${process.version} ${process.platform}/${process.arch}`);
  out(`CITP header version used for anything we send: ${VMAJ}.${VMIN};  log duration: ${DURATION_MS / 1000} s`);
  out(PHASE === 'observe' ? 'Sends: NOTHING.' : PHASE === 'hello' ? 'Sends: one PINF/PNam ("' + PROBE_NAME + '").'
    : PHASE === 'link' ? `Sends (only): UDP PINF/PLoc announcements (Type LightingConsole) every ${ANNOUNCE_MS / 1000} s; on TCP (outbound AND inbound connections): PINF/PNam, LaserFeedList (empty), EnterShow, FixtureListRequest (every ${REREQUEST_MS / 1000} s), NACK (Reason 3), LeaveShow. No DMX.`
    : PHASE === 'identify' ? 'Sends (only): PINF/PNam, LaserFeedList (empty), EnterShow, FixtureListRequest (also every ' + REREQUEST_MS / 1000 + ' s), NACK (Reason 3), LeaveShow, and ONE FixtureIdentify (CAEX 5.6) after the first FixtureList. It writes an identifier into every fixture of the open show: use a COPY. No DMX.'
    : PHASE === 'sync' ? 'Sends (only): PINF/PNam, LaserFeedList (empty), EnterShow, FixtureListRequest, NACK (Reason 3), LeaveShow.'
    : 'Sends: PINF/PNam, then CAEX FixtureListRequest (0x00020200) only.');
  out('');

  const ifaces = localIPv4();
  let port = opt('--port') ? Number(opt('--port')) : null;
  const hosts = [];
  let fallbackPorts = [];
  if (opt('--host')) hosts.push(opt('--host'));

  // ---- link: our own TCP listener + announcer start first, so the console is announced while we look for Capture ----
  const sessions = []; // every TCP session (outbound first); link adds inbound ones
  let inboundCount = 0, announcer = null, tcpServer = null;
  let makeSession = null; // defined below (needs the shared helpers); the TCP listener calls it
  if (isLink) {
    tcpServer = net.createServer({ allowHalfOpen: true }, (c) => {
      const n = ++inboundCount;
      out(`  ${since()} TCP INBOUND CONNECTION #${n} from ${c.remoteAddress}:${c.remotePort} to ${c.localAddress}:${c.localPort}`);
      const ses = makeSession(`in#${n}`, c);
      ses.inbound = true;
      sessions.push(ses);
      ses.enqueue('PINF/PNam', buildPNam(PROBE_NAME, HDR_OPTS));
    });
    tcpServer.on('error', (e) => out(`  TCP server error: ${errStr(e)}`));
    await new Promise((res) => tcpServer.listen(0, '0.0.0.0', res));
    const tcpPort = tcpServer.address().port;
    out(`== Console announcement ==`);
    out(`  TCP listener on 0.0.0.0:${tcpPort}`);
    announcer = await startAnnouncer({ ifaces, tcpPort, discover: !port, dest: opt('--announce-dest') });
    out(`  announcement (${announcer.pkt.length} bytes): ${hexOf(announcer.pkt)}`);
    decodeMessage(announcer.pkt, '    ').lines.forEach(out);
    announcer.start();
    out('');
  }

  if (!port) {
    out(`== Discovery: UDP ${CITP_UDP}, up to ${DISCOVER_MS / 1000} s, first PLoc with Type="Visualizer" ==`);
    const found = isLink ? await announcer.waitVisualizer(DISCOVER_MS) : await discover(ifaces);
    if (found) { port = found.port; out(`  using ListeningTCPPort ${port} from PLoc (announced by ${found.from})`); if (found.from) hosts.push(found.from); }
    else { out('  no Visualizer PLoc seen; falling back to lsof'); fallbackPorts = lsofTcpPorts(); }
    out('');
  }
  const ports = port ? [port] : fallbackPorts;
  const stopAnnouncing = () => { if (announcer) announcer.stop(); };
  if (!ports.length) { out('No CITP TCP port known (no PLoc received and lsof found no listening Capture TCP port). Nothing to connect to.'); stopAnnouncing(); if (tcpServer) tcpServer.close(); return 1; }
  const candidates = [];
  for (const h of ['127.0.0.1', ...hosts, ...ifaces.map((i) => i.address)]) for (const p of ports) {
    if (!candidates.some((c) => c.h === h && c.p === p)) candidates.push({ h, p });
  }

  out('== Connect ==');
  let sock = null, target = null;
  for (const c of candidates) {
    const r = await tryConnect(c.h, c.p);
    if (r.socket) { sock = r.socket; target = c; out(`  connected to ${c.h}:${c.p} (local ${sock.localAddress}:${sock.localPort})`); break; }
    out(`  ${c.h}:${c.p} failed: ${errStr(r.err)}`);
  }
  if (!sock) { out('Could not connect to any candidate.'); stopAnnouncing(); if (tcpServer) tcpServer.close(); return 1; }
  lines.unshift(`Target: ${target.h}:${target.p}`); // shown at the top of the report

  // ---- sessions ----
  const sourceKey = randomBytes(4).readUInt32LE(0);
  const REQUESTS = new Set([CAEX.GetLiveViewStatus, CAEX.GetLiveViewImage, CAEX.FixtureListRequest, CAEX.FixtureIdentify]);
  const synced = PHASE === 'sync' || isLink || isIdentify;
  const fullShown = { first: false, patched: false };
  let listCount = 0;
  // ---- identify state (Handoff 17) ----
  const ID = { map: new Map(), byId: new Map(), items: [], skipped: [], sent: false, sentAt: null, verifyPending: false, first: null, prev: null, lists: 0, reports: [], modifies: [], refused: 0, notSentReason: null, latestStats: null };
  const hex8 = (v) => '0x' + v.toString(16).padStart(8, '0');
  const stamp = () => `${since()} ${new Date().toISOString().slice(11, 23)}Z`;
  const instanceOf = (f) => f.ids.find((d) => d.type === 0x04);
  const keyOf = (f) => { const d = instanceOf(f); return d && d.guidRaw ? d.guidRaw : `#${f.index}`; };
  const fxName = (f) => `${f.manufacturer ? f.manufacturer + ' ' : ''}${f.name}`;
  const filled = (f) => f.patched || f.universe || f.universeChannel;
  const filledRow = (f) => `Ch ${f.channel} ${fxName(f)}: patched=${f.patched} universe=${f.universe + 1} [${f.universe}] address=${f.universeChannel + 1} [${f.universeChannel}]`;
  /** identifiers of a list against our map */
  function listStats(fx) {
    const identified = fx.filter((f) => f.identifier !== 0xffffffff);
    const matched = [], mismatched = [];
    for (const f of fx) {
      const want = ID.map.get(keyOf(f));
      if (!want) continue;
      (f.identifier === want.identifier ? matched : mismatched).push(f);
    }
    return { total: fx.length, identified, matched, mismatched, filledRows: fx.filter(filled) };
  }
  /** What the Selection / Modify lines call a fixture: from the latest list by identifier, else from our own map. */
  function describeId(id, latest) {
    const f = latest && latest.fixtures.find((x) => x.identifier === id);
    if (f) return `${hex8(id)} (Ch ${f.channel} ${fxName(f)})`;
    const a = ID.byId.get(id);
    if (a) return `${hex8(id)} (assigned by us: Ch ${a.f.channel} ${fxName(a.f)})`;
    return hex8(id);
  }
  function diffLists(prev, cur) {
    const out = [];
    const pm = new Map(prev.map((f) => [keyOf(f), f]));
    for (const f of cur) {
      const o = pm.get(keyOf(f));
      if (!o) { out.push(`new fixture Ch ${f.channel} ${fxName(f)} (identifier ${hex8(f.identifier)})`); continue; }
      if (o.identifier !== f.identifier) out.push(`Ch ${f.channel} ${fxName(f)}: identifier ${hex8(o.identifier)} -> ${hex8(f.identifier)}`);
      if (o.patched !== f.patched || o.universe !== f.universe || o.universeChannel !== f.universeChannel) {
        out.push(`Ch ${f.channel} ${fxName(f)}: PATCH FIELDS patched ${o.patched}->${f.patched}, universe ${o.universe + 1}->${f.universe + 1}, address ${o.universeChannel + 1}->${f.universeChannel + 1}`);
      }
    }
    const cm = new Set(cur.map(keyOf));
    for (const f of prev) if (!cm.has(keyOf(f))) out.push(`fixture removed: Ch ${f.channel} ${fxName(f)}`);
    return out;
  }

  // log with the connection tag after the indentation (link only; sync/caex lines are unchanged)
  const lg = (ses, s) => out(ses.tag ? s.replace(/^(\s*)/, `$1[${ses.tag}] `) : s);

  makeSession = (tag, sk) => {
    const ses = {
      tag, sk, inbound: false, framer: new CitpFramer(), rx: 0, msgCount: 0, sawEnterShow: false, sawFixtureList: false, closedByPeer: false, closing: false, chain: Promise.resolve(),
      S: { laserRequests: 0, laserReplies: 0, nacks: 0, captureEnterShow: 0, weEntered: false, weLeft: false, fixtureRequests: 0, fixtureLists: 0, listsWithPatched: 0, maxPatched: 0, firstPatchedAt: null, latest: null, selections: [], modifies: 0, removes: 0, unsolicitedOther: [], timers: [] },
      onEnterShow: () => {},
    };
    const send = (label, buf) => new Promise((res) => {
      const isIdent = buf.length >= 24 && buf.toString('latin1', 16, 20) === 'CAEX' && buf.readUInt32LE(20) === CAEX.FixtureIdentify;
      if (!isAllowedOutgoing(buf, { identify: isIdentify }) || (isIdent && ID.sent)) { if (isIdent) ID.refused++; lg(ses, `  ${since()} REFUSED to send ${label}: ${isIdent && ID.sent ? 'a FixtureIdentify was already sent (only one is ever allowed)' : 'not on the outgoing allowlist'} (${hexOf(buf, 32)})`); res(); return; }
      if (isIdent) { ID.sent = true; ID.sentAt = since(); }
      if (ses.closing && !/LeaveShow/.test(label)) { lg(ses, `  ${since()} not sending ${label}: shutting down`); res(); return; }
      lg(ses, `  ${since()} SEND ${label} (${buf.length} bytes): ${hexOf(buf)}`);
      decodeMessage(buf, '      ').lines.forEach((l) => lg(ses, l));
      sk.write(buf, (e) => { if (e) lg(ses, `  send error: ${errStr(e)}`); res(); });
    });
    // sends are queued so their order on the wire is the order they were decided in
    ses.send = send;
    ses.enqueue = (label, buf) => (ses.chain = ses.chain.then(() => send(label, buf)));
    ses.requestFixtures = (why) => {
      const S = ses.S;
      const cap = isLink || isIdentify ? Infinity : 6;
      if (S.fixtureRequests >= cap) { lg(ses, `  (not sending another FixtureListRequest: ${cap} already sent)`); return; }
      const n = ++S.fixtureRequests; const before = S.fixtureLists;
      ses.enqueue(`CAEX FixtureListRequest #${n} (${why})`, buildFixtureListRequest(HDR_OPTS));
      if (isLink) return; // link re-requests every REREQUEST_MS instead of the single 5 s retry
      S.timers.push(setTimeout(() => {
        if (S.fixtureLists === before && !ses.closing && !S.retried?.has(n)) {
          (S.retried ||= new Set()).add(n);
          lg(ses, `  ${since()} no FixtureList within 5 s of request #${n}; sending one retry`);
          ses.enqueue(`CAEX FixtureListRequest #${n}b (retry: no FixtureList within 5 s)`, buildFixtureListRequest(HDR_OPTS));
        }
      }, 5000));
    };
    const patchedRow = (f) => `${f.manufacturer ? f.manufacturer + ' ' : ''}${f.name} ${f.universe + 1}/${f.universeChannel + 1} ch ${f.channel}`;
    function onFixtureList(dm, at) {
      const S = ses.S;
      S.fixtureLists++; S.latest = dm.fixtures; listCount++;
      if (isIdentify) { onIdentifyList(dm, at); return; }
      if (!isLink) {
        lg(ses, `  ${at} -> FixtureList #${S.fixtureLists}: Type=${dm.fixtures.type} count=${dm.fixtures.count}${dm.fixtures.error ? ' DECODE ERROR: ' + dm.fixtures.error : ''}`);
        lg(ses, '  ---- fixture tables (every fixture) ----');
        formatFixtureTables(dm.fixtures.fixtures).forEach((l) => lg(ses, l));
        lg(ses, '  ---- end fixture tables ----');
        return;
      }
      const fx = dm.fixtures.fixtures;
      const patched = fx.filter((f) => f.patched);
      S.maxPatched = Math.max(S.maxPatched, patched.length);
      if (patched.length) { S.listsWithPatched++; S.firstPatchedAt ??= since(); }
      lg(ses, `  ${at} -> FixtureList #${S.fixtureLists} (list ${listCount} overall): count=${dm.fixtures.count} Type=${dm.fixtures.type} patched(Patched=1)=${patched.length}` +
        `${patched.length ? ` first ${Math.min(3, patched.length)}: ${patched.slice(0, 3).map(patchedRow).join('; ')}` : ''}${dm.fixtures.error ? ' DECODE ERROR: ' + dm.fixtures.error : ''}`);
      const showFull = (!fullShown.first) || (patched.length && !fullShown.patched);
      if (showFull) {
        lg(ses, `  ---- fixture tables (${!fullShown.first ? 'first list' : 'first list with a patched fixture'}) ----`);
        formatFixtureTables(fx).forEach((l) => lg(ses, l));
        lg(ses, '  ---- end fixture tables ----');
      }
      fullShown.first = true; if (patched.length) fullShown.patched = true;
    }
    /** --identify: the first list triggers the map + the ONE FixtureIdentify; later lists are verified / diffed. */
    function onIdentifyList(dm, at) {
      const S = ses.S; const fx = dm.fixtures.fixtures; const n = ++ID.lists;
      const st = listStats(fx);
      lg(ses, `  ${at} -> FixtureList #${S.fixtureLists}: Type=${dm.fixtures.type} count=${dm.fixtures.count}${dm.fixtures.error ? ' DECODE ERROR: ' + dm.fixtures.error : ''}; identifier != 0xffffffff: ${st.identified.length}; Patched/Universe/UniverseChannel filled: ${st.filledRows.length}`);
      if (!ID.first) {
        ID.first = { fx, st, at }; ID.prev = fx; ID.latestStats = st;
        lg(ses, '  ---- fixture tables (first list) ----');
        formatFixtureTables(fx).forEach((l) => lg(ses, l));
        lg(ses, '  ---- end fixture tables ----');
        // the ID map: identifier = 100001 + index, for every fixture with a 16-byte CaptureInstanceId
        for (const f of fx) {
          const d = instanceOf(f);
          if (!d) { ID.skipped.push({ f, why: 'no CaptureInstanceId (identifier type 0x04)' }); continue; }
          if (d.size !== 16) { ID.skipped.push({ f, why: `CaptureInstanceId is ${d.size} byte(s), not 16` }); continue; }
          if (ID.map.has(keyOf(f))) { ID.skipped.push({ f, why: 'same CaptureInstanceId as an earlier fixture' }); continue; }
          const e = { f, guid: Buffer.from(d.hex.replace(/ /g, ''), 'hex'), identifier: IDENTIFY_BASE + f.index };
          ID.map.set(keyOf(f), e); ID.byId.set(e.identifier, e); ID.items.push(e);
        }
        lg(ses, `  ---- ID map: identifier = ${IDENTIFY_BASE} + list index; ${ID.items.length} of ${fx.length} fixture(s) have a CaptureInstanceId ----`);
        textTable(['index', 'channel', 'model', 'mode', 'CaptureInstanceId (as received)', 'CaptureInstanceId (spec form)', 'identifier'],
          ID.items.map((e) => [e.f.index, e.f.channel, fxName(e.f), e.f.mode, instanceOf(e.f).guidRaw, instanceOf(e.f).guidSpec, `${e.identifier} (${hex8(e.identifier)})`])).forEach((l) => lg(ses, l));
        ID.skipped.forEach((x) => lg(ses, `  NOT identified: #${x.f.index} Ch ${x.f.channel} ${fxName(x.f)}: ${x.why}`));
        lg(ses, '  ---- end ID map ----');
        if (!ID.items.length) { ID.notSentReason = 'no fixture has a usable CaptureInstanceId'; lg(ses, `  ${at} FixtureIdentify NOT sent: ${ID.notSentReason}`); return; }
        const sent = ses.enqueue(`CAEX FixtureIdentify (${ID.items.length} fixture(s))`, buildFixtureIdentify(ID.items.map((e) => ({ guid: e.guid, identifier: e.identifier })), HDR_OPTS));
        sent.then(() => {
          if (!ID.sent || ses.closing) return;
          S.timers.push(setTimeout(() => { ID.verifyPending = true; ses.requestFixtures(`${VERIFY_DELAY_MS / 1000} s after FixtureIdentify: verify`); }, VERIFY_DELAY_MS));
        });
        return;
      }
      const prev = ID.prev;
      if (ID.verifyPending) {
        ID.verifyPending = false;
        const rep = { n, at, st, kind: 'verify' };
        ID.reports.push(rep);
        lg(ses, `  ${at} ==== AFTER FixtureIdentify (list #${S.fixtureLists}) ====`);
        lg(ses, `    fixtures: ${st.total}; carrying an identifier other than 0xffffffff: ${st.identified.length}; matching our map: ${st.matched.length} of ${ID.items.length}; mismatching: ${st.mismatched.length}`);
        st.mismatched.slice(0, 20).forEach((f) => lg(ses, `    MISMATCH Ch ${f.channel} ${fxName(f)}: has ${hex8(f.identifier)}, we assigned ${hex8(ID.map.get(keyOf(f)).identifier)}`));
        const other = st.identified.filter((f) => !ID.map.has(keyOf(f)));
        other.slice(0, 20).forEach((f) => lg(ses, `    identifier ${hex8(f.identifier)} on Ch ${f.channel} ${fxName(f)} (not in our map)`));
        lg(ses, `    Patched/Universe/UniverseChannel filled: ${st.filledRows.length ? 'YES (' + st.filledRows.length + ' fixture(s))' : 'NO'} (first list: ${ID.first.st.filledRows.length})`);
        st.filledRows.forEach((f) => lg(ses, `      ${filledRow(f)}`));
        lg(ses, `  ${at} ==== end ====`);
      } else {
        const d = diffLists(prev, fx);
        ID.reports.push({ n, at, st, kind: 'periodic', changes: d });
        lg(ses, d.length ? `    CHANGES since the previous list: ${d.length}` : '    no change in identifiers or patch fields since the previous list');
        d.slice(0, 40).forEach((l) => lg(ses, `      ${l}`));
        if (d.length > 40) lg(ses, `      ... ${d.length - 40} more`);
      }
      ID.latestStats = st;
      ID.prev = fx;
    }
    function handleSync(m, dm) {
      const at = isIdentify ? stamp() : since(); const S = ses.S;
      switch (dm.code) {
        case CAEX.GetLaserFeedList:
          S.laserRequests++;
          lg(ses, `  ${at} -> Capture asked GetLaserFeedList (#${S.laserRequests}); replying with an empty LaserFeedList (SourceKey 0x${sourceKey.toString(16).padStart(8, '0')}, FeedCount 0)`);
          S.laserReplies++; ses.enqueue('CAEX LaserFeedList (empty)', buildLaserFeedList(sourceKey, [], HDR_OPTS));
          return;
        case CAEX.EnterShow:
          S.captureEnterShow++;
          lg(ses, `  ${at} -> Capture entered show ${JSON.stringify(dm.showName)}`);
          if (!S.weEntered) { S.weEntered = true; ses.enqueue('CAEX EnterShow (ours)', buildEnterShow(PROBE_NAME, HDR_OPTS)); }
          ses.requestFixtures('Capture entered a show while we are in a show');
          return;
        case CAEX.FixtureList:
          onFixtureList(dm, at);
          return;
        case CAEX.FixtureSelection: {
          const names = (dm.selection || []).map((id) => {
            if (isIdentify) return describeId(id, S.latest);
            const f = S.latest && S.latest.fixtures.find((x) => x.identifier === id);
            return `0x${id.toString(16).padStart(8, '0')}${f ? ` (${f.manufacturer} ${f.name}, ch ${f.channel})` : ''}`;
          });
          S.selections.push({ at, ids: names });
          lg(ses, `  ${at} -> FIXTURE SELECTION: ${names.length ? names.join('; ') : '(empty selection)'}`);
          return;
        }
        case CAEX.FixtureModify:
          S.modifies++;
          if (isIdentify) {
            if (!dm.modify) lg(ses, `  ${at} -> FIXTURE MODIFY received but its fields could not be decoded (raw hex above)`);
            for (const x of dm.modify || []) {
              const f = [];
              if (x.changed & 0x01) f.push(`PATCH FIELDS patched=${x.patched} universe=${x.universe + 1} [${x.universe}] address=${x.universeChannel + 1} [${x.universeChannel}]`);
              if (x.changed & 0x02) f.push(`unit=${JSON.stringify(x.unit)}`);
              if (x.changed & 0x04) f.push(`channel=${x.channel}`);
              if (x.changed & 0x08) f.push(`circuit=${JSON.stringify(x.circuit)}`);
              if (x.changed & 0x10) f.push(`note=${JSON.stringify(x.note)}`);
              if (x.changed & 0x20) f.push(`position=[${x.position.join(', ')}] angles=[${x.angles.join(', ')}]`);
              ID.modifies.push({ at, id: x.identifier, changed: x.changed, patchFields: !!(x.changed & 0x01) });
              lg(ses, `  ${at} -> FIXTURE MODIFY: ${describeId(x.identifier, S.latest)} ChangedFields=0x${x.changed.toString(16)}${f.length ? '; ' + f.join('; ') : ''}`);
            }
          }
          return;
        case CAEX.FixtureRemove: S.removes++; return;
        default:
          if (dm.layer === 'CAEX' && REQUESTS.has(dm.code)) {
            S.nacks++;
            lg(ses, `  ${at} -> request ${dm.sub} (${dm.code === CAEX.FixtureListRequest ? 'FixtureListRequest' : 'not served'}) from Capture; replying NACK Reason 3 (refused)`);
            ses.enqueue(`CAEX NACK (refused) to ${dm.sub}`, buildNack(3, HDR_OPTS));
          } else if (dm.layer === 'CAEX' && dm.code !== CAEX.NACK && dm.code !== CAEX.LeaveShow) {
            S.unsolicitedOther.push(dm.sub);
            lg(ses, `  ${at} -> CAEX ${dm.sub} is not a request we serve or track; no reply sent`);
          }
      }
    }
    sk.on('data', (d) => {
      ses.rx += d.length;
      lg(ses, `  ${since()} TCP chunk ${d.length} bytes (total ${ses.rx})`);
      const { messages, events } = ses.framer.push(d);
      events.forEach((e) => lg(ses, `    ${e}`));
      for (const m of messages) {
        ses.msgCount++;
        lg(ses, `  ${since()} RECV message #${ses.msgCount}: ${m.length} bytes, layer="${fourcc(m, 16)}"` +
          `${fourcc(m, 16) === 'PINF' ? ` sub="${fourcc(m, 20)}"` : ''}`);
        lg(ses, `    hex(first 256): ${hexOf(m, 256)}${m.length > 256 ? ' ...' : ''}`);
        const dm = decodeMessage(m, '    ', { maxFixtures: synced ? 0 : 20 });
        dm.lines.forEach((l) => lg(ses, l));
        if (synced) handleSync(m, dm);
        if (dm.code === CAEX.EnterShow) { ses.sawEnterShow = true; ses.onEnterShow(); }
        if (dm.code === CAEX.FixtureList) ses.sawFixtureList = true;
      }
      if (ses.framer.pending) lg(ses, `    (${ses.framer.pending} byte(s) buffered, waiting for the rest of a message)`);
    });
    sk.on('end', () => { ses.closedByPeer = true; lg(ses, `  ${since()} peer sent FIN`); });
    sk.on('error', (e) => lg(ses, `  ${since()} socket error: ${errStr(e)}`));
    sk.on('close', (hadErr) => { ses.closedByPeer = ses.closedByPeer || false; ses.closed = true; lg(ses, `  ${since()} socket closed (hadError=${hadErr})`); });
    return ses;
  };

  const primary = makeSession(isLink ? 'out' : '', sock);
  sessions.unshift(primary);
  const { S } = primary;
  const enqueue = primary.enqueue, send = primary.send;

  out('');
  out(`== Session (${PHASE}) ==`);
  const sessionStart = Date.now();
  if (PHASE !== 'observe') await enqueue('PINF/PNam', buildPNam(PROBE_NAME, HDR_OPTS));
  if (synced) out('  waiting for Capture (it sends EnterShow after it has received our PNam)...');
  if (PHASE === 'caex') {
    let sent = 0;
    const requestFixturesCaex = async (why) => { sent++; await send(`CAEX FixtureListRequest #${sent} (${why})`, buildFixtureListRequest(HDR_OPTS)); };
    primary.onEnterShow = () => { if (sent < 3 && !primary.sawFixtureList) requestFixturesCaex('after Capture sent EnterShow'); };
    await sleep(500);
    await requestFixturesCaex('after hello');
    setTimeout(() => { if (!primary.sawFixtureList && sent < 3 && !primary.closedByPeer) requestFixturesCaex('retry: no FixtureList after 5 s'); }, 5000);
  }
  let rereq = null;
  if (isLink || isIdentify) {
    rereq = setInterval(() => {
      for (const ses of sessions) if (!ses.closing && !ses.closed && !ses.sk.destroyed) ses.requestFixtures(`periodic re-request every ${REREQUEST_MS / 1000} s`);
    }, REREQUEST_MS);
  }
  await sleep(Math.max(0, sessionStart + DURATION_MS - Date.now()));

  out('');
  if (rereq) clearInterval(rereq);
  if (synced) {
    for (const ses of sessions) { ses.closing = true; ses.S.timers.forEach(clearTimeout); }
    await Promise.all(sessions.map((s) => s.chain));
    for (const ses of sessions) {
      if (ses.S.weEntered && !ses.closedByPeer && !ses.sk.destroyed) { await ses.send('CAEX LeaveShow (ours)', buildLeaveShow(HDR_OPTS)); ses.S.weLeft = true; }
      else lg(ses, `  LeaveShow not sent (${ses.S.weEntered ? 'connection already closed' : 'we never sent EnterShow'})`);
    }
    if (sessions.some((s) => s.S.weLeft)) await sleep(500);
    out(isLink ? '== Link summary ==' : '== Sync summary ==');
    out(`  GetLaserFeedList requests: ${S.laserRequests} (replies sent: ${S.laserReplies}); Capture EnterShow messages: ${S.captureEnterShow}; our EnterShow sent: ${S.weEntered}; FixtureListRequests sent: ${S.fixtureRequests}`);
    out(`  FixtureList messages received: ${S.fixtureLists}${S.latest ? ` (latest: ${S.latest.fixtures.length} fixture(s))` : ''}; NACKs sent: ${S.nacks}; FixtureModify: ${S.modifies}; FixtureRemove: ${S.removes}; other CAEX ignored: ${S.unsolicitedOther.join(', ') || 'none'}`);
    out(`  FixtureSelection events: ${S.selections.length}`);
    S.selections.forEach((x) => out(`    ${x.at}  ${x.ids.join('; ') || '(empty)'}`));
    if (!S.captureEnterShow) out('  Capture never sent EnterShow in this run.');
    if (isLink) {
      out(`  Console announcements: ${announcer.rounds} round(s), ${announcer.ok} send(s) ok, ${announcer.fail} failed${opt('--announce-dest') ? ` (to ${opt('--announce-dest')} only)` : ''}`);
      out(`  Inbound TCP connections from Capture: ${inboundCount}`);
      for (const ses of sessions) {
        const x = ses.S;
        out(`  connection ${ses.tag}: ${x.fixtureLists} FixtureList(s), ${x.listsWithPatched} with at least one Patched=1 (most in one list: ${x.maxPatched}${x.firstPatchedAt ? `; first at ${x.firstPatchedAt}` : ''}); FixtureListRequests sent: ${x.fixtureRequests}; messages received: ${ses.msgCount}`);
      }
      const any = sessions.some((x) => x.S.maxPatched > 0);
      out(`  Patched=1 seen in any FixtureList: ${any ? 'YES' : 'NO'}`);
    }
    if (isIdentify) {
      const first = ID.first, ver = ID.reports.find((r) => r.kind === 'verify');
      const last = ID.reports.at(-1) ?? null;
      const everFilled = [first, ...ID.reports].filter(Boolean).some((r) => r.st.filledRows.length);
      const changes = ID.reports.filter((r) => r.kind === 'periodic' && r.changes.length);
      out('== Identify summary ==');
      out(`  fixtures in the first FixtureList: ${first ? first.fx.length : 0}; with a usable CaptureInstanceId: ${ID.items.length}; not identified: ${ID.skipped.length}; already carrying an identifier before ours: ${first ? first.st.identified.length : 0}`);
      out(`  FixtureIdentify sent: ${ID.sent ? `YES, ${ID.items.length} entr${ID.items.length === 1 ? 'y' : 'ies'}, identifiers ${IDENTIFY_BASE} + list index, at ${ID.sentAt}` : `NO${ID.notSentReason ? ' (' + ID.notSentReason + ')' : first ? '' : ' (no FixtureList was received)'}`}${ID.refused ? `; refused by the allowlist: ${ID.refused}` : ''}`);
      if (ver) {
        out(`  identified count after FixtureIdentify (list #${ver.n} at ${ver.at}): ${ver.st.identified.length} of ${ver.st.total} fixture(s) carry an identifier other than 0xffffffff`);
        out(`  match our map: ${ver.st.matched.length} of ${ID.items.length}; mismatching: ${ver.st.mismatched.length}`);
        out(`  Patched/Universe/UniverseChannel filled after FixtureIdentify: ${ver.st.filledRows.length ? 'YES (' + ver.st.filledRows.length + ' fixture(s))' : 'NO'} (first list: ${first.st.filledRows.length})`);
        ver.st.filledRows.slice(0, 50).forEach((f) => out(`    ${filledRow(f)}`));
      } else out(ID.sent ? '  identified count after FixtureIdentify: NOT VERIFIED (no FixtureList arrived after the verification request)' : '  identified count after FixtureIdentify: n/a (nothing was sent)');
      if (last && last.kind === 'periodic') out(`  last FixtureList (#${last.n} at ${last.at}): ${last.st.identified.length} identified, ${last.st.matched.length} matching our map, ${last.st.filledRows.length} with patch fields filled`);
      out(`  FixtureList messages: ${ID.lists}; later lists with a change in identifiers or patch fields: ${changes.length}`);
      changes.slice(0, 10).forEach((r) => out(`    list #${r.n} at ${r.at}: ${r.changes.length} change(s), first: ${r.changes[0]}`));
      out(`  patch fields seen in any FixtureList or FixtureModify: ${everFilled || ID.modifies.some((m) => m.patchFields) ? 'YES' : 'NO'}`);
      out(`  FixtureSelection events: ${S.selections.length}`);
      S.selections.forEach((x) => out(`    ${x.at}  ${x.ids.join('; ') || '(empty)'}`));
      out(`  FixtureModify events: ${S.modifies} (items decoded: ${ID.modifies.length}; with patch fields: ${ID.modifies.filter((m) => m.patchFields).length})`);
      ID.modifies.slice(0, 50).forEach((m) => out(`    ${m.at}  id=${hex8(m.id)} ChangedFields=0x${m.changed.toString(16)}${m.patchFields ? ' (patch fields)' : ''}`));
      out(`  LeaveShow sent: ${S.weLeft ? 'yes' : 'no'}`);
    }
  }
  out(`== Summary ==\n  ${primary.msgCount} CITP message(s) received${isLink ? ' on the outbound connection' : ''}, ${primary.rx} byte(s) total; peer closed first: ${primary.closedByPeer}` +
    (PHASE === 'caex' ? `; EnterShow seen: ${primary.sawEnterShow}; FixtureList seen: ${primary.sawFixtureList}` : ''));
  if (primary.framer.pending) out(`  ${primary.framer.pending} trailing byte(s) never completed a message: ${hexOf(primary.framer.buf, 64)}`);
  // clean close
  stopAnnouncing();
  for (const ses of sessions) {
    await new Promise((res) => { try { ses.sk.end(() => res()); } catch { res(); } setTimeout(res, 1000); });
    ses.sk.destroy();
  }
  if (tcpServer) await new Promise((r) => { tcpServer.close(() => r()); setTimeout(r, 500); });
  out('  closed connection');
  return 0;
}

let code = 0;
try { code = await main(); } catch (e) { out(`FATAL: ${e.stack}`); code = 1; }
fs.mkdirSync(REPORT_DIR, { recursive: true });
const file = path.join(REPORT_DIR, `citp-${PHASE}.txt`);
const hasTarget = lines[0] && lines[0].startsWith('Target: ');
fs.writeFileSync(file, `Phase: ${PHASE}\n${hasTarget ? '' : 'Target: (not connected)\n'}` + lines.join('\n') + '\n');
console.log(`\nreport: ${file}`);
process.exit(code);
