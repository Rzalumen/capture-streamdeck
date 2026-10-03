// DMX proof on ONE fixture of any type. Works out the fixture's channels itself: live patch from Capture over CITP
// (read-only), channel list from Capture's own library object, then drives pan/tilt/intensity/shutter over sACN (E1.31).
//
//   node research/dmx-proof.mjs                         list ALL fixtures (with the CAEX patch fields as Capture sent them) and exit (no DMX)
//   node research/dmx-proof.mjs --fixture <#>           prove one fixture: prints its channel table, then sends the sequence
//   node research/dmx-proof.mjs --fixture <#> --universe <1..> --address <1..512>
//                                                       same, but at a MANUAL address (needed when Capture's CAEX FixtureList carries
//                                                       no patch: Patched=0, universe 0, address 0). Without them a fixture with no
//                                                       CAEX patch is refused.
//
// Options: --universe <n>, --address <n>  manual patch (both required together); the universe is also the sACN universe number
//          --seconds <n>        length of each pan/tilt sweep (default 6)
//          --shutter-value <n>  raw 0-255 value for the shutter/strobe channel (default 255; a GUESS until channel defaults are decoded)
//          --set <ch>=<v>       hold channel <ch> (1-based within the fixture, as Capture's patch view numbers it) at <v> 0-255 for the whole run; repeatable.
//                               A coarse channel's fine partner gets the same value. Channels the test drives itself (pan, tilt, dimmer, shutter) are refused.
//          --color-full         hold every coarse/8-bit ADDITIVE colour channel (red, green, blue, white, amber, lime, uv; by name) at 255, fine partners too.
//                               Never cyan, magenta, yellow, CTO, CTB or correction channels. (Without these every undriven channel is 0, so an RGBW-only
//                               fixture has no colour output.)
//          --force              proceed although other patched fixtures share the universe (they are driven to 0 while this runs)
//          --sacn-universe <n>  sACN universe to send on (default: the 1-based universe, i.e. Capture's 0-based universe + 1; an assumption, see output)
//          --lib <path>         Library.c2z (default: Capture 2026 in Application Support)
//          --host <ip> --port <n>   CITP target (skip discovery)      --report-dir <dir> (default ./reports)
//          --sacn-port <n>      UDP port for sACN (default 5568)      --no-multicast   unicast to 127.0.0.1 only
//          --fps <n>            frames per second (default 40)
//          --pap                also send per-address-priority packets (START code 0xDD, ETC extension) on the same universe with the
//                               same CID: priority 100 on this fixture's channels, 0 ("ignore my level") on every other slot.
//                               Question it answers: does Capture then leave the other fixtures of the universe alone?
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
import { describeFixtures, readPatch, localIPv4 } from './lib/citp-sync.mjs';
import { ROLE_NAMES, ambiguityNote, loadChannels, mapAttributes } from './lib/modes.mjs';
import { planExtras } from './lib/extras.mjs';
import { OPT_TERMINATED, DEFAULT_PRIORITY, SACN_PORT, START_CODE_PAP, buildDataPacket, multicastAddress, papSlots } from './lib/sacn.mjs';
import { buildTimeline, frameSlots, stateAt } from './lib/dmx-seq.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_NAME = 'capture-streamdeck dmx-proof';
// fixed CID for this tool (any constant 16 bytes; the same on every run so receivers see one source)
const CID = Buffer.from('cd5a0d6c-6d78-4d5f-9d0e-2b1a4c3d5e6f'.replace(/-/g, ''), 'hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const o = { fixture: null, seconds: 6, shutter: 255, shutterGiven: false, force: false, universe: null, address: null, sacnUniverse: null, sets: [], colorFull: false, lib: null, host: null, port: null, reportDir: path.join(ROOT, 'reports'), sacnPort: SACN_PORT, multicast: true, fps: 40, pap: false };
  const need = (i, n) => { if (argv[i + 1] === undefined) throw new Error(`${n} needs a value`); return argv[i + 1]; };
  const num = (v, n, lo, hi) => { const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${n} must be a number from ${lo} to ${hi}, got ${JSON.stringify(v)}`); return x; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--fixture': o.fixture = num(need(i, a), a, 0, 65535); if (!Number.isInteger(o.fixture)) throw new Error('--fixture must be a whole number'); i++; break;
      case '--seconds': o.seconds = num(need(i, a), a, 0.5, 120); i++; break;
      case '--shutter-value': o.shutter = num(need(i, a), a, 0, 255); if (!Number.isInteger(o.shutter)) throw new Error('--shutter-value must be a whole number'); o.shutterGiven = true; i++; break;
      case '--set': {
        const v = need(i, a); i++;
        const m = /^(\d+)=(\d+)$/.exec(v);
        if (!m) throw new Error(`--set needs <channel>=<value> (whole numbers), got ${JSON.stringify(v)}`);
        const channel = Number(m[1]), value = Number(m[2]);
        if (channel < 1 || channel > 512) throw new Error(`--set channel must be from 1 to 512, got ${channel}`);
        if (value > 255) throw new Error(`--set value must be from 0 to 255, got ${value}`);
        const prev = o.sets.find((s) => s.channel === channel);
        if (prev && prev.value !== value) throw new Error(`--set ${channel} is given twice with different values (${prev.value} and ${value})`);
        if (!prev) o.sets.push({ channel, value });
        break;
      }
      case '--color-full': o.colorFull = true; break;
      case '--force': o.force = true; break;
      case '--pap': o.pap = true; break;
      case '--no-multicast': o.multicast = false; break;
      case '--sacn-universe': o.sacnUniverse = num(need(i, a), a, 1, 63999); i++; break;
      case '--universe': o.universe = num(need(i, a), a, 1, 63999); if (!Number.isInteger(o.universe)) throw new Error('--universe must be a whole number'); i++; break;
      case '--address': o.address = num(need(i, a), a, 1, 512); if (!Number.isInteger(o.address)) throw new Error('--address must be a whole number'); i++; break;
      case '--lib': o.lib = need(i, a); i++; break;
      case '--host': o.host = need(i, a); i++; break;
      case '--port': o.port = num(need(i, a), a, 1, 65535); i++; break;
      case '--report-dir': o.reportDir = path.resolve(need(i, a)); i++; break;
      case '--sacn-port': o.sacnPort = num(need(i, a), a, 1, 65535); i++; break;
      case '--fps': o.fps = num(need(i, a), a, 1, 100); i++; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if ((o.universe === null) !== (o.address === null)) throw new Error('--universe and --address go together: give both (a manual patch) or neither');
  if (o.universe !== null && o.fixture === null) throw new Error('--universe/--address need --fixture <#>');
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
  const all = describeFixtures(patch.fixtures);
  if (!all.length) { say('Capture reports no fixtures. Open a show with fixtures in it and run again.'); return 2; }

  if (opts.fixture === null) {
    say('');
    say(`All fixtures${patch.showName ? ` in show ${JSON.stringify(patch.showName)}` : ''} (${all.length}). "Channel" is Capture's own channel number. The last three columns are the patch fields`);
    say('of the CAEX FixtureList exactly as Capture sent them (universe/address shown 1-based); Capture may send them empty (Patched=no) even for a fixture that is patched.');
    textTable(['#', 'manufacturer', 'model', 'mode', 'ch', 'Channel', 'from CAEX: patched', 'from CAEX: universe/address', 'others patched in that universe'],
      all.map((f) => [f.index, f.manufacturer, f.name, f.mode, f.channelCount, f.channel, f.caexPatched ? 'yes' : 'no',
        f.caexPatched ? `${f.caexUniverse1}/${f.caexAddress1}` : `- (raw u${f.universe} a${f.universeChannel})`, f.caexPatched ? f.sharing : '-']), '  ').forEach(say);
    say('');
    if (all.some((f) => f.caexPatched)) say('Pick one moving light (ideally alone in its universe) and run:  npm run probe:dmx -- --fixture <#>');
    else say('No fixture has a patch in the CAEX data. Find your light by its Channel and Capture\'s Universes tab, then run:  npm run probe:dmx -- --fixture <#> --universe <1..> --address <1..512>');
    say('(With a fixture that has no CAEX patch, --universe and --address are required; with one that has, they override it.)');
    return 0;
  }

  // ---- 2. the chosen fixture -----------------------------------------------------------------------------------------
  const fx = all.find((f) => f.index === opts.fixture);
  if (!fx) { say(`ERROR: no fixture with # ${opts.fixture}. Fixtures: ${all.map((f) => f.index).join(', ')}`); return 2; }
  say('');
  say(`Fixture #${fx.index}: ${fx.manufacturer} ${fx.name}, mode ${JSON.stringify(fx.mode)}, ${fx.channelCount} channel(s), Capture Channel ${fx.channel}`);
  say(`  CAEX patch fields: Patched=${fx.patched}, universe ${fx.caexUniverse1} address ${fx.caexAddress1} (1-based; raw 0-based ${fx.universe}/${fx.universeChannel})`);
  const manual = opts.universe !== null;
  let loc;
  if (manual) {
    loc = { source: 'manual', universe1: opts.universe, address1: opts.address };
    say(`  USING A MANUAL ADDRESS: universe ${loc.universe1} address ${loc.address1} (from --universe/--address)${fx.caexPatched ? `; this overrides the CAEX patch ${fx.caexUniverse1}/${fx.caexAddress1}` : '; there is no usable CAEX patch for this fixture'}.`);
  } else if (fx.caexPatched) {
    loc = { source: 'CAEX', universe1: fx.caexUniverse1, address1: fx.caexAddress1 };
    say(`  Using the CAEX patch: universe ${loc.universe1} address ${loc.address1}.`);
  } else {
    say('ERROR: Capture sent no patch for this fixture over CAEX (Patched=0), so its universe and address are unknown. No DMX sent.');
    say('Give the address yourself, as Capture\'s Universes tab shows it:  npm run probe:dmx -- --fixture ' + fx.index + ' --universe <1..> --address <1..512>');
    return 2;
  }
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
  say(`  mode block found by its ${loaded.block.encoding} GUID at byte ${loaded.block.blockAt ?? loaded.block.at}: mode name ${JSON.stringify(loaded.block.name)}; ${chans.length} channels = block channelCount = Capture's ChannelCount`);
  if (loaded.ambiguity) {
    const amb = loaded.ambiguity;
    say(`  NOTE: ${ambiguityNote(amb.candidates, amb.differOffsets)}`);
    say(`  The table below is the first candidate (earliest in the file); slots at offsets [${amb.differOffsets.join(', ')}] are never driven, and the channels that are driven (offsets [${amb.drivenOffsets.join(', ')}]) are identical in every candidate.`);
  }
  say('');
  say('Channel table (offset is 0-based within the fixture; DMX address = fixture address + offset):');
  textTable(['offset', 'DMX addr', 'name', 'role', 'pair'],
    chans.map((c) => [c.offset, loc.address1 + c.offset, c.name, ROLE_NAMES[c.role], c.role === 0 ? '-' : c.pair]), '  ').forEach(say);

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

  // ---- 3b. extra channels (--set, --color-full) ------------------------------------------------------------------------
  const extra = planExtras(chans, map, { sets: opts.sets, colorFull: opts.colorFull, ambiguousOffsets: loaded.ambiguity?.differOffsets ?? [] });
  if (!extra.ok) { say(`ERROR: ${extra.error}. No DMX sent.`); return 2; }
  if (opts.sets.length || opts.colorFull) {
    say('');
    say(`Extra channels held at a fixed value for the whole run (${extra.extras.length}):`);
    if (extra.extras.length) {
      textTable(['channel', 'offset', 'DMX addr', 'name', 'value', 'from'], extra.extras.map((e) => [e.channel, e.offset, loc.address1 + e.offset, e.name, e.value, e.source]), '  ').forEach(say);
    }
    extra.notes.forEach((n) => say(`  note: ${n}`));
  }

  // ---- 4. safety checks ----------------------------------------------------------------------------------------------
  const base = loc.address1 - 1; // 0-based slot index of offset 0
  if (base + chans.length > 512) { say(`ERROR: the fixture's channels (${loc.address1}..${loc.address1 + chans.length - 1}) do not fit in 512 slots. No DMX sent.`); return 2; }
  const universe = opts.sacnUniverse ?? loc.universe1;
  const others = all.filter((f) => f !== fx && f.caexPatched && f.universe + 1 === loc.universe1);
  const unknown = all.filter((f) => f !== fx && !f.caexPatched).length;
  if (manual) {
    say('');
    say(`WARNING: manual address. Capture's CAEX data carries no patch for ${unknown} of the other ${all.length - 1} fixture(s) (Patched=0), so this tool cannot tell what else is in universe ${loc.universe1}.`);
    say(`Make sure universe ${loc.universe1} holds ONLY this test fixture (in a copy of the show), or accept that every other channel of universe ${loc.universe1} is sent as 0 while this runs.`);
  } else if (unknown > 0) {
    say('');
    say(`WARNING: ${unknown} other fixture(s) report no patch over CAEX, so they could share universe ${loc.universe1} without this tool knowing; every other channel of that universe is sent as 0.`);
  }
  if (others.length) {
    say('');
    say(`WARNING: ${others.length} other patched fixture(s) share universe ${loc.universe1}: ${others.map((f) => `#${f.index} ${f.manufacturer} ${f.name} @${f.caexAddress1}`).join('; ')}`);
    if (!opts.force) { say('Refusing to send: this tool writes 0 to every other channel of the universe, which would drive those fixtures too. Use a universe of its own (in a copy of the show) or add --force. No DMX sent.'); return 2; }
    say('--force given: continuing; every channel of that universe other than this fixture\'s mapped ones is sent as 0.');
  }

  // ---- 5. sequence ----------------------------------------------------------------------------------------------------
  const timeline = buildTimeline({ holdSeconds: 1, sweepSeconds: opts.seconds });
  say('');
  say(`sACN E1.31, universe ${universe}${opts.sacnUniverse ? ' (from --sacn-universe)' : ` = the ${loc.source === 'manual' ? '--universe you gave' : `CAEX universe (0-based ${fx.universe}) + 1`} (an ASSUMPTION: Capture's sACN input must be set to the same universe number)`}, priority ${DEFAULT_PRIORITY}, source "${SOURCE_NAME}", ${opts.fps} fps.`);
  say(`Slots sent: ${loc.address1}..${loc.address1 + chans.length - 1} carry this fixture; all other slots are 0${extra.extras.length ? ', except the extra channels listed above' : ''}, including this fixture's channels that are not listed above (their defaults are not decoded yet).`);
  if (opts.pap) {
    say(`--pap: every level frame (START code 0x00) is followed by a per-address-priority frame (START code 0xDD, ETC extension to E1.31; same CID, universe ${universe}, sequence counted with the level frames): priority ${DEFAULT_PRIORITY} on slots ${loc.address1}..${loc.address1 + chans.length - 1} (this fixture), 0 = "ignore my level" on all other ${512 - chans.length} slots.`);
    say('  Watch the OTHER fixtures of this universe: if Capture honours per-address priority they keep what the Control Pane gave them while this fixture moves; if they go dark or jump, it does not.');
    say('  Format per ETC: https://etclabs.github.io/sACNDocs/2.0.1/per_address_priority.html (priority 1-200, 0 = ignore this address).');
  }
  say(`Shutter/strobe raw value ${opts.shutter}${!opts.shutterGiven ? ' (default; a GUESS - 255 is often "open" but on some fixtures it is full strobe. Use --shutter-value to change)' : ''}.`);
  say('Timeline:');
  timeline.phases.forEach((p) => say(`  ${p.start.toFixed(1).padStart(5)} s - ${p.end.toFixed(1).padStart(5)} s  ${p.name}${p.axis ? '' : ' (intensity 100%, pan/tilt 50%)'}`));
  say(`Total ${timeline.total.toFixed(1)} s. Watch the light pan, then tilt, in the 3D view. Ctrl-C stops early (termination frames are still sent).`);
  say('');
  const dests = await openDestinations(universe, opts.sacnPort, opts.multicast, say);

  let seq = 0, frames = 0, papFrames = 0, stop = false;
  process.once('SIGINT', () => { stop = true; });
  const pap = opts.pap ? papSlots({ base, count: chans.length, priority: DEFAULT_PRIORITY }) : null;
  const put = (pkt) => { for (const d of dests) d.sock.send(pkt, d.port, d.addr, (e) => { if (e) { d.errors++; d.firstError ||= `${e.code || ''} ${e.message}`; } else d.sent++; }); };
  const sendFrame = (slots, options = 0) => {
    put(buildDataPacket({ cid: CID, sourceName: SOURCE_NAME, universe, sequence: seq++ & 0xff, priority: DEFAULT_PRIORITY, options, slots }));
    frames++;
    // per-address priority right after each live level frame (not with the termination frames: Stream_Terminated ends the whole source)
    if (pap && !(options & OPT_TERMINATED)) {
      put(buildDataPacket({ cid: CID, sourceName: SOURCE_NAME, universe, sequence: seq++ & 0xff, priority: DEFAULT_PRIORITY, options, slots: pap, startCode: START_CODE_PAP }));
      papFrames++;
    }
  };
  const slotsFor = (st) => frameSlots({ map, base, shutterRaw: opts.shutter, pan: st.pan, tilt: st.tilt, extras: extra.extras });
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
  if (pap) say(`per-address priority (0xDD): ${papFrames} frames sent, one after each live level frame.`);
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
