import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import test from "node:test";

import {
  ANSWER_TTL,
  LEGACY_TTL,
  MDNS_GROUP,
  MDNS_PORT,
  TYPE_A,
  TYPE_AAAA,
  TYPE_TXT,
  buildQuery,
  buildResponse,
  mdnsReply,
  parseDnsMessage,
  type DnsMessage,
} from "../src/shared/mdns.ts";
import { startMdnsResponder } from "../src/server/mdns.ts";
import { rankedLanAddresses } from "../src/server/lan.ts";

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
  // RFC 6762 section 6.7: a legacy unicast reply must not carry the cache-flush bit, its TTL
  // should not exceed ten seconds, and it must echo the question.
  assert.deepEqual(parseDnsMessage(reply.packet), {
    id: 0x1234,
    isResponse: true,
    questions: [{ name: "farol.local", type: TYPE_A, qu: false }],
    answers: [
      { name: "farol.local", type: TYPE_A, flush: false, ttl: LEGACY_TTL, address: "10.0.0.5" },
    ],
  });
});

test("answers a multicast query on multicast with id 0 and no question", () => {
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
  // RFC 6762 section 6: responses must not contain questions; only legacy replies echo them.
  assert.deepEqual(parsed.questions, []);
  assert.deepEqual(parsed.answers, [
    { name: "farol.local", type: TYPE_A, flush: true, ttl: ANSWER_TTL, address: "10.0.0.5" },
  ]);
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
  // A QU reply follows the multicast rules (section 5.4): multicast format, id 0, no question.
  const parsed = parseDnsMessage(reply.packet);
  assert.ok(parsed !== null);
  assert.equal(parsed.id, 0);
  assert.deepEqual(parsed.questions, []);
  assert.deepEqual(parsed.answers, [
    { name: "farol.local", type: TYPE_A, flush: true, ttl: ANSWER_TTL, address: "10.0.0.5" },
  ]);
});

test("silently ignores a query with a non-zero OPCODE", () => {
  // RFC 6762 section 18.3: only OPCODE 0 (a standard query) is understood.
  const opcodeQuery = Buffer.from(QUERY_BYTES);
  opcodeQuery[2] = 0x10; // OPCODE 2 ("status")
  assert.equal(parseDnsMessage(opcodeQuery), null);
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

/** A bound client socket on loopback: source port is ephemeral, so replies come back unicast. */
function client(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4" });
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolve(socket));
  });
}

