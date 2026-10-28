import { runAnalyst } from '../src/core/analyst';
import { chatLlm } from '../src/core/llm';
import { QlooClient, qlooQuota } from '../src/core/qloo';

const qloo = new QlooClient({
  apiKey: process.env.QLOO_API_KEY ?? '',
  baseUrl: process.env.QLOO_API_URL,
  explainability: process.env.QLOO_EXPLAINABILITY === '1',
});

const t0 = Date.now();
const evidence = await runAnalyst(
  { concept: 'a café', audience: 'friend group in their mid 20s', city: 'Bengaluru', ageBand: '25_to_29' },
  { qloo, llm: chatLlm(), note: (m) => console.log('NOTE', m) },
);

console.log(`ms=${Date.now() - t0}  qlooCalls=${evidence.calls.length}  replanned=${evidence.replanned}`);
console.log('quota seen:', qlooQuota());
console.log('signals:', evidence.signals.map((s) => `${s.name} (${s.type.replace('urn:entity:', '')})`));
console.log('unresolved:', evidence.unresolved);
console.log('tags:', evidence.tags.map((t) => `${t.queriedAs} -> ${t.name} [${t.id}]`));
for (const e of evidence.entities) {
  const why = e.becauseOf ? `  because of ${e.becauseOf.map((b) => b.name).join(', ')}` : '';
  console.log(`${e.type.padEnd(18)} ${String(e.affinity?.toFixed(2) ?? 'n/a').padStart(5)}  ${e.name}  [${e.tagIds.length} tags]${why}`);
}
