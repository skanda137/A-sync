import { norm, sharesWord, slugWords } from './text';
import { GROUNDABLE, TYPE_OF_DOMAIN, type AuditFailure, type AuditReport, type Brief, type Evidence } from './types';

export const DEFAULT_TARGET = 85;
export const MIN_AFFINITY = 0.5; // a named entity counts as strong evidence at or above this
export const FABRICATION_PENALTY = 10; // points per brief item citing ids that are not in the evidence

/**
 * Cultural Cohesion Score, computed, no LLM involved:
 *   score = 100 * verified / groundable  -  10 * fabricatedItems      (clamped to 0..100)
 * groundable = brief items in Qloo-groundable domains (music, brand, place, menu, audience)
 * An item is verified only when ALL of these hold:
 *   - source 'qloo', every cited id exists in the evidence
 *   - music/brand/place: it cites an entity of the matching Qloo type, its text names that entity,
 *     and that entity has affinity >= MIN_AFFINITY
 *   - menu/audience: its text names a cited entity with affinity >= MIN_AFFINITY, OR shares a significant
 *     word with the name of a cited tag
 * fabricated = any item citing an id not in the evidence, or an LLM-only domain (lighting, material,
 * styling) claiming source 'qloo' or citing ids.
 * LLM-only domains are counted and reported but never scored.
 */
export function audit(brief: Brief, evidence: Evidence, target = DEFAULT_TARGET): AuditReport {
  const entityById = new Map(evidence.entities.map((e) => [e.id, e]));
  const tagName = new Map<string, string>(evidence.tags.map((t) => [t.id, t.name]));
  const knownTags = new Set<string>(tagName.keys());
  for (const e of evidence.entities) for (const t of e.tagIds) knownTags.add(t);

  let groundable = 0;
  let verified = 0;
  let llmOnlyItems = 0;
  const failures: AuditFailure[] = [];
  const fabricated: string[] = [];
  const verifiedAffinities: number[] = [];

  for (const item of brief.items) {
    const isGroundable = (GROUNDABLE as readonly string[]).includes(item.domain);
    if (isGroundable) groundable++;
    else llmOnlyItems++;

    const cited = item.entityIds.length + item.tagIds.length;
    const badEntities = item.entityIds.filter((id) => !entityById.has(id));
    const badTags = item.tagIds.filter((id) => !knownTags.has(id));

    if (badEntities.length + badTags.length > 0) {
      fabricated.push(item.id);
      failures.push({ itemId: item.id, reason: `cites ids not in Qloo evidence: ${[...badEntities, ...badTags].join(', ')}` });
      continue;
    }
    if (!isGroundable) {
      if (item.source === 'qloo' || cited > 0) {
        fabricated.push(item.id);
        failures.push({ itemId: item.id, reason: `domain '${item.domain}' is not Qloo-groundable; label it source 'llm' with no ids` });
      }
      continue;
    }
    if (item.source === 'llm') {
      failures.push({ itemId: item.id, reason: 'groundable domain but LLM-inferred; cite Qloo entity or tag ids from the evidence' });
      continue;
    }
    if (cited === 0) {
      failures.push({ itemId: item.id, reason: "source is 'qloo' but cites no ids" });
      continue;
    }

    const text = norm(item.text);
    const cites = item.entityIds.map((id) => entityById.get(id)!);
    const named = cites.filter((e) => text.includes(norm(e.name)));
    const strongNamed = named.filter((e) => (e.affinity ?? 0) >= MIN_AFFINITY);

    const wantType = TYPE_OF_DOMAIN[item.domain];
    if (wantType) {
      const typed = cites.filter((e) => e.type === wantType);
      const kind = wantType.replace('urn:entity:', '');
      if (typed.length === 0) {
        failures.push({ itemId: item.id, reason: `a ${item.domain} item must cite a Qloo ${kind} entity; cited ${cites.map((e) => e.type.replace('urn:entity:', '')).join(', ') || 'only tags'}` });
        continue;
      }
      const typedNamed = typed.filter((e) => text.includes(norm(e.name)));
      if (typedNamed.length === 0) {
        failures.push({ itemId: item.id, reason: `cites ${typed.map((e) => e.name).join(' / ')} but the text never names it; name the cited ${kind} or drop the id` });
        continue;
      }
      const strong = typedNamed.filter((e) => (e.affinity ?? 0) >= MIN_AFFINITY);
      if (strong.length === 0) {
        failures.push({ itemId: item.id, reason: `${typedNamed.map((e) => e.name).join(' / ')} has affinity < ${MIN_AFFINITY}; choose higher-affinity evidence` });
        continue;
      }
      verified++;
      verifiedAffinities.push(Math.max(...strong.map((e) => e.affinity ?? 0)));
      continue;
    }

    // menu / audience
    if (strongNamed.length > 0) {
      verified++;
      verifiedAffinities.push(Math.max(...strongNamed.map((e) => e.affinity ?? 0)));
      continue;
    }
    const relevantTag = item.tagIds.some((id) => {
      const label = tagName.get(id) ?? slugWords(id);
      return sharesWord(item.text, label);
    });
    if (relevantTag) {
      verified++;
      continue;
    }
    failures.push({
      itemId: item.id,
      reason: item.tagIds.length > 0
        ? `none of the cited tags (${item.tagIds.map((id) => tagName.get(id) ?? slugWords(id)).join(', ')}) is reflected in the text; use the tag's own wording or cite a different tag`
        : 'cites entities but the text never names a strong one (affinity >= ' + MIN_AFFINITY + '); name it or cite a relevant tag',
    });
  }

  const raw = groundable === 0 ? 0 : (100 * verified) / groundable - FABRICATION_PENALTY * fabricated.length;
  const score = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;
  const meanAffinity = verifiedAffinities.length ? Math.round((verifiedAffinities.reduce((a, b) => a + b, 0) / verifiedAffinities.length) * 100) / 100 : null;
  return { score, target, groundable, verified, fabricatedItems: fabricated, failures, llmOnlyItems, meanAffinity };
}
