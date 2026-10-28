import { runAnalyst } from '../src/core/analyst';
import { chatLlm } from '../src/core/llm';
import { QlooClient, qlooQuota } from '../src/core/qloo';
import type { Llm } from '../src/core/types';

const qloo = new QlooClient({
  apiKey: process.env.QLOO_API_KEY ?? '',
  baseUrl: process.env.QLOO_API_URL,
  explainability: process.env.QLOO_EXPLAINABILITY === '1',
});

// Evidence for the latency question: how long each LLM call and each Qloo call really takes.
function timed(llm: Llm): Llm {
  return {
    async complete(system, user, signal) {
      const t = Date.now();
      try {
        return await llm.complete(system, user, signal);
      } finally {
        console.log(`LLM call: ${Date.now() - t} ms (${system.slice(0, 30).replace(/\s+/g, ' ')}...)`);
      }
    },
  };
}

const t0 = Date.now();
const evidence = await runAnalyst(
  { concept: 'a café', audience: 'friend group in their mid 20s', city: 'Bengaluru', ageBand: '25_to_29' },
  { qloo, llm: timed(chatLlm()), note: (m) => console.log('NOTE', m) },
);

console.log(`ms=${Date.now() - t0}  qlooCalls=${evidence.calls.length}  replanned=${evidence.replanned}`);
console.log(`qloo http ms per call: ${evidence.calls.map((c) => c.ms).join(', ')}  (sum ${evidence.calls.reduce((a, c) => a + c.ms, 0)})`);
console.log('quota seen:', qlooQuota());
console.log('signals:', evidence.signals.map((s) => `${s.name} (${s.type.replace('urn:entity:', '')})`));
console.log('unresolved:', evidence.unresolved);
console.log('tags:', evidence.tags.map((t) => `${t.queriedAs} -> ${t.name} [${t.id}]`));
for (const e of evidence.entities) {
  const why = e.becauseOf ? `  because of ${e.becauseOf.map((b) => b.name).join(', ')}` : '';
  console.log(`${e.type.padEnd(18)} ${String(e.affinity?.toFixed(2) ?? 'n/a').padStart(5)}  ${e.name}  [${e.tagIds.length} tags]${why}`);
}