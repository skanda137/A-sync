// Lists the model ids your Gemini key can call for chat. Pick one Flash text model and put it in .env as LLM_MODEL.
// Usage: node --env-file=.env scripts/list-models.mjs
const key = process.env.LLM_API_KEY;
if (!key) throw new Error('LLM_API_KEY is required (set it in .env)');
const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
const { models } = await res.json();
const ok = models.filter((m) => m.supportedGenerationMethods?.includes('generateContent'));
for (const m of ok) console.log(m.name.replace(/^models\//, '').padEnd(42), m.displayName ?? '');
console.log(`\n${ok.length} models support generateContent. Choose a stable Flash text model (avoid names containing image, tts, live, audio, embedding, preview or exp).`);