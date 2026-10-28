# Hard questions and honest answers

- **Why not just ask GPT/Claude?** `baseline-results.md`: an LLM alone names references and we check each in Qloo. Report the measured rate, not an assumption. Caveat: not in Qloo ≠ fake.
- **Is it really multi-agent, or one prompt chain?** Three roles with different failure modes: the Analyst can fail to resolve, the Architect can cite badly, the Auditor is deterministic code. The loop only exists because the Auditor's output changes the Architect's input. No agent framework; the state machine is ~60 lines (`orchestrator.ts`).
- **Where is the autonomy?** Narrow and bounded, so don't oversell it: the Analyst inspects its own retrieval, and when a type is thin the model chooses new seeds and which type to re-query, or stops (`analyst.ts`, `refinements` in the evidence). The Architect↔Auditor loop is a bounded retry, not negotiation. The trigger for refinement is a fixed rule, not model judgement.
- **Who grades the grader?** Nobody; it is deterministic and readable (`auditor.ts`, ~100 lines). Its blind spot: it checks grounding, not quality or taste.
- **Can the Architect game the score?** It tried in v0.1 (type laundering, id laundering, unrelated tags). Those are now rejected and covered by regression tests.
- **What if Qloo has no data for a city?** Qloo returns 400 for unresolvable cities (reported by another entrant); the run fails fast with the message.
- **What did you build during the event?** Answer with the git history and the changelog. See `docs/ORGANIZER_EMAIL.md`.
- **What would you do next?** Per-domain evidence for menu items (Qloo has no food entity type here), user feedback loop on real venue outcomes.
