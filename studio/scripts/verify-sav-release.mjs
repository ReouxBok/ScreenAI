import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Conservative publication check. Reports locations, never matching secret values.
// Not a complete secret/PII audit: the diff still needs human review.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
const files = [...new Set([...git(["diff", "--name-only", "--diff-filter=ACMR", "-z", "HEAD"]), ...git(["ls-files", "--others", "--exclude-standard", "-z"])])];
const forbidden = /(^|\/)(\.env(?:\..*)?|\.sav-preview|\.e2e-db|node_modules|\.next|\.vercel|backups)(\/|$)|\.(?:pem|key|db|sqlite3?|zip|tar|tar\.gz)$/i;
const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["google-api-key", /AIza[0-9A-Za-z_-]{35}/],
  ["github-token", /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})/],
  ["database-credentials", /postgres(?:ql)?:\/\/[^\s:'"/]+:[^\s@'"/]+@/],
  ["stripe-live-key", /sk_live_[A-Za-z0-9]{20,}/],
];
const findings = [];
for (const file of files) {
  if (forbidden.test(file) && !file.endsWith(".env.example")) findings.push({ file, rule: "private-or-runtime-file" });
  const contents = readFileSync(path.join(repo, file), "utf8");
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    for (const [rule, pattern] of patterns) if (pattern.test(line)) findings.push({ file, line: index + 1, rule });
  }
}
console.log(JSON.stringify({ checkedFiles: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
