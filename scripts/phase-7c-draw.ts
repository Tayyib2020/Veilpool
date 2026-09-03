import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, formatUnits, getAddress } from "ethers";
import { createInstance, SepoliaConfig } from "../frontend/node_modules/@zama-fhe/relayer-sdk/node.js";

const CHAIN_ID = 11155111;
const PRINCIPAL = 120_000_000n;
const PRIZE = 11_999_999n;
const ZERO_HANDLE = `0x${"0".repeat(64)}`;
const RETRY_CAP = 5;

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

function deployed(name: string): string {
  const value = deployment.contracts[name]?.address;
  if (!value) throw new Error(`Missing ${name} in deployment artifact`);
  return getAddress(value);
}

function nonzeroHandle(value: string): boolean {
  return value.toLowerCase() !== ZERO_HANDLE;
}

async function waitForConfirmation(
  label: string,
  tx: { hash: string; wait(): Promise<{ blockNumber?: number; gasUsed?: bigint } | null> },
): Promise<{ blockNumber: number; gasUsed?: bigint }> {
  console.log(`${label}_TX=${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt?.blockNumber) throw new Error(`${label} receipt missing`);
  console.log(`${label}_CONFIRMED_BLOCK=${receipt.blockNumber}`);
  if (receipt.gasUsed !== undefined) console.log(`${label}_GAS_USED=${receipt.gasUsed.toString()}`);
  return { blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}

async function main(): Promise<void> {
  const rpcUrl = requiredEnv("SEPOLIA_RPC_URL");
  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID);
  const signer = new Wallet(requiredEnv("DEPLOYER_PRIVATE_KEY"), provider);
  const signerAddress = getAddress(await signer.getAddress());
  if (signerAddress !== getAddress(deployment.operator) || signerAddress !== getAddress(deployment.deployer)) {
    throw new Error("Signer does not match deployed operator/deployer");
  }

  const engineAddress = deployed("prizeEngine");
  const engine = new Contract(engineAddress, [
    "function roundId() view returns(uint256)",
    "function roundState() view returns(uint8)",
    "function roundParticipantCount(uint256) view returns(uint256)",
    "function confidentialFrozenEligibilityAt(uint256,uint256) view returns(bytes32)",
    "function publicTotalWeight() view returns(uint64)",
    "function publicPrincipalLiability() view returns(uint64)",
    "function roundPrizeAmount() view returns(uint256)",
    "function prizeCommitted() view returns(bool)",
    "function unallocatedHarvestedYield() view returns(uint256)",
    "function randomDomain() view returns(uint64)",
    "function confidentialAcceptedTarget() view returns(bytes32)",
    "function confidentialWinnerIndex() view returns(bytes32)",
    "function confidentialHasAccepted() view returns(bytes32)",
    "function acceptanceDecryptionRequested() view returns(bool)",
    "function executeDraw()",
    "function requestDrawAcceptance()",
    "function finalizeDrawAcceptance(bool,bytes)",
  ], signer);

  const [round, state, count, total, prize, committed, principal, unallocated, frozen0, frozen1] = await Promise.all([
    engine.roundId(), engine.roundState(), engine.roundParticipantCount(1n), engine.publicTotalWeight(),
    engine.roundPrizeAmount(), engine.prizeCommitted(), engine.publicPrincipalLiability(),
    engine.unallocatedHarvestedYield(), engine.confidentialFrozenEligibilityAt(1n, 0n),
    engine.confidentialFrozenEligibilityAt(1n, 1n),
  ]);
  if (round !== 1n || (state !== 3n && state !== 5n) || count !== 2n || total !== PRINCIPAL || prize !== PRIZE || !committed || principal !== PRINCIPAL || unallocated !== 0n || !nonzeroHandle(String(frozen0)) || !nonzeroHandle(String(frozen1))) {
    throw new Error(`Pre-draw invariant mismatch round=${round} state=${state} participants=${count} total=${total} prize=${prize} committed=${committed} principal=${principal} unallocated=${unallocated}`);
  }
  if (state === 3n) console.log("PRE_DRAW_PASS round=1 state=DRAW_READY participants=2 aggregate=120.000000 prize=11.999999 principal=120.000000");
  else console.log("PRE_DRAW_PASS round=1 state=RETRY_REQUIRED participants=2 aggregate=120.000000 prize=11.999999 principal=120.000000");

  const fhe = await createInstance({ ...SepoliaConfig, network: rpcUrl, chainId: CHAIN_ID });
  console.log("CREATE_INSTANCE_PASS");

  const drawTxs: string[] = [];
  const acceptanceRequestTxs: string[] = [];
  const acceptanceFinalizationTxs: string[] = [];
  const acceptanceResults: boolean[] = [];
  let accepted = false;

  for (let attempt = 1; attempt <= RETRY_CAP; attempt += 1) {
    const draw = await engine.executeDraw();
    drawTxs.push(draw.hash);
    await waitForConfirmation(`EXECUTE_DRAW_${attempt}`, draw);
    const [drawState, domain, target, winnerIndex, acceptedHandle, postDrawTotal, postDrawPrize, postDrawPrincipal, postDrawCount, postDrawFrozen0, postDrawFrozen1] = await Promise.all([
      engine.roundState(), engine.randomDomain(), engine.confidentialAcceptedTarget(), engine.confidentialWinnerIndex(),
      engine.confidentialHasAccepted(), engine.publicTotalWeight(), engine.roundPrizeAmount(),
      engine.publicPrincipalLiability(), engine.roundParticipantCount(1n),
      engine.confidentialFrozenEligibilityAt(1n, 0n), engine.confidentialFrozenEligibilityAt(1n, 1n),
    ]);
    if (drawState !== 4n || domain === 0n || !nonzeroHandle(String(target)) || !nonzeroHandle(String(winnerIndex)) || !nonzeroHandle(String(acceptedHandle)) || postDrawTotal !== PRINCIPAL || postDrawPrize !== PRIZE || postDrawPrincipal !== PRINCIPAL || postDrawCount !== 2n || String(postDrawFrozen0) !== String(frozen0) || String(postDrawFrozen1) !== String(frozen1)) {
      throw new Error(`Encrypted draw invariant failed attempt=${attempt} state=${drawState} domain=${domain} total=${postDrawTotal} prize=${postDrawPrize} principal=${postDrawPrincipal}`);
    }
    console.log(`DRAW_STATE_PASS_${attempt} state=DRAWING encryptedCandidateState=present encryptedSelectionState=present domain=${domain.toString()} plaintextWinner=not_read`);

    const request = await engine.requestDrawAcceptance();
    acceptanceRequestTxs.push(request.hash);
    await waitForConfirmation(`REQUEST_DRAW_ACCEPTANCE_${attempt}`, request);
    if (!(await engine.acceptanceDecryptionRequested())) throw new Error(`Acceptance request flag missing on attempt ${attempt}`);

    const result = await fhe.publicDecrypt([String(await engine.confidentialHasAccepted())]);
    const clear = Object.values(result.clearValues)[0];
    if (typeof clear !== "boolean") throw new Error(`Acceptance public decryption returned non-boolean on attempt ${attempt}`);
    acceptanceResults.push(clear);
    console.log(`ACCEPTANCE_RESULT_${attempt}=${clear ? "ACCEPTED" : "RETRY_REQUIRED"}`);

    const finalize = await engine.finalizeDrawAcceptance(clear, result.decryptionProof);
    acceptanceFinalizationTxs.push(finalize.hash);
    await waitForConfirmation(`FINALIZE_DRAW_ACCEPTANCE_${attempt}`, finalize);
    accepted = clear;
    if (accepted) break;
    if (await engine.roundState() !== 5n) throw new Error(`Rejected acceptance did not enter RETRY_REQUIRED on attempt ${attempt}`);
    console.log(`RETRY_STATE_PASS_${attempt} participantsFrozen=true aggregatePreserved=true prizePreserved=true principalPreserved=true`);
  }

  if (!accepted) throw new Error(`Production draw reached RETRY_REQUIRED after ${RETRY_CAP} attempts`);
  const [finalState, finalRound, finalCount, finalTotal, finalPrize, finalCommitted, finalPrincipal, finalUnallocated, finalFrozen0, finalFrozen1, finalAcceptanceRequested] = await Promise.all([
    engine.roundState(), engine.roundId(), engine.roundParticipantCount(1n), engine.publicTotalWeight(),
    engine.roundPrizeAmount(), engine.prizeCommitted(), engine.publicPrincipalLiability(),
    engine.unallocatedHarvestedYield(), engine.confidentialFrozenEligibilityAt(1n, 0n),
    engine.confidentialFrozenEligibilityAt(1n, 1n), engine.acceptanceDecryptionRequested(),
  ]);
  if (finalState !== 6n || finalRound !== 1n || finalCount !== 2n || finalTotal !== PRINCIPAL || finalPrize !== PRIZE || !finalCommitted || finalPrincipal !== PRINCIPAL || finalUnallocated !== 0n || String(finalFrozen0) !== String(frozen0) || String(finalFrozen1) !== String(frozen1) || finalAcceptanceRequested) {
    throw new Error(`Settlement invariant failed state=${finalState} round=${finalRound} participants=${finalCount} total=${finalTotal} prize=${finalPrize} committed=${finalCommitted} principal=${finalPrincipal} unallocated=${finalUnallocated}`);
  }
  console.log(`SETTLEMENT_PASS round=1 state=SETTLED prize=${formatUnits(finalPrize, 6)} mUNDER principal=${formatUnits(finalPrincipal, 6)} mUNDER attempts=${drawTxs.length} winner_identity=not_read`);
  console.log(`DRAW_TXS=${drawTxs.join(",")}`);
  console.log(`ACCEPTANCE_REQUEST_TXS=${acceptanceRequestTxs.join(",")}`);
  console.log(`ACCEPTANCE_FINALIZATION_TXS=${acceptanceFinalizationTxs.join(",")}`);
  console.log(`ACCEPTANCE_RESULTS=${acceptanceResults.map((value) => value ? "true" : "false").join(",")}`);
  console.log("MANUAL_WINNINGS_REVEAL_REQUIRED");
  await provider.destroy();
}

main().catch((error: unknown) => {
  console.error(`PHASE_7C_DRAW_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
