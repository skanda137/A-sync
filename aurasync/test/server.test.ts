import { request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetQlooQuota } from '../src/core/qloo';
import { createApp, type AppOptions } from '../src/server/server';
import { badBrief, goodBrief, llmStub, qlooStub } from './support/stubs';

let close: () => Promise<void> = async () => {};
afterEach(async () => close());
beforeEach(() => resetQlooQuota());

async function boot(over: Partial<AppOptions> & { log?: string[]; qlooDelay?: number; llmDelay?: number; brief?: () => unknown } = {}) {
  const log = over.log ?? [];
  const { server, gate } = createApp({
    llm: llmStub(over.brief ?? goodBrief, { delayMs: over.llmDelay ?? 0, log }),
    qlooKey: 'k', explainability: false, trustedProxyHops: 0, runTimeoutMs: 10_000, qlooMinIntervalMs: 0,
    fetchImpl: qlooStub({ delayMs: over.qlooDelay ?? 0, log }),
    gate: { perIpPerHour: 50, dailyCap: 100, maxConcurrent: 1, minQlooRemaining: 300 },
    ...over,
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return { port, gate, log };
}

// Raw http client (global fetch is not stubbed, but we need to be able to hang up mid-stream).
function open(port: number, qs: string, onData?: (chunk: string) => void) {
  return new Promise<{ res: IncomingMessage; done: Promise<string> }>((resolve) => {
    const req = request({ port, path: `/api/run?${qs}` }, (res) => {
      let body = '';
      const done = new Promise<string>((d) => { res.on('data', (c) => { body += c; onData?.(String(c)); }); res.on('close', () => d(body)); });
      resolve({ res, done });
    });
    req.end();
  });
}
const events = (body: string) => body.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as { type: string; message?: string; result?: { stats: { llmCalls: number } } });
const QS = 'concept=a+caf%C3%A9&audience=friends&city=Bengaluru&ageBand=25_to_29';

describe('server (stubbed Qloo + LLM, real HTTP + SSE)', () => {
  it('streams a full run and reports stats', async () => {
    const { port, gate } = await boot();
    const { done } = await open(port, QS);
    const ev = events(await done);
    expect(ev.at(-1)!.type).toBe('run_done');
    expect(ev.at(-1)!.result!.stats.llmCalls).toBe(2);
    expect(gate.status.active).toBe(0);
  });

  it('rejects invalid input as a run_error event', async () => {
    const { port } = await boot();
    const ev = events(await (await open(port, 'concept=x')).done);
    expect(ev[0]!.type).toBe('run_error');
  });

  it('REGRESSION: client disconnect aborts the run, stops all upstream calls, and frees the slot', async () => {
    const log: string[] = [];
    const { port, gate } = await boot({ log, llmDelay: 400, qlooDelay: 20 });
    const { res } = await open(port, QS);
    await new Promise((r) => setTimeout(r, 120));
    expect(gate.status.active).toBe(1);
    res.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(gate.status.active).toBe(0);
    const n = log.length;
    await new Promise((r) => setTimeout(r, 900));
    expect(log.length).toBe(n); // nothing keeps running after the client left
  });

  it('REGRESSION: timeout aborts the run, emits run_error and frees the slot', async () => {
    const log: string[] = [];
    const { port, gate } = await boot({ log, runTimeoutMs: 150, llmDelay: 2000 });
    const ev = events(await (await open(port, QS)).done);
    expect(ev.at(-1)).toMatchObject({ type: 'run_error', message: 'Run exceeded the time limit' });
    expect(gate.status.active).toBe(0);
    const n = log.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(log.length).toBe(n);
  });

  it('second concurrent run is refused while the first holds the only slot', async () => {
    const { port } = await boot({ llmDelay: 300 });
    const first = await open(port, QS);
    await new Promise((r) => setTimeout(r, 50));
    const second = events(await (await open(port, QS)).done);
    expect(second[0]).toMatchObject({ type: 'run_error' });
    expect(second[0]!.message).toMatch(/busy/);
    await first.done;
  });

  it('a failing brief still ends with run_done after 3 loops (reported as-is)', async () => {
    const { port } = await boot({ brief: badBrief });
    const ev = events(await (await open(port, QS)).done);
    expect(ev.filter((e) => e.type === 'audit')).toHaveLength(3);
    expect(ev.at(-1)!.type).toBe('run_done');
  });
});
