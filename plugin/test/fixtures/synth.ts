/** Synthetic Capture data for the tests: DMX-mode blocks, a Library.c2z, a CITP FixtureList and a stub CITP server. No Capture content. */
import net from "node:net";
import zlib from "node:zlib";
import { CAEX, CitpFramer, HEADER_SIZE, buildHeader } from "../../src/fixtures/citp.ts";
import { comGuidBytes, rawGuidBytes } from "../../src/fixtures/modes.ts";

const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const u16 = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const f32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return b;
};
export const lpEncode = (s: string): Buffer => {
  const b = Buffer.from(s, "latin1");
  return Buffer.concat([u32(b.length + 1), b]);
};
const ucs2 = (s: string): Buffer => Buffer.concat([Buffer.from(s, "utf16le"), Buffer.from([0, 0])]);

export interface SynthChannel {
  name: string;
  role?: number;
  pair?: number;
  tail?: Buffer | ((i: number) => Buffer);
}

/** [16-byte GUID][name][props][channelCount]{name + role + pair + tail}. */
export function buildModeBlock({ guid, name = "Standard", channels, count }: { guid: string; name?: string; channels: SynthChannel[]; count?: number }): Buffer {
  const parts: Buffer[] = [comGuidBytes(guid), lpEncode(name), u32(1), lpEncode("Key"), u32(3), lpEncode("Value"), u32(count ?? channels.length)];
  channels.forEach((c, i) => {
    const role = c.role ?? 0;
    parts.push(lpEncode(c.name), Buffer.from([role]), u16(role === 0 ? 0xffff : (c.pair ?? 0)));
    const tail = typeof c.tail === "function" ? c.tail(i) : c.tail;
    if (tail) parts.push(tail);
  });
  return Buffer.concat(parts);
}
export const buildObject = (...blocks: Buffer[]): Buffer => Buffer.concat([Buffer.alloc(24, 0xab), ...blocks.flatMap((b) => [b, Buffer.alloc(40, 0xab)])]);

/** Moving head: 16-bit pan/tilt, 8-bit dimmer, shutter, red/green/blue/white, zoom, and a "Pan/Tilt Speed" that is NOT pan. 14 channels. */
export const movingHead = (): SynthChannel[] => [
  { name: "Pan", role: 1, pair: 1 },
  { name: "Pan Fine", role: 2, pair: 0 },
  { name: "Tilt", role: 1, pair: 3 },
  { name: "Tilt Fine", role: 2, pair: 2 },
  { name: "Pan/Tilt Speed" },
  { name: "Dimmer" },
  { name: "Shutter" },
  { name: "Red" },
  { name: "Green" },
  { name: "Blue" },
  { name: "White" },
  { name: "Amber" },
  { name: "Zoom", role: 1, pair: 13 },
  { name: "Zoom Fine", role: 2, pair: 12 },
];
/** CMY colour mixing head: 8-bit cyan/magenta/yellow, dimmer, focus, iris. */
export const cmyHead = (): SynthChannel[] => [{ name: "Dimmer" }, { name: "Cyan" }, { name: "Magenta" }, { name: "Yellow" }, { name: "Focus" }, { name: "Iris" }, { name: "Pan" }, { name: "Tilt" }];

/**
 * A framing-shutter spot (made up; Handoff 20): 16-bit pan/tilt/dimmer/zoom/focus, shutter/strobe, CMY + CTO + colour wheel, two gobo
 * wheels with rotation, prism + rotation, animation wheel + rotation, frost, iris, 8 framing blades ("Shutter 1A" … "Shutter 4B") and
 * shutter rotation, control and speed channels. 37 channels.
 */
