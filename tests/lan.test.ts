import assert from "node:assert/strict";
import test from "node:test";

import { lanAddresses, rankedLanAddresses, preferredLanAddress, type InterfaceMap } from "../src/server/lan.ts";

const entry = (address: string, family = "IPv4", internal = false) => ({ address, family, internal });

test("offers only reachable LAN addresses", () => {
  const interfaces: InterfaceMap = {
    "Wi-Fi": [entry("192.168.1.23"), entry("fe80::a1b2", "IPv6")],
    Ethernet: [entry("10.0.0.7"), entry("169.254.12.9")],
    "Loopback Pseudo-Interface 1": [entry("127.0.0.1", "IPv4", true)],
    "vEthernet (WSL)": undefined,
    Bluetooth: [],
    "Wi-Fi 2": [entry("192.168.1.23")],
  };

  assert.deepEqual(lanAddresses(interfaces), ["10.0.0.7", "192.168.1.23"]);
});

test("says nothing rather than something wrong when there is no network", () => {
  assert.deepEqual(lanAddresses({}), []);
  assert.deepEqual(lanAddresses({ Loopback: [entry("127.0.0.1", "IPv4", true)] }), []);
});

test("rankedLanAddresses: Wi-Fi score 100, Ethernet 80, virtual -200, sorted descending", () => {
  const interfaces: InterfaceMap = {
    "vEthernet (WSL)": [entry("172.20.0.1")],
    Ethernet: [entry("10.0.0.7")],
    "Wi-Fi": [entry("192.168.1.23")],
    Bluetooth: [entry("192.168.50.1")],
  };

  const ranked = rankedLanAddresses(interfaces);
  assert.deepEqual(
    ranked.map((r) => r.address),
    ["192.168.1.23", "10.0.0.7", "192.168.50.1", "172.20.0.1"],
  );
  assert.deepEqual(
    ranked.map((r) => r.score),
    [100, 80, 0, -200],
  );
  assert.deepEqual(
    ranked.map((r) => r.reason),
    ["Wi‑Fi", "Ethernet", "outra física", "virtual"],
  );
});

test("preferredLanAddress returns the highest-scored address (Wi-Fi before Ethernet)", () => {
  const interfaces: InterfaceMap = {
    Ethernet: [entry("10.0.0.7")],
    "Wi-Fi": [entry("192.168.1.23")],
  };

  assert.equal(preferredLanAddress(interfaces), "192.168.1.23");
});

test("preferredLanAddress returns null when no physical interface", () => {
  assert.equal(preferredLanAddress({}), null);
  assert.equal(
    preferredLanAddress({ "vEthernet (WSL)": [entry("172.20.0.1")] }),
    null,
  );
});
