import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const docs = readFileSync("docs/index.html", "utf8");
const readme = readFileSync("README.md", "utf8");
const skill = readFileSync("skills/oneshot-ship/SKILL.md", "utf8");
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
assert(
  readme.includes(`"model": "gpt-5.5"`),
  "README config sample must document the current default Codex model",
);
assert(
  readme.includes(`"reviewModel": "gpt-5.5"`),
  "README config sample must document review model support",
);
assert(
  skill.includes(`"model": "gpt-5.5"`),
  "skill config sample must document the current default Codex model",
);
assert(
  skill.includes("reviewModel"),
  "skill config sample must document review model support",
);

if (failures.length > 0) {
  console.error("Docs check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Docs check passed.");
