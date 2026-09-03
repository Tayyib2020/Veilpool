# Phase 3.5 rejection-sampling design spike

This is an experimental architecture note and harness. It does not implement
`PrizeEngine`, yield integration, frontend code, TWAB, VeilPool deposits, or
Phase 4 production draw logic.

## Result

The cleanest tested construction is fixed-cap homomorphic rejection sampling:

1. Freeze encrypted eligibility at lock.
2. Compute the encrypted aggregate total.
3. Make only that aggregate handle publicly decryptable.
4. Finalize the public total with the asynchronous KMS proof.
5. Derive `domain = nextPowerOfTwo(publicTotalWeight)`.
6. Generate exactly `retryCap` encrypted candidates from `[0, domain)`.
7. Homomorphically retain the first candidate for which `candidate < publicTotalWeight`.
8. Scan encrypted cumulative eligibility against the accepted target.
9. Make the accepted target and winner result public only at settlement.

The construction is unbiased conditional on acceptance. Every accepted target in
`[0, totalWeight)` has the same probability, and the first-valid selection does
not change that distribution. If all fixed-cap candidates are rejected, the
harness produces no winner rather than selecting an invalid participant.

This is a viable design direction, but it is not yet production-worthy for
Phase 4 without a product decision on aggregate leakage, a production-network
FHE benchmark, and a policy for finite-cap no-winner outcomes.

## Installed API inspection

The project remains pinned to:

- `@fhevm/solidity` `0.11.1`
- `@fhevm/hardhat-plugin` `0.4.2`
- `@fhevm/mock-utils` `0.4.2`
- `@openzeppelin/confidential-contracts` `0.5.3`

The installed `@fhevm/solidity/lib/FHE.sol` exposes:

```solidity
FHE.randEuint64() returns (euint64)
FHE.randEuint64(uint64 upperBound) returns (euint64)
FHE.makePubliclyDecryptable(euint64 value)
FHE.checkSignatures(bytes32[] handles, bytes abiEncodedCleartexts, bytes proof)
```

The bounded random bound must be a plaintext power of two. The installed API
does not expose an encrypted upper-bound random operation or encrypted modulo
by an arbitrary encrypted total. Repeated random calls are accepted by the
local executor and were benchmarked in the harness.

The local test utility's `publicDecrypt` returns clear values, an ABI-encoded
clear value, and a decryption proof. The production-safe contract pattern is
to verify that proof in a separate callback/finalization transaction with
`FHE.checkSignatures`, as the OpenZeppelin confidential wrapper does for
`finalizeUnwrap`.

