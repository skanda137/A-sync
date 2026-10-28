import { describe, expect, it } from 'vitest';
import { parsePlan, parseRefine, runAnalyst } from '../src/core/analyst';
import { QlooClient } from '../src/core/qloo';
import { json, llmStub, PLAN, qlooStub } from './support/stubs';

const seed = { concept: 'a café', audience: 'mid 20s', city: 'Bengaluru', ageBand: '25_to_29' };
const mk = (f: typeof fetch, explainability = false) => new QlooClient({ apiKey: 'k', minIntervalMs: 0, retryDelayMs: 0, fetchImpl: f, explainability });

describe('parsePlan', () => {
  it('accepts fenced JSON and rejects bad types', () => {
    expect(parsePlan('```json\n' + JSON.stringify(PLAN) + '\n```').domains).toHaveLength(3);
    expect(() => parsePlan('{"entities":[{"name":"x","type":"movie"}],"tagQueries":[],"domains":["urn:entity:artist"]}')).toThrow(/type/);
  });
});

describe('analyst', () => {
  it('resolves signals, tags and recommendations; no re-plan when enough signals', async () => {
    const notes: string[] = [];
    const ev = await runAnalyst(seed, { qloo: mk(qlooStub()), llm: llmStub(() => ({})), note: (m) => notes.push(m) });
    expect(ev.signals.map((s) => s.name)).toEqual(['Alpha', 'Beta', 'Delta']);
    expect(ev.tags).toHaveLength(2);
    expect(ev.entities.length).toBe(9);
    expect(ev.replanned).toBe(false);
    expect(notes).toEqual([]);
  });

  it('REGRESSION: rejects a fuzzy search hit that is unrelated or the wrong type, and a semantic tag with no overlap', async () => {
    const stub = qlooStub();
    const f = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === '/search' && u.searchParams.get('query') === 'Alpha') return json(200, { results: [{ entity_id: 'X', name: 'Totally Different', types: ['urn:entity:artist'] }] });
      if (u.pathname === '/search' && u.searchParams.get('query') === 'Beta') return json(200, { results: [{ entity_id: 'Y', name: 'Beta Place', types: ['urn:entity:place'] }] });
      if (u.pathname === '/v2/tags' && u.searchParams.get('filter.query') === 'indie rock') return json(200, { results: { tags: [{ id: 'urn:tag:pasta', name: 'Pasta Carbonara' }] } });
      return stub(url, init);
    }) as unknown as typeof fetch;
    const ev = await runAnalyst(seed, { qloo: mk(f), llm: llmStub(() => ({ action: 'stop', reason: 'test' }), { plan: { ...PLAN } }), maxRefineRounds: 0 });
    expect(ev.unresolved).toEqual(expect.arrayContaining(['entity: Alpha', 'entity: Beta', 'tag: indie rock']));
    expect(ev.signals.map((x) => x.name)).toEqual(['Delta']);
    expect(ev.tags.map((t) => t.queriedAs)).toEqual(['specialty coffee']);
  });

  it('re-plans exactly once when fewer than 2 signals resolve, and says so', async () => {
    const log: string[] = [];
    const stub = qlooStub();
    let calls = 0;
    const llm = {
      async complete(system: string) {
        log.push(system.startsWith('You plan Qloo') ? 'plan' : 'other');
        calls++;
        return JSON.stringify(calls === 1 ? { ...PLAN, entities: [{ name: 'Ghost', type: 'urn:entity:artist' }] } : PLAN);
      },
    };
    const f = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === '/search' && u.searchParams.get('query') === 'Ghost') return json(200, { results: [] });
      return stub(url, init);
    }) as unknown as typeof fetch;
    const notes: string[] = [];
    const ev = await runAnalyst(seed, { qloo: mk(f), llm, note: (m) => notes.push(m) });
    expect(log).toEqual(['plan', 'plan']);
    expect(ev.replanned).toBe(true);
    expect(ev.signals.length).toBe(3);
    expect(notes[0]).toMatch(/Re-planning once/);
    expect(ev.unresolved).toContain('entity: Ghost');
  });

  it('throws when nothing resolves even after the re-plan', async () => {
    const f = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/search') return json(200, { results: [] });
      return json(200, { results: { tags: [] } });
    }) as unknown as typeof fetch;
    await expect(runAnalyst(seed, { qloo: mk(f), llm: llmStub(() => ({})) })).rejects.toThrow(/no Qloo signals resolved/);
  });

  it('maps explainability back to named seed signals', async () => {
    const ev = await runAnalyst(seed, { qloo: mk(qlooStub({ explain: true }), true), llm: llmStub(() => ({})) });
    const withWhy = ev.entities.find((e) => e.becauseOf);
    expect(withWhy?.becauseOf?.[0]?.name).toBe('Alpha');
  });
});

