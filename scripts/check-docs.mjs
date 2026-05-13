import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const docs = readFileSync("docs/index.html", "utf8");
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

assert(
  docs.includes(`<span class="version-badge">v${packageJson.version}</span>`),
  `docs version badge must match package version ${packageJson.version}`,
);
assert(
  !docs.includes("gpt-5.4-mini"),
  "docs must not mention the retired gpt-5.4-mini default",
);
assert(
  docs.includes("Default: <code>gpt-5.5</code>"),
  "docs must document the current default Codex model",
);
assert(
  docs.includes("Default: same as <code>codex.model</code>"),
  "docs must document review model inheritance",
);

if (failures.length > 0) {
  console.error("Docs check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Docs check passed.");
