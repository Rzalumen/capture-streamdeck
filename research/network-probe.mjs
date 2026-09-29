// Read-only network probe for Capture: OSC (UDP 4004) ping + passive CITP listen (UDP 4809 multicast).
// Writes reports/network-report.txt. Takes ~20 s.
// Sends NOTHING on 4809 and opens NO TCP connections. OSC test sends two UDP messages per target to port 4004.

// Network probe for Capture: OSC (UDP 4004) ping + CITP (UDP 4809 multicast).
//
//   node research/network-probe.mjs              passive (default): sends only the two OSC UDP messages per
//                                                target on port 4004; CITP is receive-only, 30 s.
//   node research/network-probe.mjs --announce   ALSO announces a fake lighting console over CITP PINF/PLoc
//                                                (both multicast groups, every interface, 1/s for 30 s) and
//                                                listens on an ephemeral TCP port. Observation only: nothing
//                                                is ever written to an inbound TCP connection.
//
// Reports: reports/network-report.txt (passive) or reports/network-report-announce.txt (--announce).
//
// CITP wire format used here: CITP header + PINF/PLoc as in CITP 1.0 (little-endian; header = Cookie "CITP",
// VersionMajor, VersionMinor, Reserved[2], MessageSize u32, MessagePartCount u16, MessagePart u16,
// ContentType u32; PLoc = ListeningTCPPort u16, Type/Name/State as null-terminated ucs1 strings;
// multicast UDP 4809 on 224.0.0.180 (CITP 1.0) and 239.224.0.180 (later versions)).
// SPEC PROVENANCE: the base CITP specification (linked from https://www.capture.se/Support/Developers to
// https://bitbucket.org/lars_wernlund/citp, also http://www.citp-protocol.org) could NOT be fetched in the
// session that wrote this (robots.txt disallows automated access). These layouts were taken from two
// independent open-source implementations of CITP 1.0 (jwarwick/citp-lib and puremediaserver
// CITPDefines.h) and cross-checked against Capture's CAEX spec F (2020-07-03), which only references the
// base header. Treat bytes 6-7 (Reserved in 1.0; RequestIndex in later versions) as unverified; every
// packet's raw hex is logged so the decode can be checked by eye against the real spec.

import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = path.join(ROOT, 'reports');
const ANNOUNCE = process.argv.slice(2).includes('--announce');
const OSC_PORT = 4004;
const OSC_LISTEN_MS = 3000;
const CITP_PORT = 4809;
const CITP_GROUPS = ['239.224.0.180', '224.0.0.180'];
const CITP_LISTEN_MS = 30000;
const ANNOUNCE_INTERVAL_MS = 1000;
const ANNOUNCE_NAME = 'capture-streamdeck probe';

const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexOf = (buf, n = buf.length) => [...buf.subarray(0, n)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const t0 = Date.now();
const since = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
const errStr = (e) => `code=${e.code} errno=${e.errno} syscall=${e.syscall} message=${e.message}`;

// ---------- OSC encode/decode ----------
const pad4 = (n) => (n + 3) & ~3;
function oscString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([b, Buffer.alloc(pad4(b.length + 1) - b.length)]);
}
const oscMessage = (address) => Buffer.concat([oscString(address), oscString(',')]); // no arguments

function readOscString(buf, pos) {
  let e = pos;
  while (e < buf.length && buf[e] !== 0) e++;
  if (e >= buf.length) throw new Error('unterminated OSC string');
  return { s: buf.toString('utf8', pos, e), next: pad4(e + 1) };
}

