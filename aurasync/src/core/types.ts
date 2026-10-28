// Shared contract. Person A and Person B both import from here. Change it together, never alone.
// Changes in this version are listed in CHANGELOG.md (all additive except `requireMention` removal).

export type EntityType = 'urn:entity:artist' | 'urn:entity:brand' | 'urn:entity:place';
export const ENTITY_TYPES: readonly EntityType[] = ['urn:entity:artist', 'urn:entity:brand', 'urn:entity:place'];

export type Domain = 'music' | 'brand' | 'place' | 'menu' | 'audience' | 'lighting' | 'material' | 'styling';

// Domains Qloo can ground. Everything else is LLM design translation and is not scored.
export const GROUNDABLE: readonly Domain[] = ['music', 'brand', 'place', 'menu', 'audience'];

export const DOMAIN_OF_TYPE: Record<EntityType, Domain> = {
  'urn:entity:artist': 'music',
  'urn:entity:brand': 'brand',
  'urn:entity:place': 'place',
};

// Domains whose items must cite an entity of exactly this Qloo type.
export const TYPE_OF_DOMAIN: Partial<Record<Domain, EntityType>> = {
  music: 'urn:entity:artist',
  brand: 'urn:entity:brand',
  place: 'urn:entity:place',
};

export interface Seed {
  concept: string; // "a café"
  audience: string; // "friend group in their mid 20s"
  city: string; // "Bengaluru"
  ageBand?: string; // Qloo age bucket, e.g. "25_to_29"
  note?: string; // free-text client preference; goes to the LLM prompts only, never to Qloo
}

/** A real-world entity the Analyst resolved in Qloo and used as a taste signal. */
export interface SignalEntity {
  id: string;
  name: string;
  type: EntityType;
}

/** Qloo explainability: which seed signal drove this recommendation, and how strongly. */
export interface BecauseOf {
  id: string;
  name: string;
  score: number;
}

export interface EvidenceEntity {
  id: string;
  name: string;
  type: EntityType;
  affinity: number | null; // Qloo query.affinity, 0..1
  popularity: number | null;
  tagIds: string[];
  becauseOf?: BecauseOf[]; // present only when explainability is enabled and Qloo returned it
}

export interface EvidenceTag {
  id: string;
  name: string; // Qloo's own tag name (the Auditor requires the brief to use it)
  queriedAs: string;
}

export interface EvidenceCall {
  endpoint: string;
  params: Record<string, string>;
  status: number;
  ms: number;
}

/** One adaptive Analyst round: it saw a domain with thin strong evidence and chose how to fix it. */
export interface Refinement {
  type: EntityType;
  reason: string;
  addedEntities: string[]; // names of new seed entities that resolved
  addedTags: string[];
  strongBefore: number; // entities of this type with affinity >= 0.5 before / after the round
  strongAfter: number;
}

export interface Evidence {
  seed: Seed;
  signals: SignalEntity[]; // seed entities that resolved in Qloo
  entities: EvidenceEntity[];
  tags: EvidenceTag[];
  unresolved: string[]; // plan items Qloo could not resolve or resolved to something unrelated; never guessed
  calls: EvidenceCall[];
  replanned: boolean; // the Analyst re-planned once because evidence was thin
  refinements: Refinement[]; // adaptive rounds after the first retrieval (empty when evidence was already strong)
}

export interface BriefItem {
  id: string;
  domain: Domain;
  text: string;
  source: 'qloo' | 'llm';
  entityIds: string[]; // must exist in Evidence.entities
  tagIds: string[]; // must exist in Evidence.tags or an evidence entity's tagIds
}

export interface Brief {
  title: string;
  items: BriefItem[];
}

export interface AuditFailure {
  itemId: string;
  reason: string;
}

export interface AuditReport {
  score: number; // 0..100, computed (see auditor.ts)
  target: number;
  groundable: number;
  verified: number;
  fabricatedItems: string[]; // cited ids that are not in the evidence
  failures: AuditFailure[];
  llmOnlyItems: number; // non-groundable domains, reported not scored
  meanAffinity: number | null; // mean Qloo affinity of the named entities behind verified items
}

export type AgentName = 'analyst' | 'architect' | 'auditor';

export interface LoopRecord {
  iteration: number;
  score: number;
  verified: number;
  groundable: number;
}

export interface RunStats {
  llmCalls: number | null; // null when the caller did not supply a counter
  qlooCalls: number;
  ms: number;
}

export type RunEvent =
  | { seq: number; ts: number; type: 'run_start'; seed: Seed }
  | { seq: number; ts: number; type: 'agent'; agent: AgentName; status: 'start' | 'done'; iteration: number }
  | { seq: number; ts: number; type: 'note'; agent: AgentName; message: string }
  | { seq: number; ts: number; type: 'evidence'; entities: number; tags: number; signals: number; unresolved: string[]; replanned: boolean }
  | { seq: number; ts: number; type: 'audit'; iteration: number; report: AuditReport; brief: Brief }
  | { seq: number; ts: number; type: 'run_done'; result: RunResult }
  | { seq: number; ts: number; type: 'run_error'; message: string };

export interface RunResult {
  brief: Brief;
  report: AuditReport;
  evidence: Evidence;
  iterations: number;
  reachedTarget: boolean;
  history: LoopRecord[]; // one entry per Architect -> Auditor loop
  stats: RunStats;
}

export interface Llm {
  complete(system: string, user: string, signal?: AbortSignal): Promise<string>;
}

// Person B implements this. It must return a Brief; the orchestrator validates it.
export type Architect = (input: {
  seed: Seed;
  evidence: Evidence;
  previousBrief?: Brief;
  feedback?: AuditReport;
  signal?: AbortSignal;
}) => Promise<Brief>;

const DOMAINS: readonly string[] = ['music', 'brand', 'place', 'menu', 'audience', 'lighting', 'material', 'styling'];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function assertBrief(x: unknown): Brief {
  if (typeof x !== 'object' || x === null) throw new Error('Brief is not an object');
  const b = x as Record<string, unknown>;
  if (typeof b.title !== 'string') throw new Error('Brief.title must be a string');
  if (!Array.isArray(b.items) || b.items.length === 0) throw new Error('Brief.items must be a non-empty array');
  const seen = new Set<string>();
  for (const raw of b.items) {
    const i = raw as Record<string, unknown>;
    if (typeof i.id !== 'string' || i.id === '') throw new Error('BriefItem.id must be a non-empty string');
    if (seen.has(i.id)) throw new Error(`Duplicate BriefItem.id: ${i.id}`);
    seen.add(i.id);
    if (typeof i.domain !== 'string' || !DOMAINS.includes(i.domain)) throw new Error(`BriefItem ${i.id}: bad domain`);
    if (typeof i.text !== 'string') throw new Error(`BriefItem ${i.id}: text must be a string`);
    if (i.source !== 'qloo' && i.source !== 'llm') throw new Error(`BriefItem ${i.id}: source must be 'qloo' or 'llm'`);
    if (!isStringArray(i.entityIds)) throw new Error(`BriefItem ${i.id}: entityIds must be string[]`);
    if (!isStringArray(i.tagIds)) throw new Error(`BriefItem ${i.id}: tagIds must be string[]`);
  }
  return x as Brief;
}
