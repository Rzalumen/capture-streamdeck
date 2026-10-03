// sACN (ANSI E1.31) data packet builder. Research only: used by dmx-proof.mjs, nothing else sends DMX.
//
// Layout of one E1.31 DATA packet carrying a full universe (638 bytes), offsets from the start of the UDP payload:
//
//   Root layer (E1.31-2016 "Use of the ACN Root Layer Protocol")
//     0-1    preamble size            0x0010
//     2-3    postamble size           0x0000
//     4-15   ACN packet identifier    "ASC-E1.17" + 3 x 0x00
//     16-17  flags & length           0x7000 | (638 - 16)  = 0x726e
//     18-21  vector                   0x00000004 (VECTOR_ROOT_E131_DATA)
//     22-37  CID                      16 bytes, fixed per sender
//   Framing layer (E1.31-2016 "E1.31 Framing Layer Protocol")
//     38-39  flags & length           0x7000 | (638 - 38)  = 0x7258
//     40-43  vector                   0x00000002 (VECTOR_E131_DATA_PACKET)
//     44-107 source name              UTF-8, 64 bytes, null padded
//     108    priority                 0..200 (default 100)
//     109-110 synchronization address 0 (no synchronization)
//     111    sequence number          increments per packet, wraps at 256
//     112    options                  bit 7 Preview_Data, bit 6 Stream_Terminated, bit 5 Force_Synchronization
//     113-114 universe                big endian
//   DMP layer (E1.31-2016 "DMP Layer Protocol")
//     115-116 flags & length          0x7000 | (638 - 115) = 0x720b
//     117    vector                   0x02 (VECTOR_DMP_SET_PROPERTY)
//     118    address type & data type 0xa1
//     119-120 first property address  0x0000
//     121-122 address increment       0x0001
//     123-124 property value count    513 (start code + 512 slots)
//     125    DMX start code           0x00
//     126-637 slots 1..512
//
// All multi-byte fields are big endian (network order). UDP port 5568. Multicast address for universe U (1..63999):
// 239.255.<U high byte>.<U low byte>. A source that stops sends 3 packets with the Stream_Terminated bit set.
//
// SOURCES. The ANSI E1.31-2016 PDF (https://tsp.esta.org/tsp/documents/docs/E1-31-2016.pdf) answered HTTP 403 to the
// automated fetch in the session that wrote this, so the field table above was NOT read from the PDF. It was taken from the
// layout of two independent open-source implementations that cite that document, whose source was fetched and read:
// hhromic/libe131 (src/e131.c, e131.h: struct sizes 38 + 77 + 523 = 638, flags&length = 0x7000 | length, multicast
// 0xefff0000 | universe, options bit 6 = terminated, bit 7 = preview, default port 5568, default priority 0x64) and
// Hundemeier/sacn (sacn/messages/data_packet.py: the offsets above, 0x40 = Stream_Terminated). Section numbers in
// E1.31-2016 are therefore not quoted; check the table against the spec on first real use.

export const SACN_PORT = 5568;
export const PACKET_SIZE = 638;
export const DEFAULT_PRIORITY = 100;
export const OPT_PREVIEW = 0x80;
export const OPT_TERMINATED = 0x40;
export const OPT_FORCE_SYNC = 0x20;

const ACN_PID = Buffer.from('ASC-E1.17\0\0\0', 'latin1');

/**
 * Per-address priority (ETC extension to E1.31, Handoff 21 --pap): a data packet with the alternate START code 0xDD whose 512 slots are
 * the source's priority for the matching level slot of its 0x00 packets: 1 (lowest) .. 200 (highest), 0 = "ignore my level for this
 * address". Sources: ETC sACN library docs, "Per Address Priority" (https://etclabs.github.io/sACNDocs/2.0.1/per_address_priority.html);
 * ETC support, "Difference between sACN per-address and per-port priority" (an extension to ANSI E1.31, not part of the standard).
 */
export const START_CODE_LEVELS = 0x00;
export const START_CODE_PAP = 0xdd;

