import { describe, expect, it } from 'vitest';
import { makeArchitect } from '../src/core/architect';
import { countingLlm } from '../src/core/llm';
import { runPipeline } from '../src/core/orchestrator';
import { QlooClient } from '../src/core/qloo';
import type { RunEvent } from '../src/core/types';
import { badBrief, goodBrief, llmStub, qlooStub } from './support/stubs';

const seed = { concept: 'a café', audience: 'mid 20s', city: 'Bengaluru' };
const qloo = (signal?: AbortSignal, f = qlooStub()) => new QlooClient({ apiKey: 'k', minIntervalMs: 0, retryDelayMs: 0, fetchImpl: f, signal });

describe('orchestrator', () => {
  it('stops at target on loop 1, reports history and stats', async () => {
    const c = countingLlm(llmStub(goodBrief));
    const events: RunEvent[] = [];
    const r = await runPipeline(seed, { qloo: qloo(), llm: c.llm, architect: makeArchitect(c.llm), llmCalls: c.count, onEvent: (e) => events.push(e) });
    expect(r.reachedTarget).toBe(true);
    expect(r.iterations).toBe(1);
    expect(r.history).toEqual([{ iteration: 1, score: 100, verified: 2, groundable: 2 }]);
    expect(r.stats.llmCalls).toBe(2); // 1 plan + 1 architect
    expect(r.stats.qlooCalls).toBeGreaterThan(0);
    expect(events.map((e) => e.type)).toContain('run_done');
    expect(events.at(-1)!.type).toBe('run_done');
  });

  it('caps at 3 loops and reports the failing score as-is', async () => {
    const c = countingLlm(llmStub(badBrief));
    const r = await runPipeline(seed, { qloo: qloo(), llm: c.llm, architect: makeArchitect(c.llm) });
    expect(r.reachedTarget).toBe(false);
    expect(r.iterations).toBe(3);
    expect(r.history).toHaveLength(3);
    expect(r.report.score).toBe(0);
  });

  it('abort stops the run: no further LLM or Qloo calls after the signal fires', async () => {
    const ctl = new AbortController();
    const log: string[] = [];
    const llm = llmStub(goodBrief, { delayMs: 300, log });
    const f = qlooStub({ log });
    const p = runPipeline(seed, { qloo: qloo(ctl.signal, f), llm, architect: makeArchitect(llm), signal: ctl.signal });
    p.catch(() => {});
    setTimeout(() => ctl.abort(new Error('Client disconnected')), 50);
    await expect(p).rejects.toThrow('Client disconnected');
    const n = log.length;
    await new Promise((r) => setTimeout(r, 600));
    expect(log.length).toBe(n);
  });

  it('emits run_error and rethrows on failure', async () => {
    const events: RunEvent[] = [];
    const llm = { complete: async () => 'not json' };
    await expect(runPipeline(seed, { qloo: qloo(), llm, architect: makeArchitect(llm), onEvent: (e) => events.push(e) })).rejects.toThrow();
    expect(events.at(-1)!.type).toBe('run_error');
  });
});
