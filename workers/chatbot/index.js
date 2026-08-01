/**
 * Site chatbot worker.
 *
 * Answers visitor questions using ONLY the content published on the site.
 * Retrieval: fetches the site query-index.json, scores pages against the
 * question with a lightweight TF/keyword ranking, and passes the top pages
 * to the Anthropic API as grounded context. The model is instructed to
 * answer only from that context and to cite the source pages.
 *
 * Configuration (Worker vars / secrets):
 *   ANTHROPIC_API_KEY (secret)  - Anthropic API key
 *   SITE_ORIGIN       (var)     - Base URL of the published site, e.g.
 *                                 https://main--csme-eds-coe--kailasnadh790.aem.live
 *   ALLOWED_ORIGIN    (var)     - Allowed CORS origin (default '*')
 *   MODEL             (var)     - Anthropic model id (default claude-haiku-4-5-20251001)
 */

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONTEXT_PAGES = 6;
const MAX_BODY_CHARS = 2000;
const MAX_QUESTION_CHARS = 1000;
const INDEX_TTL_SECONDS = 300;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'we', 'you', 'they', 'he', 'she', 'do',
  'does', 'did', 'can', 'could', 'should', 'would', 'will', 'what', 'how', 'why',
  'when', 'where', 'which', 'who', 'about', 'my', 'our', 'your', 'me', 'us',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/** Fetch the site query-index, cached at the edge. */
async function fetchIndex(env) {
  const origin = String(env.SITE_ORIGIN || '').replace(/\/+$/, '');
  if (!origin) throw new Error('SITE_ORIGIN not configured');
  const resp = await fetch(`${origin}/query-index.json`, {
    cf: { cacheTtl: INDEX_TTL_SECONDS, cacheEverything: true },
  });
  if (!resp.ok) throw new Error(`query-index fetch failed: ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data?.data) ? data.data : [];
}

/** Rank pages by keyword overlap with the question. */
function retrieve(rows, question) {
  const terms = tokenize(question);
  if (!terms.length) return [];
  const termSet = new Set(terms);

  const scored = rows.map((row) => {
    const title = String(row.title || '');
    const description = String(row.description || '');
    const body = String(row.body || '');
    const titleTokens = tokenize(title);
    const bodyTokens = tokenize(`${description} ${body}`);

    let score = 0;
    titleTokens.forEach((t) => { if (termSet.has(t)) score += 3; });
    bodyTokens.forEach((t) => { if (termSet.has(t)) score += 1; });
    // Reward coverage of distinct query terms.
    const matched = new Set([...titleTokens, ...bodyTokens].filter((t) => termSet.has(t)));
    score += matched.size * 2;

    return { row, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONTEXT_PAGES)
    .map((s) => s.row);
}

function buildContext(pages, origin) {
  return pages.map((p, i) => {
    const path = String(p.path || '');
    const url = `${origin}${path}`;
    const body = String(p.body || '').slice(0, MAX_BODY_CHARS);
    return `[Source ${i + 1}] ${p.title || path}\nURL: ${url}\n${p.description || ''}\n${body}`;
  }).join('\n\n---\n\n');
}

async function callAnthropic(env, question, context, history) {
  const model = env.MODEL || DEFAULT_MODEL;
  const system = [
    'You are the helpful assistant for this website. Answer questions using ONLY the',
    'information in the provided site content below. Do not use outside knowledge.',
    'If the answer is not in the provided content, say you could not find that on the',
    'site and suggest the closest relevant page. Keep answers concise and factual.',
    'When you use a source, cite it inline like [Source 1]. Never invent URLs or facts.',
    '',
    'SITE CONTENT:',
    context || '(no relevant pages found)',
  ].join('\n');

  const messages = [
    ...(Array.isArray(history) ? history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_CHARS) })) : []),
    { role: 'user', content: question },
  ];

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${detail}`);
  }
  const result = await resp.json();
  const text = (result.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
  return text;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, env);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Worker not configured' }, 500, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, env);
    }

    const question = String(body?.message || '').trim().slice(0, MAX_QUESTION_CHARS);
    if (!question) {
      return json({ error: 'Missing message' }, 400, env);
    }

    try {
      const origin = String(env.SITE_ORIGIN || '').replace(/\/+$/, '');
      const rows = await fetchIndex(env);
      const pages = retrieve(rows, question);
      const context = buildContext(pages, origin);
      const answer = await callAnthropic(env, question, context, body?.history);
      const sources = pages.map((p) => ({
        title: p.title || p.path,
        path: p.path,
        url: `${origin}${p.path}`,
      }));
      return json({ answer, sources }, 200, env);
    } catch (err) {
      return json({ error: 'Unable to answer right now.', detail: String(err.message || err) }, 500, env);
    }
  },
};