export const framingHead = (): SynthChannel[] => [
  { name: "Pan", role: 1, pair: 1 },
  { name: "Pan Fine", role: 2, pair: 0 },
  { name: "Tilt", role: 1, pair: 3 },
  { name: "Tilt Fine", role: 2, pair: 2 },
  { name: "Pan/Tilt Speed" },
  { name: "Shutter/Strobe" },
  { name: "Dimmer", role: 1, pair: 7 },
  { name: "Dimmer Fine", role: 2, pair: 6 },
  { name: "Cyan" },
  { name: "Magenta" },
  { name: "Yellow" },
  { name: "CTO" },
  { name: "Colour Wheel" },
  { name: "Gobo Wheel 1" },
  { name: "Gobo 1 Rotation" },
  { name: "Gobo Wheel 2" },
  { name: "Prism" },
  { name: "Prism Rotation" },
  { name: "Animation Wheel" },
  { name: "Animation Rotation" },
  { name: "Frost" },
  { name: "Iris" },
  { name: "Zoom", role: 1, pair: 23 },
  { name: "Zoom Fine", role: 2, pair: 22 },
  { name: "Focus", role: 1, pair: 25 },
  { name: "Focus Fine", role: 2, pair: 24 },
  ...["1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B"].map((b) => ({ name: `Shutter ${b}` })),
  { name: "Shutter Rotation" },
  { name: "Control" },
  { name: "Effects Speed" },
];
/**
 * The real High End SolaFrame 750 "Standard" layout (47 ch) as Capture's patch view shows it on Reza's Mac (Handoff 21 addendum): start
 * channels and 16-bit pairs are REAL; Capture truncates the names, so everything after the truncated prefix is made up for the test.
 * Test data only — no plugin code knows this fixture.
 */
export const SOLAFRAME_750_PATCH_VIEW: [number, string][] = [
  [1, "Pan"], [3, "Tilt"], [5, "Color Mix Funct"], [6, "Red"], [7, "Green"], [8, "Blue"], [9, "CTO"], [10, "Static Color F"], [11, "Static Color Po"],
  [12, "Gobo 1 Functi"], [13, "Gobo 1 Positio"], [14, "Gobo 1 Rotate"], [15, "Gobo 1 Rotate"],
  [17, "Blade 1 Angle"], [18, "Blade 1 Angle"], [19, "Blade 2 Angle"], [20, "Blade 2 Angle"], [21, "Blade 3 Angle"], [22, "Blade 3 Angle"],
  [23, "Blade 4 Angle"], [24, "Blade 4 Angle"], [25, "Frame Rotatio"], [27, "Animation Fun"], [28, "Prism Functio"], [29, "Prism Rotate"],
  [31, "Frost"], [32, "Focus Coarse"], [34, "Zoom Coarse"], [36, "Auto Focus"], [38, "Iris"], [39, "Shutter/LED F"], [40, "Shutter/LED"],
  [41, "Dim Coarse"], [43, "LED Animatio"], [44, "LED Animatio"], [45, "LED Animatio"], [46, "Mspeed"], [47, "Control"],
];
/** The fine channels of that layout (the gaps in the patch view). */
export const SOLAFRAME_750_FINE = [2, 4, 16, 26, 30, 33, 35, 37, 42];
export const solaFrame750 = (): SynthChannel[] => {
  const full: Record<number, string> = {
    1: "Pan", 3: "Tilt", 5: "Color Mix Function", 6: "Red", 7: "Green", 8: "Blue", 9: "CTO", 10: "Static Color Function", 11: "Static Color Position",
    12: "Gobo 1 Function", 13: "Gobo 1 Position", 14: "Gobo 1 Rotate Function", 15: "Gobo 1 Rotate",
    17: "Blade 1 Angle A", 18: "Blade 1 Angle B", 19: "Blade 2 Angle A", 20: "Blade 2 Angle B", 21: "Blade 3 Angle A", 22: "Blade 3 Angle B",
    23: "Blade 4 Angle A", 24: "Blade 4 Angle B", 25: "Frame Rotation", 27: "Animation Function", 28: "Prism Function", 29: "Prism Rotate",
    31: "Frost", 32: "Focus Coarse", 34: "Zoom Coarse", 36: "Auto Focus", 38: "Iris", 39: "Shutter/LED Functions", 40: "Shutter/LED",
    41: "Dim Coarse", 43: "LED Animation Function", 44: "LED Animation Position", 45: "LED Animation Rotate", 46: "Mspeed", 47: "Control",
  };
  const out: SynthChannel[] = [];
  for (let n = 1; n <= 47; n++) {
    const fine = SOLAFRAME_750_FINE.includes(n);
    const hasFine = SOLAFRAME_750_FINE.includes(n + 1);
    if (fine) {
      const coarse = full[n - 1].replace(/ Coarse$/, "");
      out.push({ name: `${coarse} Fine`, role: 2, pair: n - 2 });
    } else out.push(hasFine ? { name: full[n], role: 1, pair: n } : { name: full[n] });
  }
  return out;
};

