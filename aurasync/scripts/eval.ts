// Runs the predefined seeds through the full pipeline and writes aggregate numbers to eval-results.md.
// Contains no raw Qloo payloads. A seed that errors counts as a miss and is listed as such. Usage: npm run eval
import { writeFileSync } from 'node:fs';
import { makeArchitect } from '../src/core/architect';
import { chatLlm, countingLlm } from '../src/core/llm';
import { runPipeline } from '../src/core/orchestrator';
import { QlooClient } from '../src/core/qloo';
import { SEEDS } from '../eval/seeds';

const TARGET = 85;
const MAX_SECONDS = 90;
const base = chatLlm();
const rows: string[] = [];
let pass = 0;
const affinities: number[] = [];

for (const seed of SEEDS) {
  const qloo = new QlooClient({ apiKey: process.env.QLOO_API_KEY ?? '', baseUrl: process.env.QLOO_API_URL, explainability: process.env.QLOO_EXPLAINABILITY === '1' });
  const counted = countingLlm(base);
  try {
    const r = await runPipeline(seed, { qloo, llm: counted.llm, architect: makeArchitect(counted.llm), llmCalls: counted.count });
    const s = r.stats.ms / 1000;
    // All four conditions of the success test, plus zero fabricated citations.
    const ok = r.report.score >= TARGET && r.iterations <= 3 && s <= MAX_SECONDS && r.report.fabricatedItems.length === 0;
    if (ok) pass++;
    if (r.report.meanAffinity !== null) affinities.push(r.report.meanAffinity);
    const path = r.history.map((h) => h.score).join(' → ');
    rows.push(`| ${seed.city} | ${seed.concept} | ${path} | ${r.iterations} | ${s.toFixed(1)}s | ${r.report.verified}/${r.report.groundable} | ${r.report.fabricatedItems.length} | ${r.report.meanAffinity ?? 'n/a'} | ${r.stats.qlooCalls} / ${r.stats.llmCalls} | ${ok ? 'PASS' : 'MISS'} |`);
  } catch (e) {
    rows.push(`| ${seed.city} | ${seed.concept} | - | - | - | - | - | - | - | ERROR: ${(e as Error).message.slice(0, 70).replace(/\|/g, '/')} |`);
  }
  console.log(rows.at(-1));
}

const mean = affinities.length ? (affinities.reduce((a, b) => a + b, 0) / affinities.length).toFixed(2) : 'n/a';
const md = `# Evaluation\n\nPass = score >= ${TARGET}, <= 3 loops, <= ${MAX_SECONDS}s, zero fabricated citations. Errors count as misses.\n\n| City | Concept | Score per loop | Loops | Latency | Verified | Fabricated | Mean affinity | Qloo / LLM calls | Result |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n**${pass}/${SEEDS.length} seeds met every condition.** Mean affinity of verified citations across passing runs: ${mean}.\n\nGenerated ${new Date().toISOString()} by \`npm run eval\`. The score is computed by code (src/core/auditor.ts), not by an LLM.\n`;
writeFileSync('eval-results.md', md);
console.log(`\n${pass}/${SEEDS.length} passed -> eval-results.md`);
