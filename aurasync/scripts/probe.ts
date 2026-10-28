// Evidence step. Calls Qloo with raw fetch (independent of our parsers), prints the SHAPE of each response
// (keys and types, no values), saves raw bodies to ./probe-out/ (gitignored), then runs OUR parsers on every body
// and prints PASS/FAIL per step. Any FAIL is a real response-shape mismatch to fix in src/core/qloo.ts before
// anything else. Usage: QLOO_API_KEY=... npm run probe
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseInsights, parseSearch, parseTags } from '../src/core/qloo';

const key = process.env.QLOO_API_KEY;
if (!key) throw new Error('QLOO_API_KEY is required');
const base = (process.env.QLOO_API_URL ?? 'https://hackathon.api.qloo.com').replace(/\/$/, '');
const city = process.env.PROBE_CITY ?? 'Bengaluru';

interface Step { name: string; path: string; params: Record<string, string>; parse?: (raw: unknown) => unknown; expectError?: boolean }

const insights = (raw: unknown) => parseInsights(raw, 'urn:entity:artist');

const steps: Step[] = [
  { name: 'search_place', path: '/search', params: { query: 'Third Wave Coffee', types: 'urn:entity:place', take: '3' }, parse: parseSearch },
  { name: 'search_brand', path: '/search', params: { query: 'Nike', types: 'urn:entity:brand', take: '3' }, parse: parseSearch },
  { name: 'search_artist', path: '/search', params: { query: 'Prateek Kuhad', types: 'urn:entity:artist', take: '3' }, parse: parseSearch },
  { name: 'tags_semantic', path: '/v2/tags', params: { 'filter.query': 'specialty coffee', 'feature.semantic_search': 'true', take: '3' }, parse: parseTags },
  { name: 'tags_plain', path: '/v2/tags', params: { 'filter.query': 'specialty coffee', take: '3' }, parse: parseTags },
  { name: 'insights_place_city', path: '/v2/insights', params: { 'filter.type': 'urn:entity:place', 'filter.location.query': city, take: '5' }, parse: insights },
  { name: 'insights_artist_city_age_25_to_29', path: '/v2/insights', params: { 'filter.type': 'urn:entity:artist', 'signal.location.query': city, 'signal.demographics.age': '25_to_29', take: '5' }, parse: insights },
  { name: 'insights_artist_explainability', path: '/v2/insights', params: { 'filter.type': 'urn:entity:artist', 'signal.location.query': city, 'signal.interests.entities': '', 'feature.explainability': 'true', take: '5' }, parse: insights },
  { name: 'insights_artist_age_bad', path: '/v2/insights', params: { 'filter.type': 'urn:entity:artist', 'signal.location.query': city, 'signal.demographics.age': 'mid_20s', take: '5' }, expectError: true },
  { name: 'insights_artist_bangalore_spelling', path: '/v2/insights', params: { 'filter.type': 'urn:entity:artist', 'signal.location.query': 'Bangalore', take: '5' }, parse: insights },
];

function shape(x: unknown, depth = 0): unknown {
  if (Array.isArray(x)) return x.length === 0 ? '[]' : [`[${x.length}] of`, depth < 4 ? shape(x[0], depth + 1) : '...'];
  if (x && typeof x === 'object') {
    if (depth >= 4) return '{...}';
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  return x === null ? 'null' : typeof x;
}

mkdirSync('probe-out', { recursive: true });

// The explainability step needs real signal ids: take them from the first artist search.
let signalId = '';
const summary: string[] = [];

for (const s of steps) {
  if (s.name === 'insights_artist_explainability') {
    if (!signalId) {
      summary.push(`SKIP  ${s.name} (no artist id from search_artist)`);
      continue;
    }
    s.params['signal.interests.entities'] = signalId;
  }
  const url = `${base}${s.path}?${new URLSearchParams(s.params).toString()}`;
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'X-Api-Key': key, Accept: 'application/json' } });
  const text = await res.text();
  const ms = Date.now() - t0;
  const rl = [...res.headers.entries()].filter(([h]) => h.includes('ratelimit')).map(([h, v]) => `${h}=${v}`).join(' ');
  console.log(`\n=== ${s.name}  ${res.status}  ${ms}ms  ${rl || '(no ratelimit headers)'}`);
  writeFileSync(`probe-out/${s.name}.json`, text);
  let body: unknown;
  try {
    body = JSON.parse(text);
    console.log(JSON.stringify(shape(body), null, 1));
  } catch {
    console.log(`(non-JSON) ${text.slice(0, 200)}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Qloo rejected the key (HTTP ${res.status}: ${text.slice(0, 120)}). Check QLOO_API_KEY (it must be the real key, not a placeholder) and QLOO_API_URL.`);
  }
  if (s.expectError) {
    summary.push(`${res.status === 400 || res.status === 422 ? 'PASS ' : 'NOTE '} ${s.name} (expected a 400/422 validation error; got ${res.status})`);
  } else if (!res.ok) {
    summary.push(`FAIL  ${s.name} HTTP ${res.status}: ${text.slice(0, 120)}`);
  } else {
    try {
      const parsed = s.parse!(body) as unknown[];
      summary.push(`PASS  ${s.name} -> ${parsed.length} parsed`);
      if (s.name === 'search_artist') signalId = (parsed as { id: string }[])[0]?.id ?? '';
      if (s.name === 'insights_artist_explainability') {
        const withExplain = (parsed as { explain: unknown[] }[]).filter((p) => p.explain.length > 0).length;
        summary.push(`${withExplain > 0 ? 'PASS ' : 'FAIL '} explainability: ${withExplain}/${parsed.length} entities carry query.explainability["signal.interests.entities"]`);
      }
    } catch (e) {
      summary.push(`FAIL  ${s.name} parser: ${(e as Error).message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 300));
}

console.log('\n==== PARSER CHECK (our code vs the real API) ====');
console.log(summary.join('\n'));
if (summary.some((l) => l.startsWith('FAIL'))) {
  console.log('\nFAILURES above: fix src/core/qloo.ts parsers against probe-out/*.json before running analyst or eval.');
  process.exitCode = 1;
} else {
  console.log('\nNo FAIL lines -> safe to run `npm run analyst`. Enable QLOO_EXPLAINABILITY=1 only if the explainability line printed PASS.');
}
