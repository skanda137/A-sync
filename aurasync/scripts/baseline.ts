import { writeFileSync } from 'node:fs';
import { chatLlm } from '../src/core/llm';
import { QlooClient } from '../src/core/qloo';
import { norm } from '../src/core/text';
import { ENTITY_TYPES, type EntityType } from '../src/core/types';
import { SEEDS } from '../eval/seeds';

const llm = chatLlm();
const SYSTEM = `You recommend real cultural references for a physical venue concept. Return ONLY JSON:
{"urn:entity:artist":[5 names],"urn:entity:brand":[5 names],"urn:entity:place":[5 real venues in the given city]}`;

let total = 0;
let confirmed = 0;
const rows: string[] = [];

for (const seed of SEEDS) {
  const qloo = new QlooClient({ apiKey: process.env.QLOO_API_KEY ?? '', baseUrl: process.env.QLOO_API_URL });
  const raw = await llm.complete(SYSTEM, JSON.stringify({ concept: seed.concept, audience: seed.audience, city: seed.city }));
  const named = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<EntityType, string[]>;
  let n = 0;
  let ok = 0;
  const missing: string[] = [];
  for (const type of ENTITY_TYPES) {
    for (const name of named[type] ?? []) {
      n++;
      const hits = await qloo.search(name, type, 3);
      if (hits.some((h) => h.types.includes(type) && norm(h.name) === norm(name))) ok++;
      else missing.push(name);
    }
  }
  total += n;
  confirmed += ok;
  rows.push(`| ${seed.city} | ${seed.concept} | ${ok}/${n} | ${missing.slice(0, 4).join(', ') || '-'} |`);
  console.log(rows.at(-1));
}

const pct = total ? Math.round((100 * confirmed) / total) : 0;
const md = `# Baseline: LLM alone vs Qloo-grounded\n\nAn LLM with no Qloo access names 15 references per seed. Each is looked up in Qloo by exact normalised name and type.\n\n| City | Concept | Confirmed in Qloo | Examples not confirmed |\n|---|---|---|---|\n${rows.join('\n')}\n\n**${confirmed}/${total} (${pct}%) of the LLM-only references were confirmed by Qloo.** "Not confirmed" is not proof of invention: Qloo's catalogue is finite. AuraSync's named references come from Qloo itself and are confirmed by construction; its Auditor then checks the brief text actually uses them.\n\nGenerated ${new Date().toISOString()} by \`npm run baseline\`.\n`;
writeFileSync('baseline-results.md', md);
console.log(`\n${confirmed}/${total} confirmed -> baseline-results.md`);