function decodeOsc(buf) {
  const head = readOscString(buf, 0);
  if (head.s === '#bundle') {
    const timetag = buf.length >= 16 ? buf.readBigUInt64BE(8) : null;
    const elements = [];
    let p = 16;
    while (p + 4 <= buf.length) {
      const sz = buf.readInt32BE(p); p += 4;
      if (sz < 0 || p + sz > buf.length) throw new Error(`bad bundle element size ${sz}`);
      elements.push(decodeOsc(buf.subarray(p, p + sz)));
      p += sz;
    }
    return { bundle: true, timetag, elements };
  }
  let pos = head.next;
  let tags = ',';
  if (pos < buf.length) { const t = readOscString(buf, pos); tags = t.s; pos = t.next; }
  const args = [];
  for (const c of tags.slice(1)) {
    switch (c) {
      case 'i': args.push({ t: 'i', v: buf.readInt32BE(pos) }); pos += 4; break;
      case 'f': args.push({ t: 'f', v: buf.readFloatBE(pos) }); pos += 4; break;
      case 's': case 'S': { const r = readOscString(buf, pos); args.push({ t: c, v: r.s }); pos = r.next; break; }
      case 'b': { const n = buf.readInt32BE(pos); args.push({ t: 'b', v: 'blob[' + n + ']:' + hexOf(buf.subarray(pos + 4, pos + 4 + Math.min(n, 64))) }); pos = pad4(pos + 4 + n); break; }
      case 'h': args.push({ t: 'h', v: buf.readBigInt64BE(pos) }); pos += 8; break;
      case 't': args.push({ t: 't', v: buf.readBigUInt64BE(pos) }); pos += 8; break;
      case 'd': args.push({ t: 'd', v: buf.readDoubleBE(pos) }); pos += 8; break;
      case 'c': args.push({ t: 'c', v: String.fromCharCode(buf.readUInt32BE(pos)) }); pos += 4; break;
      case 'r': args.push({ t: 'r', v: hexOf(buf.subarray(pos, pos + 4)) }); pos += 4; break;
      case 'm': args.push({ t: 'm', v: hexOf(buf.subarray(pos, pos + 4)) }); pos += 4; break;
      case 'T': args.push({ t: 'T', v: true }); break;
      case 'F': args.push({ t: 'F', v: false }); break;
      case 'N': args.push({ t: 'N', v: null }); break;
      case 'I': args.push({ t: 'I', v: 'Infinitum' }); break;
      default: throw new Error(`unknown OSC type tag '${c}'`);
    }
  }
  return { address: head.s, typeTags: tags, args };
}

function fmtOsc(m, indent = '      ') {
  if (m.bundle) {
    return [`${indent}#bundle timetag=${m.timetag}`, ...m.elements.map((e) => fmtOsc(e, indent + '  '))].join('\n');
  }
  const a = m.args.map((x) => `${x.t}:${typeof x.v === 'string' ? JSON.stringify(x.v) : String(x.v)}`).join(', ');
  return `${indent}address=${m.address} typetags=${JSON.stringify(m.typeTags)} args=[${a}]`;
}

// ---------- 1. interfaces ----------
function localIPv4() {
  const res = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' || i.family === 4) res.push({ name, address: i.address, netmask: i.netmask, internal: i.internal, mac: i.mac });
    }
  }
  return res;
}

// ---------- 3. OSC ----------
async function oscTest(targets) {
  out(`Ports/targets: UDP ${OSC_PORT}. Messages per target: "/ping" (type tag ","), "/view/live/getStatus" (type tag ",").`);
  out(`Targets (${targets.length}): ${targets.join(', ')}`);
  const sock = dgram.createSocket('udp4');
  const replies = [];
  sock.on('error', (e) => out(`  socket error: ${e.code || ''} ${e.message}`));
  sock.on('message', (msg, rinfo) => {
    replies.push({ rinfo, at: since() });
    out(`  reply ${since()} from ${rinfo.address}:${rinfo.port}  len=${msg.length}`);
    out(`    hex: ${hexOf(msg, 128)}${msg.length > 128 ? ' ...' : ''}`);
    try { out(fmtOsc(decodeOsc(msg))); } catch (e) { out(`      OSC decode failed: ${e.message}`); }
  });
  await new Promise((res) => sock.bind(0, res));
  out(`Sending from ${sock.address().address}:${sock.address().port}`);
  const msgs = ['/ping', '/view/live/getStatus'];
  for (const target of targets) {
    for (const m of msgs) {
      await new Promise((res) => {
        sock.send(oscMessage(m), OSC_PORT, target, (err) => {
          out(`  sent ${m} -> ${target}:${OSC_PORT}${err ? `  SEND ERROR ${err.code || ''} ${err.message}` : ''}`);
          res();
        });
      });
    }
  }
  out(`Listening ${OSC_LISTEN_MS / 1000} s for replies...`);
  await sleep(OSC_LISTEN_MS);
  sock.close();
  out('');
  out('Per-target result (replies whose source address equals the target):');
  for (const target of targets) {
    const n = replies.filter((r) => r.rinfo.address === target).length;
    out(`  ${target}:${OSC_PORT}  ${n ? `${n} repl${n === 1 ? 'y' : 'ies'}` : 'no reply'}`);
  }
  const other = replies.filter((r) => !targets.includes(r.rinfo.address));
  if (other.length) out(`  (${other.length} repl${other.length === 1 ? 'y' : 'ies'} came from addresses that are not in the target list; see above)`);
}

