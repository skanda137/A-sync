// Prints the exact values behind the two open questions from the probe. Reads probe-out/*.json (no network, no key).
// Usage: node scripts/inspect-probe.mjs
import { readFileSync } from 'node:fs';

const read = (f) => JSON.parse(readFileSync(`probe-out/${f}.json`, 'utf8'));

const j = read('insights_artist_city_age_25_to_29');
j.results.entities.forEach((e, i) => {
  const bad = e.tags.map((t, k) => [t, k]).filter(([t]) => typeof t.id !== 'string' || !t.id);
  console.log(`entity[${i}] ${e.name} | type=${e.type} | tags=${e.tags.length} | tags without usable id=${bad.length}`);
  if (bad.length) console.log('   first bad tag:', JSON.stringify(bad[0]));
});
console.log('\nsample good tag:', JSON.stringify(j.results.entities[0].tags[0]));
console.log('entity[0].query keys:', Object.keys(j.results.entities[0].query ?? {}));
console.log('entity[0].query.affinity:', j.results.entities[0].query?.affinity);

const x = read('insights_artist_explainability');
console.log('\naffinities (explainability run):', x.results.entities.map((e) => e.query?.affinity));
console.log('entity[0].query.explainability:', JSON.stringify(x.results.entities[0].query?.explainability)?.slice(0, 500));
