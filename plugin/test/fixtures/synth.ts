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
}

/** A CAEX FixtureList. Patched is always 0, like Capture 2026 sends it. */
export function buildPatchMessage(fixtures: SynthFixture[]): Buffer {
  const body: Buffer[] = [Buffer.from([0]), u16(fixtures.length)];
  fixtures.forEach((f, i) => {
    const ids: [number, Buffer][] = [];
    if (f.fixtureGuid) ids.push([0x02, rawGuidBytes(f.fixtureGuid)]);
    if (f.modeGuid) ids.push([0x03, rawGuidBytes(f.modeGuid)]);
    if (f.instanceId) ids.push([0x04, rawGuidBytes(f.instanceId)]);
    const [x, y, z] = f.position ?? [0, 0, 0];
    body.push(
      u32(100 + i),
      ucs2(f.mfr),
      ucs2(f.name),
      ucs2(f.mode),
      u16(f.channels),
      Buffer.from([0]),
      Buffer.from([ids.length]),
      ...ids.flatMap(([t, d]) => [Buffer.from([t]), u16(d.length), d]),
      Buffer.from([0, 0]),
      u16(0),
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

/** Stub Capture CITP server: after PNam it sends EnterShow, answers FixtureListRequest with the list. Records everything received. */
export async function startPatchStub(fixtures: SynthFixture[], { showName = "STUB SHOW" } = {}): Promise<{ server: net.Server; received: Buffer[]; port: number }> {
  const received: Buffer[] = [];
  const server = net.createServer((c) => {
    const framer = new CitpFramer();
    c.write(emptyCaex(CAEX.GetLaserFeedList));
    c.on("data", (d) => {
      for (const m of framer.push(d).messages) {
        received.push(m);
        if (m.toString("latin1", 16, 24) === "PINFPNam") {
          c.write(Buffer.concat([buildHeader(HEADER_SIZE + 4 + (showName.length + 1) * 2, "CAEX"), u32(CAEX.EnterShow), ucs2(showName)]));
        } else if (m.length === 24 && m.readUInt32LE(20) === CAEX.FixtureListRequest) c.write(buildPatchMessage(fixtures));
      }
    });
    c.on("error", () => undefined);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  return { server, received, port: (server.address() as net.AddressInfo).port };
}