describe('adaptive refinement', () => {
  // Qloo stub where brand recommendations are weak (0.3) until a "Gamma" seed is among the signals.
  function weakBrandFetch(log: string[] = []) {
    const base = qlooStub();
    return (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      log.push(u.pathname + '?' + (u.searchParams.get('filter.type') ?? u.searchParams.get('query') ?? ''));
      if (u.pathname === '/v2/insights' && u.searchParams.get('filter.type') === 'urn:entity:brand') {
        const sig = u.searchParams.get('signal.interests.entities') ?? '';
        const aff = sig.includes('S:Gamma') ? 0.8 : 0.3;
        return json(200, { results: { entities: [1, 2, 3].map((n) => ({ entity_id: `brand${n}`, name: `brand Name${n}`, query: { affinity: aff }, tags: [] })) } });
      }
      return base(url, init);
    }) as unknown as typeof fetch;
  }
  const refineJson = { action: 'refine', type: 'urn:entity:brand', entities: [{ name: 'Gamma', type: 'urn:entity:brand' }], tagQueries: [], reason: 'Brand affinities are all weak; adding a typical local brand.' };
  const llmWith = (reply: unknown, log: string[] = []) => ({
    async complete(system: string) {
      log.push(system.startsWith('You plan Qloo') ? 'plan' : 'refine');
      return JSON.stringify(system.startsWith('You plan Qloo') ? PLAN : reply);
    },
  });

  it('does not spend an LLM call when every type already has enough strong evidence', async () => {
    const log: string[] = [];
    const ev = await runAnalyst(seed, { qloo: mk(qlooStub()), llm: llmWith(refineJson, log) });
    expect(log).toEqual(['plan']);
    expect(ev.refinements).toEqual([]);
  });

  it('a thin type triggers one model-chosen refinement that adds a seed and improves strong evidence', async () => {
    const log: string[] = [];
    const notes: string[] = [];
    const ev = await runAnalyst(seed, { qloo: mk(weakBrandFetch()), llm: llmWith(refineJson, log), note: (m) => notes.push(m) });
    expect(log).toEqual(['plan', 'refine']);
    expect(ev.refinements).toHaveLength(1);
    expect(ev.refinements[0]).toMatchObject({ type: 'urn:entity:brand', addedEntities: ['Gamma'], strongBefore: 0, strongAfter: 3 });
    expect(ev.signals.map((s) => s.name)).toContain('Gamma');
    expect(notes.at(-1)).toMatch(/Strong 0 → 3/);
  });

  it('stop is respected and recorded in a note', async () => {
    const notes: string[] = [];
    const ev = await runAnalyst(seed, { qloo: mk(weakBrandFetch()), llm: llmWith({ action: 'stop', reason: 'no better seeds' }), note: (m) => notes.push(m) });
    expect(ev.refinements).toEqual([]);
    expect(notes).toContain('Analyst chose to stop refining.');
  });

  it('a refine seed that does not resolve in Qloo is reported, not used', async () => {
    const f = weakBrandFetch();
    const wrapped = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === '/search' && u.searchParams.get('query') === 'Gamma') return json(200, { results: [] });
      return f(url, init);
    }) as unknown as typeof fetch;
    const ev = await runAnalyst(seed, { qloo: mk(wrapped), llm: llmWith(refineJson), maxRefineRounds: 1 });
    expect(ev.unresolved).toContain('entity: Gamma');
    expect(ev.refinements[0]).toMatchObject({ addedEntities: [], strongBefore: 0, strongAfter: 0 });
  });

  it('is bounded by rounds', async () => {
    const log: string[] = [];
    await runAnalyst(seed, { qloo: mk(weakBrandFetch()), llm: llmWith({ ...refineJson, entities: [{ name: 'Nope', type: 'urn:entity:brand' }] }, log), maxRefineRounds: 2 });
    expect(log.filter((l) => l === 'refine').length).toBeLessThanOrEqual(2);
  });

  it('is bounded by the Qloo call budget and says so', async () => {
    const log: string[] = [];
    const notes: string[] = [];
    const ev = await runAnalyst(seed, { qloo: mk(weakBrandFetch()), llm: llmWith(refineJson, log), callBudget: 1, note: (m) => notes.push(m) });
    expect(log).toEqual(['plan']);
    expect(ev.refinements).toEqual([]);
    expect(notes[0]).toMatch(/call budget/);
  });

  it('throws on a malformed refine reply instead of guessing', async () => {
    await expect(runAnalyst(seed, { qloo: mk(weakBrandFetch()), llm: llmWith({ action: 'dance', reason: 'x' }) })).rejects.toThrow(/action must be/);
    await expect(runAnalyst(seed, { qloo: mk(weakBrandFetch()), llm: llmWith({ action: 'refine', type: 'urn:entity:brand', entities: [], tagQueries: [], reason: 'x' }) })).rejects.toThrow(/nothing to add/);
  });

  it('parseRefine accepts fenced JSON', () => {
    expect(parseRefine('```json\n' + JSON.stringify(refineJson) + '\n```')?.type).toBe('urn:entity:brand');
  });
});

