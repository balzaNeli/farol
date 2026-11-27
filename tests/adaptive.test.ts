import assert from "node:assert/strict";
import test from "node:test";

import {
  initialAdaptiveState,
  MIN_BITRATE_BPS,
  nextAdaptive,
  readSendMetrics,
  TARGET_BITRATE_BPS,
  type AdaptiveSample,
  type AdaptiveState,
} from "../src/shared/capture.ts";

type Quality = Parameters<typeof nextAdaptive>[2];

const BAD_LOSS: AdaptiveSample = { fractionLost: 0.05 };
const GOOD: AdaptiveSample = { qualityLimitationReason: "none", fractionLost: 0.001 };
const NO_EVIDENCE: AdaptiveSample = {};
const CPU: AdaptiveSample = { qualityLimitationReason: "cpu" };

function step(
  state: AdaptiveState,
  sample: AdaptiveSample,
  quality: Quality = "720p",
): AdaptiveState {
  const result = nextAdaptive(state, sample, quality);
  if (result.apply !== null) {
    assert.equal(result.state.maxBitrateBps, result.apply.maxBitrateBps);
    assert.equal(result.state.scaleResolutionDownBy, result.apply.scaleResolutionDownBy);
  }
  return result.state;
}

test("initial adaptive state starts at the target bitrate with full resolution", () => {
  assert.equal(MIN_BITRATE_BPS, 1_500_000);
  assert.equal(initialAdaptiveState().maxBitrateBps, TARGET_BITRATE_BPS);
  assert.deepEqual(initialAdaptiveState(), {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.0,
    downStreak: 0,
    upStreak: 0,
    cpuStreak: 0,
    cpuCooldownTicks: 0,
  });
});

test("native quality ignores every sample and returns the same state object", () => {
  const state = initialAdaptiveState();
  const samples: AdaptiveSample[] = [
    NO_EVIDENCE,
    BAD_LOSS,
    GOOD,
    { qualityLimitationReason: "cpu" },
    { qualityLimitationReason: "bandwidth", fractionLost: 0.1 },
    { qualityLimitationReason: "unknown" },
  ];

  for (const sample of samples) {
    const result = nextAdaptive(state, sample, "native");
    assert.strictEqual(result.state, state);
    assert.strictEqual(result.apply, null);
  }

  // native não pode nem decrementar o cooldown: o objeto volta intacto.
  const cooling: AdaptiveState = {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.5,
    downStreak: 0,
    upStreak: 0,
    cpuStreak: 2,
    cpuCooldownTicks: 3,
  };
  for (const sample of [...samples, CPU]) {
    const result = nextAdaptive(cooling, sample, "native");
    assert.strictEqual(result.state, cooling);
    assert.strictEqual(result.apply, null);
  }
});

test("CPU pressure scales resolution down and clears as soon as the reason changes", () => {
  // Antes bastava uma amostra cpu para abrir a válvula. Com histerese, a primeira amostra
  // apenas conta o streak: reconfigurar o encoder com um único tick causava o flap EX-001.
  const initial = initialAdaptiveState();
  const firstCpu = nextAdaptive(initial, CPU, "720p");
  assert.strictEqual(firstCpu.apply, null);
  assert.equal(firstCpu.state.scaleResolutionDownBy, 1.0);
  assert.equal(firstCpu.state.cpuStreak, 1);

  const cpu = nextAdaptive(firstCpu.state, CPU, "720p");
  assert.deepEqual(cpu.apply, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.5,
  });
  assert.deepEqual(cpu.state, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.5,
    downStreak: 0,
    upStreak: 0,
    cpuStreak: 2,
    cpuCooldownTicks: 0,
  });

  const noneDirect = nextAdaptive(cpu.state, GOOD, "720p");
  assert.deepEqual(noneDirect.apply, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.0,
  });
  assert.equal(noneDirect.state.scaleResolutionDownBy, 1.0);
  assert.equal(noneDirect.state.cpuStreak, 0);
  assert.equal(noneDirect.state.cpuCooldownTicks, 3);

  const bandwidth = nextAdaptive(cpu.state, { qualityLimitationReason: "bandwidth" }, "720p");
  assert.deepEqual(bandwidth.apply, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.0,
  });
  assert.equal(bandwidth.state.scaleResolutionDownBy, 1.0);
  assert.equal(bandwidth.state.downStreak, 1);
  assert.equal(bandwidth.state.cpuStreak, 0);
  assert.equal(bandwidth.state.cpuCooldownTicks, 3);

  const none = nextAdaptive(bandwidth.state, GOOD, "720p");
  assert.strictEqual(none.apply, null);
  assert.deepEqual(none.state, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.0,
    downStreak: 0,
    upStreak: 1,
    cpuStreak: 0,
    cpuCooldownTicks: 2,
  });
});

