// Times one realistic planning call per reasoning setting, so we change LLM settings from evidence, not guesses.
// Usage: node --env-file=.env scripts/llm-ping.mjs
const base = (process.env.LLM_BASE_URL ?? '').replace(/\/$/, '');
const key = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
if (!base || !key || !model) throw new Error('LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are required (.env)');

const system = 'Return ONLY JSON: {"entities":[{"name":string,"type":"urn:entity:artist"|"urn:entity:brand"|"urn:entity:place"}],"tagQueries":[string],"domains":[string]}. Up to 4 REAL well-known entities in the city that typify the audience, up to 5 taste terms.';
const user = JSON.stringify({ concept: 'a café', audience: 'friend group in their mid 20s', city: 'Bengaluru' });

for (const effort of [undefined, 'none', 'low']) {
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 8000, ...(effort ? { reasoning_effort: effort } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let note = text.slice(0, 160).replace(/\s+/g, ' ');
  try {
    const j = JSON.parse(text);
    note = `finish=${j.choices?.[0]?.finish_reason} usage=${JSON.stringify(j.usage)} reply=${String(j.choices?.[0]?.message?.content).slice(0, 80).replace(/\s+/g, ' ')}`;
  } catch {}
  console.log(`reasoning_effort=${effort ?? '(default)'}  HTTP ${res.status}  ${ms} ms\n   ${note}\n`);
}
