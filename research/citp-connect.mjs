// CITP TCP probe: connects to Capture's CITP listening port as a client and logs what Capture sends.
//
//   node research/citp-connect.mjs [--observe]   (default) connect, send NOTHING, log 20 s
//   node research/citp-connect.mjs --hello        connect, send one PINF/PNam, log 30 s
//   node research/citp-connect.mjs --caex         --hello, then CAEX FixtureListRequest; decode FixtureList
//
// Read-only toward the show: the only messages ever sent are PINF/PNam (name announcement) and the CAEX
// FixtureListRequest (0x00020200). Nothing that changes the show, patch, selection or DMX is built anywhere.
// EnterShow is deliberately NOT sent (it declares a show on our side and is not a read request).
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
import {
  CAEX, CitpFramer, buildFixtureListRequest, buildPNam, decodeMessage, fourcc, hexOf,
} from './lib/citp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const PHASE = flag('--caex') ? 'caex' : flag('--hello') ? 'hello' : 'observe';
const DEFAULT_MS = { observe: 20000, hello: 30000, caex: 30000 }[PHASE];
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
  out(PHASE === 'observe' ? 'Sends: NOTHING.' : PHASE === 'hello' ? 'Sends: one PINF/PNam ("' + PROBE_NAME + '").' : 'Sends: PINF/PNam, then CAEX FixtureListRequest (0x00020200) only.');
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
  const send = (label, buf) => new Promise((res) => {
    out(`  ${since()} SEND ${label} (${buf.length} bytes): ${hexOf(buf)}`);
    decodeMessage(buf, '      ').lines.forEach(out);
    sock.write(buf, (e) => { if (e) out(`  send error: ${errStr(e)}`); res(); });
  });
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
      const dm = decodeMessage(m);
      dm.lines.forEach(out);
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
  if (PHASE !== 'observe') await send('PINF/PNam', buildPNam(PROBE_NAME, HDR_OPTS));
  if (PHASE === 'caex') {
    let sent = 0;
    const requestFixtures = async (why) => { sent++; await send(`CAEX FixtureListRequest #${sent} (${why})`, buildFixtureListRequest(HDR_OPTS)); };
    onEnterShow = () => { if (sent < 3 && !sawFixtureList) requestFixtures('after Capture sent EnterShow'); };
    await sleep(500);
    await requestFixtures('after hello');
    setTimeout(() => { if (!sawFixtureList && sent < 3 && !closedByPeer) requestFixtures('retry: no FixtureList after 5 s'); }, 5000);
  }
  await sleep(Math.max(0, sessionStart + DURATION_MS - Date.now()));

  out('');
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
