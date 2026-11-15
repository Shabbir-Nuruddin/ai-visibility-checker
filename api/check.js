import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

// Gemini keys: GEMINI_API_KEYS (comma separated, set by scripts/setup-keys.mjs) and/or GEMINI_API_KEY.
const GEMINI_KEYS = [
  ...new Set(
    `${process.env.GEMINI_API_KEYS || ""},${process.env.GEMINI_API_KEY || ""}`
      .split(/[\s,]+/)
      .filter(Boolean),
  ),
];
// Engine: Gemini when any Gemini key is set (free tier works), otherwise Claude.
const USE_GEMINI = GEMINI_KEYS.length > 0;
const ENGINE = USE_GEMINI ? "Gemini" : "Claude";
const MODEL = USE_GEMINI
  ? process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"
  : process.env.CLAUDE_MODEL || "claude-opus-5-5";
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const MAX_QUESTIONS = 5;
const CONCURRENCY = USE_GEMINI ? Math.min(MAX_QUESTIONS, 2 * GEMINI_KEYS.length) : MAX_QUESTIONS;
// Leave room under Vercel's 300 s limit to send the answer back.
const TIME_BUDGET_MS = 240_000;

let anthropic;
const claude = () => (anthropic ??= new Anthropic());

const BRAND_LIST = {
  type: "array",
  items: {
    type: "object",
    properties: { name: { type: "string" }, is_target: { type: "boolean" } },
    required: ["name", "is_target"],
    additionalProperties: false,
  },
};

const QUESTIONS_SCHEMA = {
  type: "object",
  properties: { questions: { type: "array", items: { type: "string" } } },
  required: ["questions"],
  additionalProperties: false,
};

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, brands: BRAND_LIST },
        required: ["id", "brands"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
};

const clean = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class EngineError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/* ---------------- Gemini key pool ----------------
   Google does not report how much free quota a key has left. So the pool:
   - counts the calls it makes on each key (per Pacific day, which is when Google resets),
   - keeps each key under its per-minute limit, starting at GEMINI_RPM and lowering it
     when Google says a key hit its minute limit sooner,
   - gives each call to the ready key that has been used least today, so keys wear evenly,
   - reads Google's 429 reply: a per-minute limit rests the key for the delay Google gives,
     a per-day limit retires it until midnight Pacific,
   - on a 429 resends only that one request on another key. A 429 is not charged by Google.
   The browser keeps a copy of this state and sends it back, so it survives cold starts. */

const START_RPM = Number(process.env.GEMINI_RPM) || 10;
const STATE_VERSION = 2; // bump to drop key state saved by older builds
const DAILY_CAP = Number(process.env.GEMINI_RPD) || 0; // 0: unknown, wait for Google to say "out"
const POOL = GEMINI_KEYS.map((key, i) => ({
  key,
  id: createHash("sha256").update(key).digest("hex").slice(0, 12),
  label: `Key ${i + 1}`,
}));
const pool = new Map();

