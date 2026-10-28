import { QlooClient, type InsightEntity } from './qloo';
import { sharesWord, slugWords } from './text';
import { MIN_AFFINITY } from './auditor';
import {
  ENTITY_TYPES,
  type BecauseOf,
  type EntityType,
  type Evidence,
  type EvidenceEntity,
  type EvidenceTag,
  type Llm,
  type Refinement,
  type Seed,
  type SignalEntity,
} from './types';

export interface AnalystPlan {
  entities: { name: string; type: EntityType }[]; // real-world names to resolve as taste signals
  tagQueries: string[]; // taste/style/food vocabulary to resolve to Qloo tag ids
  domains: EntityType[]; // which entity types to ask Qloo to recommend
}

const PLAN_SYSTEM = `You plan Qloo Taste Graph queries for an experience-design brief.
Return ONLY a JSON object, no prose:
{"entities":[{"name":string,"type":"urn:entity:artist"|"urn:entity:brand"|"urn:entity:place"}],
 "tagQueries":[string],
 "domains":["urn:entity:artist"|"urn:entity:brand"|"urn:entity:place"]}
Rules:
- entities: up to 4 REAL, well-known artists, brands or places in the given city that typify the target audience. Do not invent names.
- tagQueries: up to 5 short taste terms (cuisines, drinks, music genres, interior styles).
- domains: the entity types worth recommending for this concept (at least one).
- If the user message lists names that did NOT resolve, propose different, more widely known ones.`;

export function parsePlan(text: string): AnalystPlan {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new Error(`Analyst plan is not valid JSON: ${cleaned.slice(0, 200)}`);
  }
  const p = raw as Record<string, unknown>;
  const isType = (t: unknown): t is EntityType => ENTITY_TYPES.includes(t as EntityType);

  if (!Array.isArray(p.entities)) throw new Error('Analyst plan: entities must be an array');
  const entities = p.entities.map((e, i) => {
    const x = e as Record<string, unknown>;
    if (typeof x.name !== 'string' || !x.name) throw new Error(`Analyst plan: entities[${i}].name`);
    if (!isType(x.type)) throw new Error(`Analyst plan: entities[${i}].type`);
    return { name: x.name, type: x.type };
  });
  if (!Array.isArray(p.tagQueries) || !p.tagQueries.every((t) => typeof t === 'string'))
    throw new Error('Analyst plan: tagQueries must be string[]');
  if (!Array.isArray(p.domains) || p.domains.length === 0 || !p.domains.every(isType))
    throw new Error('Analyst plan: domains must be a non-empty array of entity types');
  return { entities: entities.slice(0, 4), tagQueries: (p.tagQueries as string[]).slice(0, 5), domains: p.domains };
}

export interface AnalystDeps {
  qloo: QlooClient;
  llm: Llm;
  take?: number;
  signal?: AbortSignal;
  note?: (message: string) => void;
  maxRefineRounds?: number; // adaptive rounds after the first retrieval
  callBudget?: number; // stop refining once this many Qloo HTTP calls were made in this run
}

export const MAX_REFINE_ROUNDS = 2;
export const CALL_BUDGET = 40; // a normal run uses ~10-14 Qloo calls
export const STRONG_TARGET = 3; // per type, entities with affinity >= MIN_AFFINITY the Architect can choose from

const REFINE_SYSTEM = `You are the Analyst in a taste-grounded design system. Retrieval from Qloo left some entity types with too little strong evidence (affinity >= ${MIN_AFFINITY}).
You see a summary of the evidence. Decide ONE next step. Return ONLY JSON, no prose:
{"action":"stop","reason":string}
or
{"action":"refine","type":"urn:entity:artist"|"urn:entity:brand"|"urn:entity:place","entities":[{"name":string,"type":"urn:entity:artist"|"urn:entity:brand"|"urn:entity:place"}],"tagQueries":[string],"reason":string}
"refine" adds up to 3 REAL, well-known seed entities and up to 3 taste terms, then Qloo is re-queried for "type" with the enlarged signal set.
Pick seeds that are typical for this audience and city but DIFFERENT from the ones already used. Do not invent names. Choose "stop" only if more seeds would not plausibly help.`;

export interface RefineAction {
  type: EntityType;
  entities: { name: string; type: EntityType }[];
  tagQueries: string[];
  reason: string;
}

