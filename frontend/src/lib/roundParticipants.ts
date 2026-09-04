import { getAddress, type BrowserProvider, type Log } from "ethers";
import { useEffect, useState } from "react";

export const CURRENT_ROUND_DEPOSIT_THRESHOLD = 2;
export const CURRENT_ROUND_DEPOSIT_WINDOW_SECONDS = 2 * 60 * 60;
const LOG_CHUNK_SIZE = 10;
const ROUND_OPENED_TOPIC = "0xf5d5acf597a5f9d06a24389ebea67f576c74da4d4a73b97a5dfac2452acad647";
const DEPOSIT_RECORDED_TOPIC = "0xa16ff0a3880537f297b210723087b85eae4eb7a870e2d8edf55d0cc56ef54844";

type PublicLogProvider = Pick<BrowserProvider, "getBlockNumber" | "getLogs" | "getBlock">;

export type CurrentRoundDepositEvidence = {
  status: "idle" | "loading" | "verified" | "unavailable" | "error";
  roundId?: bigint;
  openingBlock?: number;
  openingTransactionIndex?: number;
  depositors: string[];
  thresholdBlock?: number;
  thresholdTimestamp?: number;
  error?: string;
};

const EMPTY_EVIDENCE: CurrentRoundDepositEvidence = { status: "idle", depositors: [] };

function topicRoundId(log: Log): bigint | undefined {
  if (!log.topics[1]) return undefined;
  try { return BigInt(log.topics[1]); } catch { return undefined; }
}

function topicAddress(log: Log): string | undefined {
  const topic = log.topics[1];
  if (!topic || topic.length !== 66) return undefined;
  try { return getAddress(`0x${topic.slice(-40)}`); } catch { return undefined; }
}

function logSortKey(log: Log): [number, number, number] {
  return [log.blockNumber, log.transactionIndex, log.index];
}

function isAfterOpening(log: Log, opening: Log): boolean {
  const left = logSortKey(log);
  const right = logSortKey(opening);
  return left[0] > right[0] || (left[0] === right[0] && (left[1] > right[1] || (left[1] === right[1] && left[2] > right[2])));
}

async function scanLogs(provider: PublicLogProvider, address: string, topic: string, fromBlock: number, toBlock: number): Promise<Log[]> {
  const logs: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = Math.min(toBlock, start + LOG_CHUNK_SIZE - 1);
    logs.push(...await provider.getLogs({ address, topics: [topic], fromBlock: start, toBlock: end }));
  }
  return logs;
}

async function findOpeningLog(provider: PublicLogProvider, engineAddress: string, currentRoundId: bigint, deploymentBlock: number, latestBlock: number): Promise<Log | undefined> {
  for (let end = latestBlock; end >= deploymentBlock; end -= LOG_CHUNK_SIZE) {
    const start = Math.max(deploymentBlock, end - LOG_CHUNK_SIZE + 1);
    const logs = await provider.getLogs({ address: engineAddress, topics: [ROUND_OPENED_TOPIC], fromBlock: start, toBlock: end });
    const matches = logs.filter((log) => topicRoundId(log) === currentRoundId).sort((left, right) => logSortKey(right)[2] - logSortKey(left)[2]);
    if (matches.length) return matches[0];
  }
  return undefined;
}

export async function loadCurrentRoundDepositEvidence(provider: PublicLogProvider, engineAddress: string, vaultAddress: string, roundId: bigint, deploymentBlock: number): Promise<CurrentRoundDepositEvidence> {
  const latestBlock = await provider.getBlockNumber();
  const opening = await findOpeningLog(provider, engineAddress, roundId, deploymentBlock, latestBlock);
  if (!opening) return { status: "unavailable", roundId, depositors: [], error: "The current round opening event is not available." };

  const deposits = (await scanLogs(provider, vaultAddress, DEPOSIT_RECORDED_TOPIC, opening.blockNumber, latestBlock)).filter((log) => isAfterOpening(log, opening));
  deposits.sort((left, right) => {
    const a = logSortKey(left); const b = logSortKey(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  const depositors: string[] = [];
  const seen = new Set<string>();
  let thresholdLog: Log | undefined;
  for (const log of deposits) {
    const address = topicAddress(log);
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    depositors.push(address);
    if (depositors.length === CURRENT_ROUND_DEPOSIT_THRESHOLD) {
      thresholdLog = log;
      break;
    }
  }
  const thresholdBlock = thresholdLog?.blockNumber;
  const block = thresholdBlock === undefined ? undefined : await provider.getBlock(thresholdBlock);
  return { status: "verified", roundId, openingBlock: opening.blockNumber, openingTransactionIndex: opening.transactionIndex, depositors, thresholdBlock, thresholdTimestamp: block?.timestamp };
}

export function useCurrentRoundDepositEvidence(provider: PublicLogProvider | undefined, engineAddress: string | undefined, vaultAddress: string | undefined, roundId: bigint | undefined, roundState: bigint | undefined, refreshNonce = 0): CurrentRoundDepositEvidence {
  const [evidence, setEvidence] = useState<CurrentRoundDepositEvidence>(EMPTY_EVIDENCE);
  useEffect(() => {
    let active = true;
    if (!provider || !engineAddress || !vaultAddress || roundId === undefined || roundState !== 0n) {
      setEvidence(EMPTY_EVIDENCE);
      return () => { active = false; };
    }
    const deploymentBlock = 11_614_349;
    const load = async () => {
      if (active) setEvidence((current) => ({ ...current, status: "loading", roundId, error: undefined }));
      try {
        const next = await loadCurrentRoundDepositEvidence(provider, engineAddress, vaultAddress, roundId, deploymentBlock);
        if (active) setEvidence(next);
      } catch (error) {
        if (active) setEvidence({ status: "error", roundId, depositors: [], error: error instanceof Error ? error.message : "Unable to verify current-round deposits." });
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [engineAddress, provider, refreshNonce, roundId, roundState, vaultAddress]);
  return evidence;
}
