/**
 * Minimal DNS/mDNS packet codec for the `farol.local` responder — pure functions, no sockets,
 * so the ratchet (`npm run coverage`) measures it like the other shared modules.
 *
 * Scope is deliberately small: parse a question section and build A (or empty) answers for one
 * hostname. Anything that does not parse cleanly returns null and the caller ignores the packet —
 * a responder that answers nothing is always safe.
 */

export const MDNS_PORT = 5353;
export const MDNS_GROUP = "224.0.0.251";
/** Short TTL: an address change must age out of LAN caches in minutes, not hours. */
export const ANSWER_TTL = 120;
/** RFC 6762 section 6.7: a legacy unicast reply's TTL should not exceed ten seconds. */
export const LEGACY_TTL = 10;

export const TYPE_A = 1;
export const TYPE_AAAA = 28;
export const TYPE_TXT = 16;

export type DnsQuestion = { name: string; type: number; qu: boolean };
export type DnsAnswer = { name: string; type: number; flush: boolean; ttl: number; address: string };
export type DnsMessage = {
  id: number;
  isResponse: boolean;
  questions: DnsQuestion[];
  answers: DnsAnswer[];
};

/** How many questions/answers we are willing to walk before calling a packet malformed. */
const MAX_QUESTIONS = 8;
const MAX_ANSWERS = 32;
const MAX_JUMPS = 8;
const MAX_NAME_BYTES = 255;

type NameAt = { name: string; next: number };

/**
 * Reads one (possibly compressed) name starting at `start`. Compression pointers are followed
 * with a jump cap so a crafted loop cannot spin; the reader stops at the first byte past the
 * name inside this packet.
 */
function nameAt(buf: Buffer, start: number): NameAt | null {
  const labels: string[] = [];
  let used = 0;
  let pos = start;
  let jumps = 0;
  let next = -1;
  for (;;) {
    if (pos >= buf.length) return null;
    const length = buf.readUInt8(pos);
    if (length === 0) {
      pos += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return null;
      if (next === -1) next = pos + 2; // the question continues after the first pointer
      jumps += 1;
      if (jumps > MAX_JUMPS) return null;
      pos = ((length & 0x3f) << 8) | buf.readUInt8(pos + 1);
      continue;
    }
    if (length > 63) return null; // the 0x40 / 0x80 high bits are reserved
    used += 1 + length;
    if (used > MAX_NAME_BYTES) return null;
    if (pos + 1 + length > buf.length) return null;
    labels.push(buf.toString("latin1", pos + 1, pos + 1 + length));
    pos += 1 + length;
  }
  if (next === -1) next = pos;
  return { name: labels.join("."), next };
}

/** Encodes a dotted name as DNS labels; null for anything a `.local` responder never needs. */
function encodeName(name: string): Buffer | null {
  if (name.length === 0 || name.length > MAX_NAME_BYTES - 1) return null;
  const parts: Buffer[] = [];
  let used = 0;
  for (const label of name.split(".")) {
    if (label.length === 0 || label.length > 63) return null;
    for (let i = 0; i < label.length; i += 1) {
      if (label.charCodeAt(i) > 0x7f) return null; // DNS names here are ASCII
    }
    const bytes = Buffer.from(label, "latin1");
    used += 1 + bytes.length;
    if (used > MAX_NAME_BYTES) return null;
    parts.push(Buffer.from([label.length]), bytes);
  }
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** The four octets of a dotted IPv4 address, or null when it is not one. */
function ipv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

/**
 * Boundary guard for anything arriving off the UDP socket, mirroring `parseSignal`:
 * rebuild the value or return null so malformed bytes cannot ride along.
 */
export function parseDnsMessage(buf: Buffer): DnsMessage | null {
  if (buf.length < 12) return null;
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  // RFC 6762 section 18.3: messages with an OPCODE other than 0 must be silently ignored, and a
  // rejected parse is exactly that — the caller drops the packet.
  if ((flags & 0x7800) !== 0) return null;
  const questionCount = buf.readUInt16BE(4);
  const answerCount = buf.readUInt16BE(6);
  if (questionCount > MAX_QUESTIONS || answerCount > MAX_ANSWERS) return null;

  let pos = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < questionCount; i += 1) {
    const name = nameAt(buf, pos);
    if (name === null) return null;
    pos = name.next;
    if (pos + 4 > buf.length) return null;
    questions.push({
      name: name.name,
      type: buf.readUInt16BE(pos),
      qu: (buf.readUInt16BE(pos + 2) & 0x8000) !== 0,
    });
    pos += 4;
  }

  const answers: DnsAnswer[] = [];
  for (let i = 0; i < answerCount; i += 1) {
    const name = nameAt(buf, pos);
    if (name === null) return null;
    pos = name.next;
    if (pos + 10 > buf.length) return null;
    const type = buf.readUInt16BE(pos);
    const recordClass = buf.readUInt16BE(pos + 2);
    const ttl = buf.readUInt32BE(pos + 4);
    const dataLength = buf.readUInt16BE(pos + 8);
    pos += 10;
    if (pos + dataLength > buf.length) return null;
    const address =
      type === TYPE_A && dataLength === 4
        ? `${buf.readUInt8(pos)}.${buf.readUInt8(pos + 1)}.${buf.readUInt8(pos + 2)}.${buf.readUInt8(pos + 3)}`
        : "";
    pos += dataLength;
    answers.push({ name: name.name, type, flush: (recordClass & 0x8000) !== 0, ttl, address });
  }

  return { id, isResponse: (flags & 0x8000) !== 0, questions, answers };
}

