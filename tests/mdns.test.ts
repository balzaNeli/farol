import assert from "node:assert/strict";
import test from "node:test";

import {
  ANSWER_TTL,
  MDNS_PORT,
  TYPE_A,
  TYPE_AAAA,
  TYPE_TXT,
  buildQuery,
  buildResponse,
  mdnsReply,
  parseDnsMessage,
} from "../src/shared/mdns.ts";

/** A real A query for farol.local, encoded by hand so the parser is not judged by its own encoder. */
const QUERY_BYTES = Buffer.from([
  0x12, 0x34, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // header
  0x05, 0x66, 0x61, 0x72, 0x6f, 0x6c, 0x05, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x00, // farol.local
  0x00, 0x01, 0x00, 0x01, // QTYPE A, QCLASS IN
]);

test("parses a handcrafted A query for farol.local", () => {
  assert.deepEqual(parseDnsMessage(QUERY_BYTES), {
    id: 0x1234,
    isResponse: false,
    questions: [{ name: "farol.local", type: TYPE_A, qu: false }],
    answers: [],
  });
});

test("rejects packets shorter than the DNS header", () => {
  assert.equal(parseDnsMessage(QUERY_BYTES.subarray(0, 11)), null);
  assert.equal(parseDnsMessage(Buffer.alloc(0)), null);
});

test("rejects a query truncated inside the question", () => {
  // header + "farol.local" without the terminator: the name never ends
  assert.equal(parseDnsMessage(QUERY_BYTES.subarray(0, QUERY_BYTES.length - 4)), null);
  // header + full name + QTYPE only: the 2-byte QCLASS is missing
  assert.equal(parseDnsMessage(QUERY_BYTES.subarray(0, QUERY_BYTES.length - 2)), null);
});

test("rejects a label length byte in the reserved range", () => {
  const bad = Buffer.from(QUERY_BYTES);
  bad[12] = 0x40; // 64: neither a label (<64) nor a pointer (0xC0 prefix)
  assert.equal(parseDnsMessage(bad), null);
});

test("rejects names longer than the 255-byte DNS limit", () => {
  const label = Buffer.from([0x3f, ...Buffer.from("a".repeat(63))]);
  const name = Buffer.concat([label, label, label, label, label, Buffer.from([0])]);
  const message = Buffer.concat([QUERY_BYTES.subarray(0, 12), name, Buffer.from([0, 1, 0, 1])]);
  assert.equal(parseDnsMessage(message), null);
});

test("rejects a compression pointer loop", () => {
  const loop = Buffer.from(QUERY_BYTES);
  loop[12] = 0xc0; // pointer that points at itself
  loop[13] = 0x0c;
  assert.equal(parseDnsMessage(loop), null);
});

test("follows a compression pointer inside a question", () => {
  // header | pointer C0 18 (to offset 24) | QTYPE | QCLASS | planted name at offset 24
  const pointed = Buffer.from([
    0x12, 0x34, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xc0, 0x18, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x05, 0x66, 0x61, 0x72, 0x6f, 0x6c, 0x05, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x00,
  ]);
  assert.deepEqual(parseDnsMessage(pointed), {
    id: 0x1234,
    isResponse: false,
    questions: [{ name: "farol.local", type: TYPE_A, qu: false }],
    answers: [],
  });
});

test("flags a response packet and the QU bit", () => {
  const response = Buffer.from(QUERY_BYTES);
  response[2] = 0x80; // QR bit
  const parsed = parseDnsMessage(response);
  assert.ok(parsed !== null);
  assert.equal(parsed.isResponse, true);

  const qu = Buffer.from(QUERY_BYTES);
  qu[27] = 0x80; // top bit of QCLASS: ask for a unicast reply
  assert.deepEqual(parseDnsMessage(qu), {
    id: 0x1234,
    isResponse: false,
    questions: [{ name: "farol.local", type: TYPE_A, qu: true }],
    answers: [],
  });
});

test("buildQuery round-trips through the parser, case preserved", () => {
  const query = buildQuery({ id: 7, name: "Farol.Local", type: TYPE_A, qu: true });
  assert.ok(query !== null);
  assert.deepEqual(parseDnsMessage(query), {
    id: 7,
    isResponse: false,
    questions: [{ name: "Farol.Local", type: TYPE_A, qu: true }],
    answers: [],
  });
});

test("buildQuery rejects invalid names", () => {
  assert.equal(buildQuery({ name: "", type: TYPE_A }), null);
  assert.equal(buildQuery({ name: "farol..local", type: TYPE_A }), null);
  assert.equal(buildQuery({ name: `${"a".repeat(64)}.local`, type: TYPE_A }), null);
  assert.equal(buildQuery({ name: "farol.local\u00e9", type: TYPE_A }), null);
});

