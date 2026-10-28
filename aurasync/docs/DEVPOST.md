# Devpost text (edit only after `npm run eval` — fill the [ ] with measured numbers)

**Tagline:** Agents that design experiences, and an auditor that refuses to be impressed.

**Problem.** Experience designers (cafés, pop-ups, venues) pick music, partner brands and neighbours from gut feel or generic AI suggestions that name real-sounding things nobody checked.

**What it does.** Give AuraSync a concept, audience and city. An Analyst queries Qloo's Taste Graph (entities, tags, demographics, location). An Architect writes a brief where every music, brand, venue, menu and audience claim cites a Qloo entity or tag. An Auditor, plain code with no LLM, scores it 0–100 and sends specific failures back; the loop runs at most three times. Design items Qloo cannot ground (lighting, materials, styling) are shown as LLM-inferred and excluded from the score.

**How we use Qloo.** `/search` and `/v2/tags` (semantic) to resolve seeds, `/v2/insights` with entity + tag + age + location signals for artists, brands and places, and (when enabled) explainability to show which seed drove each recommendation.

**What makes it trustworthy.** The Auditor rejects: ids not in the evidence; a music item citing a place; text that never names its cited entity; weak-affinity citations; tags unrelated to the text. Each rule has a regression test. The UI shows the Auditor→Architect conversation, a "Fixed after audit" badge only when the text actually changed, and what could not be verified.

**Measured.** [x]/5 seeds reached ≥85 within 3 loops and 90 s (`eval-results.md`). LLM-only baseline: [y]% of named references confirmed by Qloo (`baseline-results.md`). Mean affinity of verified citations: [z].

**Limits (say them).** Score measures grounding, not whether the design is good. Qloo's catalogue is finite, so "unresolved" ≠ "fake". Lighting/material/styling are not verified by anything.

**Built with.** TypeScript, Node 22, Qloo Taste Graph API, an OpenAI-compatible LLM API, zero-dependency HTTP + SSE.
