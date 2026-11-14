import assert from "node:assert/strict";
import test from "node:test";

import {
  videoConstraints,
  videoEncodingParams,
  isWindowSurface,
} from "../src/shared/capture.ts";

test("videoConstraints caps the capture instead of asking for an exact size", () => {
  assert.equal(videoConstraints("native"), null);
  assert.deepEqual(videoConstraints("1080p"), {
    width: { max: 1920 },
    height: { max: 1080 },
    frameRate: { ideal: 30, max: 30 },
  });
  assert.deepEqual(videoConstraints("720p"), {
    width: { max: 1280 },
    height: { max: 720 },
    frameRate: { ideal: 30, max: 30 },
  });
});

test("videoConstraints emits only upper bounds, never min or exact", () => {
  for (const quality of ["1080p", "720p"] as const) {
    const text = JSON.stringify(videoConstraints(quality));
    assert.equal(text.includes('"min"'), false, quality);
    assert.equal(text.includes('"exact"'), false, quality);
  }
});

test("videoEncodingParams sets maintain-resolution + scaleResolutionDownBy 1.0 (opção b)", () => {
  const params = videoEncodingParams(5_000_000);
  assert.equal(params.maxBitrate, 5_000_000);
  assert.equal(params.maxFramerate, 30);
  assert.equal(params.degradationPreference, "maintain-resolution");
  assert.equal(params.scaleResolutionDownBy, 1.0);
});

test("isWindowSurface returns true only for 'window'", () => {
  assert.equal(isWindowSurface("window"), true);
  assert.equal(isWindowSurface("screen"), false);
  assert.equal(isWindowSurface(null), false);
  assert.equal(isWindowSurface(undefined), false);
});