test("buildResponse emits an A answer with the TTL and cache-flush bit", () => {
  const response = buildResponse({
    id: 0x1234,
    question: { name: "farol.local", type: TYPE_A, qu: false },
    address: "192.168.0.20",
    ttl: ANSWER_TTL,
  });
  assert.ok(response !== null);
  assert.deepEqual(parseDnsMessage(response), {
    id: 0x1234,
    isResponse: true,
    questions: [{ name: "farol.local", type: TYPE_A, qu: false }],
    answers: [
      { name: "farol.local", type: TYPE_A, flush: true, ttl: ANSWER_TTL, address: "192.168.0.20" },
    ],
  });
});

test("buildResponse returns null for an invalid address and an empty answer for null", () => {
  const question = { name: "farol.local", type: TYPE_A, qu: false };
  assert.equal(
    buildResponse({ id: 1, question, address: "999.1.1.1", ttl: 120 }),
    null,
  );
  assert.equal(
    buildResponse({ id: 1, question, address: "1.2.3", ttl: 120 }),
    null,
  );
  const empty = buildResponse({ id: 1, question, address: null, ttl: 120 });
  assert.ok(empty !== null);
  const parsed = parseDnsMessage(empty);
  assert.ok(parsed !== null);
  assert.equal(parsed.isResponse, true);
  assert.deepEqual(parsed.answers, []);
});

test("answers a legacy unicast query to the source with the id echoed", () => {
  const reply = mdnsReply(QUERY_BYTES, {
    hostname: "farol.local",
    address: "10.0.0.5",
    sourcePort: 51234,
  });
  assert.ok(reply !== null);
  assert.equal(reply.toSource, true);
  assert.deepEqual(parseDnsMessage(reply.packet), {
    id: 0x1234,
    isResponse: true,
    questions: [{ name: "farol.local", type: TYPE_A, qu: false }],
    answers: [{ name: "farol.local", type: TYPE_A, flush: true, ttl: 120, address: "10.0.0.5" }],
  });
});

test("answers a multicast query on multicast with id 0", () => {
  const reply = mdnsReply(QUERY_BYTES, {
    hostname: "farol.local",
    address: "10.0.0.5",
    sourcePort: MDNS_PORT,
  });
  assert.ok(reply !== null);
  assert.equal(reply.toSource, false);
  const parsed = parseDnsMessage(reply.packet);
  assert.ok(parsed !== null);
  assert.equal(parsed.id, 0);
});

test("answers a QU query unicast even when it came from port 5353", () => {
  const quQuery = Buffer.from(QUERY_BYTES);
  quQuery[27] = 0x80;
  const reply = mdnsReply(quQuery, {
    hostname: "farol.local",
    address: "10.0.0.5",
    sourcePort: MDNS_PORT,
  });
  assert.ok(reply !== null);
  assert.equal(reply.toSource, true);
});

test("ignores queries for other names and record types", () => {
  const otherName = buildQuery({ id: 1, name: "other.local", type: TYPE_A });
  assert.ok(otherName !== null);
  assert.equal(
    mdnsReply(otherName, { hostname: "farol.local", address: "10.0.0.5", sourcePort: 51234 }),
    null,
  );

  const txt = buildQuery({ id: 1, name: "farol.local", type: TYPE_TXT });
  assert.ok(txt !== null);
  assert.equal(
    mdnsReply(txt, { hostname: "farol.local", address: "10.0.0.5", sourcePort: 51234 }),
    null,
  );
});

test("does not answer an A query when it has no address", () => {
  assert.equal(
    mdnsReply(QUERY_BYTES, { hostname: "farol.local", address: null, sourcePort: 51234 }),
    null,
  );
});

test("answers AAAA with an empty answer so the resolver does not time out", () => {
  const aaaa = buildQuery({ id: 9, name: "farol.local", type: TYPE_AAAA });
  assert.ok(aaaa !== null);
  const reply = mdnsReply(aaaa, {
    hostname: "farol.local",
    address: "10.0.0.5",
    sourcePort: 51234,
  });
  assert.ok(reply !== null);
  assert.equal(reply.toSource, true);
  const parsed = parseDnsMessage(reply.packet);
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.questions, [{ name: "farol.local", type: TYPE_AAAA, qu: false }]);
  assert.deepEqual(parsed.answers, []);
});

test("ignores responses and garbage", () => {
  const response = Buffer.from(QUERY_BYTES);
  response[2] = 0x80;
  assert.equal(
    mdnsReply(response, { hostname: "farol.local", address: "10.0.0.5", sourcePort: 51234 }),
    null,
  );
  assert.equal(
    mdnsReply(Buffer.from([0x12, 0x34, 0x00]), {
      hostname: "farol.local",
      address: "10.0.0.5",
      sourcePort: 51234,
    }),
    null,
  );
});