/** null = the model chose to stop. Throws on anything malformed (no silent defaults). */
export function parseRefine(text: string): RefineAction | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new Error(`Analyst refine step is not valid JSON: ${cleaned.slice(0, 200)}`);
  }
  if (typeof raw.reason !== 'string' || !raw.reason) throw new Error('Analyst refine: reason must be a non-empty string');
  if (raw.action === 'stop') return null;
  if (raw.action !== 'refine') throw new Error(`Analyst refine: action must be 'stop' or 'refine', got ${String(raw.action)}`);
  const isType = (t: unknown): t is EntityType => ENTITY_TYPES.includes(t as EntityType);
  if (!isType(raw.type)) throw new Error('Analyst refine: type must be an entity type');
  if (!Array.isArray(raw.entities) || !Array.isArray(raw.tagQueries) || !raw.tagQueries.every((t) => typeof t === 'string'))
    throw new Error('Analyst refine: entities and tagQueries must be arrays');
  const entities = raw.entities.map((e, i) => {
    const x = e as Record<string, unknown>;
    if (typeof x.name !== 'string' || !x.name || !isType(x.type)) throw new Error(`Analyst refine: entities[${i}] needs name and type`);
    return { name: x.name, type: x.type };
  });
  if (entities.length + raw.tagQueries.length === 0) throw new Error('Analyst refine: nothing to add');
  return { type: raw.type, entities: entities.slice(0, 3), tagQueries: (raw.tagQueries as string[]).slice(0, 3), reason: raw.reason };
}

/** Fewer resolved signals than this and the Analyst re-plans once. */
export const MIN_SIGNALS = 2;

interface Resolved {
  signals: SignalEntity[];
  tags: EvidenceTag[];
  unresolved: string[];
}

// Qloo's search is fuzzy and /v2/tags is semantic (it always returns something). A hit is accepted only if
// its name shares a significant word with what we asked for, and entity hits must be of the planned type.
async function resolve(plan: AnalystPlan, qloo: QlooClient): Promise<Resolved> {
  const [entityHits, tagHits] = await Promise.all([
    Promise.all(plan.entities.map((e) => qloo.search(e.name, e.type, 3))),
    Promise.all(plan.tagQueries.map((q) => qloo.tags(q, 3))),
  ]);
  const signals: SignalEntity[] = [];
  const tags: EvidenceTag[] = [];
  const unresolved: string[] = [];

  entityHits.forEach((hits, i) => {
    const want = plan.entities[i]!;
    const hit = hits.find((h) => h.types.includes(want.type) && sharesWord(want.name, h.name));
    if (hit) signals.push({ id: hit.id, name: hit.name, type: want.type });
    else unresolved.push(`entity: ${want.name}`);
  });
  tagHits.forEach((hits, i) => {
    const q = plan.tagQueries[i]!;
    const hit = hits.find((h) => sharesWord(q, h.name) || sharesWord(q, slugWords(h.id)));
    if (hit) tags.push({ id: hit.id, name: hit.name, queriedAs: q });
    else unresolved.push(`tag: ${q}`);
  });
  return { signals, tags, unresolved };
}

const short = (t: string) => t.replace('urn:entity:', '');

function dedupe<T extends { id: string }>(list: T[]): T[] {
  return [...new Map(list.map((x) => [x.id, x])).values()];
}

function becauseOf(e: InsightEntity, signals: SignalEntity[]): BecauseOf[] | undefined {
  const byId = new Map(signals.map((s) => [s.id, s.name]));
  const out = e.explain.filter((x) => byId.has(x.id)).map((x) => ({ id: x.id, name: byId.get(x.id)!, score: x.score }));
  return out.length ? out.sort((a, b) => b.score - a.score).slice(0, 3) : undefined;
}

