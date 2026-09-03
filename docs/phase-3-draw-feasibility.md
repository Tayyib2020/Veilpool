# Phase 3 draw feasibility spike

This is an experimental benchmark note, not production PrizeEngine design.

## Installed random API

With `@fhevm/solidity` `0.11.1`, the exact available APIs are:

- `FHE.randEuint64()` → encrypted `euint64` with the full type range.
- `FHE.randEuint64(uint64 upperBound)` → encrypted `euint64` in `[0, upperBound)`. The installed implementation requires `upperBound` to be a plaintext power of two.

The result is ACL-authorized transiently to the calling contract by the FHEVM executor. The harness persists the required contract permission with `FHE.allowThis`. It does not grant participants access and does not call `FHE.makePubliclyDecryptable` until `settle()`.

The installed API does not provide an encrypted upper-bound random primitive and does not provide `rem(euint64, euint64)`. Therefore an arbitrary confidential `totalWeight` cannot be mapped exactly to `[0, totalWeight)` in one direct operation. The harness measures the safe fixed-domain alternative: sample from a public power-of-two domain, compare the encrypted target against encrypted `totalWeight`, and return `hasWinner = false` when the target is outside the total. Exact sampling for totals smaller than the domain would require a retry/rejection protocol or another architecture.

## Algorithm

`lock()` freezes encrypted eligibility handles. `draw()` sums encrypted weights, samples the bounded encrypted target, then scans cumulative encrypted weights. The first encrypted comparison `randomTarget < cumulative` selects an encrypted participant index through `FHE.select`. Zero weights do not advance the cumulative total. All-zero snapshots yield `hasWinner = false` and are never silently mapped to participant zero.

`settle()` is the only harness operation that grants public decryption permission to the diagnostic outputs. A Phase 4 round implementation must freeze eligibility before RNG generation and must not expose RNG, cumulative weights, selected index, or winner information before settlement.

## Operation-count model per `draw()`

For `N` participants, excluding the `N` input verifications in `lock()`:

- encrypted additions: `2N` (total and cumulative scans)
- encrypted comparisons: `N + 1` (cumulative comparisons plus target-range check)
- encrypted selects: `N`
- encrypted random operations: `1`
- encrypted boolean operations: `3N` (`not`, `and`, `or`)
- trivial encrypted constants: `N + 3`
- approximate FHE operation calls: `8N + 5`

The weighted scan is therefore linear, `O(N)`. The benchmark reports mocked EVM gas separately from these symbolic FHE operations; mocked gas is not a Sepolia cost estimate.
