# Canonical isolated Sepolia deployment

The canonical deployment is `deployments/sepolia-v2-isolated.json`, marked
complete and verified. Do not overwrite that evidence or migrate legacy positions.
Preserve Round #1 SETTLED for the demo; no new round or transaction is authorized
by this document. Remote Vercel settings have not been updated in this pass.

## Public frontend build configuration

Use the following variables for a separately approved Vercel production build
(root directory `frontend`, build `npm run build`, output `dist`). Vite embeds
these values at build time; changing variables requires a new frontend build.
Preserve `frontend/vercel.json` SPA routing for `/app` and `/operator`.

```dotenv
VITE_CHAIN_ID=11155111
VITE_VEILPOOL_ADDRESS=0x139C2fe98FcE4E2D178d04127bf357C7e04FBEc6
VITE_PRIZE_ENGINE_ADDRESS=0xfD9ED0c82b0Cb98741a21fc7fb1f39b898A1b008
VITE_YIELD_ADAPTER_ADDRESS=0x8Af52321c4B4cb4A9937FE7c3cD32fe452521A13
VITE_UNDERLYING_TOKEN_ADDRESS=0x60FAC1d70af4e4b6f7eF973787bddd37763508bc
VITE_CONFIDENTIAL_TOKEN_ADDRESS=0xfbC3096644cc41bAa6768897c0de286F79D1578a
VITE_OPERATOR_ADDRESS=0x51133dfa694940Fe4ebC785a5CE11B54f5C86048
VITE_EXPLORER_BASE_URL=https://sepolia.etherscan.io
VITE_ZAMA_RELAYER_URL=
VITE_SEPOLIA_RPC_URL=
VITE_ROUND_START_TIMESTAMP=
```

Leave the optional variables above unset/empty: relayer defaults to SDK
SepoliaConfig (`https://relayer.testnet.zama.org`); reads use the connected wallet
provider. A credential-free public Sepolia RPC may be separately configured for
wallet chain addition. Never copy root `SEPOLIA_RPC_URL` credentials into VITE
configuration. Never commit `.env.local`, private keys, signatures or credentials.
Do not carry a historical round-start timestamp into this deployment.

Dedicated yield vault: `0xa072afCe9da7Bc93d398AE0985Bc64cFCf3B70F1`.
It is referenced by the adapter onchain; there is no frontend yield-vault env key.
The underlying and wrapper are reused; the yield vault, adapter, pool and engine
are dedicated to this stack. Controlled donations to this vault do not reprice
the old shared vault's shares.

## Isolated live E2E evidence — 2026-09-06

The operator/user confirmed completion of the following live browser lifecycle.
Final settlement and private participant results below are user-attested; this
documentation pass did not repeat transactions or independently decrypt them.

- Two participants deposited 120 mUNDER aggregate principal confidentially.
- Principal was deployed into the dedicated ERC-4626 vault.
- Exactly 12 mUNDER controlled test yield was injected; generated yield was
  11.999999 mUNDER after one-base-unit conversion rounding.
- Yield was harvested separately from principal. At independently read block
  11,647,332: liability/deployed principal/managed assets were each 120,000,000;
  unallocated harvested yield was 11,999,999; generated yield was zero; Round 1
  was OPEN with two participants, no committed prize and no pending sync.
- Round 1 was subsequently locked; aggregate eligibility public decryption and
  proof finalization completed; generated yield was committed as prize.
- The real Zama encrypted balance-weighted draw and acceptance proof completed;
  Round 1 SETTLED. Winner identity was not published by the draw.
- Winner privately revealed winnings; non-winner privately revealed zero.
- Winner withdrew 11 mUNDER from winnings, with exactly 11 mUNDER received in
  the confidential wrapper and winnings reduced accordingly.
- Optional wrapper unwrap finalized to public Sepolia mUNDER, increasing the
  public test balance by exactly 11 mUNDER. Remaining winnings stayed encrypted.
