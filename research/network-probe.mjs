// Read-only network probe for Capture: OSC (UDP 4004) ping + passive CITP listen (UDP 4809 multicast).
// Writes reports/network-report.txt. Takes ~20 s.
// Sends NOTHING on 4809 and opens NO TCP connections. OSC test sends two UDP messages per target to port 4004.

import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = path.join(ROOT, 'reports');
const OSC_PORT = 4004;
const OSC_LISTEN_MS = 3000;
const CITP_PORT = 4809;
const CITP_GROUP = '239.224.0.180';
const CITP_LISTEN_MS = 15000;

const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexOf = (buf, n = buf.length) => [...buf.subarray(0, n)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const t0 = Date.now();
const since = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

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

function decodeCitp(msg) {
  const o = [];
  if (msg.length < 20) { o.push(`    CITP header truncated (${msg.length} bytes < 20)`); return o; }
  o.push(`    CITP header: version ${msg[4]}.${msg[5]}, bytes6-7=0x${msg.readUInt16LE(6).toString(16).padStart(4, '0')} (reserved / request index), ` +
    `MessageSize=${msg.readUInt32LE(8)}, MessagePartCount=${msg.readUInt16LE(12)}, MessagePart=${msg.readUInt16LE(14)}`);
  const layer = fourcc(msg, 16);
  o.push(`    content type (layer): "${layer}"`);
  if (layer === 'PINF') {
    const sub = fourcc(msg, 20);
    o.push(`    PINF content type: "${sub}"`);
    try {
      if (sub === 'PLoc' && msg.length >= 26) {
        const port = msg.readUInt16LE(24);
        const type = ucs1z(msg, 26);
        const name = type && ucs1z(msg, type.next);
        const state = name && ucs1z(msg, name.next);
        o.push(`    PLoc: ListeningTCPPort=${port} Type=${JSON.stringify(type && type.s)} Name=${JSON.stringify(name && name.s)} State=${JSON.stringify(state && state.s)}`);
        if (!state) o.push('    PLoc: strings did not parse to the end (see hex)');
      } else if (sub === 'PNam') {
        const name = ucs1z(msg, 24);
        o.push(`    PNam: Name=${JSON.stringify(name && name.s)}`);
      }
    } catch (e) { o.push(`    PINF decode failed: ${e.message}`); }
  } else {
    o.push(`    next 4 bytes after content type at 20-23: "${fourcc(msg, 20)}"`);
  }
  return o;
}

async function citpListen(ifaces) {
  out(`Receive only. Bind UDP ${CITP_PORT} (reuseAddr), join ${CITP_GROUP}, listen ${CITP_LISTEN_MS / 1000} s. Nothing is sent; no TCP.`);
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let count = 0;
  sock.on('error', (e) => out(`  socket error: code=${e.code} errno=${e.errno} syscall=${e.syscall} message=${e.message}`));
  sock.on('message', (msg, rinfo) => {
    count++;
    out(`  packet #${count} ${since()} from ${rinfo.address}:${rinfo.port}  len=${msg.length}`);
    out(`    hex(first 128): ${hexOf(msg, 128)}${msg.length > 128 ? ' ...' : ''}`);
    if (msg.length >= 4 && msg.toString('latin1', 0, 4) === 'CITP') decodeCitp(msg).forEach(out);
  });
  let bound = false;
  await new Promise((res) => {
    const onErr = (e) => { out(`  BIND FAILED: code=${e.code} errno=${e.errno} syscall=${e.syscall} message=${e.message}`); res(); };
    sock.once('error', onErr);
    sock.bind(CITP_PORT, () => { sock.removeListener('error', onErr); bound = true; res(); });
  });
  if (bound) {
    out(`  bound to ${sock.address().address}:${sock.address().port}`);
    for (const i of ifaces) {
      try { sock.addMembership(CITP_GROUP, i.address); out(`  joined ${CITP_GROUP} on ${i.name} (${i.address}): ok`); }
      catch (e) { out(`  join ${CITP_GROUP} on ${i.name} (${i.address}) FAILED: code=${e.code} errno=${e.errno} syscall=${e.syscall} message=${e.message}`); }
    }
    await sleep(CITP_LISTEN_MS);
    out(`  done: ${count} packet(s) received in ${CITP_LISTEN_MS / 1000} s`);
    try { sock.close(); } catch { /* ignore */ }
  } else {
    out('  (no listen performed: socket did not bind)');
    try { sock.close(); } catch { /* ignore */ }
  }
}

// ---------- main ----------
async function main() {
  out(`Network probe ${new Date().toISOString()}  node ${process.version}  ${process.platform}/${process.arch}`);
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

  out('== 4. CITP passive listen ==');
  await citpListen(ifaces);
  out('');
  out(`Finished ${since()}`);
}

fs.mkdirSync(REPORTS, { recursive: true });
try { await main(); } catch (e) { out(`FATAL: ${e.stack}`); process.exitCode = 1; }
const file = path.join(REPORTS, 'network-report.txt');
fs.writeFileSync(file, lines.join('\n') + '\n');
console.log(`\nreport: ${file}`);
process.exit(process.exitCode || 0);