const ptDay = (t = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(t);

function nextPtMidnight(now = Date.now()) {
  const pt = new Date(new Date(now).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const midnight = new Date(pt);
  midnight.setHours(24, 0, 0, 0);
  return now + (midnight - pt);
}

function slot(id) {
  const day = ptDay();
  let s = pool.get(id);
  if (!s) {
    s = { day, used: 0, rpm: START_RPM, recent: [], coolUntil: 0, outUntil: 0, bad: false };
    pool.set(id, s);
  }
  if (s.day !== day) Object.assign(s, { day, used: 0, outUntil: 0, rpm: START_RPM });
  return s;
}

function mergeState(input) {
  if (!input || typeof input !== "object") return;
  for (const k of POOL) {
    const c = input[k.id];
    if (!c || typeof c !== "object" || c.v !== STATE_VERSION) continue;
    const s = slot(k.id);
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    if (c.day === s.day) s.used = Math.max(s.used, num(c.used));
    if (c.day === s.day && num(c.rpm) >= 1) s.rpm = Math.min(s.rpm, num(c.rpm));
    s.coolUntil = Math.max(s.coolUntil, num(c.coolUntil));
    if (c.day === s.day) s.outUntil = Math.max(s.outUntil, num(c.outUntil));
  }
}

const exportState = () =>
  Object.fromEntries(
    POOL.map((k) => {
      const { day, used, rpm, coolUntil, outUntil } = slot(k.id);
      return [k.id, { v: STATE_VERSION, day, used, rpm, coolUntil, outUntil }];
    }),
  );

function readyAt(k, now) {
  const s = slot(k.id);
  if (s.bad) return Infinity;
  s.recent = s.recent.filter((t) => now - t < 60_000);
  let at = Math.max(now, s.coolUntil, s.outUntil);
  if (DAILY_CAP && s.used >= DAILY_CAP) at = Math.max(at, nextPtMidnight(now));
  if (s.recent.length >= s.rpm) at = Math.max(at, s.recent[s.recent.length - s.rpm] + 60_000);
  return at;
}

const resetText = "Free quota resets at midnight Pacific time, which is 1:30 pm in India.";

async function takeKey(ctx) {
  for (;;) {
    const now = Date.now();
    let best = null;
    let bestAt = Infinity;
    for (const k of POOL) {
      const at = readyAt(k, now);
      if (at < bestAt || (best && at === bestAt && slot(k.id).used < slot(best.id).used)) {
        best = k;
        bestAt = at;
      }
    }
    if (bestAt === Infinity) throw new EngineError(401, "None of the Gemini keys work. Run the key setup again.");
    if (bestAt > now) {
      const allOut = POOL.every((k) => slot(k.id).bad || slot(k.id).outUntil > now);
      if (allOut) throw new EngineError(429, `Every key has used today's free quota. ${resetText}`);
      if (bestAt > ctx.deadline) {
        const why = ctx.lastLimit ? ` Google said: ${ctx.lastLimit.slice(0, 400)}` : "";
        throw new EngineError(429, `All keys are resting. Try again in ${Math.ceil((bestAt - now) / 1000)} seconds.${why}`);
      }
      await wait(bestAt - now);
      continue;
    }
    const s = slot(best.id);
    s.recent.push(now);
    s.used++;
    return best;
  }
}

function onRateLimit(k, data) {
  const s = slot(k.id);
  const now = Date.now();
  const details = data?.error?.details || [];
  const quotas = details.flatMap((d) => (d.violations || []).map((v) => `${v.quotaId || ""} ${v.quotaMetric || ""}`)).join(" ");
  const retry = details.find((d) => d.retryDelay)?.retryDelay;
  if (/per_?day/i.test(quotas)) {
    s.outUntil = nextPtMidnight(now);
    return;
  }
  // Hit the minute limit sooner than expected: learn the lower pace for this key.
  const inLastMinute = s.recent.filter((t) => now - t < 60_000).length;
  if (inLastMinute > 1 && inLastMinute <= s.rpm) s.rpm = Math.max(1, inLastMinute - 1);
  s.coolUntil = now + (retry ? Math.ceil(parseFloat(retry) * 1000) + 500 : 60_000);
}

const isKeyError = (e) =>
  e instanceof EngineError && (e.status === 401 || ([400, 403].includes(e.status) && /api key/i.test(e.message)));

async function geminiCall(body, ctx) {
  let serverRetries = 0;
  for (;;) {
    const k = await takeKey(ctx);
    const res = await fetch(`${GEMINI_BASE}/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": k.key },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const data = await res.json().catch(() => ({}));
    const err = new EngineError(res.status, data?.error?.message || `HTTP ${res.status}`);
    if (res.status === 429) {
      slot(k.id).used--; // rejected calls are not charged
      // "limit: 0" means this tier does not include the feature (e.g. Google Search on free keys).
      // Waiting will not help, so report it instead of resting the key.
      // A 429 on a Google Search request on a free key is the same thing: search is not in its quota.
      if (/limit:\s*0\b/.test(err.message) || body.tools) throw new EngineError(429, err.message, { noQuota: true });
      onRateLimit(k, data);
      // Keep the part that names the limit, e.g. "generate_content_free_tier_requests, limit: 5, model: x".
      const hit = (err.message.match(/Quota exceeded for metric:[^\n]*/g) || [])
        .map((m) => m.replace(/^Quota exceeded for metric:\s*(generativelanguage\.googleapis\.com\/)?/, "").trim());
      const ids = (data?.error?.details || []).flatMap((d) => (d.violations || []).map((v) => v.quotaId)).filter(Boolean);
      ctx.lastLimit = [...new Set(hit.length ? hit : ids)].join("; ") || err.message;
      continue;
    }
    if (isKeyError(err)) {
      Object.assign(slot(k.id), { bad: true, used: slot(k.id).used - 1 });
      continue;
    }
    if (res.status >= 500 && serverRetries < 2) {
      serverRetries++;
      await wait(serverRetries * 2000);
      continue;
    }
    throw err;
  }
}

function keyReport() {
  const now = Date.now();
  return POOL.map((k) => {
    const s = slot(k.id);
    const status = s.bad
      ? "rejected by Google"
      : s.outUntil > now
        ? "out for today"
        : s.coolUntil > now
          ? `resting ${Math.ceil((s.coolUntil - now) / 1000)}s`
          : "ready";
    return { label: k.label, used: s.used, cap: DAILY_CAP || null, pace: s.rpm, status };
  });
}

/* ---------------- Gemini calls ---------------- */

function geminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
}

function geminiBlocked(data) {
  if (data?.promptFeedback?.blockReason) return true;
  return ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(data?.candidates?.[0]?.finishReason);
}

// Remember which structured-output shape this model accepts, so no call is wasted finding out twice.
let jsonMode = "responseFormat";
let searchBlocked = false;

async function geminiStructured(prompt, schema, ctx) {
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  const config = (mode) =>
    mode === "responseFormat"
      ? { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema } } }
      : { responseMimeType: "application/json", responseJsonSchema: schema };
  let data;
  try {
    data = await geminiCall({ contents, generationConfig: config(jsonMode) }, ctx);
  } catch (err) {
    if (!(err instanceof EngineError) || err.status !== 400 || jsonMode !== "responseFormat") throw err;
    jsonMode = "legacy";
    data = await geminiCall({ contents, generationConfig: config(jsonMode) }, ctx);
  }
  if (geminiBlocked(data)) throw new Error("The model declined this request.");
  return JSON.parse(geminiText(data));
}

async function geminiAnswer(question, system, web, ctx) {
  const base = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: question }] }],
  };
  let data;
  let searched = web && !searchBlocked;
  if (searched) {
    try {
      data = await geminiCall({ ...base, tools: [{ google_search: {} }] }, ctx);
    } catch (err) {
      // Free-tier keys cannot use Google Search on current models. Answer from memory instead.
      if (!(err instanceof EngineError) || !(err.status === 400 || err.noQuota)) throw err;
      searchBlocked = true;
      searched = false;
    }
  }
  if (!data) data = await geminiCall(base, ctx);
  if (geminiBlocked(data)) return { text: "", sources: [], refused: true, searched };

  const sources = new Map();
  for (const c of data?.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
    const w = c.web;
    if (w?.uri && !sources.has(w.uri)) sources.set(w.uri, { title: w.title || w.uri, url: w.uri });
  }
  return { text: geminiText(data).trim(), sources: [...sources.values()].slice(0, 8), refused: false, searched };
}

/* ---------------- Claude calls ---------------- */

async function claudeStructured(prompt, schema) {
  const response = await claude().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  return JSON.parse(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
}

async function claudeAnswer(question, system, web) {
  const messages = [{ role: "user", content: question }];
  let text = "";
  const sources = new Map();

  for (let turn = 0; turn < 4; turn++) {
    const response = await claude().beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system,
      messages,
      ...(web ? { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }] } : {}),
    });

    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      // Successful search results arrive as a list; an error arrives as a single object.
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.url && !sources.has(r.url)) sources.set(r.url, { title: r.title || r.url, url: r.url });
        }
      }
    }

    if (response.stop_reason === "refusal") return { text: "", sources: [], refused: true, searched: web };
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    break;
  }
  return { text: text.trim(), sources: [...sources.values()].slice(0, 8), refused: false, searched: web };
}

/* ---------------- Shared flow ---------------- */

const structured = (prompt, schema, ctx) =>
  USE_GEMINI ? geminiStructured(prompt, schema, ctx) : claudeStructured(prompt, schema);

// Ask the question the way a buyer would. With web search on, this mirrors AI search.
function answer(question, market, web, ctx) {
  const system =
    "Answer the user's question the way you normally would for a real person. Be concise, under 250 words." +
    (market ? ` The person asking is based in ${market}.` : "");
  return USE_GEMINI ? geminiAnswer(question, system, web, ctx) : claudeAnswer(question, system, web);
}

async function makeQuestions({ brand, category, market }, ctx) {
  const prompt = [
    `Write ${MAX_QUESTIONS} questions a real buyer would type into ChatGPT, Gemini or Claude when they are looking for ${category}${market ? ` in ${market}` : ""}.`,
    `They have not heard of ${brand}, so never name ${brand} or any other company.`,
    "Mix them: one 'best ... in ...' question, one comparison, one led by a problem the buyer has, one about price, one about a specific use case.",
    "Write them the way people actually type: plain, short, no quotation marks.",
  ].join("\n");
  const out = await structured(prompt, QUESTIONS_SCHEMA, ctx);
  return out.questions.map((q) => clean(q, 300)).filter(Boolean).slice(0, MAX_QUESTIONS);
}

// One call reads the brands out of every answer, instead of one call per answer.
async function extractAll(items, { brand, domain }, ctx) {
  if (!items.length) return new Map();
  const prompt = [
    `Target brand: ${brand}${domain ? ` (website ${domain})` : ""}.`,
    "Below are an AI assistant's answers to buyers, each with an id. For each answer, list every company, brand, product or provider it recommends or names as an option, in the order each first appears.",
    "Set is_target to true only for the target brand itself (its company, its products, or a clear variant of its name or website).",
    "Leave out generic categories, and publications or directories that are only cited as sources.",
    "Return one entry per answer id, with an empty list when an answer names no one.",
    "",
    ...items.map((it) => `<answer id="${it.id}">\n${it.text}\n</answer>`),
  ].join("\n");
  const out = await structured(prompt, EXTRACT_SCHEMA, ctx);
  const byId = new Map();
  for (const a of out.answers || []) {
    const seen = new Set();
    byId.set(
      a.id,
      (a.brands || [])
        .map((b) => ({ name: clean(b.name, 120), is_target: !!b.is_target }))
        .filter((b) => b.name && !seen.has(b.name.toLowerCase()) && seen.add(b.name.toLowerCase())),
    );
  }
  return byId;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function writeOpener(target, results, competitors) {
  const ok = results.filter((r) => !r.error && !r.refused);
  const total = ok.length;
  const hits = ok.filter((r) => r.mentioned).length;
  const top = competitors[0];
  const example = ok[0]?.question;
  if (!total) return "";
  const intro =
    total === 1
      ? `I asked ${ENGINE} a question your buyers ask: "${example}".`
      : `I asked ${ENGINE} ${total} questions your buyers ask, like "${example}".`;
  if (total === 1) {
    return hits
      ? `${intro} ${target.brand} came up.${top ? ` So did ${top.name}.` : ""} Want to see more questions?`
      : `${intro} ${target.brand} did not come up.${top ? ` ${top.name} did.` : ""} Want the full answer?`;
  }
  if (hits === 0) {
    return `${intro} ${target.brand} did not come up once.${top ? ` ${top.name} came up in ${top.count} of ${total}.` : ""} Want the full answers?`;
  }
  if (hits < total) {
    return `${intro} ${target.brand} came up in ${hits} of ${total}.${top ? ` ${top.name} came up in ${top.count}.` : ""} Want to see which answers you are missing from?`;
  }
  return `${intro} ${target.brand} came up in all ${total}.${top ? ` ${top.name} is the name most often listed next to you.` : ""} Want the full answers?`;
}

function describe(err) {
  if (err instanceof EngineError) {
    if (err.status === 429 || err.status === 401) return err.message.startsWith("HTTP") ? "Rate limited by the API." : err.message;
    if (isKeyError(err)) return "The API key is missing or invalid.";
    return `API error ${err.status}: ${err.message}`;
  }
  if (err instanceof Anthropic.AuthenticationError) return "The API key is missing or invalid.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a minute and run it again.";
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`.trim();
  return err?.message || "Something went wrong.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body || {};
  const expected = process.env.ACCESS_CODE;
  if (!expected) return res.status(500).json({ error: "ACCESS_CODE is not set on the server." });
  if (body.code !== expected) return res.status(401).json({ error: "Wrong access code." });
  if (!USE_GEMINI && !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "No API key on the server. Set GEMINI_API_KEYS (free) or ANTHROPIC_API_KEY." });
  }

  mergeState(body.keyState);
  const keyInfo = () => (USE_GEMINI ? { keys: keyReport(), keyState: exportState() } : {});
  if (body.action === "status") return res.status(200).json({ engine: ENGINE, model: MODEL, ...keyInfo() });
  if (body.action === "probe" && USE_GEMINI) return res.status(200).json(await probeKeys(body.model, !!body.search));

  const target = {
    brand: clean(body.brand, 120),
    domain: clean(body.domain, 120).replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    category: clean(body.category, 200),
    market: clean(body.market, 120),
  };
  if (!target.brand) return res.status(400).json({ error: "Brand name is required." });
  if (!target.category) return res.status(400).json({ error: "Say what the brand sells." });
  const web = body.web !== false;
  const ctx = { deadline: Date.now() + TIME_BUDGET_MS };

  try {
    let questions = Array.isArray(body.questions)
      ? body.questions.map((q) => clean(q, 300)).filter(Boolean).slice(0, MAX_QUESTIONS)
      : [];
    if (!questions.length) questions = await makeQuestions(target, ctx);
    if (!questions.length) return res.status(502).json({ error: "Could not write buyer questions. Add your own and retry.", ...keyInfo() });

    const answers = await mapLimit(questions, CONCURRENCY, async (q) => {
      try {
        return await answer(q, target.market, web, ctx);
      } catch (err) {
        return { error: describe(err) };
      }
    });

    const toRead = answers.map((a, i) => ({ id: i + 1, text: a.text })).filter((it) => it.text);
    let brandsById = new Map();
    let extractError = "";
    try {
      brandsById = await extractAll(toRead, target, ctx);
    } catch (err) {
      extractError = `Got the answer but could not read the brands in it: ${describe(err)}`;
    }

    const results = questions.map((question, i) => {
      const a = answers[i];
      if (a.error) return { question, error: a.error, brands: [], sources: [], mentioned: false, position: null };
      const brands = brandsById.get(i + 1) || [];
      const idx = brands.findIndex((b) => b.is_target);
      return {
        question,
        answer: a.text,
        sources: a.sources,
        refused: a.refused,
        searched: a.searched,
        brands,
        mentioned: idx >= 0,
        position: idx >= 0 ? idx + 1 : null,
        ...(extractError && a.text ? { error: extractError } : {}),
      };
    });

    const tally = new Map();
    for (const r of results) {
      for (const b of r.brands) {
        if (b.is_target) continue;
        const key = b.name.toLowerCase();
        const row = tally.get(key) || { name: b.name, count: 0 };
        row.count += 1;
        tally.set(key, row);
      }
    }
    const competitors = [...tally.values()].sort((a, b) => b.count - a.count).slice(0, 10);
    const answered = results.filter((r) => !r.error && !r.refused).length;
    const mentioned = results.filter((r) => r.mentioned).length;

    return res.status(200).json({
      ...target,
      engine: ENGINE,
      web: results.some((r) => r.searched),
      webRequested: web,
      model: MODEL,
      checkedAt: new Date().toISOString(),
      score: { mentioned, answered, asked: results.length },
      competitors,
      opener: writeOpener(target, results, competitors),
      results,
      ...keyInfo(),
    });
  } catch (err) {
    return res.status(502).json({ error: describe(err), ...keyInfo() });
  }
}

// One tiny call per key, to see what Google allows each key. Never returns the keys themselves.
async function probeKeys(model, search) {
  const m = clean(model, 80) || MODEL;
  const keys = await Promise.all(
    POOL.map(async (k) => {
      const r = await fetch(`${GEMINI_BASE}/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": k.key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Say ok." }] }],
          ...(search ? { tools: [{ google_search: {} }] } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      const msg = d?.error?.message || "";
      const hit = (msg.match(/Quota exceeded for metric:[^\n]*/g) || []).map((x) => x.replace(/^Quota exceeded for metric:\s*/, ""));
      const ids = (d?.error?.details || []).flatMap((x) => (x.violations || []).map((v) => `${v.quotaId} ${v.quotaValue || ""}`.trim()));
      return { label: k.label, status: r.status, limit: hit.length ? hit : ids, error: r.ok ? "" : msg.split("\n")[0].slice(0, 160) };
    }),
  );
  const list = await fetch(`${GEMINI_BASE}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": POOL[0].key } })
    .then((r) => r.json())
    .catch(() => ({}));
  const models = (list.models || [])
    .filter((x) => (x.supportedGenerationMethods || []).includes("generateContent"))
    .map((x) => x.name.replace(/^models\//, ""));
  return { model: m, keys, models };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
