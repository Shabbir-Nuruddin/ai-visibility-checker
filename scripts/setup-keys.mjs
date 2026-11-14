// Adds Gemini API keys and the access code to the Vercel project, then redeploys.
// Keys show as * while pasted, are checked against Google, and are sent to Vercel over stdin.
// Only the first and last 4 characters are ever shown. Nothing is logged or written to disk.
// Run from the project folder: node scripts/setup-keys.mjs
import readline from "node:readline";
import { spawnSync } from "node:child_process";

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Masked input: shows one * per character typed or pasted, so you can see the paste landed.
function askMasked(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) return ask("").then(resolve);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

const masked = (key) => `${key.slice(0, 4)}${"*".repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`;

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
console.log("The site paces each key, skips any that are resting or out for the day, and uses them evenly.");
console.log("This replaces the saved key list, so add every key you want the site to use.");
console.log("Paste one key at a time (right-click pastes in this window), then press Enter.");
console.log("Each character shows as *. Press Enter on an empty line when you are done.\n");

const keys = [];
for (;;) {
  const key = await askMasked(`Gemini key ${keys.length + 1}: `);
  if (!key) break;
  console.log(`  Received ${masked(key)} (${key.length} characters).`);
  if (keys.includes(key)) {
    console.log("  Already added, skipped.\n");
    continue;
  }
  process.stdout.write("  Checking with Google... ");
  const check = await checkKey(key);
  if (check.ok) {
    keys.push(key);
    console.log(`works. Saved as Key ${keys.length}.\n`);
  } else {
    console.log(`rejected: ${check.why}\n`);
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
  code = await askMasked(
    hasCode
      ? "New access code for the site (Enter to keep the current one): "
      : "Choose an access code (the password people type on the site): ",
  );
  if (!code && hasCode) break;
  if (code.length < 4) {
    console.log("  Use at least 4 characters.");
    continue;
  }
  const again = await askMasked("Type it again: ");
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