// ---------- 4. CITP ----------
const fourcc = (b, o) => (b.length >= o + 4 ? b.toString('latin1', o, o + 4).replace(/[^\x20-\x7e]/g, '.') : null);
function ucs1z(buf, pos) {
  let e = pos;
  while (e < buf.length && buf[e] !== 0) e++;
  if (e >= buf.length) return null;
  return { s: buf.toString('latin1', pos, e), next: e + 1 };
}

/** Build a CITP 1.0 PINF/PLoc datagram. */
function buildPLoc(tcpPort, type, name, state) {
  const strs = Buffer.concat([type, name, state].map((x) => Buffer.concat([Buffer.from(x, 'latin1'), Buffer.from([0])])));
  const total = 20 + 4 + 2 + strs.length;
  const b = Buffer.alloc(total);
  b.write('CITP', 0, 'latin1');
  b[4] = 1; b[5] = 0;              // VersionMajor, VersionMinor
  b[6] = 0; b[7] = 0;              // Reserved[2]
  b.writeUInt32LE(total, 8);       // MessageSize (whole message incl. header)
  b.writeUInt16LE(1, 12);          // MessagePartCount
  b.writeUInt16LE(0, 14);          // MessagePart
  b.write('PINF', 16, 'latin1');   // ContentType (layer)
  b.write('PLoc', 20, 'latin1');   // PINF content type
  b.writeUInt16LE(tcpPort, 24);    // ListeningTCPPort
  strs.copy(b, 26);
  return b;
}

/** Decode one CITP message (header + known layers). Returns log lines (no trailing hex). */
function decodeCitp(msg, indent = '    ') {
  const o = [];
  if (msg.length < 20) { o.push(`${indent}CITP header truncated (${msg.length} bytes < 20)`); return o; }
  const size = msg.readUInt32LE(8);
  o.push(`${indent}CITP header: version ${msg[4]}.${msg[5]}, bytes6-7=${hexOf(msg.subarray(6, 8))} (Reserved in 1.0), MessageSize=${size}` +
    `${size === msg.length ? '' : ` (!= ${msg.length} bytes actually present)`}, MessagePartCount=${msg.readUInt16LE(12)}, MessagePart=${msg.readUInt16LE(14)}`);
  const layer = fourcc(msg, 16);
  o.push(`${indent}content type (layer): "${layer}"`);
  if (layer === 'PINF') {
    const sub = fourcc(msg, 20);
    o.push(`${indent}PINF content type: "${sub}"`);
    try {
      if (sub === 'PLoc' && msg.length >= 26) {
        const port = msg.readUInt16LE(24);
        const type = ucs1z(msg, 26);
        const name = type && ucs1z(msg, type.next);
        const state = name && ucs1z(msg, name.next);
        o.push(`${indent}PLoc: ListeningTCPPort=${port} Type=${JSON.stringify(type && type.s)} Name=${JSON.stringify(name && name.s)} State=${JSON.stringify(state && state.s)}`);
        if (!state) o.push(`${indent}PLoc: Type/Name/State did not all parse (see hex)`);
        else if (state.next !== msg.length) o.push(`${indent}PLoc: ${msg.length - state.next} extra byte(s) after State: ${hexOf(msg.subarray(state.next))}`);
      } else if (sub === 'PNam') {
        const name = ucs1z(msg, 24);
        o.push(`${indent}PNam: Name=${JSON.stringify(name && name.s)}`);
      }
    } catch (e) { o.push(`${indent}PINF decode failed: ${e.message}`); }
  } else {
    o.push(`${indent}layer content not decoded (only the base header and PINF are implemented); bytes 20-27: ${hexOf(msg.subarray(20, 28))}`);
  }
  return o;
}

