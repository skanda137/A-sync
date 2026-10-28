import { assertBrief, type Architect, type AuditReport, type Brief, type Evidence, type Llm, type Seed } from './types';

const SYSTEM = `You are the Architect in a three-agent system that designs physical experiences (cafés, pop-ups, venues).
You receive a seed and EVIDENCE retrieved from the Qloo Taste Graph. Return ONLY one JSON object, no prose, no code fences:
{"title":string,"items":[{"id":string,"domain":"music"|"brand"|"place"|"menu"|"audience"|"lighting"|"material"|"styling","text":string,"source":"qloo"|"llm","entityIds":string[],"tagIds":string[]}]}

Hard rules (an independent Auditor checks every one, in code):
1. Cover all 8 domains. Aim for 2 items each in music, brand, place, menu; 1-2 in audience; 1-2 each in lighting, material, styling. 14-18 items total.
2. music, brand, place, menu, audience are GROUNDABLE. Make them source "qloo" and cite ids that appear in EVIDENCE.
   - music items cite an artist entity, brand items a brand entity, place items a place entity (see the type column), AND name that entity exactly as written in EVIDENCE inside "text". A music item citing a place is rejected.
   - menu/audience items: cite one or more tag ids from the T: lines, and use that tag's own wording in "text" (a tag the text does not reflect is rejected). Or name a cited entity with affinity >= 0.5.
   - Prefer entities with affinity >= 0.5. Never cite an id not present in EVIDENCE. Never invent artists, brands or venues.
3. lighting, material, styling are NOT groundable. Use source "llm", entityIds [], tagIds []. Make them concrete (colour temperature in K, materials, textures, dress cues) and consistent with the grounded items.
4. "text" is one or two specific, actionable sentences a pop-up team could execute. Say WHY it fits this audience when evidence supports it.
5. Item ids are short and stable (m1, b1, p1, f1, a1, l1, s1, t1...). When revising, keep ids of items that passed.
If EVIDENCE is thin for a domain, write fewer items for it rather than guessing.`;

const short = (t: string) => t.replace('urn:entity:', '');

export function renderEvidence(ev: Evidence, perType = 12): string {
  const lines: string[] = [];
  for (const type of ['urn:entity:artist', 'urn:entity:brand', 'urn:entity:place'] as const) {
    const list = ev.entities
      .filter((e) => e.type === type)
      .sort((a, b) => (b.affinity ?? -1) - (a.affinity ?? -1))
      .slice(0, perType);
    for (const e of list) {
      const aff = e.affinity === null ? 'n/a' : e.affinity.toFixed(2);
      lines.push(`E: ${e.id} | ${e.name} | ${short(e.type)} | affinity ${aff} | tags: ${e.tagIds.slice(0, 5).join(',') || '-'}`);
    }
  }
  for (const t of ev.tags) lines.push(`T: ${t.id} | ${t.name} | (queried as "${t.queriedAs}")`);
  if (ev.unresolved.length) lines.push(`UNRESOLVED (Qloo had nothing; do not guess): ${ev.unresolved.join('; ')}`);
  return lines.join('\n');
}

export function renderFeedback(prev: Brief, fb: AuditReport): string {
  const bad = new Set(fb.failures.map((f) => f.itemId));
  const keep = prev.items.filter((i) => !bad.has(i.id)).map((i) => i.id);
  return [
    `AUDITOR FEEDBACK. Score ${fb.score} (target ${fb.target}); ${fb.verified}/${fb.groundable} groundable items verified.`,
    ...fb.failures.map((f) => `- ${f.itemId}: ${f.reason}`),
    `Fix or replace ONLY the failing items. Items to keep unchanged: ${keep.join(', ') || 'none'}.`,
    `PREVIOUS BRIEF:\n${JSON.stringify(prev)}`,
  ].join('\n');
}

export function buildPrompt(seed: Seed, ev: Evidence, prev?: Brief, fb?: AuditReport): string {
  const parts = [
    `SEED: ${JSON.stringify({ concept: seed.concept, audience: seed.audience, city: seed.city })}`,
    ...(seed.note ? [`CLIENT NOTE (preference; not Qloo evidence, never cite it): ${seed.note}`] : []),
    `EVIDENCE (the only ids you may cite):\n${renderEvidence(ev)}`,
  ];
  if (prev && fb) parts.push(renderFeedback(prev, fb));
  return parts.join('\n\n');
}

export function parseBrief(text: string): Brief {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error(`Architect reply has no JSON object: ${t.slice(0, 120)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(t.slice(a, b + 1));
  } catch {
    throw new Error(`Architect reply is not valid JSON: ${t.slice(0, 120)}`);
  }
  return assertBrief(raw);
}

// One repair attempt on malformed output, then fail fast (consistent with the run's stop rules).
export function makeArchitect(llm: Llm): Architect {
  return async ({ seed, evidence, previousBrief, feedback, signal }) => {
    const user = buildPrompt(seed, evidence, previousBrief, feedback);
    try {
      return parseBrief(await llm.complete(SYSTEM, user, signal));
    } catch (e) {
      const retry = `${user}\n\nYour previous reply was rejected: ${(e as Error).message}\nReturn ONLY the JSON object, matching the schema exactly.`;
      return parseBrief(await llm.complete(SYSTEM, retry, signal));
    }
  };
}