test("CPU cooldown blocks re-engagement until three ticks have elapsed", () => {
  let state = step(step(initialAdaptiveState(), CPU), CPU); // t1/t2: streak 2 → 1.5
  assert.equal(state.scaleResolutionDownBy, 1.5);

  state = step(state, GOOD); // t3: none devolve 1.0 na mesma amostra e inicia o cooldown
  assert.equal(state.scaleResolutionDownBy, 1.0);
  assert.equal(state.cpuCooldownTicks, 3);

  for (const expectedCooldown of [2, 1]) {
    const result = nextAdaptive(state, CPU, "720p");
    assert.strictEqual(result.apply, null, "cpu dentro do cooldown não reconfigura o encoder");
    assert.equal(result.state.scaleResolutionDownBy, 1.0);
    assert.equal(result.state.cpuCooldownTicks, expectedCooldown);
    state = result.state;
  }
  assert.equal(state.cpuStreak, 2);

  const reengaged = nextAdaptive(state, CPU, "720p"); // t6: cooldown 0, streak 3
  assert.deepEqual(reengaged.apply, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.5,
  });
  assert.equal(reengaged.state.cpuStreak, 3);
  assert.equal(reengaged.state.cpuCooldownTicks, 0);
});

test("bandwidth and unknown samples reset the CPU streak", () => {
  const warming = step(initialAdaptiveState(), CPU);
  assert.equal(warming.cpuStreak, 1);

  for (const sample of [
    { qualityLimitationReason: "bandwidth" },
    { qualityLimitationReason: "unknown" },
    NO_EVIDENCE,
  ]) {
    const reset = nextAdaptive(warming, sample, "720p");
    assert.equal(reset.state.cpuStreak, 0);
    assert.equal(reset.state.scaleResolutionDownBy, 1.0);
    // O streak zerado impede que uma única amostra cpu seguinte abra a válvula.
    assert.strictEqual(nextAdaptive(reset.state, CPU, "720p").apply, null);
  }
});

test("only CPU scales resolution down; every other reason fails closed to 1.0", () => {
  const samples: AdaptiveSample[] = [
    { qualityLimitationReason: "bandwidth" },
    { qualityLimitationReason: "none" },
    { qualityLimitationReason: undefined },
    { fractionLost: null },
    { qualityLimitationReason: "thermal" },
  ];

  for (const sample of samples) {
    const result = nextAdaptive(initialAdaptiveState(), sample, "1080p");
    assert.equal(result.state.scaleResolutionDownBy, 1.0);
    if (result.apply !== null) {
      assert.equal(result.apply.scaleResolutionDownBy, 1.0);
    }
  }
});

test("two consecutive bad samples drop the bitrate by 20% and reset the streak", () => {
  const initial = initialAdaptiveState();
  const first = nextAdaptive(initial, BAD_LOSS, "720p");
  assert.strictEqual(first.apply, null);
  assert.deepEqual(first.state, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.0,
    downStreak: 1,
    upStreak: 0,
    cpuStreak: 0,
    cpuCooldownTicks: 0,
  });

  const second = nextAdaptive(first.state, BAD_LOSS, "720p");
  assert.deepEqual(second.apply, {
    maxBitrateBps: 4_000_000,
    scaleResolutionDownBy: 1.0,
  });
  assert.deepEqual(second.state, {
    maxBitrateBps: 4_000_000,
    scaleResolutionDownBy: 1.0,
    downStreak: 0,
    upStreak: 0,
    cpuStreak: 0,
    cpuCooldownTicks: 0,
  });

  const third = nextAdaptive(second.state, BAD_LOSS, "720p");
  assert.strictEqual(third.apply, null);
  assert.equal(third.state.maxBitrateBps, 4_000_000);
  assert.equal(third.state.downStreak, 1);

  const fourth = nextAdaptive(third.state, BAD_LOSS, "720p");
  assert.deepEqual(fourth.apply, {
    maxBitrateBps: 3_200_000,
    scaleResolutionDownBy: 1.0,
  });
  assert.equal(fourth.state.maxBitrateBps, 3_200_000);
});

test("bandwidth alone counts as a bad sample", () => {
  const bad: AdaptiveSample = { qualityLimitationReason: "bandwidth" };
  let state = initialAdaptiveState();
  state = step(state, bad);
  assert.equal(state.downStreak, 1);
  state = step(state, bad);
  assert.equal(state.maxBitrateBps, 4_000_000);
  assert.equal(state.scaleResolutionDownBy, 1.0);
});