/** Priorities for a 0xDD packet: `priority` on slots base .. base+count-1 (0-based), 0 everywhere else. */
export function papSlots({ base, count, priority = DEFAULT_PRIORITY }) {
  if (!Number.isInteger(priority) || priority < 1 || priority > 200) throw new Error(`per-address priority out of range 1..200: ${priority}`);
  if (base < 0 || base + count > 512) throw new Error(`slots ${base + 1}..${base + count} do not fit in 512`);
  const p = new Uint8Array(512);
  p.fill(priority, base, base + count);
  return p;
}

/** Build one data packet. `slots` = up to 512 bytes (missing slots are 0). `startCode` 0x00 = levels, 0xDD = per-address priority. */
export function buildDataPacket({ cid, sourceName, universe, sequence, priority = DEFAULT_PRIORITY, options = 0, slots, startCode = START_CODE_LEVELS }) {
  if (!Buffer.isBuffer(cid) || cid.length !== 16) throw new Error('cid must be a 16-byte Buffer');
  if (!Number.isInteger(universe) || universe < 1 || universe > 63999) throw new Error(`sACN universe out of range 1..63999: ${universe}`);
  if (!Number.isInteger(priority) || priority < 0 || priority > 200) throw new Error(`priority out of range 0..200: ${priority}`);
  if (slots.length > 512) throw new Error(`more than 512 slots: ${slots.length}`);
  const b = Buffer.alloc(PACKET_SIZE);
  b.writeUInt16BE(0x0010, 0);
  b.writeUInt16BE(0x0000, 2);
  ACN_PID.copy(b, 4);
  b.writeUInt16BE(0x7000 | (PACKET_SIZE - 16), 16);
  b.writeUInt32BE(0x00000004, 18);
  cid.copy(b, 22);
  b.writeUInt16BE(0x7000 | (PACKET_SIZE - 38), 38);
  b.writeUInt32BE(0x00000002, 40);
  const name = Buffer.from(sourceName, 'utf8');
  if (name.length > 63) throw new Error('source name longer than 63 bytes');
  name.copy(b, 44);
  b[108] = priority;
  b.writeUInt16BE(0, 109);
  b[111] = sequence & 0xff;
  b[112] = options & 0xff;
  b.writeUInt16BE(universe, 113);
  b.writeUInt16BE(0x7000 | (PACKET_SIZE - 115), 115);
  b[117] = 0x02;
  b[118] = 0xa1;
  b.writeUInt16BE(0x0000, 119);
  b.writeUInt16BE(0x0001, 121);
  b.writeUInt16BE(513, 123);
  if (!Number.isInteger(startCode) || startCode < 0 || startCode > 255) throw new Error(`start code out of range: ${startCode}`);
  b[125] = startCode;
  Buffer.from(slots).copy(b, 126);
  return b;
}

export function multicastAddress(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

/** Decode the fields of a data packet (used by tests and by dmx-proof's own listener checks). Throws if it isn't one. */
export function parseDataPacket(b) {
  if (b.length !== PACKET_SIZE) throw new Error(`E1.31 data packet is ${PACKET_SIZE} bytes, got ${b.length}`);
  if (b.readUInt16BE(0) !== 0x0010 || b.readUInt16BE(2) !== 0 || !b.subarray(4, 16).equals(ACN_PID)) throw new Error('not an ACN root layer');
  if (b.readUInt32BE(18) !== 4 || b.readUInt32BE(40) !== 2 || b[117] !== 2) throw new Error('not an E1.31 data packet');
  const nameEnd = b.indexOf(0, 44);
  return {
    cid: Buffer.from(b.subarray(22, 38)),
    sourceName: b.toString('utf8', 44, nameEnd < 0 || nameEnd > 108 ? 108 : nameEnd),
    priority: b[108], sync: b.readUInt16BE(109), sequence: b[111], options: b[112],
    terminated: (b[112] & OPT_TERMINATED) !== 0, preview: (b[112] & OPT_PREVIEW) !== 0,
    universe: b.readUInt16BE(113), startCode: b[125], slots: Buffer.from(b.subarray(126)),
    rootLength: b.readUInt16BE(16) & 0x0fff, frameLength: b.readUInt16BE(38) & 0x0fff, dmpLength: b.readUInt16BE(115) & 0x0fff,
  };
}