/** A conventional: one intensity channel. */
export const conventional = (): SynthChannel[] => [{ name: "Intensity" }];

/** Library.c2z holding objects {'<raw guid>': bytes}. */
export function buildLibraryFile(objects: Record<string, Buffer>): Buffer {
  const data: Buffer[] = [];
  const meta: [string, number, number][] = [];
  let off = 0;
  for (const [guid, b] of Object.entries(objects)) {
    const z = zlib.deflateSync(b);
    meta.push([`${guid}.c2o`, off, b.length]);
    data.push(z);
    off += z.length;
  }
  const tree = Buffer.concat([
    Buffer.from("c2z "),
    Buffer.alloc(12),
    ...meta.map(([n, o, s]) => {
      const t = Buffer.alloc(8);
      t.writeUInt32LE(o);
      t.writeUInt32LE(s, 4);
      return Buffer.concat([Buffer.from(n, "utf16le"), Buffer.from([0, 0]), t]);
    }),
  ]);
  return Buffer.concat([zlib.deflateSync(tree), ...data]);
}

export interface SynthFixture {
  mfr: string;
  name: string;
  mode: string;
  channels: number;
  channel: number;
  fixtureGuid?: string;
  modeGuid?: string;
  /** CaptureInstanceId (raw-order GUID string). */
  instanceId?: string;
  position?: [number, number, number];
  /** FixtureIdentifier as Capture reports it (default 100 + list index; 0xffffffff = not identified). */
  identifier?: number;
  /** v0.10.0: the fixture's patch in "Capture" (1-based). Reported as Patched=1 only after the plugin declared its universes. */
  patch?: { universe: number; address: number };
}

/**
 * A CAEX FixtureList (`type`: 0 existing, 1 new, 2 exchanged). Patched is 0, like Capture 2026 sends it to an undeclared console;
 * with `withPatch` (v0.10.0: the console declared its universes) a fixture with a `patch` is sent as Patched=1 with its address.
 */
export function buildPatchMessage(fixtures: SynthFixture[], type = 0, withPatch = false): Buffer {
  const body: Buffer[] = [Buffer.from([type]), u16(fixtures.length)];
  fixtures.forEach((f, i) => {
    const ids: [number, Buffer][] = [];
    if (f.fixtureGuid) ids.push([0x02, rawGuidBytes(f.fixtureGuid)]);
    if (f.modeGuid) ids.push([0x03, rawGuidBytes(f.modeGuid)]);
    if (f.instanceId) ids.push([0x04, rawGuidBytes(f.instanceId)]);
    const [x, y, z] = f.position ?? [0, 0, 0];
    body.push(
      u32(f.identifier ?? 100 + i),
      ucs2(f.mfr),
      ucs2(f.name),
      ucs2(f.mode),
      u16(f.channels),
      Buffer.from([0]),
      Buffer.from([ids.length]),
      ...ids.flatMap(([t, d]) => [Buffer.from([t]), u16(d.length), d]),
      ...(withPatch && f.patch ? [Buffer.from([1, f.patch.universe - 1]), u16(f.patch.address - 1)] : [Buffer.from([0, 0]), u16(0)]),
      ucs2(""),
      u16(f.channel),
      ucs2(""),
      ucs2(""),
      f32(x),
      f32(y),
      f32(z),
      f32(0),
      f32(0),
      f32(0),
    );
  });
  const inner = Buffer.concat([u32(CAEX.FixtureList), ...body]);
  return Buffer.concat([buildHeader(HEADER_SIZE + inner.length, "CAEX"), inner]);
}