References: [Zama public decryption documentation](https://docs.zama.org/protocol/solidity-guides/smart-contract/oracle),
[OpenZeppelin confidential token API](https://docs.openzeppelin.com/confidential-contracts/api/token),
and the installed source at
`node_modules/@fhevm/solidity/lib/FHE.sol`.

## Exact lifecycle

The harness lifecycle is:

```text
OPEN
  -- lock(encrypted eligibility, input proof)
  --> AGGREGATE_REVEAL_PENDING
        encrypted total is computed
        only total is made publicly decryptable
  -- off-chain publicDecrypt(total) + KMS proof
  -- finalizeAggregateReveal(clear total, proof)
  --> AGGREGATE_REVEALED
        public total is stored; eligibility remains encrypted
  -- draw()
  --> DRAWING
        fixed-cap encrypted rejection sampling + encrypted scan
  -- settle()
  --> SETTLED
        accepted target and winner result become publicly decryptable
```

This requires multiple transactions because public decryption is asynchronous:

- `lock` freezes the snapshot and requests aggregate disclosure.
- A relayer/KMS service returns the clear aggregate and proof off-chain.
- Anyone may submit `finalizeAggregateReveal`; the contract verifies the proof.
- `draw` is then a separate transaction because the public domain is not known
  until finalization.
- `settle` is the explicit public-result stage.

No deposit, withdrawal, or second lock is available after the snapshot is
frozen in the harness. A production round must preserve that invariant through
aggregate finalization and draw construction.

## Rejection strategy evaluation

### Option A: variable retry loop in one transaction

This is unbiased if it eventually accepts, but it has an unbounded execution
and gas risk. A strict cap turns it into a finite-failure design, but a branch
that stops on the first acceptance can expose the number of attempts through
gas or timing. It was not selected.

### Option B: fixed candidates and homomorphic first-valid selection

The harness generates exactly `retryCap` candidates. It computes each validity
bit, then uses encrypted `select` and `or` operations to retain the first valid
candidate without storing or revealing rejected candidates. Every attempt has
the same public execution shape, so rejection history and actual acceptance
position are not public. This is the selected design.

### Option C: multi-transaction retry

This avoids one large transaction, but each retry creates an operational
transcript. A public success/failure result, retry timing, or a caller choosing
when to submit the next transaction can leak information about the total. It
also complicates liveness and round ownership. It is not the preferred MVP
construction.

The fixed-cap design still has a finite no-winner probability. A production
engine must decide whether to carry that outcome into a later round, use a
larger cap, or adopt a different random beacon/design.

## Acceptance and rejection probabilities

For total `T`, the domain is the smallest power of two `D >= T`.

`acceptance = T / D` and `rejection = (D - T) / D`.

| Total | Domain | Acceptance | Rejection |
|---:|---:|---:|---:|
| 1 | 1 | 100.000000% | 0.000000% |
| 2 | 2 | 100.000000% | 0.000000% |
| 3 | 4 | 75.000000% | 25.000000% |
| 5 | 8 | 62.500000% | 37.500000% |
| 10 | 16 | 62.500000% | 37.500000% |
| 17 | 32 | 53.125000% | 46.875000% |
| 31 | 32 | 96.875000% | 3.125000% |
| 32 | 32 | 100.000000% | 0.000000% |
| 33 | 64 | 51.562500% | 48.437500% |
| 63 | 64 | 98.437500% | 1.562500% |
| 64 | 64 | 100.000000% | 0.000000% |
| 65 | 128 | 50.781250% | 49.218750% |
| 100 | 128 | 78.125000% | 21.875000% |
| 127 | 128 | 99.218750% | 0.781250% |
| 128 | 128 | 100.000000% | 0.000000% |
| 129 | 256 | 50.390625% | 49.609375% |
| 255 | 256 | 99.609375% | 0.390625% |
| 256 | 256 | 100.000000% | 0.000000% |
| 257 | 512 | 50.195313% | 49.804688% |
| 500 | 512 | 97.656250% | 2.343750% |
| 1000 | 1024 | 97.656250% | 2.343750% |

For an independent fixed-cap sequence, the no-acceptance probability is
`rejection^A`, where `A` is the cap. At total `129` (near the worst case in
the table), the estimated no-acceptance probability is:

| Attempts | No-acceptance probability |
|---:|---:|
| 1 | 49.609375% |
| 2 | 24.610901% |
| 3 | 12.209314% |
| 4 | 6.056964% |
| 5 | 3.004822% |

The limiting worst case just above a power-of-two boundary approaches 50%
rejection, so the cap cannot make failure negligible for every possible total.
For totals close to a power of two, cap 5 is much safer; for a worst-case total
it still leaves approximately 3.125% no-acceptance probability. Cap 5 is a
reasonable spike value, not a final economic or liveness policy.

## N=10 benchmark

The benchmark uses ten participants with a positive total of 1024, and measures
the `draw` transaction only. Gas is from the local Hardhat/fhEVM mock and is not
a Sepolia production estimate. `globalHCU` and `maxHCUDepth` are mock executor
measurements.

| N | Cap | Gas | Global HCU | Max HCU depth | Approx. FHE ops |
|---:|---:|---:|---:|---:|---:|
| 10 | 1 | 1,927,179 | 4,645,534 | 1,871,032 | 92 |
| 10 | 2 | 2,120,835 | 4,918,536 | 1,871,032 | 98 |
| 10 | 3 | 2,314,482 | 5,192,538 | 1,871,032 | 104 |
| 10 | 5 | 2,701,785 | 5,740,542 | 1,871,032 | 116 |

The approximate operation model is `6A + 7N + (N + 6)`, where `A` is the
retry cap and `N` is participant count. The retry portion is linear and cap 5
did not change the observed maximum handle depth in this local run. This is
comfortable for the existing N=10 spike margin, but the previous Phase 3
linear scan already hit the local mock's `HCUTransactionDepthLimitExceeded`
around N=30, so a production benchmark remains necessary.

## Privacy and leakage analysis

- Individual eligibility handles remain encrypted and unauthorized users cannot
  decrypt them in the tests.
- The aggregate total is intentionally public after lock finalization. It does
  not reveal individual weights in the normal multi-participant case, but it is
  still useful side information when balances or eligibility are correlated
  with other public facts.
- With one participant, `totalWeight` exactly equals that participant's weight.
  The harness tests and documents this unavoidable leakage.
- With two participants, the aggregate is not by itself either individual
  weight, but a known zero/known contribution can make the other contribution
  inferable. More participants reduce this risk but do not cryptographically
  eliminate side-channel inference.
- Rejected candidates are not returned, emitted, or made publicly decryptable.
  The draw performs a fixed number of attempts, so gas/timing does not reveal
  which attempt accepted.
- The harness does not expose an actual retry count. A public `hasAccepted=false`
  after settlement reveals that all capped attempts failed; this is a weak
  probabilistic signal about the public total, not a rejected-value disclosure.
- A failed `draw` transaction is reserved for explicit public edge conditions
  such as zero total or an unrepresentable random domain. Rejection itself does
  not revert, so it does not create a rejection-dependent transaction trace.

Recommended production policy: require at least two participants before public
aggregate reveal, and document that this is a minimum privacy threshold rather
than a formal guarantee. The one-participant case should be rejected or use a
different private draw path. The harness intentionally does not enforce this
policy because it must test the leakage edge case.

## Edge cases

- `totalWeight == 0`: aggregate may be finalized as zero, but `draw` reverts
  with `NoEligibleWeight`; no random draw occurs.
- `totalWeight == 1`: the only valid target is zero. The harness uses the
  mathematically equivalent encrypted zero path because the local mock has a
  zero-bit bug for `randEuint64(1)`.
- A power-of-two total uses the full domain and has zero rejection probability.
- A total just above a power-of-two boundary has nearly 50% rejection.
- `nextPowerOfTwo` is checked through `2^63`. Totals greater than `2^63` would
  require the unrepresentable bound `2^64` and revert with
  `RandomDomainOverflow`.
- Eligibility accumulation is `euint64`; production code must bound or
  otherwise account for aggregate overflow before adopting this design.

## Files

- `contracts/experiments/RejectionSamplingHarness.sol` — experimental
  aggregate-reveal and fixed-cap rejection-sampling harness.
- `test/RejectionSamplingHarness.ts` — focused lifecycle, ACL, privacy,
  probability-construction, edge-case, and N=10 benchmark tests.
- `docs/phase-3-5-rejection-sampling.md` — this design and feasibility report.

No dependency versions changed. Phase 1 and Phase 2 production behavior was not
modified, and no Phase 4 code was added.
