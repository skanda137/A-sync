import { beforeEach, describe, expect, it } from 'vitest';
import { parseInsights, parseSearch, parseTags, QlooClient, QlooError, qlooQuota, resetQlooQuota } from '../src/core/qloo';
import { json, qlooStub } from './support/stubs';

const fast = { apiKey: 'k', minIntervalMs: 0, retryDelayMs: 0 };
beforeEach(() => resetQlooQuota());

describe('QlooClient', () => {
  it('sends the key as X-Api-Key and never in the URL', async () => {
    let seen: { url: string; headers: Headers } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers) };
      return json(200, { results: [] });
    }) as unknown as typeof fetch;
    await new QlooClient({ ...fast, fetchImpl }).search('x', 'urn:entity:place');
    expect(seen!.headers.get('x-api-key')).toBe('k');
    expect(seen!.url).not.toContain('k=');
  });

  it('retries once on 429, throws after the single retry, never retries a 400', async () => {
    let n = 0;
    const once = (async () => (++n === 1 ? json(429, {}) : json(200, { results: [] }))) as unknown as typeof fetch;
    await new QlooClient({ ...fast, fetchImpl: once }).search('x', 'urn:entity:place');
    expect(n).toBe(2);

    n = 0;
    const down = (async () => { n++; return json(500, {}); }) as unknown as typeof fetch;
    await expect(new QlooClient({ ...fast, fetchImpl: down }).search('x', 'urn:entity:place')).rejects.toBeInstanceOf(QlooError);
    expect(n).toBe(2);

    n = 0;
    const bad = (async () => { n++; return json(400, {}); }) as unknown as typeof fetch;
    await expect(new QlooClient({ ...fast, fetchImpl: bad }).insights({ 'filter.type': 'urn:entity:place' })).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });

  it('caches identical calls', async () => {
    const log: string[] = [];
    const c = new QlooClient({ ...fast, fetchImpl: qlooStub({ log }) });
    await c.search('x', 'urn:entity:place');
    await c.search('x', 'urn:entity:place');
    expect(log).toHaveLength(1);
  });

  it('abort cancels an in-flight request with the abort reason', async () => {
    const ctl = new AbortController();
    const c = new QlooClient({ ...fast, signal: ctl.signal, fetchImpl: qlooStub({ delayMs: 5000 }) });
    const p = c.search('x', 'urn:entity:place');
    setTimeout(() => ctl.abort(new Error('gone')), 20);
    await expect(p).rejects.toThrow('gone');
  });

  it('an aborted caller waiting in the rate-limit queue does not block later callers', async () => {
    const ctl = new AbortController();
    const slow = new QlooClient({ apiKey: 'k', minIntervalMs: 300, retryDelayMs: 0, signal: ctl.signal, fetchImpl: qlooStub() });
    const other = new QlooClient({ apiKey: 'k', minIntervalMs: 300, retryDelayMs: 0, fetchImpl: qlooStub() });
    await other.search('warm', 'urn:entity:place');
    const queued = slow.search('a', 'urn:entity:place');
    queued.catch(() => {});
    setTimeout(() => ctl.abort(new Error('gone')), 10);
    await expect(queued).rejects.toThrow('gone');
    const t0 = Date.now();
    await other.search('b', 'urn:entity:place');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('captures quota headers', async () => {
    await new QlooClient({ ...fast, fetchImpl: qlooStub({ quotaRemaining: 1234 }) }).search('x', 'urn:entity:place');
    expect(qlooQuota().monthRemaining).toBe(1234);
  });

  it('adds feature.explainability only when enabled', async () => {
    const urls: string[] = [];
    const spy = (async (u: string) => { urls.push(u); return json(200, { results: { entities: [] } }); }) as unknown as typeof fetch;
    await new QlooClient({ ...fast, fetchImpl: spy }).insights({ 'filter.type': 'urn:entity:artist' });
    await new QlooClient({ ...fast, fetchImpl: spy, explainability: true }).insights({ 'filter.type': 'urn:entity:artist' });
    expect(urls[0]).not.toContain('explainability');
    expect(urls[1]).toContain('feature.explainability=true');
  });

  it('refuses to construct without a key', () => {
    expect(() => new QlooClient({ apiKey: '' })).toThrow(/QLOO_API_KEY/);
  });
});

describe('parsers (shapes unverified against the live API until `npm run probe` passes)', () => {
  it('parse search, tags and insights incl. explainability', () => {
    expect(parseSearch({ results: [{ entity_id: 'E1', name: 'N', types: ['urn:entity:place'] }] })[0]!.id).toBe('E1');
    expect(parseTags({ results: { tags: [{ id: 'T1', name: 'Coffee' }] } })[0]!.name).toBe('Coffee');
    const e = parseInsights({ results: { entities: [{ entity_id: 'E1', name: 'N', query: { affinity: 0.7, explainability: { 'signal.interests.entities': [{ entity_id: 'S', score: 0.5 }] } }, tags: [{ id: 'T' }] }] } }, 'urn:entity:artist')[0]!;
    expect(e.affinity).toBe(0.7);
    expect(e.tagIds).toEqual(['T']);
    expect(e.explain).toEqual([{ id: 'S', score: 0.5 }]);
  });
  it('REGRESSION (live data): skips a bare category-marker tag with no id, still rejects a malformed id', () => {
    const body = (tags: unknown[]) => ({ results: { entities: [{ entity_id: 'E', name: 'N', query: { affinity: 0.9 }, tags }] } });
    expect(parseInsights(body([{ id: 'urn:tag:a', name: 'A' }, { type: 'urn:tag:voice_type:qloo' }]), 'urn:entity:artist')[0]!.tagIds).toEqual(['urn:tag:a']);
    expect(() => parseInsights(body([{ id: '' }]), 'urn:entity:artist')).toThrow(/tags\[0\].id/);
  });
  it('throw on a mismatch instead of guessing', () => {
    expect(() => parseSearch({ data: [] })).toThrow(/search.results/);
    expect(() => parseInsights({ results: { entities: [{ name: 'x' }] } }, 't')).toThrow(/entity_id/);
    expect(() => parseInsights({ results: { entities: [{ entity_id: 'a', name: 'b', query: { explainability: { 'signal.interests.entities': [{ entity_id: 'S', score: 'hi' }] } } }] } }, 't')).toThrow(/score/);
  });
});