const peers = new Map(); // "src|type|name|port" -> count (PLoc only)
function notePeer(rinfo, msg) {
  if (msg.length >= 26 && msg.toString('latin1', 0, 4) === 'CITP' && fourcc(msg, 16) === 'PINF' && fourcc(msg, 20) === 'PLoc') {
    const type = ucs1z(msg, 26), name = type && ucs1z(msg, type.next), state = name && ucs1z(msg, name.next);
    const k = `${rinfo.address}:${rinfo.port} port=${msg.readUInt16LE(24)} type=${JSON.stringify(type && type.s)} name=${JSON.stringify(name && name.s)} state=${JSON.stringify(state && state.s)}`;
    peers.set(k, (peers.get(k) || 0) + 1);
  }
}

/** Passive listener on UDP 4809 (+ optional announcer and TCP observer). */
async function citpSession(ifaces) {
  out(`Mode: ${ANNOUNCE ? 'ACTIVE (--announce)' : 'passive'}. Bind UDP ${CITP_PORT} (reuseAddr), join ${CITP_GROUPS.join(' and ')} on every local IPv4 interface, listen ${CITP_LISTEN_MS / 1000} s.`);
  out(ANNOUNCE
    ? `Announcing PINF/PLoc every ${ANNOUNCE_INTERVAL_MS / 1000} s to both groups on every interface; TCP listener is read-only (nothing is ever sent on a TCP connection).`
    : 'Nothing is sent on 4809; no TCP.');
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let count = 0, ownPkt = null, ownCount = 0;
  const local = new Set(ifaces.map((i) => i.address));
  sock.on('error', (e) => out(`  socket error: ${errStr(e)}`));
  sock.on('message', (msg, rinfo) => {
    count++;
    const own = ownPkt && msg.equals(ownPkt) && local.has(rinfo.address);
    if (own && ++ownCount > 4) return; // only the first 4 looped-back copies of our own announcement are logged in full
    out(`  packet #${count} ${since()} from ${rinfo.address}:${rinfo.port}  len=${msg.length}${own ? '  [our own announcement, looped back]' : ''}`);
    out(`    hex(first 128): ${hexOf(msg, 128)}${msg.length > 128 ? ' ...' : ''}`);
    if (msg.length >= 4 && msg.toString('latin1', 0, 4) === 'CITP') { decodeCitp(msg).forEach(out); if (!own) notePeer(rinfo, msg); }
    else out('    (not CITP: bytes 0-3 are not "CITP")');
  });
  let bound = false;
  await new Promise((res) => {
    const onErr = (e) => { out(`  BIND FAILED: ${errStr(e)}`); res(); };
    sock.once('error', onErr);
    sock.bind(CITP_PORT, () => { sock.removeListener('error', onErr); bound = true; res(); });
  });
  if (bound) {
    out(`  bound to ${sock.address().address}:${sock.address().port}`);
    for (const g of CITP_GROUPS) for (const i of ifaces) {
      try { sock.addMembership(g, i.address); out(`  joined ${g} on ${i.name} (${i.address}): ok`); }
      catch (e) { out(`  join ${g} on ${i.name} (${i.address}) FAILED: ${errStr(e)}`); }
    }
  } else out('  (listening skipped: socket did not bind)');

  // ---- optional active part ----
  let server = null; const conns = new Set(); let connCount = 0;
  let sendSock = sock;
  if (ANNOUNCE) {
    if (!bound) { sendSock = dgram.createSocket('udp4'); await new Promise((r) => sendSock.bind(0, r)); out(`  announcing from ephemeral socket ${sendSock.address().port} (4809 not bound)`); }
    server = net.createServer({ allowHalfOpen: true }, (c) => {
      const id = ++connCount; conns.add(c);
      out(`  TCP #${id} ${since()} INBOUND CONNECTION from ${c.remoteAddress}:${c.remotePort} to ${c.localAddress}:${c.localPort}`);
      let acc = Buffer.alloc(0), total = 0;
      c.on('data', (d) => {
        total += d.length;
        out(`  TCP #${id} ${since()} ${d.length} bytes received (total ${total})`);
        out(`    hex: ${hexOf(d)}`);
        acc = Buffer.concat([acc, d]);
        while (acc.length >= 20 && acc.toString('latin1', 0, 4) === 'CITP') {
          const size = acc.readUInt32LE(8);
          if (size < 20 || size > acc.length) { if (size >= 20) out(`    (CITP message of ${size} bytes, only ${acc.length} buffered so far)`); break; }
          out(`    CITP message ${size} bytes:`); decodeCitp(acc.subarray(0, size), '      ').forEach(out);
          acc = acc.subarray(size);
        }
        if (acc.length && acc.toString('latin1', 0, Math.min(4, acc.length)) !== 'CITP'.slice(0, Math.min(4, acc.length))) out(`    (${acc.length} buffered byte(s) not starting with "CITP")`);
      });
      c.on('end', () => out(`  TCP #${id} ${since()} remote sent FIN`));
      c.on('close', () => { conns.delete(c); out(`  TCP #${id} ${since()} closed`); });
      c.on('error', (e) => out(`  TCP #${id} error: ${errStr(e)}`));
    });
    server.on('error', (e) => out(`  TCP server error: ${errStr(e)}`));
    await new Promise((res) => server.listen(0, '0.0.0.0', res));
    const tcpPort = server.address().port;
    out(`  TCP listener on 0.0.0.0:${tcpPort}`);
    ownPkt = buildPLoc(tcpPort, 'LightingConsole', ANNOUNCE_NAME, 'Running');
    out(`  announcement (${ownPkt.length} bytes): ${hexOf(ownPkt)}`);
    decodeCitp(ownPkt, '    ').forEach(out);
  }

  const start = Date.now();
  let tick = 0, sentOk = 0, sentFail = 0; const seenErr = new Set();
  while (Date.now() - start < CITP_LISTEN_MS) {
    if (ANNOUNCE) {
      tick++;
      let ok = 0, fail = 0;
      for (const i of ifaces) {
        try { sendSock.setMulticastInterface(i.address); } catch (e) { const k = `iface ${i.name} ${errStr(e)}`; if (!seenErr.has(k)) { seenErr.add(k); out(`  setMulticastInterface(${i.address}) FAILED: ${errStr(e)}`); } fail += CITP_GROUPS.length; continue; }
        for (const g of CITP_GROUPS) {
          await new Promise((res) => sendSock.send(ownPkt, CITP_PORT, g, (err) => {
            if (err) { fail++; const k = `${i.name}|${g}|${err.code}`; if (!seenErr.has(k)) { seenErr.add(k); out(`  send ${g}:${CITP_PORT} via ${i.name} (${i.address}) FAILED: ${errStr(err)}`); } } else ok++;
            res();
          }));
        }
      }
      sentOk += ok; sentFail += fail;
      if (tick === 1) out(`  ${since()} announce round 1: ${ok} sends ok, ${fail} failed (${ifaces.length} interfaces x ${CITP_GROUPS.length} groups)`);
    }
    await sleep(Math.max(0, start + tick * ANNOUNCE_INTERVAL_MS - Date.now()) || (ANNOUNCE ? 0 : Math.min(1000, CITP_LISTEN_MS)));
    if (!ANNOUNCE) tick++;
  }
  out(`  done: ${count} UDP packet(s) received in ${CITP_LISTEN_MS / 1000} s` +
    (ANNOUNCE ? `; ${tick} announce rounds, ${sentOk} sends ok, ${sentFail} failed; ${connCount} inbound TCP connection(s)` : ''));
  if (ANNOUNCE) out(`  (of those, ${ownCount} were our own announcements looped back; only the first 4 are shown above)`);
  out('  distinct CITP PLoc peers seen (excluding our own announcements):');
  if (!peers.size) out('    (none)');
  for (const [k, n] of peers) out(`    x${n}  ${k}`);

  // clean shutdown
  for (const c of conns) { try { c.destroy(); } catch { /* ignore */ } }
  if (server) await new Promise((r) => server.close(() => r()));
  try { sock.close(); } catch { /* ignore */ }
  if (sendSock !== sock) { try { sendSock.close(); } catch { /* ignore */ } }
  out('  closed all sockets');
}

