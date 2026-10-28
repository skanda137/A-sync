import { describe, expect, it } from 'vitest';
import { audit } from '../src/core/auditor';
import type { Brief, BriefItem, Evidence, EvidenceEntity } from '../src/core/types';

const ent = (id: string, name: string, type: EvidenceEntity['type'], affinity: number | null, tagIds: string[] = []): EvidenceEntity => ({ id, name, type, affinity, popularity: 0.5, tagIds });
const evidence: Evidence = {
  seed: { concept: 'c', audience: 'a', city: 'x' },
  signals: [],
  entities: [
    ent('A1', 'Prateek Kuhad', 'urn:entity:artist', 0.9, ['urn:tag:indie']),
    ent('A2', 'Weak Band', 'urn:entity:artist', 0.2),
    ent('P1', 'Blue Tokai', 'urn:entity:place', 0.8),
    ent('B1', 'Nike', 'urn:entity:brand', 0.7),
  ],
  tags: [{ id: 'T1', name: 'Specialty Coffee', queriedAs: 'specialty coffee' }],
  unresolved: [],
  calls: [],
  replanned: false, refinements: [],
};
const item = (o: Partial<BriefItem> & Pick<BriefItem, 'id' | 'domain' | 'text'>): BriefItem => ({ source: 'qloo', entityIds: [], tagIds: [], ...o });
const run = (items: BriefItem[]) => audit({ title: 't', items } as Brief, evidence);
const reason = (r: ReturnType<typeof run>, id: string) => r.failures.find((f) => f.itemId === id)?.reason ?? '';

describe('auditor', () => {
  it('verifies a typed, named, strong citation and reports mean affinity', () => {
    const r = run([item({ id: 'm1', domain: 'music', text: 'Open with Prateek Kuhad.', entityIds: ['A1'] }), item({ id: 'p1', domain: 'place', text: 'Echo Blue Tokai pour-overs.', entityIds: ['P1'] })]);
    expect(r.score).toBe(100);
    expect(r.meanAffinity).toBe(0.85);
  });

  it('REGRESSION: a music item cannot be verified by citing a place or brand (type laundering)', () => {
    const r = run([item({ id: 'm1', domain: 'music', text: 'Play Blue Tokai beats.', entityIds: ['P1'] })]);
    expect(r.verified).toBe(0);
    expect(reason(r, 'm1')).toMatch(/must cite a Qloo artist/);
  });

  it('REGRESSION: a menu item cannot be verified by citing an unrelated tag', () => {
    const r = run([item({ id: 'f1', domain: 'menu', text: 'Serve spicy ramen bowls.', tagIds: ['T1'] })]);
    expect(r.verified).toBe(0);
    expect(reason(r, 'f1')).toMatch(/is reflected in the text/);
  });

  it('a menu item reflecting the tag wording verifies', () => {
    expect(run([item({ id: 'f1', domain: 'menu', text: 'Lead with specialty coffee flights.', tagIds: ['T1'] })]).verified).toBe(1);
  });

  it('REGRESSION: text must name the cited entity (no id laundering)', () => {
    const r = run([item({ id: 'm1', domain: 'music', text: 'Play some jazz.', entityIds: ['A1'] })]);
    expect(r.verified).toBe(0);
    expect(reason(r, 'm1')).toMatch(/never names it/);
  });

  it('weak affinity fails; fabricated ids are penalised; llm-only domains are not scored', () => {
    const weak = run([item({ id: 'm1', domain: 'music', text: 'Play Weak Band.', entityIds: ['A2'] })]);
    expect(reason(weak, 'm1')).toMatch(/affinity/);
    const fab = run([
      item({ id: 'm1', domain: 'music', text: 'Open with Prateek Kuhad.', entityIds: ['A1'] }),
      item({ id: 'm2', domain: 'music', text: 'Play Ghost.', entityIds: ['NOPE'] }),
      item({ id: 'l1', domain: 'lighting', text: 'Warm 2700K.', source: 'llm' }),
    ]);
    expect(fab.fabricatedItems).toEqual(['m2']);
    expect(fab.score).toBe(40); // 100*1/2 - 10
    expect(fab.llmOnlyItems).toBe(1);
    expect(fab.groundable).toBe(2);
  });

  it('an LLM-only domain claiming Qloo is fabricated', () => {
    const r = run([item({ id: 'l1', domain: 'lighting', text: 'Warm.', source: 'qloo', entityIds: ['A1'] })]);
    expect(r.fabricatedItems).toEqual(['l1']);
  });

  it('empty groundable set scores 0, meanAffinity null', () => {
    const r = run([item({ id: 'l1', domain: 'styling', text: 'Denim.', source: 'llm' })]);
    expect(r.score).toBe(0);
    expect(r.meanAffinity).toBeNull();
  });
});
