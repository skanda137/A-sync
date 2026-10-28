import type { Llm } from '../../src/core/types';

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

export interface QlooStubOptions {
  delayMs?: number;
  log?: string[];
  quotaRemaining?: number;
  explain?: boolean;
}

/** A fake Qloo that behaves like the documented shapes and honours AbortSignal. */
export function qlooStub(o: QlooStubOptions = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    await wait(o.delayMs ?? 0, init?.signal ?? undefined);
    o.log?.push(u.pathname);
    const h: Record<string, string> = o.quotaRemaining === undefined ? {} : { 'x-month-ratelimit-remaining': String(o.quotaRemaining) };
    if (u.pathname === '/search') {
      const q = u.searchParams.get('query')!;
      const type = u.searchParams.get('types')!;
      return json(200, { results: [{ entity_id: `S:${q}`, name: q, types: [type], popularity: 0.5 }] }, h);
    }
    if (u.pathname === '/v2/tags') {
      const q = u.searchParams.get('filter.query')!;
      return json(200, { results: { tags: [{ id: `urn:tag:${q.replace(/ /g, '_')}`, name: q[0]!.toUpperCase() + q.slice(1) }] } }, h);
    }
    const type = u.searchParams.get('filter.type')!;
    const kind = type.replace('urn:entity:', '');
    const sig = (u.searchParams.get('signal.interests.entities') ?? '').split(',').filter(Boolean);
    return json(200, {
      results: {
        entities: [1, 2, 3].map((n) => ({
          entity_id: `${kind}${n}`,
          name: `${kind} Name${n}`,
          popularity: 0.4,
          query: { affinity: 0.9 - n * 0.1, ...(o.explain && sig[0] ? { explainability: { 'signal.interests.entities': [{ entity_id: sig[0], score: 0.8 }] } } : {}) },
          tags: [{ id: `urn:tag:${kind}_t${n}` }],
        })),
      },
    }, h);
  }) as unknown as typeof fetch;
}

export const PLAN = {
  entities: [
    { name: 'Alpha', type: 'urn:entity:artist' },
    { name: 'Beta', type: 'urn:entity:brand' },
    { name: 'Delta', type: 'urn:entity:place' },
  ],
  tagQueries: ['specialty coffee', 'indie rock'],
  domains: ['urn:entity:artist', 'urn:entity:brand', 'urn:entity:place'],
};

/** LLM stub: plan prompt -> PLAN, anything else -> `brief()` . Honours AbortSignal. */
export function llmStub(brief: () => unknown, o: { delayMs?: number; plan?: unknown; log?: string[] } = {}): Llm {
  return {
    async complete(system, _user, signal) {
      const isPlan = system.startsWith('You plan Qloo');
      o.log?.push(isPlan ? 'llm:plan' : 'llm:architect');
      await wait(o.delayMs ?? 0, signal);
      return JSON.stringify(isPlan ? (o.plan ?? PLAN) : brief());
    },
  };
}

export const goodBrief = () => ({
  title: 'Test',
  items: [
    { id: 'm1', domain: 'music', text: 'Play artist Name1 on the speakers.', source: 'qloo', entityIds: ['artist1'], tagIds: [] },
    { id: 'b1', domain: 'brand', text: 'Partner with brand Name1 for merch.', source: 'qloo', entityIds: ['brand1'], tagIds: [] },
    { id: 'l1', domain: 'lighting', text: 'Warm 2700K pendants.', source: 'llm', entityIds: [], tagIds: [] },
  ],
});

export const badBrief = () => ({
  title: 'Bad',
  items: [{ id: 'm1', domain: 'music', text: 'Play some jazz.', source: 'qloo', entityIds: ['artist1'], tagIds: [] }],
});
