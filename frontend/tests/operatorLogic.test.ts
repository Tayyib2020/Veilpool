import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { availableOperatorActions, lifecycleIndex, operatorAccessState, operatorAddressMatches } from "../src/operatorLogic.ts";

test("matches operator addresses case-insensitively without accepting missing addresses", () => {
  assert.equal(operatorAddressMatches("0xAbC", "0xaBc"), true);
  assert.equal(operatorAddressMatches(undefined, "0xabc"), false);
  assert.equal(operatorAddressMatches("0xabc", undefined), false);
});

test("maps wallet state to authorized, unauthorized, disconnected, and configuration states", () => {
  const base = { walletStatus: "connected" as const, connectedAddress: "0xabc", operatorAddress: "0xAbC", hasOperatorConfiguration: true };
  assert.equal(operatorAccessState(base), "authorized");
  assert.equal(operatorAccessState({ ...base, connectedAddress: "0xdef" }), "unauthorized");
  assert.equal(operatorAccessState({ ...base, walletStatus: "disconnected", connectedAddress: undefined }), "disconnected");
  assert.equal(operatorAccessState({ ...base, hasOperatorConfiguration: false, operatorAddress: undefined }), "missing_configuration");
  assert.equal(operatorAccessState({ ...base, walletStatus: "wrong-network" }), "wrong_network");
});

test("exposes only valid open and draw actions for the current lifecycle", () => {
  assert.deepEqual(availableOperatorActions({ state: "OPEN", participantCount: 1n, unallocatedHarvestedYield: 0n, prizeCommitted: false, acceptanceDecryptionRequested: false, adapterConfigured: false, principalSyncPending: false, principalUnwrapPending: false, principalDeployed: 0n }), []);
  assert.deepEqual(availableOperatorActions({ state: "OPEN", participantCount: 2n, unallocatedHarvestedYield: 4n, prizeCommitted: false, acceptanceDecryptionRequested: false, adapterConfigured: true, principalSyncPending: false, principalUnwrapPending: false, principalDeployed: 0n }), ["request_principal_deployment", "harvest_yield", "lock_round"]);
});

test("maps retry-required and encrypted acceptance states without exposing winner controls", () => {
  assert.deepEqual(availableOperatorActions({ state: "RETRY_REQUIRED", participantCount: 2n, publicTotalWeight: 3n, unallocatedHarvestedYield: 0n, prizeCommitted: true, acceptanceDecryptionRequested: false, adapterConfigured: false, principalSyncPending: false, principalUnwrapPending: false, principalDeployed: 0n }), ["execute_draw"]);
  assert.deepEqual(availableOperatorActions({ state: "DRAWING", participantCount: 2n, unallocatedHarvestedYield: 0n, prizeCommitted: true, acceptanceDecryptionRequested: true, adapterConfigured: false, principalSyncPending: false, principalUnwrapPending: false, principalDeployed: 0n }), ["finalize_draw_acceptance"]);
});

test("operator writes use the connected wallet signer while reads stay provider-backed", () => {
  const source = readFileSync(new URL("../src/OperatorPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /const readEngine = contracts\.engine/);
  assert.match(source, /const writeEngine = contracts\.engine\.connect\(wallet\.signer\)/);
  assert.equal([...source.matchAll(/tx = await contracts\.engine\./g)].length, 0);
  assert.match(source, /start_next_round/);
  assert.match(source, /`Start Round #\$\{state\.roundId \+ 1n\}`/);
});

test("keeps lifecycle ordering stable for the public state timeline", () => {
  assert.equal(lifecycleIndex("OPEN"), 0);
  assert.equal(lifecycleIndex("DRAW_READY"), 3);
  assert.equal(lifecycleIndex("UNKNOWN"), -1);
});
