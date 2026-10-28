import type { EntityType, EvidenceCall } from './types';

export class QlooError extends Error {
  constructor(message: string, readonly status: number | null, readonly endpoint: string) {
    super(message);
    this.name = 'QlooError';
  }
}

type ParamValue = string | number | readonly string[];
export type Params = Record<string, ParamValue | undefined>;

export interface QlooOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  // Hackathon key reportedly capped at 5 req/s and 10,000/month (one entrant, from response headers).
  minIntervalMs?: number;
  retryDelayMs?: number;
  signal?: AbortSignal; // aborting cancels the in-flight request, the queue wait and the retry wait
  explainability?: boolean; // adds feature.explainability=true to /v2/insights; enable only after `npm run probe` passes
}

export interface SearchHit {
  id: string;
  name: string;
  types: string[];
  popularity: number | null;
}

export interface TagHit {
  id: string;
  name: string;
}

export interface InsightEntity {
  id: string;
  name: string;
  type: string;
  affinity: number | null;
  popularity: number | null;
  tagIds: string[];
  explain: { id: string; score: number }[]; // query.explainability["signal.interests.entities"], [] when absent
}

// ---- process-wide state: the API key is shared by every concurrent run -------------------------------

let chain: Promise<void> = Promise.resolve();
let lastCall = 0;

export interface QlooQuota {
  monthRemaining: number | null;
  monthLimit: number | null;
  secondLimit: number | null;
  seenAt: number | null;
}
const quota: QlooQuota = { monthRemaining: null, monthLimit: null, secondLimit: null, seenAt: null };

/** Last rate-limit numbers Qloo reported. Header names for *-limit are confirmed by another entrant;
 *  x-month-ratelimit-remaining is assumed. `npm run probe` prints the real names. Null = never seen. */
export function qlooQuota(): QlooQuota {
  return { ...quota };
}
export function resetQlooQuota(): void {
  Object.assign(quota, { monthRemaining: null, monthLimit: null, secondLimit: null, seenAt: null });
}

function readQuota(h: Headers): void {
  const num = (k: string): number | null => {
    const v = h.get(k);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const remaining = num('x-month-ratelimit-remaining');
  const monthLimit = num('x-month-ratelimit-limit');
  const secondLimit = num('x-second-ratelimit-limit');
  if (remaining !== null) quota.monthRemaining = remaining;
  if (monthLimit !== null) quota.monthLimit = monthLimit;
  if (secondLimit !== null) quota.secondLimit = secondLimit;
  quota.seenAt = Date.now();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- parsing ------------------------------------------------------------------------------------------

function toStringParams(p: Params): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : v.join(',');
  }
  return out;
}

function obj(x: unknown, where: string): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(`Qloo parse: ${where} is not an object`);
  return x as Record<string, unknown>;
}

function arr(x: unknown, where: string): unknown[] {
  if (!Array.isArray(x)) throw new Error(`Qloo parse: ${where} is not an array`);
  return x;
}

function str(x: unknown, where: string): string {
  if (typeof x !== 'string' || x === '') throw new Error(`Qloo parse: ${where} is not a non-empty string`);
  return x;
}

function numOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

export function parseSearch(raw: unknown): SearchHit[] {
  const results = arr(obj(raw, 'search body').results, 'search.results');
  return results.map((r, i) => {
    const e = obj(r, `search.results[${i}]`);
    const types = Array.isArray(e.types) ? e.types.filter((t): t is string => typeof t === 'string') : [];
    return {
      id: str(e.entity_id, `search.results[${i}].entity_id`),
      name: str(e.name, `search.results[${i}].name`),
      types,
      popularity: numOrNull(e.popularity),
    };
  });
}

export function parseTags(raw: unknown): TagHit[] {
  const results = obj(obj(raw, 'tags body').results, 'tags.results');
  const tags = arr(results.tags, 'tags.results.tags');
  return tags.map((t, i) => {
    const e = obj(t, `tags.results.tags[${i}]`);
    return { id: str(e.id, `tags[${i}].id`), name: str(e.name, `tags[${i}].name`) };
  });
}

// Shape reported from a live run (long-chair issue #11): query.explainability =
// {"signal.interests.entities": [{entity_id, score}]}. Other keys are ignored.
function parseExplain(q: Record<string, unknown>, where: string): { id: string; score: number }[] {
  const ex = q.explainability;
  if (ex === undefined || ex === null) return [];
  const list = obj(ex, `${where}.explainability`)['signal.interests.entities'];
  if (list === undefined) return [];
  return arr(list, `${where}.explainability["signal.interests.entities"]`).map((x, j) => {
    const e = obj(x, `${where}.explainability[${j}]`);
    if (typeof e.score !== 'number' || !Number.isFinite(e.score)) throw new Error(`Qloo parse: ${where}.explainability[${j}].score is not a number`);
    return { id: str(e.entity_id, `${where}.explainability[${j}].entity_id`), score: e.score };
  });
}