export async function runAnalyst(seed: Seed, { qloo, llm, take = 10, signal, note, maxRefineRounds = MAX_REFINE_ROUNDS, callBudget = CALL_BUDGET }: AnalystDeps): Promise<Evidence> {
  const ask = (extra?: string) =>
    llm.complete(PLAN_SYSTEM, JSON.stringify({ concept: seed.concept, audience: seed.audience, city: seed.city, ...(extra ? { didNotResolve: extra } : {}) }), signal);

  let plan = parsePlan(await ask());
  let got = await resolve(plan, qloo);
  let replanned = false;

  if (got.signals.length < MIN_SIGNALS) {
    replanned = true;
    note?.(`Only ${got.signals.length} seed entities resolved in Qloo (need ${MIN_SIGNALS}). Re-planning once with: ${got.unresolved.join('; ') || 'nothing'}.`);
    const second = parsePlan(await ask(got.unresolved.join('; ')));
    const more = await resolve(second, qloo);
    plan = { entities: [...plan.entities, ...second.entities], tagQueries: [...plan.tagQueries, ...second.tagQueries], domains: [...new Set([...plan.domains, ...second.domains])] };
    got = {
      signals: dedupe([...got.signals, ...more.signals]),
      tags: dedupe([...got.tags, ...more.tags]),
      unresolved: [...got.unresolved, ...more.unresolved],
    };
  }

  let { signals, tags } = got;
  if (signals.length === 0 && tags.length === 0) {
    throw new Error(`Analyst: no Qloo signals resolved. Unresolved: ${got.unresolved.join('; ')}`);
  }

  const unresolved = got.unresolved;
  const byId = new Map<string, EvidenceEntity>();
  const fetchType = async (type: EntityType) => {
    const list = await qloo.insights({
      'filter.type': type,
      'signal.interests.entities': signals.length ? signals.map((s) => s.id) : undefined,
      'signal.interests.tags': tags.length ? tags.map((t) => t.id) : undefined,
      'signal.demographics.age': seed.ageBand,
      ...(type === 'urn:entity:place' ? { 'filter.location.query': seed.city } : { 'signal.location.query': seed.city }),
      take,
    });
    // Deduplicate by id, keeping the highest affinity.
    for (const e of list) {
      const prev = byId.get(e.id);
      if (prev && (prev.affinity ?? -1) >= (e.affinity ?? -1)) continue;
      byId.set(e.id, { id: e.id, name: e.name, type, affinity: e.affinity, popularity: e.popularity, tagIds: e.tagIds, becauseOf: becauseOf(e, signals) });
    }
  };
  const strong = (type: EntityType) => [...byId.values()].filter((e) => e.type === type && (e.affinity ?? 0) >= MIN_AFFINITY).length;

  await Promise.all(plan.domains.map(fetchType));
  if (byId.size === 0) throw new Error('Analyst: Qloo returned no recommendations for this seed');

  // Adaptive rounds. The trigger is deterministic (a type with < STRONG_TARGET strong entities); HOW to fix it is
  // the model's decision: which new seeds to add, for which type, or to stop. Bounded by rounds and a call budget.
  const refinements: Refinement[] = [];
  for (let round = 1; round <= maxRefineRounds; round++) {
    signal?.throwIfAborted();
    const weak = ENTITY_TYPES.filter((t) => strong(t) < STRONG_TARGET);
    if (weak.length === 0) break;
    if (qloo.calls.length >= callBudget) {
      note?.(`Qloo call budget (${callBudget}) reached; not refining further. Thin: ${weak.map(short).join(', ')}.`);
      break;
    }
    const summary = {
      seed: { concept: seed.concept, audience: seed.audience, city: seed.city },
      seedsUsed: signals.map((s) => `${s.name} (${short(s.type)})`),
      tagsUsed: tags.map((t) => t.name),
      thinTypes: weak.map(short),
      perType: ENTITY_TYPES.map((t) => ({ type: short(t), found: [...byId.values()].filter((e) => e.type === t).length, strong: strong(t), top: [...byId.values()].filter((e) => e.type === t).sort((a, b) => (b.affinity ?? -1) - (a.affinity ?? -1)).slice(0, 3).map((e) => `${e.name} ${e.affinity?.toFixed(2) ?? 'n/a'}`) })),
      didNotResolve: unresolved,
    };
    const action = parseRefine(await llm.complete(REFINE_SYSTEM, JSON.stringify(summary), signal));
    if (!action) {
      note?.('Analyst chose to stop refining.');
      break;
    }
    const before = strong(action.type);
    const more = await resolve({ entities: action.entities, tagQueries: action.tagQueries, domains: [action.type] }, qloo);
    const newSignals = more.signals.filter((s) => !signals.some((x) => x.id === s.id));
    const newTags = more.tags.filter((t) => !tags.some((x) => x.id === t.id));
    unresolved.push(...more.unresolved);
    signals = [...signals, ...newSignals];
    tags = [...tags, ...newTags];
    if (newSignals.length + newTags.length > 0) await fetchType(action.type);
    const after = strong(action.type);
    refinements.push({ type: action.type, reason: action.reason, addedEntities: newSignals.map((s) => s.name), addedTags: newTags.map((t) => t.name), strongBefore: before, strongAfter: after });
    note?.(`Refined ${short(action.type)}: ${action.reason} Added ${[...newSignals.map((s) => s.name), ...newTags.map((t) => `tag ${t.name}`)].join(', ') || 'nothing that resolved'}. Strong ${before} → ${after}.`);
  }

  return { seed, signals, entities: [...byId.values()], tags, unresolved, calls: [...qloo.calls], replanned, refinements };
}
