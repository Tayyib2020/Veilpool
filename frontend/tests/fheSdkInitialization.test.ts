import assert from "node:assert/strict";
import test from "node:test";
import { createFheSdkInitializer, createInitializedFheInstance } from "../src/lib/fheSdkInitialization.ts";

test("initializes the browser FHE WASM before concurrent instance creation", async () => {
  const calls: string[] = [];
  let resolveInitialization: (() => void) | undefined;
  const initialize = () => new Promise<void>((resolve) => {
    calls.push("init-start");
    resolveInitialization = () => {
      calls.push("init-complete");
      resolve();
    };
  });
  const createInstance = createInitializedFheInstance(initialize, async (label: string) => {
    calls.push(`create-${label}`);
    return label;
  });
  const first = createInstance("first");
  const second = createInstance("second");

  assert.deepEqual(calls, ["init-start"]);
  resolveInitialization!();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(calls, ["init-start", "init-complete", "create-first", "create-second"]);
});

test("allows a failed WASM initialization to be retried", async () => {
  let attempts = 0;
  const ensureInitialized = createFheSdkInitializer(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("WASM load failed");
  });

  await assert.rejects(ensureInitialized(), /WASM load failed/);
  await ensureInitialized();
  assert.equal(attempts, 2);
});
