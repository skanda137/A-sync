import { runAnalyst, type AnalystDeps } from './analyst';
import { audit, DEFAULT_TARGET } from './auditor';
import {
  assertBrief,
  type Architect,
  type AuditReport,
  type Brief,
  type LoopRecord,
  type RunEvent,
  type RunResult,
  type Seed,
} from './types';

export const MAX_ITERATIONS = 3;

export interface RunDeps extends Omit<AnalystDeps, 'note'> {
  architect: Architect;
  target?: number;
  maxIterations?: number;
  llmCalls?: () => number; // from countingLlm; omitted -> stats.llmCalls is null
  onEvent?: (e: RunEvent) => void;
}

type EventBody = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'seq' | 'ts'> : never) : never;

// Analyst once, then Architect -> Auditor up to maxIterations. Stops at target or at the cap, and reports
// the final score as-is. Aborting (deps.signal) stops before the next step. Any error emits run_error
// and is rethrown (fail fast).
export async function runPipeline(seed: Seed, deps: RunDeps): Promise<RunResult> {
  const target = deps.target ?? DEFAULT_TARGET;
  const max = deps.maxIterations ?? MAX_ITERATIONS;
  const t0 = Date.now();
  let seq = 0;
  const emit = (e: EventBody) => deps.onEvent?.({ ...e, seq: seq++, ts: Date.now() } as RunEvent);
  const history: LoopRecord[] = [];

  try {
    emit({ type: 'run_start', seed });

    emit({ type: 'agent', agent: 'analyst', status: 'start', iteration: 0 });
    const evidence = await runAnalyst(seed, { ...deps, note: (message) => emit({ type: 'note', agent: 'analyst', message }) });
    emit({ type: 'agent', agent: 'analyst', status: 'done', iteration: 0 });
    emit({ type: 'evidence', entities: evidence.entities.length, tags: evidence.tags.length, signals: evidence.signals.length, unresolved: evidence.unresolved, replanned: evidence.replanned });

    let brief: Brief | undefined;
    let report: AuditReport | undefined;

    for (let i = 1; i <= max; i++) {
      deps.signal?.throwIfAborted();
      emit({ type: 'agent', agent: 'architect', status: 'start', iteration: i });
      brief = assertBrief(await deps.architect({ seed, evidence, previousBrief: brief, feedback: report, signal: deps.signal }));
      emit({ type: 'agent', agent: 'architect', status: 'done', iteration: i });

      emit({ type: 'agent', agent: 'auditor', status: 'start', iteration: i });
      report = audit(brief, evidence, target);
      emit({ type: 'agent', agent: 'auditor', status: 'done', iteration: i });
      history.push({ iteration: i, score: report.score, verified: report.verified, groundable: report.groundable });
      emit({ type: 'audit', iteration: i, report, brief });

      if (report.score >= target) return finish(brief, report, evidence, i, true);
    }
    return finish(brief!, report!, evidence, max, false);
  } catch (err) {
    emit({ type: 'run_error', message: (err as Error).message });
    throw err;
  }

  function finish(brief: Brief, report: AuditReport, evidence: RunResult['evidence'], iterations: number, reachedTarget: boolean) {
    const stats = { llmCalls: deps.llmCalls ? deps.llmCalls() : null, qlooCalls: evidence.calls.length, ms: Date.now() - t0 };
    const result: RunResult = { brief, report, evidence, iterations, reachedTarget, history, stats };
    emit({ type: 'run_done', result });
    return result;
  }
}
