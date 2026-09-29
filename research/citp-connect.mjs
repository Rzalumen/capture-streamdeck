// CITP TCP probe: connects to Capture's CITP listening port as a client and logs what Capture sends.
//
//   node research/citp-connect.mjs [--observe]   (default) connect, send NOTHING, log 20 s
//   node research/citp-connect.mjs --hello        connect, send one PINF/PNam, log 30 s
//   node research/citp-connect.mjs --caex         --hello, then CAEX FixtureListRequest; decode FixtureList
//   node research/citp-connect.mjs --sync         CAEX spec F show-sync handshake, 45 s (see below)
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
// Test/dev options: --host <ip> --port <n> (skip discovery), --duration <s> (override log time),
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
  CAEX, CitpFramer, buildEnterShow, buildFixtureListRequest, buildLaserFeedList, buildLeaveShow, buildNack, buildPNam,
  decodeMessage, formatFixtureTables, fourcc, hexOf, isAllowedOutgoing,
} from './lib/citp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const PHASE = flag('--sync') ? 'sync' : flag('--caex') ? 'caex' : flag('--hello') ? 'hello' : 'observe';
const DEFAULT_MS = { observe: 20000, hello: 30000, caex: 30000, sync: 45000 }[PHASE];
const DURATION_MS = opt('--duration') ? Math.round(parseFloat(opt('--duration')) * 1000) : DEFAULT_MS;
const REPORT_DIR = opt('--report-dir') ? path.resolve(opt('--report-dir')) : path.join(ROOT, 'reports');
const [VMAJ, VMIN] = (opt('--citp-version') || '1.0').split('.').map(Number);
const HDR_OPTS = { major: VMAJ, minor: VMIN };
const GROUPS = ['239.224.0.180', '224.0.0.180'];
const CITP_UDP = 4809;
const DISCOVER_MS = 5000;
const PROBE_NAME = 'capture-streamdeck probe';

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

