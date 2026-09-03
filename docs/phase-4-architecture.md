# Phase 4 production round and prize engine

Phase 4 adds the production MVP draw layer. It deliberately does not add yield,
TWAB, frontend code, referrals, governance, multiple pools, multiple prize
tiers, NFTs, or Phase 5 functionality.

## Components and limits

- `VeilPool` remains the principal and live-eligibility vault.
- `PrizeEngine` owns round state, frozen eligibility handles, aggregate reveal,
  confidential draw construction, and separate prize-reserve accounting.
- `VeilPool` authorizes exactly one configured `PrizeEngine` to snapshot
  eligibility and credit winnings.
- `maxParticipants` is enforced at `10`, matching the Phase 3 local FHE depth
  benchmark. The `PrizeEngine` also rejects a vault configured above `10`.
- A round requires at least two registered participants before aggregate
  disclosure. The MVP does not confidentially count positive weights, so two
  registered addresses with one zero eligibility can still pass this rule. This
  limitation is explicit: if one participant is known to be zero, the public
  aggregate can reveal the other participant's weight.

## Round state machine

```text
OPEN
  lockRound()
  -> LOCKED
  requestAggregateDecryption()
  -> AWAITING_TOTAL_DECRYPTION
  finalizeAggregateReveal(clear total, proof)
  -> DRAW_READY
  commitRoundPrize(encrypted prize)
  executeDraw()
  -> DRAWING
  requestDrawAcceptance()
  finalizeDrawAcceptance(clear accepted, proof)
  -> SETTLED                 if accepted
  -> RETRY_REQUIRED          if every capped candidate was rejected
  executeDraw()              from RETRY_REQUIRED, with fresh candidates

DRAW_READY + total == 0
  closeEmptyRound()
  -> CANCELLED

SETTLED or CANCELLED
  startNextRound()
  -> OPEN with roundId + 1
```

`LOCKED` freezes the snapshot. Live deposits and withdrawals remain available
in `VeilPool`, but cannot mutate the stored round handles. `closeEmptyRound`
exists so an empty verified round is not permanently stuck and is not falsely
reported as a prize settlement.

## Public aggregate disclosure

Only the encrypted sum of the frozen eligibility handles crosses the public
decryption boundary:

1. `lockRound` obtains fresh snapshot handles from `VeilPool` and computes the
   encrypted aggregate.
2. `requestAggregateDecryption` calls
   `FHE.makePubliclyDecryptable(_totalWeight)`.
3. An off-chain relayer calls `publicDecrypt` and receives the clear total and
   KMS decryption proof.
4. Anyone may call `finalizeAggregateReveal`; `FHE.checkSignatures` verifies
   that proof against the exact aggregate handle and clear value.
5. Only after successful verification is `publicTotalWeight` stored and draw
   construction enabled.

This is intentionally selective disclosure. Individual live balances,
eligibility, frozen weights, accepted targets, winner indices, and winnings are
not made publicly decryptable by the engine.

The lifecycle is necessarily multi-transaction because the public decryption
proof is generated off-chain. The verified public total is then used as public
metadata to derive the RNG domain.

## Snapshot and ACL strategy

`VeilPool.snapshotEligibility` derives a fresh ciphertext by adding encrypted
zero to each live eligibility handle. It grants the vault persistent access and
the engine transient access during the snapshot call. `PrizeEngine` then grants
itself persistent access to the copied handle. This prevents the participant's
ACL on the live eligibility handle from carrying over to the frozen snapshot.

The engine never grants participant access to frozen eligibility, RNG
candidates, accepted target, or winner index. `VeilPool.creditWinnings` grants
only the updated winnings handle to its position owner. There is no admin or
operator decryption backdoor.

## Draw and rejection sampling

The installed `@fhevm/solidity` `0.11.1` API accepts only a plaintext
power-of-two upper bound for `FHE.randEuint64(uint64)`. The engine therefore:

```text
domain = nextPowerOfTwo(publicTotalWeight)
generate exactly RETRY_CAP (5) encrypted candidates in [0, domain)
valid = candidate < publicTotalWeight
encrypted-select the first valid candidate
scan encrypted cumulative weights against that target
```

Rejected values are not stored or emitted. The loop has a fixed public shape,
so the position of the first accepted candidate does not affect gas or timing.
If all five candidates are rejected, the engine makes only the encrypted
acceptance bit publicly decryptable. A verified false bit moves the round to
`RETRY_REQUIRED`; it does not choose a fallback participant or use modulo.
The next `executeDraw` generates fresh candidates.

The acceptance construction is unbiased conditional on acceptance: every
value in `[0, totalWeight)` has equal probability, and selecting the first valid
candidate does not change that conditional distribution. A finite cap means a
no-winner outcome remains possible.

Totals above `2^63` are rejected because their next power of two is `2^64`,
which cannot be passed to the installed `uint64` RNG-bound API. Totals at or
below `2^63` are representable. Encrypted accumulation is `euint64`, so a
production deployment must also bound per-participant eligibility so the sum
cannot wrap.

## Prize accounting

Principal and prize are separate:

- Users deposit confidential vPOOL into the vault and retain ownership of their
  principal.
- A funder separately transfers confidential vPOOL into the engine's prize
  reserve using `fundPrize`.
- The operator allocates an encrypted amount from that reserve with
  `commitRoundPrize`.
- On successful acceptance finalization, the engine transfers that prize to the
  vault and homomorphically credits it to the selected participant's winnings.
- Losers receive encrypted zero; their principal and winnings remain unchanged.

This is a dedicated test/MVP reserve, not yield. Phase 5 can replace the source
of reserve funding with harvested yield without changing the principal/prize
separation.

## Authorization and trust boundary

The configured operator may lock a round, request aggregate decryption, fund or
commit a prize, execute a draw, request acceptance disclosure, close an empty
round, and open the next round. Aggregate and acceptance finalization are
permissionless but require a valid Zama proof bound to the stored ciphertext.

The operator cannot provide randomness, select an index, alter frozen handles,
forge a total, decrypt user balances, settle twice, or bypass the encrypted
winner computation. The operator can choose when to advance lifecycle steps and
can choose the encrypted amount it commits from the separately funded reserve;
that is the explicit MVP trust boundary.

## Privacy tradeoff and minimum participants

Revealing the aggregate is technically practical and follows Zama's official
three-step public-decryption pattern, but it is intentional selective leakage.
With one participant it reveals that participant's exact eligibility. With two
or more participants it does not mathematically reveal each individual value
by itself, although known zero contributions or external side information can
make values inferable. The engine therefore rejects fewer than two registered
participants and documents that this is a conservative MVP rule, not a formal
anonymity guarantee.

The public acceptance result reveals only whether all five fixed candidates were
rejected. It does not reveal candidate values or the rejection count. Draw gas
and timing are independent of which candidate is accepted. The retryable state
is public because the public aggregate is already disclosed and the product
needs a liveness path.

## Phase 5 prerequisites

Before adding yield integration, the project should validate:

- production-network gas/HCU and depth at the enforced N=10 limit;
- reserve solvency and accounting across multiple rounds;
- a policy for the finite no-winner probability;
- whether the two-registered-participant rule is sufficient against expected
  side information;
- eligibility overflow bounds and token-decimal assumptions.

The local suite proves the contract flow and ACL behavior in the embedded mock;
it is not a substitute for Sepolia/coprocessor validation.