- PRINCIPAL != PRIZE remained intact; winnings withdrawal did not deduct savings
  or eligibility. Private results are not linked to a participant address here.

Known injection transaction:
`0x33e23b13fba2fdc7251cf7d25e5032d9e957b6cfebdc4037efe9bfa0eb4ecf8c`
(block 11,647,313). Approval:
`0xf424a2f4fb6a81af9ff454e70239034335c0553aa291fca5a62a810885ec3d5e`.
Deployment/setup hashes remain in the authoritative JSON. No unprovided final
draw/claim/unwrap hashes are invented.

## Privacy and testnet boundaries

Yield is a controlled Sepolia simulation using test assets, **not real lending
yield**. The ERC-4626 accounting, FHE state, encrypted randomness, proof checks,
and Sepolia transactions are real. Only selected aggregate principal/eligibility
and draw acceptance values are publicly decrypted for lifecycle processing.
Individual savings, eligibility, winnings and winner identity are not publicly
decrypted by the protocol. User decryption is participant-authorized.

This is not transaction anonymity: accounts, calls, lifecycle metadata and
ciphertext handles are public. Optional unwrap explicitly reveals the returned
amount and credits a public ERC-20 balance. Public metadata can support inference;
do not claim that withdrawals/unwraps hide all correlations.

## Address audit and historical references

- `deployments/sepolia.json`: historical/deprecated V1 evidence; unchanged.
- `deployments/sepolia-v2.json`: historical/deprecated shared-vault V2; unchanged.
- `deployments/sepolia-v2-isolated.json`: authoritative canonical evidence;
  legacyBefore/legacyAfter and record hashes intentionally retain old addresses.
- `docs/phase-7c-sepolia-e2e.md` and `docs/phase-7d-production-qa.md`: historical
  V1 test/deployment evidence, not current remote-configuration assertions.
- `docs/sepolia-deployment.md`, `docs/sepolia-v2-deployment.md`: historical
  deployment runbooks. Isolated preparation history is retained separately.
- `scripts/deploy-sepolia.ts`, `deploy-sepolia-v2.ts`, `phase-7c-*.ts`, and
  `round3-inject-yield.ts`: old-target scripts, not canonical operational commands.
  Do not run them against the preserved demo. Retargeting them would destroy
  historical reproducibility or risk writes to the wrong deployment.
- `scripts/deploy-sepolia-v2-isolated.ts`: original deployment preparation and
  safety pinning intentionally compares both legacy stacks; do not rerun it.
- Old addresses in `frontend/tests/evmAddress.test.ts` and
  `frontend/tests/fheInputBinding.test.ts` are fixed regression inputs, not runtime
  targets. Deployment tests also pin historical topology intentionally.
- Active frontend source resolves runtime targets from public configuration;
  the generated ABI includes `withdrawWinnings(bytes32,bytes)` and
  `supportsWinningsWithdrawal()`. No ABI or runtime change is needed.

The registry remains global with a cumulative cap of ten participants per pool;
round transitions remain operator-triggered. The two-hour funded countdown is
informational, not automatic scheduling. No TWAB, add-winnings-to-savings or
WalletConnect/mobile QR capability is claimed.

## Canonicalization validation — 2026-09-06

- Full local Hardhat contract suite: 80 passing, 0 failing.
- Full frontend suite: 88 passing, 0 failing.
- Root and frontend TypeScript: PASS.
- Vite production build: PASS; existing non-blocking large-chunk warning.
- Public env example matches the authoritative deployment record; winnings ABI
  capability/withdrawal entries are present. No runtime ABI change was needed.
- Git diff whitespace check: PASS. Credential-pattern scan found no secrets in
  commit candidates; real env files remain ignored. This is not a formal security
  audit of the protocol or all possible secret formats.
- No Solidity, deployment JSON, operational script, frontend runtime, live state
  or remote Vercel configuration was changed. No commit or push was performed.