test("five consecutive good samples raise the bitrate by 10% and reset the streak", () => {
  let state: AdaptiveState = {
    maxBitrateBps: 4_000_000,
    scaleResolutionDownBy: 1.0,
    downStreak: 0,
    upStreak: 0,
    cpuStreak: 0,
    cpuCooldownTicks: 0,
  };

  for (let i = 1; i < 5; i += 1) {
    const result = nextAdaptive(state, GOOD, "720p");
    assert.strictEqual(result.apply, null);
    assert.equal(result.state.maxBitrateBps, 4_000_000);
    assert.equal(result.state.upStreak, i);
    state = result.state;
  }

  const fifth = nextAdaptive(state, GOOD, "720p");
  assert.deepEqual(fifth.apply, {
    maxBitrateBps: 4_400_000,
    scaleResolutionDownBy: 1.0,
  });
  assert.deepEqual(fifth.state, {
    maxBitrateBps: 4_400_000,
    scaleResolutionDownBy: 1.0,
    downStreak: 0,
    upStreak: 0,
    cpuStreak: 0,
    cpuCooldownTicks: 0,
  });
});

test("missing or unusable loss evidence resets both streaks", () => {
  const afterBad = step(initialAdaptiveState(), BAD_LOSS);
  assert.equal(afterBad.downStreak, 1);

  const neutral = nextAdaptive(afterBad, NO_EVIDENCE, "720p");
  assert.strictEqual(neutral.apply, null);
  assert.deepEqual(neutral.state, { ...afterBad, downStreak: 0, upStreak: 0 });
  assert.strictEqual(nextAdaptive(neutral.state, BAD_LOSS, "720p").apply, null);

  const fourGood: AdaptiveState = {
    maxBitrateBps: 4_000_000,
    scaleResolutionDownBy: 1.0,
    downStreak: 0,
    upStreak: 4,
    cpuStreak: 0,
    cpuCooldownTicks: 0,
  };
  const notGood: AdaptiveSample[] = [
    NO_EVIDENCE,
    { fractionLost: null },
    { qualityLimitationReason: "none" },
    { qualityLimitationReason: "none", fractionLost: null },
    { qualityLimitationReason: "none", fractionLost: undefined },
    { fractionLost: 0.001 },
  ];

  for (const sample of notGood) {
    const result = nextAdaptive(fourGood, sample, "720p");
    assert.strictEqual(result.apply, null);
    assert.equal(result.state.maxBitrateBps, 4_000_000);
    assert.equal(result.state.upStreak, 0);
    assert.equal(result.state.downStreak, 0);
  }

  const afterReset = nextAdaptive(fourGood, NO_EVIDENCE, "720p").state;
  const firstGoodAgain = nextAdaptive(afterReset, GOOD, "720p");
  assert.strictEqual(firstGoodAgain.apply, null);
  assert.equal(firstGoodAgain.state.upStreak, 1);
});

test("bitrate stays within the floor and ceiling under sustained pressure", () => {
  let state = initialAdaptiveState();
  for (let i = 0; i < 30; i += 1) {
    const atFloor = state.maxBitrateBps === MIN_BITRATE_BPS;
    const result = nextAdaptive(state, BAD_LOSS, "720p");
    if (atFloor) assert.strictEqual(result.apply, null);
    state = result.state;
    assert.ok(state.maxBitrateBps >= MIN_BITRATE_BPS);
    assert.ok(state.maxBitrateBps <= TARGET_BITRATE_BPS);
  }
  assert.equal(state.maxBitrateBps, MIN_BITRATE_BPS);

  // sobem 10% a cada 5 amostras boas: de 1,5 para 5 Mbps levam ~65 amostras
  for (let i = 0; i < 100; i += 1) {
    const atCeiling = state.maxBitrateBps === TARGET_BITRATE_BPS;
    const result = nextAdaptive(state, GOOD, "720p");
    if (atCeiling) assert.strictEqual(result.apply, null);
    state = result.state;
    assert.ok(state.maxBitrateBps >= MIN_BITRATE_BPS);
    assert.ok(state.maxBitrateBps <= TARGET_BITRATE_BPS);
  }
  assert.equal(state.maxBitrateBps, TARGET_BITRATE_BPS);
});

test("LAN oscillation never reduces resolution for bandwidth or loss samples", () => {
  const mixed: AdaptiveSample[] = [
    { qualityLimitationReason: "bandwidth", fractionLost: 0.04 },
    { qualityLimitationReason: "none", fractionLost: 0.001 },
    { qualityLimitationReason: "bandwidth", fractionLost: 0.01 },
    { qualityLimitationReason: "none", fractionLost: 0.03 },
    { qualityLimitationReason: "unknown", fractionLost: 0.04 },
    { qualityLimitationReason: "none", fractionLost: 0 },
  ];

  let state = initialAdaptiveState();
  for (let i = 0; i < 5; i += 1) {
    for (const sample of mixed) {
      const result = nextAdaptive(state, sample, "1080p");
      state = result.state;
      assert.equal(state.scaleResolutionDownBy, 1.0);
      assert.equal(state.cpuStreak, 0, "rede nunca acumula streak de CPU");
      if (result.apply !== null) {
        assert.equal(result.apply.scaleResolutionDownBy, 1.0);
      }
    }
  }
});