describe('REGRESSION (live data): relevance and type-gap trigger', () => {
  it('does not accept "WAVE Sports" for "Third Wave Coffee" (one shared word is not a match)', async () => {
    const stub = qlooStub();
    const f = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === '/search' && u.searchParams.get('query') === 'Third Wave Coffee') return json(200, { results: [{ entity_id: 'W', name: 'WAVE Sports', types: ['urn:entity:brand'] }] });
      return stub(url, init);
    }) as unknown as typeof fetch;
    const plan = { ...PLAN, entities: [...PLAN.entities, { name: 'Third Wave Coffee', type: 'urn:entity:brand' }] };
    const ev = await runAnalyst(seed, { qloo: mk(f), llm: llmStub(() => ({}), { plan }) });
    expect(ev.unresolved).toContain('entity: Third Wave Coffee');
    expect(ev.signals.map((s) => s.id)).not.toContain('W');
  });

  it('refines when a type has strong recommendations but NO seed entity of that type', async () => {
    const log: string[] = [];
    const plan = { ...PLAN, entities: PLAN.entities.filter((e) => e.type !== 'urn:entity:artist') };
    const llm = {
      async complete(system: string) {
        log.push(system.startsWith('You plan Qloo') ? 'plan' : 'refine');
        return JSON.stringify(system.startsWith('You plan Qloo') ? plan : { action: 'refine', type: 'urn:entity:artist', entities: [{ name: 'Zed', type: 'urn:entity:artist' }], tagQueries: [], reason: 'No artist seed; recommendations were driven by brands and places only.' });
      },
    };
    const ev = await runAnalyst(seed, { qloo: mk(qlooStub()), llm, maxRefineRounds: 1 });
    expect(log).toEqual(['plan', 'refine']);
    expect(ev.signals.map((s) => s.name)).toContain('Zed');
    expect(ev.refinements[0]).toMatchObject({ type: 'urn:entity:artist', addedEntities: ['Zed'] });
  });
});
