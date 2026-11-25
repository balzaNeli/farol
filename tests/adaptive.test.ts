import assert from "node:assert/strict";
import test from "node:test";

import {
  initialAdaptiveState,
  MIN_BITRATE_BPS,
  nextAdaptive,
  TARGET_BITRATE_BPS,
  type AdaptiveSample,
  type AdaptiveState,
} from "../src/shared/capture.ts";

type Quality = Parameters<typeof nextAdaptive>[2];

const BAD_LOSS: AdaptiveSample = { fractionLost: 0.05 };
const GOOD: AdaptiveSample = { qualityLimitationReason: "none", fractionLost: 0.001 };
const NO_EVIDENCE: AdaptiveSample = {};

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
});

test("CPU pressure scales resolution down and clears as soon as the reason changes", () => {
  const initial = initialAdaptiveState();
  const cpu = nextAdaptive(initial, { qualityLimitationReason: "cpu" }, "720p");
  assert.deepEqual(cpu.apply, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.5,
  });
  assert.deepEqual(cpu.state, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.5,
    downStreak: 0,
    upStreak: 0,
  });

  const noneDirect = nextAdaptive(cpu.state, GOOD, "720p");
  assert.deepEqual(noneDirect.apply, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.0,
  });
  assert.equal(noneDirect.state.scaleResolutionDownBy, 1.0);

  const bandwidth = nextAdaptive(cpu.state, { qualityLimitationReason: "bandwidth" }, "720p");
  assert.deepEqual(bandwidth.apply, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.0,
  });
  assert.equal(bandwidth.state.scaleResolutionDownBy, 1.0);
  assert.equal(bandwidth.state.downStreak, 1);

  const none = nextAdaptive(bandwidth.state, GOOD, "720p");
  assert.strictEqual(none.apply, null);
  assert.deepEqual(none.state, {
    maxBitrateBps: 5_000_000,
    scaleResolutionDownBy: 1.0,
    downStreak: 0,
    upStreak: 1,
  });
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
      if (result.apply !== null) {
        assert.equal(result.apply.scaleResolutionDownBy, 1.0);
      }
    }
  }
});

test("apply is null without a change and carries both fields when present", () => {
  const initial = initialAdaptiveState();
  assert.strictEqual(nextAdaptive(initial, NO_EVIDENCE, "720p").apply, null);

  const cpu = nextAdaptive(initial, { qualityLimitationReason: "cpu" }, "720p");
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
