import { describe, expect, it } from 'vitest';
import { chatLlm } from '../src/core/llm';
import { json } from './support/stubs';

const cfg = { baseUrl: 'https://x.test/v1/', apiKey: 'k', model: 'm' };

describe('chatLlm', () => {
  it('posts an OpenAI-style chat request with a bearer key and returns the message text', async () => {
    let seen: { url: string; headers: Headers; body: { model: string; messages: { role: string }[] } } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return json(200, { choices: [{ message: { content: 'hello' } }] });
    }) as unknown as typeof fetch;
    expect(await chatLlm({ ...cfg, fetchImpl }).complete('sys', 'usr')).toBe('hello');
    expect(seen!.url).toBe('https://x.test/v1/chat/completions');
    expect(seen!.headers.get('authorization')).toBe('Bearer k');
    expect(seen!.body.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
  it('surfaces a 429 instead of hiding it', async () => {
    const fetchImpl = (async () => json(429, { error: 'quota' })) as unknown as typeof fetch;
    await expect(chatLlm({ ...cfg, fetchImpl }).complete('s', 'u')).rejects.toThrow(/LLM 429/);
  });
  it('throws on an empty or missing reply, naming the finish reason', async () => {
    const fetchImpl = (async () => json(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] })) as unknown as typeof fetch;
    await expect(chatLlm({ ...cfg, fetchImpl }).complete('s', 'u')).rejects.toThrow(/finish_reason: length/);
  });
  it('refuses to construct without base url, key and model', () => {
    expect(() => chatLlm({ apiKey: 'k', model: 'm', baseUrl: '' })).toThrow(/LLM_BASE_URL/);
    expect(() => chatLlm({ baseUrl: 'u', model: 'm', apiKey: '' })).toThrow(/LLM_API_KEY/);
    expect(() => chatLlm({ baseUrl: 'u', apiKey: 'k', model: '' })).toThrow(/LLM_MODEL/);
  });
});
