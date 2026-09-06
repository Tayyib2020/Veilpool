# Phase 7C Sepolia E2E evidence

> Historical V1 evidence, preserved unchanged below. V1 is deprecated as a
> canonical frontend target. See [isolated canonical E2E](canonical-sepolia.md)
> for the current deployment and successful confidential winnings withdrawal.

## Principal deployment and controlled-yield checkpoint

This record covers the complete validated production lifecycle for Round 1:
principal deployment, controlled Sepolia yield, encrypted draw and settlement,
participant-authorized reveals, principal restoration, private withdrawal, and
the final confidential-wrapper unwrap into public Sepolia mUNDER.

### Public transactions

- Principal sync request: `0xb503ff91bffc67893c9a571ab5a5cd810340173d09177898552bbcd00a62916f`
- Principal aggregate finalization: `0x0333d0e529e6f26cb26e3beb5d28ee8fb5832e84e1044e5a5d2253f899da5080`
- Async unwrap finalization: `0xc0e80f8100e84e63b4752477aede39eb9387342a106ceef2ec9700d2b1cbccfa`
- Yield-vault approval: `0x2efb905f77d0bd5a8a1f3fae4ea1ad70b85a9223371343ceaf1625f4f681dcff`
- Controlled yield injection: `0xff880696a19b35b5112244022ebea849febc50b6a5e0828fffdf6cd8edf07b99`

### Aggregate disclosure

The authorized public decryption of the pool-level pending principal
liability returned `120.0 mUNDER`. No individual participant balance was
publicly disclosed by this operation.

The asynchronous wrapper unwrap finalized `120.0 mUNDER` into the yield
adapter.

### Controlled-yield disclaimer

The injected `12 mUNDER` is a controlled Sepolia simulation using test
assets only. It is not real lending yield and has no monetary value.

### Accounting checkpoint

After principal synchronization:

- principal liability: `120.0 mUNDER`
- adapter deployed principal: `120.0 mUNDER`
- strategy assets: `120.0 mUNDER`
- generated yield: `0`
- harvested/unallocated yield: `0`
- round prize: `0`
- round: `#1 OPEN`

After the exact `12,000,000` base-unit injection:

- strategy assets: `132.0 mUNDER`
- adapter managed assets: `131.999999 mUNDER`
- adapter generated surplus: `11.999999 mUNDER`
- harvested/unallocated yield: `0`
- round prize: `0`
- round: `#1 OPEN`

The one-unit difference is ERC-4626 share conversion rounding. Per the
failure policy, execution stopped before `harvestYield()` rather than
silently treating `11.999999` as exactly `12`.

### Principal-versus-prize invariant

`PASS` — the `120 mUNDER` principal was deployed separately and was not
classified as prize.

## Accepted ERC-4626 rounding boundary

Controlled yield injected: `12.000000 mUNDER`.
ERC-4626 asset/share conversion produced a 1-base-unit floor-rounding
difference, leaving `11.999999 mUNDER` harvestable yield.
Principal remained exactly `120.000000 mUNDER` and was not used as prize.

The boundary was accepted after read-only verification of the exact
principal, vault assets, adapter assets, generated yield, zero round prize,
and OPEN round state. Harvesting proceeds against the measured
`11.999999 mUNDER` amount.

## Harvest checkpoint

- Harvest transaction: `0xb6a922a3be8336ecf6fb737363cd2e4ef509b0360e4210c25120a5ce7d1773c5`
- Harvested/unallocated yield: `11.999999 mUNDER`
- Adapter deployed principal: `120.000000 mUNDER`
- Adapter generated yield after harvest: `0`
- Yield-vault underlying assets after harvest: `120.000001 mUNDER`
- Round: `#1 OPEN`
- Round prize: `0`
- Prize committed: `false`

`PASS` — the measured generated surplus was harvested exactly as reported by
the adapter. The one underlying unit remaining in the yield vault is the
bounded ERC-4626 conversion dust; no principal was classified as prize.
Execution then continued through Round 1 locking, aggregate disclosure, and
prize commitment as recorded below.