const emptyCaex = (code: number): Buffer => Buffer.concat([buildHeader(HEADER_SIZE + 4, "CAEX"), u32(code)]);
const caex = (code: number, ...parts: Buffer[]): Buffer => {
  const inner = Buffer.concat([u32(code), ...parts]);
  return Buffer.concat([buildHeader(HEADER_SIZE + inner.length, "CAEX"), inner]);
};
export const buildEnterShowMessage = (name: string): Buffer => caex(CAEX.EnterShow, ucs2(name));
export const buildLeaveShowMessage = (): Buffer => emptyCaex(CAEX.LeaveShow);
/** FixtureSelection (0x00020300): u16 count, u32 identifiers. */
export const buildSelectionMessage = (ids: number[]): Buffer => caex(CAEX.FixtureSelection, u16(ids.length), ...ids.map(u32));
/** FixtureRemove (0x00020203): u16 count, u32 identifiers. */
export const buildRemoveMessage = (ids: number[]): Buffer => caex(CAEX.FixtureRemove, u16(ids.length), ...ids.map(u32));

export interface SynthModify {
  identifier: number;
  changed: number;
  patched: number;
  /** 0-based */
  universe: number;
  /** 0-based */
  universeChannel: number;
  unit?: string;
  channel?: number;
  circuit?: string;
  note?: string;
}
/** FixtureModify (0x00020202), spec F 5.7: every field is always present. */
export function buildModifyMessage(items: SynthModify[]): Buffer {
  const body = items.map((m) =>
    Buffer.concat([u32(m.identifier), Buffer.from([m.changed, m.patched, m.universe]), u16(m.universeChannel), ucs2(m.unit ?? ""), u16(m.channel ?? 0), ucs2(m.circuit ?? ""), ucs2(m.note ?? ""), f32(0), f32(0), f32(0), f32(0), f32(0), f32(0)]),
  );
  return caex(CAEX.FixtureModify, u16(items.length), ...body);
}

/** The SDMX Capa the real Capture sent on connect (2026-10-05 probe run): capabilities 2, 3, 4, 101, 102, 105. */
export const REAL_CAPA = Buffer.from("4349545001000000260000000100000053444d58436170610600020003000400650066006900", "hex");
/** SDMX ChBk: "SDMX" + "ChBk" + u8 Blind, u8 UniverseIndex (0-based), u16 FirstChannel (0-based), u16 ChannelCount, u8 levels. */
export function buildChBk(universe: number, address: number, levels: number[], blind = 0): Buffer {
  const body = Buffer.alloc(6 + levels.length);
  body[0] = blind;
  body[1] = universe - 1;
  body.writeUInt16LE(address - 1, 2);
  body.writeUInt16LE(levels.length, 4);
  Buffer.from(levels).copy(body, 6);
  return Buffer.concat([buildHeader(HEADER_SIZE + 4 + body.length, "SDMX"), Buffer.from("ChBk", "latin1"), body]);
}

/**
 * Stub Capture CITP server. After PNam it sends EnterShow; a FixtureListRequest is answered with the whole list (Type 0). A
 * FixtureIdentify sets the identifiers (unless `ignoreIdentify`), like Capture does. Records every message received, and can push
 * unsolicited FixtureSelection / FixtureModify / FixtureList / LeaveShow / EnterShow, or drop the connection.
 */
