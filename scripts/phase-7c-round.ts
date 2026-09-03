import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, formatUnits, getAddress } from "ethers";
import { createInstance, SepoliaConfig } from "../frontend/node_modules/@zama-fhe/relayer-sdk/node.js";

const CHAIN_ID = 11155111;
const PRINCIPAL = 120_000_000n;
const PRIZE = 11_999_999n;
const ZERO = `0x${"0".repeat(64)}`;
const A = getAddress("0x51133dfa694940Fe4ebC785a5CE11B54f5C86048");
const B = getAddress("0xD406De42bf35bCEf0CB82Fda509C179846b22e6C");

const deployment = JSON.parse(readFileSync("deployments/sepolia.json", "utf8")) as {
  contracts: Record<string, { address: string }>;
  deployer: string;
  operator: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function address(name: string): string {
  const value = deployment.contracts[name]?.address;
  if (!value) throw new Error(`Missing ${name} in deployment artifact`);
  return getAddress(value);
}

function nonzeroHandle(value: string): boolean {
  return value.toLowerCase() !== ZERO;
}

async function wait(label: string, tx: { hash: string; wait(): Promise<unknown> }): Promise<void> {
  console.log(`${label}_TX=${tx.hash}`);
  const receipt = await tx.wait() as { blockNumber?: number } | null;
  if (!receipt || receipt.blockNumber === undefined) throw new Error(`${label} receipt missing`);
  console.log(`${label}_CONFIRMED_BLOCK=${receipt.blockNumber}`);
}

async function publicUint(fhe: Awaited<ReturnType<typeof createInstance>>, handle: string): Promise<{ value: bigint; proof: string }> {
  const result = await fhe.publicDecrypt([handle]);
  const clear = Object.values(result.clearValues)[0];
  if (clear === undefined) throw new Error("public decryption returned no value");
  return { value: BigInt(String(clear)), proof: result.decryptionProof };
}

async function publicBool(fhe: Awaited<ReturnType<typeof createInstance>>, handle: string): Promise<{ value: boolean; proof: string }> {
  const result = await fhe.publicDecrypt([handle]);
  const clear = Object.values(result.clearValues)[0];
  if (typeof clear !== "boolean") throw new Error("public decryption returned a non-boolean");
  return { value: clear, proof: result.decryptionProof };
}

async function main(): Promise<void> {
  const rpcUrl = requiredEnv("SEPOLIA_RPC_URL");
  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID);
  const signer = new Wallet(requiredEnv("DEPLOYER_PRIVATE_KEY"), provider);
  const operator = getAddress(await signer.getAddress());
  if (operator !== getAddress(deployment.operator) || operator !== getAddress(deployment.deployer)) {
    throw new Error("Signer does not match deployed operator/deployer");
  }

  const vaultAddress = address("veilPool");
  const engineAddress = address("prizeEngine");
  const adapterAddress = address("yieldAdapter");
  const vault = new Contract(vaultAddress, [
    "function participantCount() view returns(uint256)",
    "function participantAt(uint256) view returns(address)",
    "function confidentialPrincipalLiability() view returns(bytes32)",
  ], provider);
  const engine = new Contract(engineAddress, [
    "function roundId() view returns(uint256)",
    "function roundState() view returns(uint8)",
    "function confidentialFrozenEligibilityAt(uint256,uint256) view returns(bytes32)",
    "function lockRound()",
    "function requestAggregateDecryption()",
    "function confidentialTotalWeight() view returns(bytes32)",
    "function finalizeAggregateReveal(uint64,bytes)",
    "function commitHarvestedYield(uint256)",
    "function roundPrizeAmount() view returns(uint256)",
    "function prizeCommitted() view returns(bool)",
    "function unallocatedHarvestedYield() view returns(uint256)",
    "function executeDraw()",
    "function requestDrawAcceptance()",
    "function confidentialHasAccepted() view returns(bytes32)",
    "function acceptanceDecryptionRequested() view returns(bool)",
    "function finalizeDrawAcceptance(bool,bytes)",
    "function publicPrincipalLiability() view returns(uint64)",
    "function publicTotalWeight() view returns(uint64)",
    "function roundParticipantCount(uint256) view returns(uint256)",
  ], signer);
  const adapter = new Contract(adapterAddress, [
    "function principalDeployed() view returns(uint256)",
  ], provider);

  const [round, state, count, harvested, prize, committed, principal, deployed] = await Promise.all([
    engine.roundId(), engine.roundState(), vault.participantCount(), engine.unallocatedHarvestedYield(),
    engine.roundPrizeAmount(), engine.prizeCommitted(), engine.publicPrincipalLiability(), adapter.principalDeployed(),
  ]);
  if (round !== 1n || state !== 1n || count !== 2n || harvested !== PRIZE || prize !== 0n || committed || principal !== PRINCIPAL || deployed !== PRINCIPAL) {
    throw new Error(`Locked-state precondition mismatch round=${round} state=${state} count=${count} harvested=${harvested} prize=${prize} committed=${committed} principal=${principal} deployed=${deployed}`);
  }
  if ((await vault.participantAt(0)).toLowerCase() !== A.toLowerCase() || (await vault.participantAt(1)).toLowerCase() !== B.toLowerCase()) {
    throw new Error("Participant snapshot order differs from the verified A/B registry");
  }
  console.log("LOCKED_STATE_PASS round=1 participants=2 principal=120.000000 harvested=11.999999 prize=0 aggregateRequest=false");
  const frozen0 = String(await engine.confidentialFrozenEligibilityAt(1n, 0n));
  const frozen1 = String(await engine.confidentialFrozenEligibilityAt(1n, 1n));
  if (!nonzeroHandle(frozen0) || !nonzeroHandle(frozen1)) throw new Error("Frozen eligibility snapshot handle was zero");
  console.log("LOCK_CHECK_PASS state=LOCKED participants=2 frozenEligibilityHandles=present");

  await wait("REQUEST_AGGREGATE_DECRYPTION", await engine.requestAggregateDecryption());
  if (await engine.roundState() !== 2n) throw new Error("Round did not enter AWAITING_TOTAL_DECRYPTION");
  const fhe = await createInstance({ ...SepoliaConfig, network: rpcUrl, chainId: CHAIN_ID });
  console.log("CREATE_INSTANCE_PASS");
  const aggregateHandle = String(await engine.confidentialTotalWeight());
  if (!nonzeroHandle(aggregateHandle)) throw new Error("Aggregate eligibility handle was zero");
  const aggregate = await publicUint(fhe, aggregateHandle);
  console.log(`AGGREGATE_ELIGIBILITY_REVEALED=${formatUnits(aggregate.value, 6)} mUNDER`);
  if (aggregate.value !== PRINCIPAL) throw new Error(`Aggregate eligibility mismatch: expected ${PRINCIPAL}, observed ${aggregate.value}`);
  await wait("FINALIZE_AGGREGATE_REVEAL", await engine.finalizeAggregateReveal(aggregate.value, aggregate.proof));
  if (await engine.roundState() !== 3n) throw new Error("Round did not enter DRAW_READY");

  const [publicTotal, postFinalizePrincipal, postFinalizeYield, postFinalizePrize, postFinalizeCommitted, postFinalizeCount, postFrozen0, postFrozen1] = await Promise.all([
    engine.publicTotalWeight(), engine.publicPrincipalLiability(), engine.unallocatedHarvestedYield(),
    engine.roundPrizeAmount(), engine.prizeCommitted(), engine.roundParticipantCount(1n),
    engine.confidentialFrozenEligibilityAt(1n, 0n), engine.confidentialFrozenEligibilityAt(1n, 1n),
  ]);
  if (publicTotal !== PRINCIPAL || postFinalizePrincipal !== PRINCIPAL || postFinalizeYield !== PRIZE || postFinalizePrize !== 0n || postFinalizeCommitted || postFinalizeCount !== 2n || String(postFrozen0) !== frozen0 || String(postFrozen1) !== frozen1) {
    throw new Error(`Pre-prize-commit invariant failed total=${publicTotal} principal=${postFinalizePrincipal} yield=${postFinalizeYield} prize=${postFinalizePrize} committed=${postFinalizeCommitted} count=${postFinalizeCount}`);
  }
  console.log("PRE_PRIZE_COMMIT_CHECK_PASS aggregate=120.000000 mUNDER principal=120.000000 mUNDER yield=11.999999 mUNDER participants=2 frozenEligibilityUnchanged=true");

  await wait("COMMIT_HARVESTED_YIELD", await engine.commitHarvestedYield(PRIZE));
  const [committedPrize, prizeAmount, remainingPrincipal] = await Promise.all([engine.prizeCommitted(), engine.roundPrizeAmount(), engine.publicPrincipalLiability()]);
  if (!committedPrize || prizeAmount !== PRIZE || remainingPrincipal !== PRINCIPAL) throw new Error("Prize commit or principal safety check failed");
  console.log(`PRIZE_COMMIT_CHECK_PASS prize=${formatUnits(prizeAmount, 6)} mUNDER principal=${formatUnits(remainingPrincipal, 6)} mUNDER`);
  console.log(`PRE_DRAW_CHECKPOINT_PASS round=1 state=DRAW_READY prize=${formatUnits(prizeAmount, 6)} mUNDER unallocated=${formatUnits(await engine.unallocatedHarvestedYield(), 6)} mUNDER principal=${formatUnits(remainingPrincipal, 6)} mUNDER`);
}

main().catch((error: unknown) => {
  console.error(`PHASE_7C_ROUND_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
