import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeArchitect } from '../core/architect';
import { chatLlm, countingLlm } from '../core/llm';
import { runPipeline } from '../core/orchestrator';
import { QlooClient, qlooQuota } from '../core/qloo';
import type { Llm, Seed } from '../core/types';
import { clientIp, Gate, type GateOptions } from './gate';

const AGE_BANDS = new Set(['', '24_and_younger', '25_to_29', '30_to_34', '35_to_44', '45_to_54', '55_and_older']);
const ROOT = join(import.meta.dirname, '../..');

export interface AppOptions {
  llm: Llm;
  qlooKey: string;
  qlooUrl?: string;
  explainability: boolean;
  trustedProxyHops: number;
  runTimeoutMs: number;
  qlooMinIntervalMs?: number; // tests set 0
  fetchImpl?: typeof fetch; // Qloo transport; tests inject a stub
  gate: GateOptions;
}

export function optionsFromEnv(): AppOptions {
  const n = (k: string, d: number) => {
    const v = process.env[k];
    if (v === undefined || v === '') return d;
    const x = Number(v);
    if (!Number.isFinite(x)) throw new Error(`${k} must be a number`);
    return x;
  };
  return {
    llm: chatLlm(),
    qlooKey: process.env.QLOO_API_KEY ?? '',
    qlooUrl: process.env.QLOO_API_URL,
    explainability: process.env.QLOO_EXPLAINABILITY === '1',
    trustedProxyHops: n('TRUSTED_PROXY_HOPS', 0),
    runTimeoutMs: n('RUN_TIMEOUT_MS', 150_000),
    gate: { perIpPerHour: n('RUNS_PER_IP_HOUR', 6), dailyCap: n('RUNS_PER_DAY', 150), maxConcurrent: n('MAX_CONCURRENT', 2), minQlooRemaining: n('QLOO_MIN_REMAINING', 300) },
  };
}

function clean(v: string | null, max: number): string {
  return (v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function parseSeed(u: URL): Seed | string {
  const concept = clean(u.searchParams.get('concept'), 80);
  const audience = clean(u.searchParams.get('audience'), 120);
  const city = clean(u.searchParams.get('city'), 60);
  const ageBand = clean(u.searchParams.get('ageBand'), 20);
  const note = clean(u.searchParams.get('note'), 200);
  if (!concept || !audience || !city) return 'concept, audience and city are required';
  if (!AGE_BANDS.has(ageBand)) return 'unsupported ageBand';
  return { concept, audience, city, ...(ageBand ? { ageBand } : {}), ...(note ? { note } : {}) };
}

function sse(res: ServerResponse, data: unknown) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createApp(o: AppOptions): { server: Server; gate: Gate } {
  const gate = new Gate(o.gate);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(await readFile(join(ROOT, 'public/index.html')));
        return;
      }
      if (url.pathname === '/eval-results.md') {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        res.end(await readFile(join(ROOT, 'eval-results.md')));
        return;
      }
      if (url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...gate.status, qloo: qlooQuota(), explainability: o.explainability }));
        return;
      }
      if (url.pathname !== '/api/run') {
        res.writeHead(404).end('not found');
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      // Rejections travel as run_error events so the browser never auto-reconnects into a second run.
      const seed = parseSeed(url);
      if (typeof seed === 'string') {
        sse(res, { type: 'run_error', message: seed });
        res.end();
        return;
      }
      const admission = gate.admit(clientIp(req, o.trustedProxyHops));
      if (!admission.ok) {
        sse(res, { type: 'run_error', message: admission.message });
        res.end();
        return;
      }

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error('Run exceeded the time limit')), o.runTimeoutMs);
      const beat = setInterval(() => res.write(': hb\n\n'), 15_000);
      res.on('close', () => ctl.abort(new Error('Client disconnected')));
      try {
        const qloo = new QlooClient({ apiKey: o.qlooKey, baseUrl: o.qlooUrl, signal: ctl.signal, explainability: o.explainability, minIntervalMs: o.qlooMinIntervalMs, fetchImpl: o.fetchImpl });
        const counted = countingLlm(o.llm);
        await runPipeline(seed, { qloo, llm: counted.llm, architect: makeArchitect(counted.llm), llmCalls: counted.count, signal: ctl.signal, onEvent: (e) => sse(res, e) });
      } catch {
        // runPipeline already emitted run_error for every failure, including abort and timeout.
      } finally {
        clearTimeout(timer);
        clearInterval(beat);
        admission.release();
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String((err as Error).message));
    }
  });
  return { server, gate };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createApp(optionsFromEnv()).server.listen(port, () => console.log(`AuraSync on http://localhost:${port}`));
}
