// Adds Gemini API keys and the access code to the Vercel project, then redeploys.
// Keys are typed hidden, checked against Google, and sent to Vercel over stdin.
// Nothing is printed, logged or written to disk.
// Run from the project folder: node scripts/setup-keys.mjs
import readline from "node:readline";
import { spawnSync } from "node:child_process";

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
    if (hidden) rl._writeToOutput = () => {};
  });
}

async function checkKey(key) {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: { "x-goog-api-key": key },
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, why: data?.error?.message || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

function vercel(args, input) {
  const r = spawnSync("vercel", args, { input, encoding: "utf8", shell: true });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function setEnv(name, value) {
  const r = vercel(["env", "add", name, "production", "--force", "--sensitive", "--yes"], value);
  if (!r.ok) {
    console.log(`  Could not save ${name}. Vercel said:\n${r.out.split("\n").slice(-6).join("\n")}`);
    process.exit(1);
  }
  console.log(`  Saved ${name} to Vercel (production).`);
}

console.log("\nShortlist key setup\n-------------------");
console.log("Get a key at aistudio.google.com > Get API key > Create API key.");
console.log("Keys from different Google projects add more free quota; keys from the same project share one limit.");
console.log("Paste one key at a time. Nothing shows while you paste. Press Enter on an empty line when done.\n");

const keys = [];
for (let n = 1; ; n++) {
  const key = await ask(`Gemini key ${n}: `, { hidden: true });
  if (!key) break;
  if (keys.includes(key)) {
    console.log("  Already added, skipped.");
    continue;
  }
  process.stdout.write("  Checking with Google... ");
  const check = await checkKey(key);
  if (check.ok) {
    keys.push(key);
    console.log(`works (ending ...${key.slice(-4)}).`);
  } else {
    console.log(`rejected: ${check.why}`);
    n--;
  }
}

if (!keys.length) {
  console.log("\nNo working keys added. Nothing changed.");
  process.exit(0);
}

console.log(`\n${keys.length} working key${keys.length > 1 ? "s" : ""}.`);
const list = vercel(["env", "ls", "production"]).out;
const hasCode = /\bACCESS_CODE\b/.test(list);
let code = "";
for (;;) {
  code = await ask(
    hasCode
      ? "New access code for the site (Enter to keep the current one): "
      : "Choose an access code (the password people type on the site): ",
    { hidden: true },
  );
  if (!code && hasCode) break;
  if (code.length < 4) {
    console.log("  Use at least 4 characters.");
    continue;
  }
  const again = await ask("Type it again: ", { hidden: true });
  if (again === code) break;
  console.log("  They did not match. Try again.");
}

console.log("\nSaving to Vercel...");
setEnv("GEMINI_API_KEYS", keys.join(","));
if (code) setEnv("ACCESS_CODE", code);

console.log("\nRedeploying so the site picks them up (about a minute)...");
const deploy = vercel(["deploy", "--prod", "--yes"]);
console.log(deploy.ok ? "  Done. Open the site, enter your access code and run a brand." : `  Deploy failed:\n${deploy.out.split("\n").slice(-8).join("\n")}`);
console.log("\nYou can close this window.");