export function parseInsights(raw: unknown, requestedType: string): InsightEntity[] {
  const results = obj(obj(raw, 'insights body').results, 'insights.results');
  const entities = arr(results.entities, 'insights.results.entities');
  return entities.map((x, i) => {
    const e = obj(x, `entities[${i}]`);
    const where = `entities[${i}].query`;
    const q = e.query === undefined || e.query === null ? {} : obj(e.query, where);
    const tags = Array.isArray(e.tags) ? e.tags : [];
    // Observed live (probe, Oct 28): about 1 in 95 tags is a bare category marker like {"type":"urn:tag:voice_type:qloo"}
    // with no id. It cannot be cited as evidence, so it is skipped. A tag that HAS an id key must still be valid.
    const tagIds = tags.flatMap((t, j) => {
      const o = obj(t, `entities[${i}].tags[${j}]`);
      return 'id' in o ? [str(o.id, `entities[${i}].tags[${j}].id`)] : [];
    });
    return {
      id: str(e.entity_id, `entities[${i}].entity_id`),
      name: str(e.name, `entities[${i}].name`),
      type: typeof e.type === 'string' ? e.type : requestedType,
      affinity: numOrNull(q.affinity),
      popularity: numOrNull(e.popularity),
      tagIds,
      explain: parseExplain(q, where),
    };
  });
}

// ---- client -------------------------------------------------------------------------------------------

export class QlooClient {
  readonly calls: EvidenceCall[] = [];
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly o: QlooOptions) {
    if (!o.apiKey) throw new Error('QLOO_API_KEY is required');
    this.baseUrl = (o.baseUrl ?? 'https://hackathon.api.qloo.com').replace(/\/$/, '');
    this.doFetch = o.fetchImpl ?? fetch;
    this.minIntervalMs = o.minIntervalMs ?? 210;
    this.retryDelayMs = o.retryDelayMs ?? 1000;
  }

  // One slot at a time across the whole process. The chain is always released, even when the wait is aborted.
  private async slot(signal?: AbortSignal): Promise<void> {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((r) => (release = r));
    try {
      await prev;
      signal?.throwIfAborted();
      const wait = lastCall + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait, signal);
      lastCall = Date.now();
    } finally {
      release();
    }
  }

  // Retries exactly once on network error, 429 or 5xx. Anything else throws. Abort throws the abort reason.
  private async get(path: string, params: Params): Promise<unknown> {
    const sp = toStringParams(params);
    const qs = new URLSearchParams(sp).toString();
    const key = `${path}?${qs}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const signal = this.o.signal;
    let lastErr: QlooError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs, signal);
      await this.slot(signal);
      const t0 = Date.now();
      let res: Response;
      try {
        res = await this.doFetch(`${this.baseUrl}${path}?${qs}`, {
          method: 'GET',
          headers: { 'X-Api-Key': this.o.apiKey, Accept: 'application/json' },
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        lastErr = new QlooError(`Qloo network error on ${path}: ${(e as Error).message}`, null, path);
        continue;
      }
      readQuota(res.headers);
      this.calls.push({ endpoint: path, params: sp, status: res.status, ms: Date.now() - t0 });
      if (res.ok) {
        const body: unknown = await res.json();
        this.cache.set(key, body);
        return body;
      }
      const snippet = (await res.text()).slice(0, 300);
      lastErr = new QlooError(`Qloo ${res.status} on ${path}: ${snippet}`, res.status, path);
      if (res.status !== 429 && res.status < 500) throw lastErr;
    }
    throw lastErr ?? new QlooError(`Qloo request failed on ${path}`, null, path);
  }

  async search(query: string, type: EntityType, take = 3): Promise<SearchHit[]> {
    return parseSearch(await this.get('/search', { query, types: type, take }));
  }

  async tags(query: string, take = 3): Promise<TagHit[]> {
    return parseTags(await this.get('/v2/tags', { 'filter.query': query, 'feature.semantic_search': 'true', take }));
  }

  async insights(params: Params & { 'filter.type': string }): Promise<InsightEntity[]> {
    const p: Params = this.o.explainability ? { ...params, 'feature.explainability': 'true' } : params;
    return parseInsights(await this.get('/v2/insights', p), params['filter.type']);
  }
}
