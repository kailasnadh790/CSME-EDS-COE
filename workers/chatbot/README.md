# Chatbot Worker

A Cloudflare Worker that answers visitor questions using **only** this site's
published content. It retrieves relevant pages from the site `query-index.json`
and calls the Anthropic API server-side, so no API key is ever exposed to the
browser.

## How it works

1. Browser (the `chatbot` block) POSTs `{ message, history }` to this worker.
2. Worker fetches `SITE_ORIGIN/query-index.json` (cached at the edge).
3. It ranks pages against the question with a lightweight keyword score and
   takes the top pages as grounding context.
4. It calls the Anthropic Messages API with a system prompt that restricts the
   model to the provided context and requires inline `[Source N]` citations.
5. Worker returns `{ answer, sources }`.

The site content corpus is produced by `helix-query.yaml` at the repo root,
which tells Edge Delivery to publish `/query-index.json` with each page's
`title`, `description`, and `body` text.

## Configuration

Set in `wrangler.toml` under `[vars]`:

| Var | Purpose | Example |
| --- | --- | --- |
| `SITE_ORIGIN` | Base URL of the published site | `https://main--csme-eds-coe--kailasnadh790.aem.live` |
| `ALLOWED_ORIGIN` | CORS allow-origin | `*` or your domain |
| `MODEL` | Anthropic model id | `claude-haiku-4-5-20251001` |

Secret (never commit):

```sh
wrangler secret put ANTHROPIC_API_KEY --config ./workers/chatbot/wrangler.toml
```

## Local development

```sh
npm run dev:chatbot   # runs on http://localhost:8787
```

The `chatbot` block automatically targets `http://localhost:8787` on
`localhost`, and `/chatbot` in production. For local runs you still need the
`ANTHROPIC_API_KEY` — put it in a `.dev.vars` file in this folder:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Deploy

1. Uncomment and edit the `routes` block in `wrangler.toml` so `/chatbot/*` is
   served from the production domain (mirrors the `contact_us` worker pattern).
2. `npm run deploy:chatbot`
3. `npm run tail:chatbot` to watch logs.

## Request / response

```
POST /
{ "message": "How do I choose an authoring model?",
  "history": [ { "role": "user", "content": "..." }, ... ] }

200
{ "answer": "…", "sources": [ { "title": "...", "path": "/...", "url": "https://..." } ] }
```
