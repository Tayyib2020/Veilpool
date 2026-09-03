# VeilPool

VeilPool is a confidential prize-savings prototype for Zama fhEVM. Users
deposit an ERC-20 test asset through an ERC-7984 confidential wrapper; private
savings and draw eligibility remain encrypted while public round lifecycle and
aggregate accounting remain verifiable.

This repository contains the Solidity protocol, Hardhat tests and deployment
scripts, the reviewer-facing React/Vite frontend, and the completed Phase 7C
Sepolia evidence. It is a testnet demonstration, not a production financial
product.

## Sepolia deployment

Network: Sepolia, chain ID `11155111`.

| Contract | Address |
| --- | --- |
| MockUnderlyingToken (mUNDER) | `0x60FAC1d70af4e4b6f7eF973787bddd37763508bc` |
| Confidential ERC-7984 wrapper | `0xfbC3096644cc41bAa6768897c0de286F79D1578a` |
| VeilPool | `0x6E308F5F33abbdd800883e297906dF8de6B68Bd5` |
| Sepolia yield vault | `0xecF8Abb70E79aF0E9428388b66F8498b474040b1` |
| ERC-4626 yield adapter | `0xef20dc27219531e8fbbfcb932EE8d8ad04eA3fe8` |
| PrizeEngine | `0xaA6899418e85a1D6302B7C92aD760A9165aB358E` |

Current intended reviewer URL: [https://veilpool.vercel.app/](https://veilpool.vercel.app/)

Deployment addresses are public configuration, never credentials. Private
keys, RPC API keys and wallet secrets must remain in ignored environment files.

## Architecture and privacy model

The underlying ERC-20 is wrapped into an OpenZeppelin ERC-7984 confidential
token. VeilPool stores encrypted savings, eligibility, principal liability and
winnings using fhEVM types and ACL permissions. A participant can request
authorized decryption of their own handles; the operator can process public
aggregate lifecycle steps but cannot decrypt individual balances or choose a
winner. Public events expose ciphertext handles and lifecycle metadata, not
plaintext confidential amounts.

The frontend uses compatible EIP-1193 EVM wallets with EIP-6963 discovery,
ethers 6, and the Zama relayer SDK. It supports `/`, `/app`, and `/operator`.
The landing page has a 1280px mobile desktop-canvas presentation; app routes
remain normally responsive for wallet, form and transaction interactions.

## Local setup

Requirements: Node.js 20+ and npm 7+.

```bash
npm install
copy .env.example .env
npm run compile
npm test

cd frontend
npm install
copy .env.example .env.local
npm run dev
```

Fill local environment files with the required values. Use placeholders from
`.env.example` and `frontend/.env.example`; never commit `.env`, `.env.local`,
RPC credentials, private keys or seed phrases.

Frontend validation:

```bash
cd frontend
npm test
npm run typecheck
npm run build
```

Contract validation:

```bash
npm run compile
npm test
```

## Round lifecycle

The current lifecycle is `OPEN → LOCKED → DRAWING → SETTLED` (or
`CANCELLED`). While open, deposits can contribute to the next frozen snapshot.
At lock time, the live registry and encrypted eligibility are snapshotted.
Aggregate eligibility is publicly decrypted with a proof, yield is committed as
the prize, encrypted randomness selects by balance-weighted eligibility, and
acceptance is publicly decrypted before settlement. Participant-authorized
reveals expose only the connected participant's own savings and winnings.

On Sepolia, round transitions are operator-triggered. The frontend's weekly
round duration is informational only; it does not start, lock, draw, or settle
rounds automatically. VeilPool is designed for predictable recurring rounds,
such as weekly rounds, in a future production deployment.

## Yield and Phase 7C evidence

The Sepolia yield path is a controlled test-asset simulation through
`SepoliaYieldVault`, not real lending yield or real-money returns. ERC-4626
share/asset conversion produced the documented one-base-unit floor-rounding
boundary while preserving principal separately from prize accounting.

The complete live lifecycle evidence is recorded in
[docs/phase-7c-sepolia-e2e.md](docs/phase-7c-sepolia-e2e.md), including two
confidential participants, aggregate eligibility decryption, Zama encrypted
randomness draw, settlement, participant-authorized reveals, principal
restoration, private withdrawal, and final wrapper unwrap validation.

## Known limitations

- Sepolia round transitions are operator-triggered rather than timer-driven.
- The frontend weekly schedule is informational only.
- The participant cap is 10 cumulatively across this Sepolia deployment.
- VeilPool uses one global participant registry; it is not reset per round.
- Each new round snapshots the current live registry when the operator locks it.
- Sepolia yield is a controlled test-asset simulation, not real DeFi yield.
- Winnings withdrawal is not implemented.
- Adding winnings back to savings is not implemented.
- WalletConnect/mobile QR support is not implemented; compatible injected EVM
  wallets are supported through EIP-1193/EIP-6963.
- Public FHE decryption and proof finalization depend on relayer availability.
- The deployed testnet contracts and mUNDER are not intended for monetary use.

## Feature freeze

Phase 7C protocol validation is complete. The protocol feature freeze remains
active: deployment configuration, documentation, accessibility fixes and
critical bug fixes are allowed; new Solidity functionality, redeployment,
TWAB, winnings withdrawal, add-winnings-to-savings, new pool mechanics and
architectural changes require explicit review.
