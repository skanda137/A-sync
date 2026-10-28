import { describe, expect, it } from 'vitest';
import { buildPrompt, makeArchitect, parseBrief, renderEvidence } from '../src/core/architect';
import type { Evidence } from '../src/core/types';

const ev: Evidence = {
  seed: { concept: 'c', audience: 'a', city: 'x', note: 'no alcohol' },
  signals: [], tags: [{ id: 'T1', name: 'Coffee', queriedAs: 'coffee' }], unresolved: ['entity: Ghost'], calls: [], replanned: false, refinements: [],
  entities: [{ id: 'A1', name: 'Band', type: 'urn:entity:artist', affinity: 0.9, popularity: 0.1, tagIds: ['t'] }],
};

describe('architect', () => {
  it('renders evidence incl. unresolved and puts the client note in the prompt as non-evidence', () => {
    expect(renderEvidence(ev)).toContain('UNRESOLVED');
    const p = buildPrompt(ev.seed, ev);
    expect(p).toMatch(/CLIENT NOTE.*no alcohol/);
  });
  it('parseBrief strips fences and validates', () => {
    expect(parseBrief('```json\n{"title":"t","items":[{"id":"a","domain":"music","text":"x","source":"llm","entityIds":[],"tagIds":[]}]}\n```').title).toBe('t');
    expect(() => parseBrief('nope')).toThrow(/no JSON/);
  });
  it('repairs once on malformed output, then fails fast', async () => {
    let n = 0;
    const good = '{"title":"t","items":[{"id":"a","domain":"music","text":"x","source":"llm","entityIds":[],"tagIds":[]}]}';
    const a = makeArchitect({ complete: async () => (++n === 1 ? 'garbage' : good) });
    expect((await a({ seed: ev.seed, evidence: ev })).title).toBe('t');
    expect(n).toBe(2);
    n = 0;
    await expect(makeArchitect({ complete: async () => { n++; return 'garbage'; } })({ seed: ev.seed, evidence: ev })).rejects.toThrow();
    expect(n).toBe(2);
  });
});
