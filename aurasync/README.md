# AuraSync

Three agents design a physical experience (café, pop-up, bar) for a target audience in a city, grounded in the **Qloo Taste Graph**. Every claim in the brief is labelled *Qloo-sourced* or *LLM-inferred*, and an independent **Auditor scores the brief in code** (no LLM judge).

```
Seed ─▶ Analyst ──evidence──▶ Architect ──brief──▶ Auditor ─┐
        (Qloo)                 (LLM)                (code)   │ score < 85 and loops < 3
                                  ▲──────── failures ────────┘
```

| Agent | Does | Cannot |
|---|---|---|
| Analyst | Plans with an LLM, resolves names/tags in Qloo (rejecting fuzzy mismatches), pulls recommendations, re-plans once if too few seeds resolve; if a type has < 3 strong entities, lets the model pick new seeds (≤ 2 rounds, ≤ 40 Qloo calls) | Invent ids; unresolved items are reported, never guessed |
| Architect | Writes the brief, citing Qloo ids | Cite an id that is not in the evidence |
| Auditor | Computes the Cultural Cohesion Score | Be talked into a pass: typed, named, strong-affinity citations only |

**Score** = `100 · verified / groundable − 10 · fabricated`. Groundable = music, brand, place, menu, audience. Lighting, material and styling are LLM design translation: shown, labelled, **not scored**. Rules are in `src/core/auditor.ts`.

## Run it

```bash
npm install
cp .env.example .env   # fill QLOO_API_KEY, LLM_API_KEY, LLM_MODEL (npm scripts load .env themselves)

npm run probe      # 1. raw Qloo calls + runs our parsers on the real responses. Any FAIL = fix src/core/qloo.ts first
npm run analyst    # 2. Analyst alone; read the evidence
npm run eval       # 3. 5 seeds end to end -> eval-results.md
npm run baseline   # 4. LLM-only vs Qloo confirmation rate -> baseline-results.md
npm start          # dashboard on :3000
npm test && npm run typecheck
```

Docker: `docker build -t aurasync . && docker run -p 3000:3000 --env-file .env aurasync`.

## What is and is not verified

- **Verified here:** 47 tests (stubbed upstreams, real HTTP + SSE), typecheck, dashboard rendered in a browser.
- **Verified live (probe, 2026-10-28):** search, tags, insights and per-entity explainability shapes; affinity is present. **Not yet verified:** the full pipeline, because it needs the LLM key; see `eval-results.md` once it exists.
- **Affinity is high almost everywhere:** the top-5 insights returned 0.97–0.999. `MIN_AFFINITY = 0.5` therefore rarely rejects anything, and "mean affinity" will look near 1 by construction. Do not present it as a quality signal.
- The 85% target and the 5-seed results are **unmeasured** until you run `npm run eval` with real keys. Do not quote numbers before then.

## Operating it for judging

Public demo must stay live through judging (Qloo: Nov 2–16). Our Qloo key reports 50,000 calls/month and 10 calls/s in its response headers (observed 2026-10-28); a run costs ~10–14 calls. The server refuses new runs when Qloo reports fewer than `QLOO_MIN_REMAINING` calls left, caps runs per IP/day, and aborts runs when the client leaves or `RUN_TIMEOUT_MS` hits. Set `TRUSTED_PROXY_HOPS=1` behind Render/Railway/Fly.

## Layout

`src/core` types, qloo, analyst, architect, auditor, orchestrator · `src/server` gate (limits, IP), server (HTTP+SSE) · `public/index.html` dashboard · `scripts` probe/analyst/eval/baseline · `test` · `docs` pitch and operations.

MIT. Shri Skanda D, Nishant P Reddy.
