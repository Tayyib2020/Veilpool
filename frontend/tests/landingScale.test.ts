import assert from "node:assert/strict";
import test from "node:test";
import { getLandingScale, getScaledLandingHeight } from "../src/lib/landingScale.ts";

test("landing scale stays desktop-sized above the mobile canvas breakpoint", () => {
  assert.equal(getLandingScale(1440), 1);
  assert.equal(getLandingScale(1024), 1);
});

test("landing scale maps mobile widths to the 1280px virtual canvas", () => {
  assert.equal(getLandingScale(768), 0.6);
  assert.equal(getLandingScale(430), 430 / 1280);
  assert.equal(getLandingScale(390), 390 / 1280);
  assert.equal(getLandingScale(360), 360 / 1280);
});

test("scaled landing height preserves natural document scrolling", () => {
  assert.equal(getScaledLandingHeight(2000, 390), 2000 * (390 / 1280));
  assert.equal(getScaledLandingHeight(2000, 1024), 2000);
});
