# Changelog

## 0.2.0 — hardening + features (this version)

Defects found by test against v0.1 and fixed (each has a REGRESSION test):

| # | Defect in v0.1 | Fix |
|---|---|---|
| 1 | Auditor: a `music` item verified by citing any entity, including a place or brand | Typed domains must cite an entity of the matching Qloo type |
| 2 | Auditor: a menu item verified by any cited tag, even unrelated to its text | Tag name must be reflected in the text |
| 3 | Auditor: mention check was opt-in (`requireMention`) | Always on; flag removed |
| 4 | Analyst took the first fuzzy search hit and the first semantic tag (which always returns something) | Hit must match the planned type and share a word with the query; otherwise reported as unresolved |
| 5 | Server kept running abandoned/timed-out runs (Promise.race does not cancel) and released the slot early | AbortSignal threaded through LLM, Qloo queue, retry wait; slot released only when the run has stopped |
| 6 | Rate-limit queue could hold a slot for an aborted caller | Abortable wait; chain always released |
| 7 | `TRUST_PROXY` trusted the leftmost (client-controlled) X-Forwarded-For entry | `TRUSTED_PROXY_HOPS=N`: Nth entry from the right |
| 8 | No guard against exhausting the monthly Qloo quota during judging | Quota header captured; new runs refused below `QLOO_MIN_REMAINING` |
| 9 | UI "Fixed after audit" badge appeared on any reused id | Only when the id failed earlier AND its text changed |
| 10 | Eval counted a run as pass without checking fabricated citations | Pass = score ≥ 85, ≤ 3 loops, ≤ 90 s, 0 fabricated |

New:
- **Adaptive Analyst** (bounded): after the first retrieval, any entity type with fewer than 3 entities at affinity ≥ 0.5 triggers up to 2 refinement rounds. The trigger is deterministic code; the model decides what to do: which new seed entities/tags to add, for which type, or to stop. New seeds go through the same relevance checks; Qloo is re-queried; the result (strong count before → after) is recorded in `Evidence.refinements` and streamed as notes. Stops at the round cap or at 40 Qloo calls. No LLM call is spent when evidence is already strong.
- Analyst adaptive re-plan (once) when fewer than 2 seed entities resolve; announced in the UI.
- Qloo explainability ("because of …") behind `QLOO_EXPLAINABILITY=1`, off by default until `npm run probe` passes.
- Client note (steers wording only, never evidence), Markdown export, per-loop score history, Qloo/LLM call counts, call trace.
- `npm run baseline`: LLM-only references checked against Qloo.
- `probe` now runs our parsers on the real responses and prints PASS/FAIL.
- Server is `createApp()` and tested over real HTTP + SSE with stubbed upstreams.

Breaking: `requireMention` option removed; `TRUST_PROXY` replaced by `TRUSTED_PROXY_HOPS`; `AuditReport.meanAffinity`, `RunResult.history/stats`, `Evidence.signals/replanned` added.