// ---------- main ----------
async function main() {
  out(`Network probe ${new Date().toISOString()}  node ${process.version}  ${process.platform}/${process.arch}`);
  out(`--announce used: ${ANNOUNCE ? 'YES (active CITP announcement + TCP listener, observation only)' : 'NO (passive)'}`);
  out('');

  out('== 1. Local IPv4 interfaces (os.networkInterfaces) ==');
  const ifaces = localIPv4();
  if (!ifaces.length) out('  (none reported)');
  ifaces.forEach((i) => out(`  ${i.name}  ${i.address}  netmask ${i.netmask}  ${i.internal ? 'internal' : 'external'}  mac ${i.mac}`));
  out('');

  out('== 2. lsof -nP -a -c Capture -i ==');
  const ls = spawnSync('lsof', ['-nP', '-a', '-c', 'Capture', '-i'], { encoding: 'utf8' });
  let lsofText = '';
  if (ls.error) {
    out(`  could not run lsof: ${ls.error.code || ''} ${ls.error.message}`);
  } else {
    lsofText = ls.stdout || '';
    if (lsofText.trim()) out(lsofText.replace(/\n$/, ''));
    else {
      out(`  lsof exit status ${ls.status}, no rows: no process matching command "Capture*" with network sockets was listed. Capture does not appear to be running.`);
      if (ls.stderr && ls.stderr.trim()) out(`  lsof stderr: ${ls.stderr.trim()}`);
    }
    const pg = spawnSync('pgrep', ['-il', '^Capture'], { encoding: 'utf8' });
    out(`  pgrep -il ^Capture: ${pg.error ? `could not run (${pg.error.code})` : (pg.stdout.trim() || `(no output, exit ${pg.status})`)}`);
  }
  out('');

  // OSC targets: addresses bound to :4004 (UDP) in lsof + every local IPv4 + 127.0.0.1
  const bound = [];
  for (const l of lsofText.split('\n')) {
    if (!/\bUDP\b/.test(l)) continue;
    const m = l.match(/UDP\s+(\S+?):4004(?:\s|$)/);
    if (m) bound.push(m[1]);
  }
  const targets = new Set();
  const skipped = [];
  for (const b of bound) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(b)) targets.add(b);
    else if (b !== '*') skipped.push(b);
  }
  ifaces.forEach((i) => targets.add(i.address));
  targets.add('127.0.0.1');

  out('== 3. OSC test (UDP) ==');
  out(`Addresses bound to :4004 per lsof: ${bound.length ? bound.join(', ') : '(none parsed)'}${skipped.length ? `  (not IPv4, not targeted: ${skipped.join(', ')})` : ''}`);
  await oscTest([...targets]);
  out('');

  out(`== 4. CITP ${ANNOUNCE ? 'announce + listen' : 'passive listen'} ==`);
  await citpSession(ifaces);
  out('');
  out(`Finished ${since()}`);
}

fs.mkdirSync(REPORTS, { recursive: true });
try { await main(); } catch (e) { out(`FATAL: ${e.stack}`); process.exitCode = 1; }
const file = path.join(REPORTS, ANNOUNCE ? 'network-report-announce.txt' : 'network-report.txt');
fs.writeFileSync(file, lines.join('\n') + '\n');
console.log(`\nreport: ${file}`);
process.exit(process.exitCode || 0);
