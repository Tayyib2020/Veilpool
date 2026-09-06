# Sepolia deployment records

- **Canonical:** `sepolia-v2-isolated.json` — dedicated yield vault; confidential
  winnings withdrawal; preserve the validated Round 1 SETTLED demo.
- **Historical/deprecated:** `sepolia.json` — V1, retained as evidence.
- **Historical/deprecated:** `sepolia-v2.json` — previous shared-yield-vault V2,
  retained as evidence; positions have not been migrated.

JSON evidence is preserved byte-for-byte. Do not overwrite records, reuse an old
record as current frontend config, or rerun deployment scripts. See
[canonical configuration and E2E](../docs/canonical-sepolia.md).
