# Shortlist

Checks whether Claude names a brand when buyers ask it for recommendations.

Give it a brand, its website, what it sells and its market. It writes five buyer questions (or uses yours), asks Claude each one with web search on, pulls out every brand the answer names, and reports:

- how many answers named the brand, and at what position
- which competitors were named instead
- the full answers and the sources Claude cited
- a short, data-backed opener you can send to that brand

Batch mode runs up to 25 brands and exports a CSV.

## Stack

- Static `index.html` (no build step)
- One Vercel function, `api/check.js`, using `@anthropic-ai/sdk`
- Structured outputs for question writing and brand extraction, the web search server tool for answers

## Run it

```
npm install
node scripts/setup-keys.mjs   # adds one or more Gemini keys and the access code, then deploys
```

Or set `GEMINI_API_KEYS` (comma separated), `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`, plus `ACCESS_CODE`, yourself. Several Gemini keys are used in turn, and a rate-limited or rejected key is skipped.

With a Gemini key set it runs on Gemini (`GEMINI_MODEL`, default `gemini-4-hydrogen`) and uses Grounding with Google Search when the key allows it. Free-tier keys answer from the model's own knowledge, and the report says so. Without it, it runs on Claude (`CLAUDE_MODEL`, default `claude-opus-5-5`) with web search.

## Caveat

AI answers change from run to run. One check is a sample, not a ranking.
