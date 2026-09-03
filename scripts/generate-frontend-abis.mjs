import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "frontend", "src", "contracts", "generated.ts");
const sources = {
  veilPoolAbi: "artifacts/contracts/VeilPool.sol/VeilPool.json",
  confidentialTokenAbi: "artifacts/contracts/VeilPoolConfidentialToken.sol/VeilPoolConfidentialToken.json",
  underlyingTokenAbi: "artifacts/contracts/MockUnderlyingToken.sol/MockUnderlyingToken.json",
  prizeEngineAbi: "artifacts/contracts/PrizeEngine.sol/PrizeEngine.json",
  yieldAdapterAbi: "artifacts/contracts/ERC4626YieldAdapter.sol/ERC4626YieldAdapter.json",
};

const declarations = Object.entries(sources).map(([name, relativePath]) => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
  return `export const ${name} = ${JSON.stringify(artifact.abi)} as const;`;
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  `// Generated from Hardhat artifacts. Run npm run generate:abis after contract changes.\n${declarations.join("\n\n")}\n`,
);

console.log(`Generated ${Object.keys(sources).length} frontend ABIs at ${path.relative(root, output)}`);