export class CitpStub {
  readonly received: Buffer[] = [];
  readonly clients = new Set<net.Socket>();
  /** FixtureIdentify entries received, per message: [guidRaw, identifier][] */
  readonly identifies: [string, number][][] = [];
  ignoreIdentify = false;
  /** Do not answer FixtureListRequest (to test the retry). */
  muteList = false;
  /** v0.8.0: after PNam, send the SDMX Capa the real Capture sent on 2026-10-05 (before EnterShow), like Capture does. */
  sendCapa = false;
  /** v0.10.0: connections that sent the SDMX declaration (their lists carry the patch, as on the real Capture). */
  readonly declaredConns = new Set<net.Socket>();
  server!: net.Server;
  port = 0;
  constructor(
    public fixtures: SynthFixture[],
    public showName = "STUB SHOW",
  ) {}

  async listen(port = 0): Promise<this> {
    this.server = net.createServer((c) => {
      this.clients.add(c);
      const framer = new CitpFramer();
      c.write(emptyCaex(CAEX.GetLaserFeedList));
      c.on("data", (d) => {
        for (const m of framer.push(d).messages) {
          this.received.push(m);
          const code = m.toString("latin1", 16, 20) === "CAEX" ? m.readUInt32LE(20) : null;
          if (m.toString("latin1", 16, 24) === "PINFPNam") {
            if (this.sendCapa) c.write(REAL_CAPA);
            c.write(buildEnterShowMessage(this.showName));
          }
          else if (m.toString("latin1", 16, 24) === "SDMXSXSr") this.declaredConns.add(c);
          else if (code === CAEX.FixtureListRequest) {
            if (!this.muteList) c.write(buildPatchMessage(this.fixtures, 0, this.declaredConns.has(c)));
          } else if (code === CAEX.FixtureIdentify) {
            const n = m.readUInt16LE(24);
            const got: [string, number][] = [];
            for (let i = 0; i < n; i++) {
              const o = 26 + i * 20;
              const raw = m.subarray(o, o + 16).toString("hex");
              const guid = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
              const id = m.readUInt32LE(o + 16);
              got.push([guid, id]);
              if (!this.ignoreIdentify) for (const f of this.fixtures) if (f.instanceId === guid) f.identifier = id;
            }
            this.identifies.push(got);
          }
        }
      });
      c.on("error", () => undefined);
      c.on("close", () => {
        this.clients.delete(c);
        this.declaredConns.delete(c);
      });
    });
    await new Promise<void>((res) => this.server.listen(port, "127.0.0.1", () => res()));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }
  push(buf: Buffer): void {
    for (const c of this.clients) c.write(buf);
  }
  select(ids: number[]): void {
    this.push(buildSelectionMessage(ids));
  }
  modify(items: SynthModify[]): void {
    this.push(buildModifyMessage(items));
  }
  list(type = 0, fixtures = this.fixtures): void {
    for (const c of this.clients) c.write(buildPatchMessage(fixtures, type, this.declaredConns.has(c)));
  }
  enterShow(name = this.showName): void {
    this.showName = name;
    this.push(buildEnterShowMessage(name));
  }
  leaveShow(): void {
    this.push(buildLeaveShowMessage());
  }
  /** v0.8.0: an SDMX ChBk (universe 1-based, address 1-based), laid out as the real Capture sends it. */
  chbk(universe: number, address: number, levels: number[], blind = 0): void {
    this.push(buildChBk(universe, address, levels, blind));
  }
  drop(): void {
    for (const c of this.clients) c.destroy();
  }
  /** Messages received with this CAEX code. */
  of(code: number): Buffer[] {
    return this.received.filter((m) => m.toString("latin1", 16, 20) === "CAEX" && m.readUInt32LE(20) === code);
  }
  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export async function startPatchStub(fixtures: SynthFixture[], { showName = "STUB SHOW", port = 0 } = {}): Promise<CitpStub> {
  return new CitpStub(fixtures, showName).listen(port);
}
