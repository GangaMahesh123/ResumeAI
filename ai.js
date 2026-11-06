'use strict';
// Claude client wrapper: bounded retries with backoff, typed errors,
// strict JSON extraction. Never returns a fake "empty" success.

const config = require('./config');

class AIError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'AIError';
    this.kind = kind; // timeout | rate_limited | overloaded | provider | invalid_json | auth | config
    Object.assign(this, extra);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function classify(err) {
  if (err instanceof AIError) return err;
  const status = err && (err.status || (err.response && err.response.status));
  const msg = (err && err.message) || String(err);
  if (/timed?\s*out|timeout|ETIMEDOUT|ECONNABORTED/i.test(msg) || (err && err.name === 'APIConnectionTimeoutError')) return new AIError('timeout', 'The AI provider timed out.', { cause: msg });
  if (status === 401 || status === 403) return new AIError('auth', 'The AI provider rejected the API key (check ANTHROPIC_API_KEY on Railway).', { status, cause: msg });
  if (status === 404) return new AIError('config', `The AI model "${config.model}" was not found (check CLAUDE_MODEL).`, { status, cause: msg });
  if (status === 429) return new AIError('rate_limited', 'The AI provider rate limit was reached.', { status, cause: msg });
  if (status === 529 || status === 503) return new AIError('overloaded', 'The AI provider is overloaded.', { status, cause: msg });
  if (status === 400) return new AIError('provider', `The AI provider rejected the request: ${msg}`, { status, cause: msg });
  if (status >= 500) return new AIError('provider', 'The AI provider returned a server error.', { status, cause: msg });
  if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|Connection error/i.test(msg)) return new AIError('provider', 'Could not connect to the AI provider.', { cause: msg });
  return new AIError('provider', msg);
}

const TRANSIENT = new Set(['timeout', 'rate_limited', 'overloaded', 'provider']);

/** Pull the first complete JSON object out of a model reply. */
function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) throw new AIError('invalid_json', 'The AI reply did not contain JSON.');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); }
        catch (e) { throw new AIError('invalid_json', `The AI reply contained malformed JSON: ${e.message}`); }
      }
    }
  }
  throw new AIError('invalid_json', 'The AI reply JSON was incomplete (likely cut off by the output token limit).');
}

/**
 * Default provider: Anthropic SDK. Tests inject a fake with the same
 * `complete({system, user, maxTokens})` → string signature.
 */
function createAnthropicProvider() {
  if (!config.anthropicApiKey) {
    return {
      async complete() { throw new AIError('config', 'ANTHROPIC_API_KEY is not set on the server (Railway → Variables).'); },
    };
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropicApiKey, timeout: config.requestTimeoutMs, maxRetries: 0 });
  return {
    async complete({ system, user, maxTokens, model }) {
      const useModel = model || config.model;
      // Streaming keeps long generations alive and avoids SDK limits on large max_tokens.
      const stream = client.messages.stream({
        model: useModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });
      let msg;
      try { msg = await stream.finalMessage(); }
      catch (e) {
        // A missing fast model must not break the run: fall back to the main model.
        if (useModel !== config.model && (e.status === 404 || e.status === 400)) return this.complete({ system, user, maxTokens });
        throw e;
      }
      const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
      if (msg.stop_reason === 'max_tokens') {
        throw new AIError('invalid_json', `The AI reply hit the output limit (${maxTokens} tokens). Increase CLAUDE_REWRITE_MAX_TOKENS.`, { truncated: true });
      }
      return text;
    },
  };
}

/**
 * Call the provider and parse JSON, with bounded retries.
 * - Transient errors: exponential backoff.
 * - Invalid JSON: re-ask (counts as a retry).
 * - Auth/config errors: fail immediately.
 */
async function callJson(provider, { system, user, maxTokens, label, requestId, log = console, model, retries }) {
  let lastErr;
  const attempts = Math.max(1, retries || config.maxRetries);
  for (let i = 0; i < attempts; i++) {
    try {
      const text = await provider.complete({ system, user, maxTokens, model });
      return extractJson(text);
    } catch (raw) {
      const err = classify(raw);
      lastErr = err;
      log.error(`[${requestId}] AI ${label} attempt ${i + 1}/${attempts} failed: ${err.kind} — ${err.message}${err.cause ? ` (${err.cause})` : ''}`);
      if (!TRANSIENT.has(err.kind) && err.kind !== 'invalid_json') break;
      if (i < attempts - 1) await sleep(Math.min(4000, 500 * 2 ** i) + Math.floor(Math.random() * 200));
    }
  }
  lastErr.stage = label;
  throw lastErr;
}

module.exports = { AIError, callJson, extractJson, createAnthropicProvider, classify };
