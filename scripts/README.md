# Sepolia scripts: historical targets, not current operations

The canonical deployment is `deployments/sepolia-v2-isolated.json`. Its preserved
Round 1 demo must not be mutated without explicit approval.

`deploy-sepolia.ts`, all `phase-7c-*.ts`, and `round3-inject-yield.ts` target
historical V1. `deploy-sepolia-v2.ts` prepares the historical shared-vault V2.
Their addresses/record references are intentionally unchanged; **do not use
these as canonical operational commands**. In particular, the Round 3 injection
script targets the old shared yield vault, not the isolated vault.

`deploy-sepolia-v2-isolated.ts` is the completed isolated deployment's original
script and retains historical pinning for isolation checks. Do not rerun it or
reset its existing journal. `generate-frontend-abis.mjs` is a local artifact
generator, not a transaction script.

See [canonical configuration](../docs/canonical-sepolia.md) before any future
separately authorized operations. No scripts were retargeted by canonicalization.
