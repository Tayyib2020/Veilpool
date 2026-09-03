# Phase 7D production frontend deployment and reviewer QA

Date: 2026-09-03

## Status

`PHASE 7D — PARTIAL`

The existing frontend was deployed publicly to Vercel without Solidity,
contract, protocol, or economic changes. Static deployment and browser QA
passed. Manual wallet signing QA remains a reviewer action because the
available in-app browser has no injected EIP-1193 provider.

`PROTOCOL FEATURE FREEZE — ACTIVE`

## Deployment

- Provider: Vercel
- Target: production
- Public alias: https://veilpool.vercel.app/
- Deployment URL: https://veilpool-dkbjftset-tayyibs-projects-d0415455.vercel.app/
- Artifact: existing `frontend/dist` production build
- Uploaded files: 16, including the current JS, CSS, images, and FHE WASM assets
- Root uploaded: build artifact only; root `.env`, private keys, RPC credentials,
  and other secrets were not uploaded
- SPA routing: `frontend/vercel.json` rewrite serves `index.html` for direct
  navigation and reloads

## Public browser QA

1. Homepage `/`: PASS — VeilPool title, photography-led hero, navigation, and
   `Enter app` CTA render.
2. `/app`: PASS — direct navigation renders the user shell and faucet surface.
3. `/app` reload: PASS — direct reload remains on the user route.
4. `/operator`: PASS — direct navigation renders the operator shell.
5. `/operator` reload: PASS — direct reload remains on the operator route.
6. Public alias: PASS — `https://veilpool.vercel.app/` renders the homepage.
7. Assets: PASS — hero, principal, yield, privacy, and dashboard imagery loaded;
   FHE WASM assets are present in the deployment artifact.
8. Mixed content: PASS — no `http:` `src` or `href` references were found.
9. Browser console: PASS — no error or warning entries were reported on the
   homepage, `/app`, or `/operator` checks.
10. Localhost leakage: PASS — no localhost UI/config reference was found on the
    deployed app surfaces.

## Sepolia configuration and read-only protocol surface

The deployed build contains the existing public Sepolia configuration only:

- Chain ID: `11155111`
- mUNDER: `0x60FAC1d70af4e4b6f7eF973787bddd37763508bc`
- Confidential wrapper: `0xfbC3096644cc41bAa6768897c0de286F79D1578a`
- VeilPool: `0x6E308F5F33abbdd800883e297906dF8de6B68Bd5`
- Yield vault: `0xecF8Abb70E79aF0E9428388b66F8498b474040b1`
- Yield adapter: `0xef20dc27219531e8fbbfcb932EE8d8ad04eA3fe8`
- PrizeEngine: `0xaA6899418e85a1D6302B7C92aD760A9165aB358E`

The previously verified deployed Sepolia state remains the source of truth:

- Round 1: `SETTLED`
- Participant count: `2`
- Public principal liability: `120.000000 mUNDER`
- Committed prize: `11.999999 mUNDER`
- Unallocated harvested yield: `0`
- Adapter principal after restoration: `0`
- Yield-vault residual: `1` base unit of documented ERC-4626 dust
- Operator relationship and deployed bytecode: previously verified PASS

No protocol transaction was sent during Phase 7D deployment or QA.

## Wallet compatibility QA

- EIP-6963 discovery and provider selection: automated frontend tests PASS.
- Generic EIP-1193 fallback, account changes, chain changes, disconnect/reset,
  and existing ethers BrowserProvider behavior: automated frontend tests PASS.
- Public product language uses “Compatible EVM wallets”; it does not claim
  universal wallet support or make a MetaMask-specific security claim.
- Live wallet connect, signing, Sepolia switching, FHE authorization, and
  transaction prompts: NOT EXECUTED in this environment because the available
  in-app browser has no injected wallet. This is the remaining reviewer QA item.

## User and operator surface QA

- User app visual shell: PASS.
- Faucet availability and testnet-only copy: PASS; no automatic mint, wrap,
  deposit, or protocol transaction was triggered.
- Confidential balance/reveal controls remain user-authorized in the existing
  implementation; no private balances are rendered as public protocol state.
- Operator panel visual shell: PASS.
- Operator actions were not invoked; no operator transaction was sent.
- Round Monitor remains informational, maps the onchain lifecycle first, and
  retains its default seven-day frontend schedule without creating timers or
  automatic protocol scheduling.

## Responsive, theme, and accessibility checks

- In-app browser mobile-width check: PASS — no horizontal overflow detected.
- Light theme: PASS — theme switch rendered and retained readable contrast.
- Dark theme: PASS — restored after verification and rendered without console
  errors.
- Semantic controls, route navigation, theme control, wallet-unavailable state,
  and existing reduced-motion behavior remain present.
- Full 1440/1024/390/360 device-matrix and screen-reader QA require a reviewer
  browser/device pass; no source-level responsive or accessibility regression
  was introduced in this deployment.

## Privacy and copy audit

- No private key, seed phrase, RPC credential, relayer secret, signature,
  plaintext private balance, or winner identity was uploaded or added to the
  public build.
- Public copy continues to distinguish encrypted individual state from public
  round lifecycle data.
- The deployed site does not claim that simulated Sepolia yield is real lending
  yield.
- Phase 7C’s unwrap and privacy boundaries remain documented in
  `docs/phase-7c-sepolia-e2e.md`.

## Validation gates

- Frontend tests: `60 passing, 0 failing`
- Frontend TypeScript: PASS (`npm run typecheck`)
- Vite production build: PASS (`vite v8.2.2`); advisory large-chunk warning only
- Solidity compile: PASS (`Nothing to compile`)
- Complete contract suite: `55 passing, 0 failing`
- Solidity and deployed Sepolia contracts: unchanged

## Remaining blocker before Phase 7E

One manual reviewer pass is still required for live wallet behavior on a
browser with an injected compatible EVM wallet: connect/select provider,
confirm Sepolia, verify read-only state, and inspect wallet prompts without
invoking writes unless explicitly intended. Phase 7E has not started.