/** Sends one query at the responder and resolves with the first reply (2 s guard). */
function ask(socket: Socket, port: number, query: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no mDNS reply")), 2000);
    socket.once("message", (buf: Buffer) => {
      clearTimeout(timer);
      resolve(buf);
    });
    socket.send(query, port, "127.0.0.1", (err) => {
      if (err !== null) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/** Idempotent dgram close: a failed assert mid-test must never leave the runner hung. */
function closeOnce(socket: Socket): () => Promise<void> {
  let closed = false;
  return () =>
    new Promise((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      socket.close(() => resolve());
    });
}

test("the responder replies over a real UDP socket", async (t) => {
  const responder = await startMdnsResponder({
    hostname: "farol.local",
    getAddress: () => "127.0.0.1",
    address: "127.0.0.1",
    multicast: false,
    warn: () => undefined,
  });
  t.after(() => responder.close());
  assert.equal(responder.active, true);

  const socket = await client();
  const closeClient = closeOnce(socket);
  t.after(closeClient);

  const query = buildQuery({ id: 7, name: "farol.local", type: TYPE_A });
  assert.ok(query !== null);
  const reply = await ask(socket, responder.port, query);
  await closeClient();
  await responder.close();

  // The client's source port is ephemeral, so this is a legacy unicast reply (RFC 6762 §6.7).
  assert.deepEqual(parseDnsMessage(reply), {
    id: 7,
    isResponse: true,
    questions: [{ name: "farol.local", type: TYPE_A, qu: false }],
    answers: [
      { name: "farol.local", type: TYPE_A, flush: false, ttl: LEGACY_TTL, address: "127.0.0.1" },
    ],
  });
});

test("the address is resolved at query time, so an IP change needs no restart", async (t) => {
  let address: string | null = "127.0.0.1";
  const responder = await startMdnsResponder({
    hostname: "farol.local",
    getAddress: () => address,
    address: "127.0.0.1",
    multicast: false,
    warn: () => undefined,
  });
  t.after(() => responder.close());

  const socket = await client();
  const closeClient = closeOnce(socket);
  t.after(closeClient);
  const query = buildQuery({ id: 1, name: "farol.local", type: TYPE_A });
  assert.ok(query !== null);

  const first = parseDnsMessage(await ask(socket, responder.port, query));
  address = "10.1.2.3";
  const second = parseDnsMessage(await ask(socket, responder.port, query));
  await closeClient();
  await responder.close();

  assert.ok(first !== null);
  assert.ok(second !== null);
  assert.equal(first.answers[0]?.address, "127.0.0.1");
  assert.equal(second.answers[0]?.address, "10.1.2.3");
});

test("close releases the UDP port", async () => {
  const responder = await startMdnsResponder({
    hostname: "farol.local",
    getAddress: () => null,
    port: 0,
    address: "127.0.0.1",
    multicast: false,
    warn: () => undefined,
  });
  await responder.close();

  // Exclusive rebind: it only succeeds if the responder's socket is truly gone.
  const rebound = await new Promise<boolean>((resolve) => {
    const socket = createSocket({ type: "udp4" });
    socket.once("error", () => resolve(false));
    socket.bind(responder.port, "127.0.0.1", () => {
      socket.close();
      resolve(true);
    });
  });
  assert.equal(rebound, true);
});

test("an occupied port leaves the responder inactive and the caller running", async (t) => {
  const holder = await new Promise<Socket>((resolve, reject) => {
    const socket = createSocket({ type: "udp4" }); // no reuseAddr: Windows binds it exclusively
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolve(socket));
  });
  const closeHolder = closeOnce(holder);
  t.after(closeHolder);
  const warns: string[] = [];
  const responder = await startMdnsResponder({
    hostname: "farol.local",
    getAddress: () => "127.0.0.1",
    port: holder.address().port,
    address: "127.0.0.1",
    multicast: false,
    warn: (message) => warns.push(message),
  });

  assert.equal(responder.active, false);
  // The contract is one non-critical warning: the pre-bind generic listener and the bind-failure
  // listener used to fire on the same event and warn twice.
  assert.equal(warns.length, 1, "the failure must be warned about exactly once, not thrown");
  await responder.close(); // must resolve without hanging
  await closeHolder();
});

test("the multicast responder shuts down cleanly", async () => {
  // Ephemeral port so the test never fights the OS mDNS service for 5353; active-or-not is
  // machine-dependent (firewall, interfaces), but shutdown must always resolve.
  const responder = await startMdnsResponder({
    hostname: "farol.local",
    getAddress: () => "127.0.0.1",
    port: 0,
    warn: () => undefined,
  });
  await responder.close();
});

test("re-announces twice when the address changes, then goes quiet after close", async (t) => {
  // RFC 6762 section 8.4: an address change must be re-announced (twice, a second apart, section
  // 8.3) so caches flush instead of serving a stale IP for the rest of the TTL.
  if (rankedLanAddresses().length === 0) {
    t.skip("needs a joinable multicast interface");
    return;
  }

  let address: string | null = "10.9.8.7";
  const responder = await startMdnsResponder({
    hostname: "farol.local",
    getAddress: () => address,
    changePollMs: 20,
    announceGapMs: 30,
    warn: () => undefined,
  });
  t.after(() => responder.close());
  assert.equal(responder.active, true);

  // A second socket joined to the group on port 5353 hears the responder's announcements.
  const seen: DnsMessage[] = [];
  const ear = createSocket({ type: "udp4", reuseAddr: true });
  let earClosed = false;
  const closeEar = (): Promise<void> =>
    new Promise((resolve) => {
      if (earClosed) {
        resolve();
        return;
      }
      earClosed = true;
      ear.close(() => resolve());
    });
  t.after(closeEar);
  await new Promise<void>((resolve) => ear.bind(MDNS_PORT, "0.0.0.0", () => resolve()));
  ear.addMembership(MDNS_GROUP);
  const farolAnswer = (parsed: DnsMessage | null): boolean =>
    parsed !== null &&
    parsed.isResponse &&
    parsed.answers.some(
      (answer) => answer.name === "farol.local" && answer.type === TYPE_A,
    );
  ear.on("message", (buf: Buffer) => {
    const parsed = parseDnsMessage(buf);
    if (farolAnswer(parsed) && parsed !== null) seen.push(parsed);
  });

  address = "10.1.2.3";
  const deadline = Date.now() + 2000;
  while (seen.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(seen.length >= 2, "both re-announcements must arrive");

  const expected = {
    name: "farol.local",
    type: TYPE_A,
    flush: true,
    ttl: ANSWER_TTL,
    address: "10.1.2.3",
  };
  const first = seen[0];
  const second = seen[1];
  assert.deepEqual(first?.answers, [expected]);
  assert.deepEqual(second?.answers, [expected]);
  assert.deepEqual(first?.questions, []); // multicast format carries no question

  await closeEar();
  await responder.close();

  // The poll must be gone with the responder: a further change announces nothing.
  const after: DnsMessage[] = [];
  const lateEar = createSocket({ type: "udp4", reuseAddr: true });
  let lateClosed = false;
  t.after(
    () =>
      new Promise<void>((resolve) => {
        if (lateClosed) {
          resolve();
          return;
        }
        lateClosed = true;
        lateEar.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve) => lateEar.bind(MDNS_PORT, "0.0.0.0", () => resolve()));
  lateEar.addMembership(MDNS_GROUP);
  lateEar.on("message", (buf: Buffer) => {
    const parsed = parseDnsMessage(buf);
    if (farolAnswer(parsed) && parsed !== null) after.push(parsed);
  });

  address = "10.4.4.4";
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(after.length, 0, "a closed responder must not announce");
});
