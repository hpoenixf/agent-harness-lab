import test from "node:test";
import assert from "node:assert/strict";
import { supportsNodeVersion } from "../scripts/node-version.mjs";

test("accepts the supported Node 26 range", () => {
  assert.equal(supportsNodeVersion("v26.11.1"), true);
  assert.equal(supportsNodeVersion("26.11.2"), true);
  assert.equal(supportsNodeVersion("26.99.0"), true);
});

test("rejects versions below the minimum, outside major 26, and non-release versions", () => {
  for (const version of ["v26.10.9", "v26.11.0", "v27.0.0", "v25.99.99", "v26.11.1-rc.1", "unknown"]) {
    assert.equal(supportsNodeVersion(version), false, version);
  }
});