async function main() {
  out(`CITP connect probe   phase=${PHASE}   ${new Date().toISOString()}   node ${process.version} ${process.platform}/${process.arch}`);
  out(`CITP header version used for anything we send: ${VMAJ}.${VMIN};  log duration: ${DURATION_MS / 1000} s`);
  out(PHASE === 'observe' ? 'Sends: NOTHING.' : PHASE === 'hello' ? 'Sends: one PINF/PNam ("' + PROBE_NAME + '").'
    : PHASE === 'sync' ? 'Sends (only): PINF/PNam, LaserFeedList (empty), EnterShow, FixtureListRequest, NACK (Reason 3), LeaveShow.'
    : 'Sends: PINF/PNam, then CAEX FixtureListRequest (0x00020200) only.');
  out('');

  const ifaces = localIPv4();
  let port = opt('--port') ? Number(opt('--port')) : null;
  const hosts = [];
  let fallbackPorts = [];
  if (opt('--host')) hosts.push(opt('--host'));

  if (!port) {
    out(`== Discovery: UDP ${CITP_UDP}, up to ${DISCOVER_MS / 1000} s, first PLoc with Type="Visualizer" ==`);
    const found = await discover(ifaces);
    if (found) { port = found.port; out(`  using ListeningTCPPort ${port} from PLoc (announced by ${found.from})`); if (found.from) hosts.push(found.from); }
    else { out('  no Visualizer PLoc seen; falling back to lsof'); fallbackPorts = lsofTcpPorts(); }
    out('');
  }
  const ports = port ? [port] : fallbackPorts;
  if (!ports.length) { out('No CITP TCP port known (no PLoc received and lsof found no listening Capture TCP port). Nothing to connect to.'); return 1; }
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
  if (!sock) { out('Could not connect to any candidate.'); return 1; }
  lines.unshift(`Target: ${target.h}:${target.p}`); // shown at the top of the report

  // ---- session ----
  const framer = new CitpFramer();
  let rx = 0, msgCount = 0, sawEnterShow = false, sawFixtureList = false, closedByPeer = false;
  let closing = false;
  const send = (label, buf) => new Promise((res) => {
    if (!isAllowedOutgoing(buf)) { out(`  ${since()} REFUSED to send ${label}: not on the outgoing allowlist (${hexOf(buf, 32)})`); res(); return; }
    if (closing && !/LeaveShow/.test(label)) { out(`  ${since()} not sending ${label}: shutting down`); res(); return; }
    out(`  ${since()} SEND ${label} (${buf.length} bytes): ${hexOf(buf)}`);
    decodeMessage(buf, '      ').lines.forEach(out);
    sock.write(buf, (e) => { if (e) out(`  send error: ${errStr(e)}`); res(); });
  });
  // sends are queued so their order on the wire is the order they were decided in
  let sendChain = Promise.resolve();
  const enqueue = (label, buf) => (sendChain = sendChain.then(() => send(label, buf)));

  // --- sync state ---
  const S = { laserRequests: 0, laserReplies: 0, nacks: 0, captureEnterShow: 0, weEntered: false, weLeft: false, fixtureRequests: 0,
    fixtureLists: 0, latest: null, selections: [], modifies: 0, removes: 0, unsolicitedOther: [], timers: [] };
  const sourceKey = randomBytes(4).readUInt32LE(0);
  const REQUESTS = new Set([CAEX.GetLiveViewStatus, CAEX.GetLiveViewImage, CAEX.FixtureListRequest, CAEX.FixtureIdentify]);
  const requestFixtures = (why) => {
    if (S.fixtureRequests >= 6) { out(`  (not sending another FixtureListRequest: 6 already sent)`); return; }
    const n = ++S.fixtureRequests; const before = S.fixtureLists;
    enqueue(`CAEX FixtureListRequest #${n} (${why})`, buildFixtureListRequest(HDR_OPTS));
    S.timers.push(setTimeout(() => {
      if (S.fixtureLists === before && !closing && !S.retried?.has(n)) {
        (S.retried ||= new Set()).add(n);
        out(`  ${since()} no FixtureList within 5 s of request #${n}; sending one retry`);
        enqueue(`CAEX FixtureListRequest #${n}b (retry: no FixtureList within 5 s)`, buildFixtureListRequest(HDR_OPTS));
      }
    }, 5000));
  };
  function handleSync(m, dm) {
    const at = since();
    switch (dm.code) {
      case CAEX.GetLaserFeedList:
        S.laserRequests++;
        out(`  ${at} -> Capture asked GetLaserFeedList (#${S.laserRequests}); replying with an empty LaserFeedList (SourceKey 0x${sourceKey.toString(16).padStart(8, '0')}, FeedCount 0)`);
        S.laserReplies++; enqueue('CAEX LaserFeedList (empty)', buildLaserFeedList(sourceKey, [], HDR_OPTS));
        return;
      case CAEX.EnterShow:
        S.captureEnterShow++;
        out(`  ${at} -> Capture entered show ${JSON.stringify(dm.showName)}`);
        if (!S.weEntered) { S.weEntered = true; enqueue('CAEX EnterShow (ours)', buildEnterShow(PROBE_NAME, HDR_OPTS)); }
        requestFixtures('Capture entered a show while we are in a show');
        return;
      case CAEX.FixtureList:
        S.fixtureLists++; S.latest = dm.fixtures;
        out(`  ${at} -> FixtureList #${S.fixtureLists}: Type=${dm.fixtures.type} count=${dm.fixtures.count}${dm.fixtures.error ? ' DECODE ERROR: ' + dm.fixtures.error : ''}`);
        out('  ---- fixture tables (every fixture) ----');
        formatFixtureTables(dm.fixtures.fixtures).forEach(out);
        out('  ---- end fixture tables ----');
        return;
      case CAEX.FixtureSelection: {
        const names = (dm.selection || []).map((id) => {
          const f = S.latest && S.latest.fixtures.find((x) => x.identifier === id);
          return `0x${id.toString(16).padStart(8, '0')}${f ? ` (${f.manufacturer} ${f.name}, ch ${f.channel})` : ''}`;
        });
        S.selections.push({ at, ids: names });
        out(`  ${at} -> FIXTURE SELECTION: ${names.length ? names.join('; ') : '(empty selection)'}`);
        return;
      }
      case CAEX.FixtureModify: S.modifies++; return;
      case CAEX.FixtureRemove: S.removes++; return;
      default:
        if (dm.layer === 'CAEX' && REQUESTS.has(dm.code)) {
          S.nacks++;
          out(`  ${at} -> request ${dm.sub} (${dm.code === CAEX.FixtureListRequest ? 'FixtureListRequest' : 'not served'}) from Capture; replying NACK Reason 3 (refused)`);
          enqueue(`CAEX NACK (refused) to ${dm.sub}`, buildNack(3, HDR_OPTS));
        } else if (dm.layer === 'CAEX' && dm.code !== CAEX.NACK && dm.code !== CAEX.LeaveShow) {
          S.unsolicitedOther.push(dm.sub);
          out(`  ${at} -> CAEX ${dm.sub} is not a request we serve or track; no reply sent`);
        }
    }
  }
  let onEnterShow = () => {};

  sock.on('data', (d) => {
    rx += d.length;
    out(`  ${since()} TCP chunk ${d.length} bytes (total ${rx})`);
    const { messages, events } = framer.push(d);
    events.forEach((e) => out(`    ${e}`));
    for (const m of messages) {
      msgCount++;
      out(`  ${since()} RECV message #${msgCount}: ${m.length} bytes, layer="${fourcc(m, 16)}"` +
        `${fourcc(m, 16) === 'PINF' ? ` sub="${fourcc(m, 20)}"` : ''}`);
      out(`    hex(first 256): ${hexOf(m, 256)}${m.length > 256 ? ' ...' : ''}`);
      const dm = decodeMessage(m, '    ', { maxFixtures: PHASE === 'sync' ? 0 : 20 });
      dm.lines.forEach(out);
      if (PHASE === 'sync') handleSync(m, dm);
      if (dm.code === CAEX.EnterShow) { sawEnterShow = true; onEnterShow(); }
      if (dm.code === CAEX.FixtureList) sawFixtureList = true;
    }
    if (framer.pending) out(`    (${framer.pending} byte(s) buffered, waiting for the rest of a message)`);
  });
  sock.on('end', () => { closedByPeer = true; out(`  ${since()} peer sent FIN`); });
  sock.on('error', (e) => out(`  ${since()} socket error: ${errStr(e)}`));
  sock.on('close', (hadErr) => out(`  ${since()} socket closed (hadError=${hadErr})`));

  out('');
  out(`== Session (${PHASE}) ==`);
  const sessionStart = Date.now();
  if (PHASE !== 'observe') await enqueue('PINF/PNam', buildPNam(PROBE_NAME, HDR_OPTS));
  if (PHASE === 'sync') out('  waiting for Capture (it sends EnterShow after it has received our PNam)...');
  if (PHASE === 'caex') {
    let sent = 0;
    const requestFixturesCaex = async (why) => { sent++; await send(`CAEX FixtureListRequest #${sent} (${why})`, buildFixtureListRequest(HDR_OPTS)); };
    onEnterShow = () => { if (sent < 3 && !sawFixtureList) requestFixturesCaex('after Capture sent EnterShow'); };
    await sleep(500);
    await requestFixturesCaex('after hello');
    setTimeout(() => { if (!sawFixtureList && sent < 3 && !closedByPeer) requestFixturesCaex('retry: no FixtureList after 5 s'); }, 5000);
  }
  await sleep(Math.max(0, sessionStart + DURATION_MS - Date.now()));

  out('');
  if (PHASE === 'sync') {
    closing = true; S.timers.forEach(clearTimeout);
    await sendChain;
    if (S.weEntered && !closedByPeer && !sock.destroyed) {
      await send('CAEX LeaveShow (ours)', buildLeaveShow(HDR_OPTS)); S.weLeft = true;
      await sleep(500);
    } else out(`  LeaveShow not sent (${S.weEntered ? 'connection already closed' : 'we never sent EnterShow'})`);
    out('== Sync summary ==');
    out(`  GetLaserFeedList requests: ${S.laserRequests} (replies sent: ${S.laserReplies}); Capture EnterShow messages: ${S.captureEnterShow}; our EnterShow sent: ${S.weEntered}; FixtureListRequests sent: ${S.fixtureRequests}`);
    out(`  FixtureList messages received: ${S.fixtureLists}${S.latest ? ` (latest: ${S.latest.fixtures.length} fixture(s))` : ''}; NACKs sent: ${S.nacks}; FixtureModify: ${S.modifies}; FixtureRemove: ${S.removes}; other CAEX ignored: ${S.unsolicitedOther.join(', ') || 'none'}`);
    out(`  FixtureSelection events: ${S.selections.length}`);
    S.selections.forEach((x) => out(`    ${x.at}  ${x.ids.join('; ') || '(empty)'}`));
    if (!S.captureEnterShow) out('  Capture never sent EnterShow in this run.');
  }
  out(`== Summary ==\n  ${msgCount} CITP message(s) received, ${rx} byte(s) total; peer closed first: ${closedByPeer}` +
    (PHASE === 'caex' ? `; EnterShow seen: ${sawEnterShow}; FixtureList seen: ${sawFixtureList}` : ''));
  if (framer.pending) out(`  ${framer.pending} trailing byte(s) never completed a message: ${hexOf(framer.buf, 64)}`);
  // clean close
  await new Promise((res) => { sock.end(() => res()); setTimeout(res, 1000); });
  sock.destroy();
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
