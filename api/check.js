import Anthropic from "@anthropic-ai/sdk";

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
  ? process.env.GEMINI_MODEL || "gemini-4-hydrogen"
  : process.env.CLAUDE_MODEL || "claude-opus-5-5";
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const MAX_QUESTIONS = 5;
// Free-tier Gemini keys have low per-minute limits, so ask two questions at a time per key.
const CONCURRENCY = USE_GEMINI ? Math.min(MAX_QUESTIONS, 2 * GEMINI_KEYS.length) : MAX_QUESTIONS;

// Set once a key turns out to have no Google Search access, so later questions skip the attempt.
let searchBlocked = false;
let anthropic;
const claude = () => (anthropic ??= new Anthropic());

const QUESTIONS_SCHEMA = {
  type: "object",
  properties: { questions: { type: "array", items: { type: "string" } } },
  required: ["questions"],
  additionalProperties: false,
};

const BRANDS_SCHEMA = {
  type: "object",
  properties: {
    brands: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          is_target: { type: "boolean" },
        },
        required: ["name", "is_target"],
        additionalProperties: false,
      },
    },
  },
  required: ["brands"],
  additionalProperties: false,
};

const clean = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class EngineError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------------- Gemini (REST, generateContent) ---------------- */

// Spread calls across keys; when one is rate limited or rejected, move to the next.
let keyCursor = 0;

async function geminiCall(body) {
  let switches = 0;
  let waits = 0;
  for (;;) {
    const key = GEMINI_KEYS[keyCursor++ % GEMINI_KEYS.length];
    const res = await fetch(`${GEMINI_BASE}/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const data = await res.json().catch(() => ({}));
    const err = new EngineError(res.status, data?.error?.message || `HTTP ${res.status}`);
    if ((res.status === 429 || isKeyError(err)) && switches < GEMINI_KEYS.length - 1) {
      switches++;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && waits < 2) {
      waits++;
      switches = 0;
      await wait(waits * 5000);
      continue;
    }
    throw err;
  }
}

const isKeyError = (e) => e instanceof EngineError && (e.status === 401 || e.status === 403 || /api key/i.test(e.message));

function geminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
}

function geminiBlocked(data) {
  if (data?.promptFeedback?.blockReason) return true;
  const reason = data?.candidates?.[0]?.finishReason;
  return ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(reason);
}

async function geminiStructured(prompt, schema) {
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  let data;
  try {
    data = await geminiCall({
      contents,
      generationConfig: { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema } } },
    });
  } catch (err) {
    // Older model versions use the SDK-style field names.
    if (!(err instanceof EngineError) || err.status !== 400 || isKeyError(err)) throw err;
    data = await geminiCall({
      contents,
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema },
    });
  }
  if (geminiBlocked(data)) throw new Error("The model declined this request.");
  return JSON.parse(geminiText(data));
}

async function geminiAnswer(question, system, web) {
  const base = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: question }] }],
  };
  let data;
  let searched = web && !searchBlocked;
  if (searched) {
    try {
      data = await geminiCall({ ...base, tools: [{ google_search: {} }] });
    } catch (err) {
      // Free-tier keys cannot use Google Search on current models. Answer from memory instead.
      if (isKeyError(err) || !(err instanceof EngineError) || err.status === 429) throw err;
      searchBlocked = true;
      searched = false;
    }
  }
  if (!data) data = await geminiCall(base);
  if (geminiBlocked(data)) return { text: "", sources: [], refused: true, searched };

  const sources = new Map();
  for (const c of data?.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
    const w = c.web;
    if (w?.uri && !sources.has(w.uri)) sources.set(w.uri, { title: w.title || w.uri, url: w.uri });
  }
  return { text: geminiText(data).trim(), sources: [...sources.values()].slice(0, 8), refused: false, searched };
}

/* ---------------- Claude (Anthropic SDK) ---------------- */

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

const structured = (prompt, schema) => (USE_GEMINI ? geminiStructured : claudeStructured)(prompt, schema);

// Ask the question the way a buyer would. With web search on, this mirrors AI search.
function answer(question, market, web) {
  const system =
    "Answer the user's question the way you normally would for a real person. Be concise, under 250 words." +
    (market ? ` The person asking is based in ${market}.` : "");
  return (USE_GEMINI ? geminiAnswer : claudeAnswer)(question, system, web);
}

async function makeQuestions({ brand, category, market }) {
  const prompt = [
    `Write ${MAX_QUESTIONS} questions a real buyer would type into ChatGPT, Gemini or Claude when they are looking for ${category}${market ? ` in ${market}` : ""}.`,
    `They have not heard of ${brand}, so never name ${brand} or any other company.`,
    "Mix them: one 'best ... in ...' question, one comparison, one led by a problem the buyer has, one about price, one about a specific use case.",
    "Write them the way people actually type: plain, short, no quotation marks.",
  ].join("\n");
  const out = await structured(prompt, QUESTIONS_SCHEMA);
  return out.questions.map((q) => clean(q, 300)).filter(Boolean).slice(0, MAX_QUESTIONS);
}

async function extractBrands(answerText, { brand, domain }) {
  if (!answerText) return [];
  const prompt = [
    `Target brand: ${brand}${domain ? ` (website ${domain})` : ""}.`,
    "Below is an AI assistant's answer to a buyer. List every company, brand, product or provider it recommends or names as an option, in the order each first appears.",
    "Set is_target to true only for the target brand itself (its company, its products, or a clear variant of its name or website).",
    "Leave out generic categories, and publications or directories that are only cited as sources.",
    "",
    "<answer>",
    answerText,
    "</answer>",
  ].join("\n");
  const out = await structured(prompt, BRANDS_SCHEMA);
  const seen = new Set();
  return out.brands
    .map((b) => ({ name: clean(b.name, 120), is_target: !!b.is_target }))
    .filter((b) => b.name && !seen.has(b.name.toLowerCase()) && seen.add(b.name.toLowerCase()));
}

async function checkQuestion(question, target, web) {
  try {
    const a = await answer(question, target.market, web);
    const brands = await extractBrands(a.text, target);
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
    };
  } catch (err) {
    return { question, error: describe(err), brands: [], sources: [], mentioned: false, position: null };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
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
    if (isKeyError(err)) return "The API key is missing or invalid.";
    if (err.status === 429) return "Rate limited by the API. Wait a minute and run it again.";
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
    return res.status(500).json({ error: "No API key on the server. Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY." });
  }

  const target = {
    brand: clean(body.brand, 120),
    domain: clean(body.domain, 120).replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    category: clean(body.category, 200),
    market: clean(body.market, 120),
  };
  if (!target.brand) return res.status(400).json({ error: "Brand name is required." });
  if (!target.category) return res.status(400).json({ error: "Say what the brand sells." });
  const web = body.web !== false;

  try {
    let questions = Array.isArray(body.questions)
      ? body.questions.map((q) => clean(q, 300)).filter(Boolean).slice(0, MAX_QUESTIONS)
      : [];
    if (!questions.length) questions = await makeQuestions(target);
    if (!questions.length) return res.status(502).json({ error: "Could not write buyer questions. Add your own and retry." });

    const results = await mapLimit(questions, CONCURRENCY, (q) => checkQuestion(q, target, web));

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
    });
  } catch (err) {
    return res.status(502).json({ error: describe(err) });
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