## Round 1 pre-draw checkpoint

The first attempt stopped after the already-successful lock because the
temporary runner had omitted `confidentialFrozenEligibilityAt(uint256,uint256)`
from the deployed `PrizeEngine` ABI and had incorrectly associated it with the
vault ABI. This was local runner wiring only; it caused no onchain revert and
no duplicate lock transaction.

The runner was corrected to use the exact deployed signature:

`confidentialFrozenEligibilityAt(uint256 historicalRoundId, uint256 index) returns (bytes32)`

### Lifecycle transactions

- Round 1 lock: `0x05299edd6955ddca16cea42a828beab10d515731883d909f3124ddf531b688f6`
- Aggregate decryption request: `0xd81a13aa10aec260af2de5b2ffcc0d4dd77018f95ce6c3c5140ea545f0098453`
- Aggregate finalization: `0xc509724c85b65ab0b014441c70dc2ba9f799f7d68d8554b8101f259de66f0d77`
- Harvested-yield prize commitment: `0xd17c8dbfe3dd6ef3a979cc756395101dd2072f2685730f934b1c1400a7e8b24f`

The aggregate ciphertext handle after the request was:
`0x0040492d263300983c047c507a08eb06a958109845ff0000000000aa36a70500`.

### Verified transitions and accounting

- `OPEN` → `LOCKED` with exactly two participants and two frozen encrypted eligibility handles.
- `LOCKED` → `AWAITING_TOTAL_DECRYPTION` through the aggregate request.
- Aggregate-only public decryption: `120.000000 mUNDER`.
- `AWAITING_TOTAL_DECRYPTION` → `DRAW_READY` after proof finalization.
- Pre-commit checks passed: aggregate `120.000000 mUNDER`, principal `120.000000 mUNDER`, harvested yield `11.999999 mUNDER`, prize `0`, and both frozen handles unchanged.
- Committed Round 1 prize: `11.999999 mUNDER`.
- Remaining unallocated harvested yield: `0`.
- Principal liability remained exactly `120.000000 mUNDER`.

No individual frozen eligibility, balance, winnings, or winner identity was
publicly disclosed or recorded. Execution stopped at the clean checkpoint
immediately before encrypted randomness (`executeDraw()`).

## Round 1 production draw and settlement

The deployed `PrizeEngine` production path was used. No harness, deterministic
randomness, plaintext weights, offchain winner calculation, or modulo fallback
was used.

### Draw and acceptance transactions

- Production encrypted draw attempt 1: `0x5bd174e2463e20f814f15adb0acb7084d4beacdd8bbf252f0e3d30a8f217f9e0`
  - confirmed in block `11626214`
  - gas used: `1790615`
- Acceptance decryption request 1: `0xda06760d04fdba7028e2987fe9990a9147516206587e01444381533e896ae9ef`
  - confirmed in block `11626215`
  - gas used: `73469`
- Acceptance result: `true` (public decryption of the acceptance bit only)
- Acceptance finalization 1: `0x54db790cbaceebb5ed9a3c6b3687ee839c7a17a2851d74b498ca40e4838ea843`
  - confirmed in block `11626217`
  - gas used: `1269009`

No retry was required. The draw state exposed only encrypted candidate,
acceptance, and selection state to the runner; target, participant weights,
winner index, winner address, and winnings were not decrypted.

### Settlement verification

- Round: `#1 SETTLED`
- Participants: `2`
- Public aggregate eligibility: `120.000000 mUNDER`
- Committed prize: `11.999999 mUNDER`
- Principal liability: `120.000000 mUNDER`
- Remaining unallocated yield: `0`
- Prize committed: `true`
- Acceptance request pending: `false`
- Frozen eligibility handles: unchanged and nonzero
- Settlement events: exactly one `RoundSettled(1)` event
- Settlement confidential transfer: one ciphertext-handle transfer to the vault; no plaintext amount was emitted