/** A standard unicast-style query; tests (and only tests) send these at the responder. */
export function buildQuery(options: {
  id?: number;
  name: string;
  type: number;
  qu?: boolean;
}): Buffer | null {
  const name = encodeName(options.name);
  if (name === null) return null;
  const buf = Buffer.alloc(12 + name.length + 4);
  buf.writeUInt16BE(options.id ?? 0, 0);
  buf.writeUInt16BE(0x0000, 2); // standard query, recursion not desired
  buf.writeUInt16BE(1, 4); // QDCOUNT
  name.copy(buf, 12);
  buf.writeUInt16BE(options.type, 12 + name.length);
  buf.writeUInt16BE(options.qu === true ? 0x8001 : 0x0001, 12 + name.length + 2);
  return buf;
}

/**
 * One authoritative answer for a question: an A record when `address` is set (cache-flush bit,
 * so caches replace a stale address instead of keeping both), or an empty answer when it is null
 * — the AAAA case, where "no records" beats letting the resolver time out. A TTL of 0 is the
 * goodbye packet: goodbye = same record, TTL 0.
 */
export function buildResponse(options: {
  id: number;
  question: DnsQuestion;
  address: string | null;
  ttl: number;
  /** Cache-flush bit on the answer (section 10.2); false for legacy unicast replies (section 6.7). */
  flush?: boolean;
  /** Multicast-format responses carry no question (section 6); legacy replies echo it (section 6.7). */
  echoQuestion?: boolean;
}): Buffer | null {
  const flush = options.flush ?? true;
  const echoQuestion = options.echoQuestion ?? true;
  const name = encodeName(options.question.name);
  if (name === null) return null;
  const octets = options.address === null ? null : ipv4Octets(options.address);
  if (options.address !== null && octets === null) return null;
  const hasAnswer = octets !== null;

  const questionLength = echoQuestion ? name.length + 4 : 0;
  const answerLength = hasAnswer ? name.length + 14 : 0; // name + type+class+ttl+rdlength+rdata
  const buf = Buffer.alloc(12 + questionLength + answerLength);
  buf.writeUInt16BE(options.id & 0xffff, 0);
  buf.writeUInt16BE(0x8400, 2); // QR=1, AA=1, RCODE=0
  buf.writeUInt16BE(echoQuestion ? 1 : 0, 4); // QDCOUNT
  buf.writeUInt16BE(hasAnswer ? 1 : 0, 6); // ANCOUNT
  let pos = 12;
  if (echoQuestion) {
    name.copy(buf, pos);
    buf.writeUInt16BE(options.question.type, pos + name.length);
    buf.writeUInt16BE(options.question.qu ? 0x8001 : 0x0001, pos + name.length + 2);
    pos += name.length + 4;
  }
  if (octets !== null) {
    name.copy(buf, pos); // uncompressed answer name: two names in 30-odd bytes total
    pos += name.length;
    buf.writeUInt16BE(TYPE_A, pos);
    buf.writeUInt16BE(flush ? 0x8001 : 0x0001, pos + 2); // cache-flush: this record is unique, replace it
    buf.writeUInt32BE(options.ttl, pos + 4);
    buf.writeUInt16BE(4, pos + 8);
    buf.writeUInt8(octets[0], pos + 10);
    buf.writeUInt8(octets[1], pos + 11);
    buf.writeUInt8(octets[2], pos + 12);
    buf.writeUInt8(octets[3], pos + 13);
  }
  return buf;
}

export type MdnsReply = { packet: Buffer; toSource: boolean };

/**
 * The responder's whole decision, kept pure: what packet to send (if any) and whether it goes
 * back to the sender (legacy / QU queries) or out on multicast. The address is resolved by the
 * caller on every query, so an IP change is answered with the new address without a restart.
 */
export function mdnsReply(
  query: Buffer,
  options: { hostname: string; address: string | null; sourcePort: number },
): MdnsReply | null {
  const message = parseDnsMessage(query);
  if (message === null || message.isResponse) return null;
  const hostname = options.hostname.toLowerCase();
  const question = message.questions.find(
    (q) => q.name.toLowerCase() === hostname && (q.type === TYPE_A || q.type === TYPE_AAAA),
  );
  if (question === undefined) return null;

  const answerAddress = question.type === TYPE_A ? options.address : null;
  if (question.type === TYPE_A && answerAddress === null) return null;
  // RFC 6762 section 6.7: a legacy unicast reply (querier on a port other than 5353, and no QU
  // bit) must not carry the cache-flush bit, should keep the TTL at or under ten seconds, and
  // must echo the question. QU replies follow the multicast rules (section 5.4) instead.
  const legacy = !question.qu && options.sourcePort !== MDNS_PORT;
  const packet = buildResponse({
    id: legacy ? message.id : 0,
    question,
    address: answerAddress,
    ttl: legacy ? LEGACY_TTL : ANSWER_TTL,
    flush: !legacy,
    echoQuestion: legacy,
  });
  if (packet === null) return null;

  return { packet, toSource: question.qu || options.sourcePort !== MDNS_PORT };
}