test("apply is null without a change and carries both fields when present", () => {
  const initial = initialAdaptiveState();
  assert.strictEqual(nextAdaptive(initial, NO_EVIDENCE, "720p").apply, null);

  // A única amostra cpu não produz apply; a segunda consecutiva é que carrega os dois campos.
  const warming = nextAdaptive(initial, CPU, "720p");
  assert.strictEqual(warming.apply, null);
  const cpu = nextAdaptive(warming.state, CPU, "720p");
  assert.deepEqual(Object.keys(cpu.apply ?? {}).sort(), [
    "maxBitrateBps",
    "scaleResolutionDownBy",
  ]);
  assert.equal(cpu.apply?.maxBitrateBps, cpu.state.maxBitrateBps);
  assert.equal(cpu.apply?.scaleResolutionDownBy, cpu.state.scaleResolutionDownBy);

  const lowered = step(initial, BAD_LOSS);
  const secondBad = nextAdaptive(lowered, BAD_LOSS, "720p");
  assert.deepEqual(Object.keys(secondBad.apply ?? {}).sort(), [
    "maxBitrateBps",
    "scaleResolutionDownBy",
  ]);
});

test("readSendMetrics: primeira amostra não inventa taxas", () => {
  const { counters, metrics } = readSendMetrics(null, {
    framesEncoded: 30, bytesSent: 1_000, timestamp: 3000,
  });
  assert.deepEqual(metrics, { fps: null, bitrateBps: null, limitReason: null });
  assert.deepEqual(counters, { framesEncoded: 30, bytesSent: 1_000, timestamp: 3000 });
});

test("readSendMetrics: delta gera fps e bitrate", () => {
  const { metrics } = readSendMetrics(
    { framesEncoded: 30, bytesSent: 1_000, timestamp: 3000 },
    { framesEncoded: 60, bytesSent: 4_000, timestamp: 6000, qualityLimitationReason: "none" },
  );
  assert.equal(metrics.fps, 10);
  assert.equal(metrics.bitrateBps, 8_000);
  assert.equal(metrics.limitReason, "none");
});

test("readSendMetrics: sem bytesSent o fps continua", () => {
  const { metrics } = readSendMetrics(
    { framesEncoded: 30, bytesSent: null, timestamp: 3000 },
    { framesEncoded: 90, timestamp: 6000 },
  );
  assert.equal(metrics.fps, 20);
  assert.equal(metrics.bitrateBps, null);
});

test("readSendMetrics: timestamp regressivo e deltas negativos não produzem taxas", () => {
  const old = { framesEncoded: 30, bytesSent: 1_000, timestamp: 3000 };
  const regressive = readSendMetrics(old, { framesEncoded: 90, bytesSent: 4_000, timestamp: 2000 });
  assert.equal(regressive.metrics.fps, null);
  assert.equal(regressive.metrics.bitrateBps, null);
  const negative = readSendMetrics(old, { framesEncoded: 10, bytesSent: 500, timestamp: 6000 });
  assert.equal(negative.metrics.fps, null);
  assert.equal(negative.metrics.bitrateBps, null);
});

test("readSendMetrics: valores não finitos limpam contadores e preservam o motivo", () => {
  const { counters, metrics } = readSendMetrics(null, {
    framesEncoded: Number.NaN, bytesSent: Number.POSITIVE_INFINITY, timestamp: 3000,
    qualityLimitationReason: "cpu",
  });
  assert.equal(counters, null);
  assert.deepEqual(metrics, { fps: null, bitrateBps: null, limitReason: "cpu" });
});

test("readSendMetrics: reason nulo e ausente viram limitReason nulo", () => {
  const previous = { framesEncoded: 30, bytesSent: 1_000, timestamp: 3000 };
  const explicit = readSendMetrics(previous, {
    framesEncoded: 60, bytesSent: 2_000, timestamp: 6000, qualityLimitationReason: null,
  });
  const absent = readSendMetrics(previous, {
    framesEncoded: 60, bytesSent: 2_000, timestamp: 6000,
  });
  assert.equal(explicit.metrics.limitReason, null);
  assert.equal(absent.metrics.limitReason, null);
});

test("readSendMetrics: bytesSent não finito não invalida o fps", () => {
  const { counters, metrics } = readSendMetrics(
    { framesEncoded: 30, bytesSent: 1_000, timestamp: 3000 },
    { framesEncoded: 60, bytesSent: Number.NaN, timestamp: 6000 },
  );
  assert.equal(metrics.fps, 10);
  assert.equal(metrics.bitrateBps, null);
  assert.equal(counters?.bytesSent, null);
});
