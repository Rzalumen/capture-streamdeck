import test from 'node:test';
import assert from 'node:assert/strict';
import { OPT_TERMINATED, PACKET_SIZE, buildDataPacket, multicastAddress, parseDataPacket } from '../lib/sacn.mjs';

// KNOWN-GOOD VECTOR, written out by hand field by field (not produced by the builder). Layout: ANSI E1.31 data packet as
// implemented by hhromic/libe131 (struct e131_packet_t: root 38 + framing 77 + DMP 523 = 638 bytes) and Hundemeier/sacn.
// CAVEAT: the E1.31-2016 PDF itself could not be fetched when this was written (HTTP 403), so the E1.31 section numbers
// are NOT quoted here; compare this vector with the spec's data-packet tables (root layer, framing layer, DMP layer) on first use.
const CID = '000102030405060708090a0b0c0d0e0f';
const NAME = 'capture-streamdeck dmx-proof';
const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

function expectedPacket({ universe, seq, options, priority, slots }) {
  const name = Buffer.alloc(64); name.write(NAME, 'utf8');
  const dmx = Buffer.alloc(512); Buffer.from(slots).copy(dmx);
  return Buffer.concat([
    hex('0010'),                    // preamble size
    hex('0000'),                    // postamble size
    hex('4153432d45312e31370000 00'), // "ASC-E1.17" + 3 zero bytes
    hex('726e'),                    // root flags (0x7) + length 622
    hex('00000004'),                // VECTOR_ROOT_E131_DATA
    hex(CID),
    hex('7258'),                    // framing flags + length 600
    hex('00000002'),                // VECTOR_E131_DATA_PACKET
    name,
    Buffer.from([priority]),
    hex('0000'),                    // synchronization address
    Buffer.from([seq]),
    Buffer.from([options]),
    Buffer.from([universe >> 8, universe & 0xff]),
    hex('720b'),                    // DMP flags + length 523
    hex('02'),                      // VECTOR_DMP_SET_PROPERTY
    hex('a1'),                      // address type & data type
    hex('0000'),                    // first property address
    hex('0001'),                    // address increment
    hex('0201'),                    // property value count = 513
    hex('00'),                      // DMX start code
    dmx,
  ]);
}

test('E1.31 data packet: byte-exact against a hand-written vector', () => {
  const slots = new Array(512).fill(0); slots[0] = 255; slots[1] = 128; slots[511] = 7;
  for (const c of [
    { universe: 1, seq: 0, options: 0, priority: 100 },
    { universe: 2, seq: 255, options: OPT_TERMINATED, priority: 100 },
    { universe: 0x1234, seq: 9, options: 0x80, priority: 200 },
  ]) {
    const got = buildDataPacket({ cid: hex(CID), sourceName: NAME, universe: c.universe, sequence: c.seq, priority: c.priority, options: c.options, slots });
    const want = expectedPacket({ ...c, slots });
    assert.equal(got.length, 638);
    assert.equal(got.length, PACKET_SIZE);
    assert.equal(got.toString('hex'), want.toString('hex'));
  }
});

test('E1.31: parse round trip, short slot lists are zero filled, 3 terminate frames carry bit 6', () => {
  const p = buildDataPacket({ cid: hex(CID), sourceName: NAME, universe: 7, sequence: 300, options: OPT_TERMINATED, slots: [1, 2, 3] });
  const d = parseDataPacket(p);
  assert.equal(d.universe, 7); assert.equal(d.sequence, 300 & 255); assert.equal(d.terminated, true); assert.equal(d.priority, 100);
  assert.equal(d.sourceName, NAME); assert.equal(d.startCode, 0);
  assert.deepEqual([...d.slots.subarray(0, 4)], [1, 2, 3, 0]);
  assert.equal(d.slots.length, 512);
  assert.equal(d.rootLength, 622); assert.equal(d.frameLength, 600); assert.equal(d.dmpLength, 523);
});

test('E1.31: multicast address and argument checks', () => {
  assert.equal(multicastAddress(1), '239.255.0.1');
  assert.equal(multicastAddress(257), '239.255.1.1');
  assert.equal(multicastAddress(63999), '239.255.249.255');
  const base = { cid: hex(CID), sourceName: NAME, sequence: 0, slots: [] };
  assert.throws(() => buildDataPacket({ ...base, universe: 0 }), /universe/);
  assert.throws(() => buildDataPacket({ ...base, universe: 64000 }), /universe/);
  assert.throws(() => buildDataPacket({ ...base, universe: 1, priority: 201 }), /priority/);
  assert.throws(() => buildDataPacket({ ...base, universe: 1, slots: new Array(513).fill(0) }), /512/);
  assert.throws(() => buildDataPacket({ ...base, cid: Buffer.alloc(15), universe: 1 }), /cid/);
});