`PASS` — the encrypted weighted draw and rejection-sampling acceptance path
settled exactly once while preserving the principal and keeping winner
identity and individual winnings private. Execution stopped after settlement,
before any winnings reveal, principal restoration, or withdrawal.

## Principal restoration checkpoint

The deployed production restoration sequence is a single operator call:
`PrizeEngine.restorePrincipalLiquidity()`.

The engine reads the adapter's tracked principal, the adapter withdraws that
amount from the ERC-4626 yield vault to VeilPool, and VeilPool wraps the exact
underlying amount into its confidential liquid balance. No prize or winnings
balance is used, and no additional FHE decryption is required.

- Restoration transaction: `0xf09dfb4a190afaf41352e06e83189bc373e653aae4e1d2967d7bd72760df2db0`
- Confirmed in block: `11626387`
- Gas used: `381425`
- Restored principal: `120.000000 mUNDER`
- Public underlying boundary transfers: `120.000000 mUNDER` from the yield vault to VeilPool, then `120.000000 mUNDER` from VeilPool to the confidential wrapper

### Post-restoration invariants

- Round: `#1 SETTLED`
- Principal liability: `120.000000 mUNDER`
- Committed prize: `11.999999 mUNDER`
- Unallocated harvested yield: `0`
- Adapter principal deployed: `0`
- Adapter managed assets: `0`
- Adapter generated yield: `0`
- Yield-vault assets remaining: `1` base unit, the documented ERC-4626 dust
- VeilPool underlying balance: `0` after wrapping
- VeilPool confidential liquidity handle: nonzero
- Participant winnings handles: unchanged
- Principal handle: unchanged and not individually decrypted

`PASS` — principal and prize accounting remain separate, principal liability
remains exactly `120.000000 mUNDER`, and sufficient confidential liquidity is
available for participant withdrawals. Frontend withdrawal is now safe to
test manually, but each participant must first connect their own wallet and
authorize a private savings reveal. No participant withdrawal was performed at
the time of restoration.

### Verified participant withdrawal

- Successful withdrawal transaction: `0x862d4b06cf508c961f5ce1e29cf5f812916faa605d8bb0bd964734c2f83efa93`
- Pre-withdrawal private savings: `80.000000 mUNDER`
- Withdrawal amount: `10.000000 mUNDER`
- Post-withdrawal participant-authorized reveal: `70.000000 mUNDER`
- Confidential withdrawal invariant: `PASS` — `80.000000 - 10.000000 = 70.000000 mUNDER`

The private balance evidence is intentionally not associated with a public
wallet address in this document.

## Phase 7C formal closeout

`PHASE 7C — PASS`

The following production lifecycle was validated on Sepolia:

1. Two real participants deposited confidentially through the deployed frontend.
2. Total principal was exactly `120.000000 mUNDER`.
3. Principal was deployed through the production ERC-4626 adapter.
4. Controlled Sepolia yield was injected using test assets.
5. The adapter measured `11.999999 mUNDER` of generated yield after the known
   one-base-unit ERC-4626 floor-rounding boundary.
6. The generated yield was harvested while principal remained separate from
   the prize.
7. Round 1 was locked with two frozen encrypted eligibility handles.
8. Aggregate eligibility was publicly decrypted as `120.000000 mUNDER`; no
   individual eligibility was publicly decrypted.
9. The measured `11.999999 mUNDER` yield was committed as the prize.
10. The production Zama encrypted-randomness draw was executed.
11. The acceptance bit was publicly decrypted and verified.
12. Round 1 settled without retry.
13. Participant-authorized winnings reveals were verified; winner identity and
    other participants' private results were not exposed.
14. The operator restored exactly `120.000000 mUNDER` of principal liquidity.
15. A participant completed a `10.000000 mUNDER` confidential withdrawal.
16. Authorized private savings changed from `80.000000` to `70.000000 mUNDER`.
17. The withdrawn amount moved to the participant's confidential wrapper
    balance; public mUNDER did not change at that step.
