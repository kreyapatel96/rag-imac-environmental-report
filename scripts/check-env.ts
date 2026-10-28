import fs from "node:fs";
import { envProblems } from "../src/lib/env";

// Load .env.local / .env without extra dependencies.
for (const f of [".env.local", ".env"]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const problems = envProblems();
if (problems.length) {
  console.error("Environment is NOT valid:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("Environment looks valid (keys not verified against the services).");
