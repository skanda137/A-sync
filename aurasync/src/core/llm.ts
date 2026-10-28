import type { Llm } from './types';

export interface ChatOptions {
  baseUrl?: string; // OpenAI-compatible base, e.g. https://generativelanguage.googleapis.com/v1beta/openai
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

// One provider-neutral path: any OpenAI-compatible /chat/completions endpoint (Gemini, Groq, OpenRouter, NVIDIA NIM...).
// Throws if misconfigured or on any non-200 (a 429 from a free tier is surfaced, not hidden). Aborting cancels the request.
// max_tokens is generous because "thinking" models count reasoning tokens against it and a truncated reply is invalid JSON.
export function chatLlm(o: ChatOptions = {}): Llm {
  const baseUrl = (o.baseUrl ?? process.env.LLM_BASE_URL ?? '').replace(/\/$/, '');
  const apiKey = o.apiKey ?? process.env.LLM_API_KEY;
  const model = o.model ?? process.env.LLM_MODEL;
  if (!baseUrl) throw new Error('LLM_BASE_URL is required');
  if (!apiKey) throw new Error('LLM_API_KEY is required');
  if (!model) throw new Error('LLM_MODEL is required');
  const doFetch = o.fetchImpl ?? fetch;

  return {
    async complete(system, user, signal) {
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 8000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal,
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] };
      const choice = body.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text !== 'string' || text === '') throw new Error(`LLM returned no text (finish_reason: ${choice?.finish_reason ?? 'unknown'})`);
      return text;
    },
  };
}

/** Wraps an Llm so a run can report how many model calls it made. One wrapper per run. */
export function countingLlm(llm: Llm): { llm: Llm; count: () => number } {
  let n = 0;
  return {
    llm: {
      complete(system, user, signal) {
        n++;
        return llm.complete(system, user, signal);
      },
    },
    count: () => n,
  };
}