18. The participant completed the asynchronous wrapper unwrap flow.
19. The authorized wrapper reveal changed from `15.000000` to `0 mUNDER`.
20. Public mUNDER changed from `220.000000` to `235.000000 mUNDER`.
21. Round 1 remained `SETTLED`.
22. Confidentiality boundaries remained intact throughout the lifecycle.

### Final live unwrap evidence

The unwrap evidence was recovered read-only from the deployed wrapper events;
no duplicate transaction was sent.

- Unwrap request transaction: `0xae0712321f1887615947f414ff023bf46c5f93a21f5be98b95b1c0115a59b23e`
  - confirmed in block `11626638`
  - gas used: `354008`
- Unwrap request ID: `0xf61fb20b4d88bfd4bc2b11b0c42dbbee614cea8b20ff0000000000aa36a70500`
- Publicly decrypted unwrap amount: `15.000000 mUNDER`
- `finalizeUnwrap` transaction: `0x277e78a19da8098c443740a9ae0a40e3f31b05bbe1ba91b75beb303aec858d12`
  - confirmed in block `11626640`
  - gas used: `367279`
- Post-finalization `unwrapRequester(requestId)`: zero address, confirming the
  request was consumed exactly once.

The browser-verified accounting invariant was:

`70 + 15 + 220 = 70 + 0 + 235 mUNDER` — `PASS`

The unwrap destination was the participant's public mUNDER wallet balance. It
did not increase VeilPool private savings. The private balance evidence is not
associated with a public wallet address in this document.

### Evidence classification

- The `12.000000 mUNDER` injection was a controlled Sepolia yield simulation
  using test assets only. It is not real lending yield and has no monetary
  value.
- The ERC-4626 adapter, share conversion, one-unit floor rounding, tracked
  principal, and measured generated surplus were real deployed Sepolia
  accounting behavior.
- Participant balances, eligibility, winnings, pool liquidity, and wrapper
  balances were maintained as FHE ciphertext handles. Authorized user reveals
  were performed only by the relevant participant wallet.
- The weighted draw used the deployed Zama encrypted-randomness path. No
  plaintext winner calculation or deterministic fallback was used.
- Public decryption/proofs were used only for the aggregate/acceptance and
  required asynchronous unwrap finalization flows.
- All lifecycle transactions listed in this document were real Sepolia
  transactions.

### Final invariants

- Principal liability: `120.000000 mUNDER`
- Committed prize: `11.999999 mUNDER`
- Unallocated yield: `0`
- Round: `#1 SETTLED`
- Participant count: `2`
- Final public mUNDER after the unwrap: `235.000000`
- Final authorized wrapper reveal: `0`
- Principal was not used as prize and was not returned through the unwrap.
- No individual private balance became public through the protocol lifecycle.

`PASS` — Phase 7C production E2E evidence is complete.

## Post-settlement deposits on the current Sepolia deployment

VeilPool currently uses one global participant registry. The registry is not
reset when a round settles or when the operator opens the next round. The
current maximum of 10 participants is therefore cumulative across this
Sepolia deployment, rather than a per-round allowance.

Deposits made after settlement update the live encrypted balance and
eligibility in VeilPool, but they are not members of the already-frozen
round. When the operator opens a future round and later calls `lockRound()`,
that round snapshots the current live registry and its current eligibility.
This means a post-settlement depositor can be included in the next snapshot,
while existing registered savers remain part of the global registry. This is
a current testnet architecture limitation, not a privacy failure.

## Protocol feature freeze

`PROTOCOL FEATURE FREEZE — ACTIVE`

Until submission, only deployment configuration, documentation,
accessibility fixes, critical bug fixes, and demo/submission preparation are
in scope. New Solidity functionality, redeployment, new protocol features,
TWAB, winnings withdrawal, add-winnings-to-savings, new pool mechanics, and
architectural changes require explicit review.
