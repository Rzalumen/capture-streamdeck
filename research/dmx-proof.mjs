// DMX proof on ONE patched fixture of any type. Works out the fixture's channels itself: live patch from Capture over CITP
// (read-only), channel list from Capture's own library object, then drives pan/tilt/intensity/shutter over sACN (E1.31).
//
//   node research/dmx-proof.mjs                         list the patched fixtures and exit (no DMX)
//   node research/dmx-proof.mjs --fixture <#>           prove one fixture: prints its channel table, then sends the sequence
//
// Options: --seconds <n>        length of each pan/tilt sweep (default 6)
//          --shutter-value <n>  raw 0-255 value for the shutter/strobe channel (default 255; a GUESS until channel defaults are decoded)
//          --force              proceed although other patched fixtures share the universe (they are driven to 0 while this runs)
//          --sacn-universe <n>  sACN universe to send on (default: Capture's 0-based universe + 1; an assumption, see output)
//          --lib <path>         Library.c2z (default: Capture 2026 in Application Support)
//          --host <ip> --port <n>   CITP target (skip discovery)      --report-dir <dir> (default ./reports)
//          --sacn-port <n>      UDP port for sACN (default 5568)      --no-multicast   unicast to 127.0.0.1 only
//          --fps <n>            frames per second (default 40)
//
// DMX is sent ONLY by this script and ONLY between "sending" and "terminated" in its output. CITP use is the read-only allowlist
// of lib/citp-sync.mjs. Nothing is written to Capture's library or show.
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/main.mjs';
import { libPathFromArgs, openLibrary } from './lib/c2z.mjs';
import { textTable } from './lib/citp.mjs';
import { patchedFixtures, readPatch, localIPv4 } from './lib/citp-sync.mjs';
import { ROLE_NAMES, loadChannels, mapAttributes } from './lib/modes.mjs';
import { OPT_TERMINATED, DEFAULT_PRIORITY, SACN_PORT, buildDataPacket, multicastAddress } from './lib/sacn.mjs';
import { buildTimeline, frameSlots, stateAt } from './lib/dmx-seq.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_NAME = 'capture-streamdeck dmx-proof';
// fixed CID for this tool (any constant 16 bytes; the same on every run so receivers see one source)
const CID = Buffer.from('cd5a0d6c-6d78-4d5f-9d0e-2b1a4c3d5e6f'.replace(/-/g, ''), 'hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const o = { fixture: null, seconds: 6, shutter: 255, shutterGiven: false, force: false, universe: null, lib: null, host: null, port: null, reportDir: path.join(ROOT, 'reports'), sacnPort: SACN_PORT, multicast: true, fps: 40 };
  const need = (i, n) => { if (argv[i + 1] === undefined) throw new Error(`${n} needs a value`); return argv[i + 1]; };
  const num = (v, n, lo, hi) => { const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${n} must be a number from ${lo} to ${hi}, got ${JSON.stringify(v)}`); return x; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--fixture': o.fixture = num(need(i, a), a, 0, 65535); if (!Number.isInteger(o.fixture)) throw new Error('--fixture must be a whole number'); i++; break;
      case '--seconds': o.seconds = num(need(i, a), a, 0.5, 120); i++; break;
      case '--shutter-value': o.shutter = num(need(i, a), a, 0, 255); if (!Number.isInteger(o.shutter)) throw new Error('--shutter-value must be a whole number'); o.shutterGiven = true; i++; break;
      case '--force': o.force = true; break;
      case '--no-multicast': o.multicast = false; break;
      case '--sacn-universe': o.universe = num(need(i, a), a, 1, 63999); i++; break;
      case '--lib': o.lib = need(i, a); i++; break;
      case '--host': o.host = need(i, a); i++; break;
      case '--port': o.port = num(need(i, a), a, 1, 65535); i++; break;
      case '--report-dir': o.reportDir = path.resolve(need(i, a)); i++; break;
      case '--sacn-port': o.sacnPort = num(need(i, a), a, 1, 65535); i++; break;
      case '--fps': o.fps = num(need(i, a), a, 1, 100); i++; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

/** UDP destinations: unicast 127.0.0.1 and (unless disabled) the sACN multicast group on every local IPv4 interface. */
async function openDestinations(universe, port, multicast, say) {
  const dests = [];
  const open = (label, addr, ifaceAddr) => new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const d = { label, addr, port, sock, sent: 0, errors: 0, firstError: null };
    sock.on('error', (e) => { d.errors++; d.firstError ||= `${e.code || ''} ${e.message}`; });
    sock.bind(0, ifaceAddr, () => {
      try {
        if (ifaceAddr) { sock.setMulticastInterface(ifaceAddr); sock.setMulticastTTL(1); sock.setMulticastLoopback(true); }
      } catch (e) { d.errors++; d.firstError ||= `${e.code || ''} ${e.message}`; }
      dests.push(d); resolve();
    });
    sock.once('error', () => resolve());
  });
  await open(`unicast ${'127.0.0.1'}`, '127.0.0.1', null);
  if (multicast) {
    const group = multicastAddress(universe);
    for (const i of localIPv4()) await open(`multicast ${group} via ${i.name} (${i.address})`, group, i.address);
  }
  dests.forEach((d) => say(`  destination: ${d.label} -> ${d.addr}:${d.port}`));
  return dests;
}

async function main(opts, say) {
  // ---- 1. live patch -------------------------------------------------------------------------------------------------
  say('Reading the live patch from Capture over CITP (read-only) ...');
  const patch = await readPatch({ host: opts.host, port: opts.port, log: (s) => say(`  ${s}`) });
  if (!patch.ok) { say(`ERROR: ${patch.error}`); return 1; }
  const patched = patchedFixtures(patch.fixtures);
  if (!patched.length) { say(`Capture reports ${patch.fixtures.length} fixture(s) but none is patched to a universe. Patch one moving light and run again.`); return 2; }

  if (opts.fixture === null) {
    say('');
    say(`Patched fixtures${patch.showName ? ` in show ${JSON.stringify(patch.showName)}` : ''} (universe/address are 1-based, as Capture shows them):`);
    textTable(['#', 'manufacturer', 'model', 'mode', 'ch', 'universe/address', 'others in universe'],
      patched.map((f) => [f.index, f.manufacturer, f.name, f.mode, f.channelCount, `${f.universe1}/${f.address1}`, f.sharing]), '  ').forEach(say);
    say('');
    say('Pick one moving light (ideally alone in its universe) and run:  npm run probe:dmx -- --fixture <#>');
    return 0;
  }

  // ---- 2. the chosen fixture -----------------------------------------------------------------------------------------
  const fx = patched.find((f) => f.index === opts.fixture);
  if (!fx) { say(`ERROR: no patched fixture with # ${opts.fixture}. Patched: ${patched.map((f) => f.index).join(', ')}`); return 2; }
  say('');
  say(`Fixture #${fx.index}: ${fx.manufacturer} ${fx.name}, mode ${JSON.stringify(fx.mode)}, ${fx.channelCount} channel(s), universe ${fx.universe1} address ${fx.address1}`);
  if (!fx.fixtureGuid || !fx.modeGuid) { say(`ERROR: Capture did not send both identifiers for this fixture (AtlaBaseFixtureId: ${fx.fixtureGuid ?? 'missing'}, AtlaBaseModeId: ${fx.modeGuid ?? 'missing'}). No DMX sent.`); return 2; }
  say(`  AtlaBaseFixtureId (library object name) ${fx.fixtureGuid}   AtlaBaseModeId ${fx.modeGuid}`);

  const libPath = opts.lib ? path.resolve(opts.lib) : libPathFromArgs([]);
  let obj;
  try {
    const lib = openLibrary(libPath);
    try { obj = lib.readObjectByGuid(fx.fixtureGuid); } finally { lib.close(); }
  } catch (e) { say(`ERROR: cannot read library object ${fx.fixtureGuid}.c2o from ${libPath}: ${e.message}. No DMX sent.`); return 2; }
  say(`  library object: ${obj.length} bytes from ${libPath}`);

  const loaded = loadChannels(obj, fx.modeGuid, fx.channelCount);
  if (loaded.block?.warnings?.length) loaded.block.warnings.forEach((w) => say(`  note: ${w}`));
  if (!loaded.ok) {
    say(`ERROR: could not establish this fixture's channels safely: ${loaded.error}`);
    say('No DMX sent. Run `npm run export:objects` and send reports/objects/* to Claude.');
    return 2;
  }
  const chans = loaded.channels;
  say(`  mode block found by its ${loaded.block.encoding} GUID at byte ${loaded.block.blockAt}: mode name ${JSON.stringify(loaded.block.name)}; ${chans.length} channels = block channelCount = Capture's ChannelCount`);
  say('');
  say('Channel table (offset is 0-based within the fixture; DMX address = fixture address + offset):');
  textTable(['offset', 'DMX addr', 'name', 'role', 'pair'],
    chans.map((c) => [c.offset, fx.address1 + c.offset, c.name, ROLE_NAMES[c.role], c.role === 0 ? '-' : c.pair]), '  ').forEach(say);

  // ---- 3. attribute mapping by name ----------------------------------------------------------------------------------
  const { map, missing, warnings } = mapAttributes(chans);
  say('');
  say('Attributes found by channel NAME (generic rules: pan, tilt, dimmer/intensity, shutter/strobe):');
  for (const a of ['pan', 'tilt', 'intensity', 'shutter']) {
    const m = map[a];
    say(`  ${a.padEnd(9)} ${m ? `offset ${m.coarse.offset} "${m.coarse.name}"${m.fine ? ` + fine offset ${m.fine.offset} "${m.fine.name}" (16-bit)` : ' (8-bit)'}` : 'NOT FOUND'}`);
  }
  warnings.forEach((w) => say(`  note: ${w}`));
  if (missing.includes('pan') || missing.includes('tilt')) {
    say(`ERROR: ${missing.filter((a) => a === 'pan' || a === 'tilt').join(' and ')} not found among this fixture's channel names, so there is nothing to sweep. No DMX sent.`);
    return 2;
  }
  if (missing.includes('intensity')) say('  note: no dimmer/intensity channel found; the light may stay dark (fixtures with a virtual dimmer, or a dimmer named something else)');
  if (missing.includes('shutter')) say('  note: no shutter/strobe channel found; none will be driven');

  // ---- 4. safety checks ----------------------------------------------------------------------------------------------
  const base = fx.universeChannel; // 0-based slot index of offset 0
  if (base + chans.length > 512) { say(`ERROR: the fixture's channels (${fx.address1}..${fx.address1 + chans.length - 1}) do not fit in 512 slots. No DMX sent.`); return 2; }
  const universe = opts.universe ?? fx.universe + 1;
  if (fx.sharing > 0) {
    const others = patched.filter((f) => f !== fx && f.universe === fx.universe);
    say('');
    say(`WARNING: ${fx.sharing} other patched fixture(s) share universe ${fx.universe1}: ${others.map((f) => `#${f.index} ${f.manufacturer} ${f.name} @${f.address1}`).join('; ')}`);
    if (!opts.force) { say('Refusing to send: this tool writes 0 to every other channel of the universe, which would drive those fixtures too. Use a universe of its own (in a copy of the show) or add --force. No DMX sent.'); return 2; }
    say('--force given: continuing; every channel of that universe other than this fixture\'s mapped ones is sent as 0.');
  }

  // ---- 5. sequence ----------------------------------------------------------------------------------------------------
  const timeline = buildTimeline({ holdSeconds: 1, sweepSeconds: opts.seconds });
  say('');
  say(`sACN E1.31, universe ${universe}${opts.universe ? ' (from --sacn-universe)' : ` = Capture's 0-based universe ${fx.universe} + 1 (an ASSUMPTION: Capture's sACN input must be set to the same universe)`}, priority ${DEFAULT_PRIORITY}, source "${SOURCE_NAME}", ${opts.fps} fps.`);
  say(`Slots sent: ${fx.address1}..${fx.address1 + chans.length - 1} carry this fixture; all other slots are 0, including this fixture's channels that are not listed above (their defaults are not decoded yet).`);
  say(`Shutter/strobe raw value ${opts.shutter}${!opts.shutterGiven ? ' (default; a GUESS - 255 is often "open" but on some fixtures it is full strobe. Use --shutter-value to change)' : ''}.`);
  say('Timeline:');
  timeline.phases.forEach((p) => say(`  ${p.start.toFixed(1).padStart(5)} s - ${p.end.toFixed(1).padStart(5)} s  ${p.name}${p.axis ? '' : ' (intensity 100%, pan/tilt 50%)'}`));
  say(`Total ${timeline.total.toFixed(1)} s. Watch the light pan, then tilt, in the 3D view. Ctrl-C stops early (termination frames are still sent).`);
  say('');
  const dests = await openDestinations(universe, opts.sacnPort, opts.multicast, say);

  let seq = 0, frames = 0, stop = false;
  process.once('SIGINT', () => { stop = true; });
  const sendFrame = (slots, options = 0) => {
    const pkt = buildDataPacket({ cid: CID, sourceName: SOURCE_NAME, universe, sequence: seq++ & 0xff, priority: DEFAULT_PRIORITY, options, slots });
    for (const d of dests) d.sock.send(pkt, d.port, d.addr, (e) => { if (e) { d.errors++; d.firstError ||= `${e.code || ''} ${e.message}`; } else d.sent++; });
    frames++;
  };
  const slotsFor = (st) => frameSlots({ map, base, shutterRaw: opts.shutter, pan: st.pan, tilt: st.tilt });
  say('sending ...');
  const period = 1000 / opts.fps;
  const t0 = process.hrtime.bigint();
  const nowMs = () => Number(process.hrtime.bigint() - t0) / 1e6;
  let lastPhase = null, last = null;
  for (let n = 0; !stop; n++) {
    const tMs = n * period;
    if (tMs / 1000 > timeline.total) break;
    const wait = tMs - nowMs();
    if (wait > 0) await sleep(wait);
    const st = stateAt(timeline, tMs / 1000);
    if (st.phase !== lastPhase) { say(`  +${(tMs / 1000).toFixed(2)} s  ${st.phase}`); lastPhase = st.phase; }
    last = slotsFor(st);
    sendFrame(last);
  }
  const elapsed = nowMs() / 1000;
  const live = frames;
  // termination: 3 frames with the Stream_Terminated bit
  for (let k = 0; k < 3; k++) { sendFrame(last ?? new Uint8Array(512), OPT_TERMINATED); await sleep(period); }
  await sleep(100);
  say(`terminated: ${live} data frames in ${elapsed.toFixed(2)} s (${(live / elapsed).toFixed(1)} fps) + 3 frames with Stream_Terminated${stop ? ' (stopped early by Ctrl-C)' : ''}.`);
  say('Frames handed to the network per destination:');
  for (const d of dests) say(`  ${d.label}: ${d.sent} sent${d.errors ? `, ${d.errors} error(s), first: ${d.firstError}` : ''}`);
  dests.forEach((d) => d.sock.close());
  const bad = dests.filter((d) => d.errors && !d.sent);
  if (bad.length === dests.length) { say('ERROR: no destination accepted any packet.'); return 3; }
  say('');
  say('If the light did not move: is Capture\'s sACN input enabled for this universe (Capture\'s DMX/network settings)? Check the universe number printed above, then try --sacn-universe <n>.');
  return 0;
}

if (isMain(import.meta.url)) {
  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };
  let opts, code;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`dmx-proof: ${e.message}`); process.exit(2); }
  say(`dmx-proof   ${new Date().toISOString()}   node ${process.version} ${process.platform}/${process.arch}`);
  try { code = await main(opts, say); } catch (e) { say(`FATAL: ${e.stack}`); code = 1; }
  try {
    fs.mkdirSync(opts.reportDir, { recursive: true });
    const file = path.join(opts.reportDir, 'dmx-proof.txt');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    console.log(`\nreport: ${file}`);
  } catch (e) { console.log(`(could not write the report: ${e.message})`); }
  process.exit(code);
}
