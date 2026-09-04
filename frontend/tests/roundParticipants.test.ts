import assert from "node:assert/strict";
import test from "node:test";
import { id, zeroPadValue } from "ethers";
import { loadCurrentRoundDepositEvidence } from "../src/lib/roundParticipants.ts";

const engineAddress = "0x0000000000000000000000000000000000000001";
const vaultAddress = "0x0000000000000000000000000000000000000002";
const roundOpenedTopic = id("RoundOpened(uint256)");
const depositRecordedTopic = id("DepositRecorded(address)");
const accountA = "0x00000000000000000000000000000000000000aa";
const accountB = "0x00000000000000000000000000000000000000bb";

function log(address: string, topics: string[], blockNumber: number, transactionIndex: number, index: number) {
  return { address, topics, data: "0x", blockNumber, transactionIndex, index } as never;
}

test("derives distinct current-round depositors from confirmed logs only", async () => {
  const opening = log(engineAddress, [roundOpenedTopic, zeroPadValue("0x02", 32)], 100, 0, 0);
  const deposits = [
    log(vaultAddress, [depositRecordedTopic, zeroPadValue(accountA, 32)], 90, 0, 0),
    log(vaultAddress, [depositRecordedTopic, zeroPadValue(accountA, 32)], 101, 0, 0),
    log(vaultAddress, [depositRecordedTopic, zeroPadValue(accountA, 32)], 102, 0, 0),
    log(vaultAddress, [depositRecordedTopic, zeroPadValue(accountB, 32)], 103, 0, 0),
  ];
  const provider = {
    getBlockNumber: async () => 105,
    getLogs: async (filter: { address: string; fromBlock: number; toBlock: number }) => {
      if (filter.address === engineAddress) return filter.fromBlock <= 100 && filter.toBlock >= 100 ? [opening] : [];
      return deposits.filter((entry) => entry.blockNumber >= filter.fromBlock && entry.blockNumber <= filter.toBlock);
    },
    getBlock: async (blockNumber: number) => blockNumber === 103 ? { timestamp: 1_000_103 } : null,
  };
  const evidence = await loadCurrentRoundDepositEvidence(provider, engineAddress, vaultAddress, 2n, 1);
  assert.equal(evidence.status, "verified");
  assert.deepEqual(evidence.depositors.map((address) => address.toLowerCase()), [accountA, accountB]);
  assert.equal(evidence.openingBlock, 100);
  assert.equal(evidence.thresholdBlock, 103);
  assert.equal(evidence.thresholdTimestamp, 1_000_103);
  assert.doesNotMatch(JSON.stringify(evidence, (_, value) => typeof value === "bigint" ? value.toString() : value), /amount|handle|wallet|private/i);
});
