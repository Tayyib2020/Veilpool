import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";
import { normalizeEvmAddress, normalizeFheAuthAddresses } from "../src/lib/evmAddress.ts";

const participantB = "0xD406De42bf35bCEf0CB82Fda509C179846b22e6C";
const wrapper = "0xfbC3096644cc41bAa6768897c0de286F79D1578a";
const vault = "0x6E308F5F33abbdd800883e297906dF8de6B68Bd5";

test("normalizes lowercase and already-checksummed EVM addresses", () => {
  assert.equal(normalizeEvmAddress(participantB.toLowerCase()), participantB);
  assert.equal(normalizeEvmAddress(participantB), participantB);
});

test("repairs a valid 20-byte address with an invalid mixed-case checksum", () => {
  const invalidMixedCase = participantB.replace("0xD406", "0xd406");
  assert.notEqual(invalidMixedCase, participantB);
  assert.equal(normalizeEvmAddress(invalidMixedCase), participantB);
});

test("keeps the deployed wrapper and VeilPool vault addresses canonical", () => {
  const normalized = normalizeFheAuthAddresses(wrapper.toLowerCase(), vault.toLowerCase());
  assert.deepEqual(normalized, { contractAddress: wrapper, userAddress: vault });
  assert.equal(getAddress(normalized.contractAddress), wrapper);
  assert.equal(getAddress(normalized.userAddress), vault);
});

test("does not mask malformed non-address input", () => {
  assert.throws(() => normalizeEvmAddress("not-an-address", "FHE user address"), /20-byte hexadecimal address/);
  assert.throws(() => normalizeEvmAddress("0x1234", "FHE user address"), /20-byte hexadecimal address/);
});

test("normalizes both addresses used by the reveal authorization flow", () => {
  const invalidParticipantBCase = participantB.replace("0xD406", "0xd406");
  assert.deepEqual(normalizeFheAuthAddresses(vault.toLowerCase(), invalidParticipantBCase), {
    contractAddress: vault,
    userAddress: participantB,
  });
});
