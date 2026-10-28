import { beforeEach, describe, expect, it } from 'vitest';
import { resetQlooQuota, QlooClient } from '../src/core/qloo';
import { clientIp, Gate } from '../src/server/gate';
import { qlooStub } from './support/stubs';

const req = (xff: string | undefined, socket = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: socket } }) as never;
const opts = { perIpPerHour: 2, dailyCap: 100, maxConcurrent: 1, minQlooRemaining: 300 };
beforeEach(() => resetQlooQuota());

describe('clientIp', () => {
  it('hops=0 uses the socket and ignores XFF', () => {
    expect(clientIp(req('1.1.1.1'), 0)).toBe('10.0.0.1');
  });
  it('REGRESSION: with one trusted proxy a spoofed leftmost XFF entry is ignored', () => {
    expect(clientIp(req('6.6.6.6, 203.0.113.9'), 1)).toBe('203.0.113.9');
  });
  it('hops=2 takes the second from the right', () => {
    expect(clientIp(req('6.6.6.6, 203.0.113.9, 10.1.1.1'), 2)).toBe('203.0.113.9');
  });
  it('throws when the header is shorter than configured hops', () => {
    expect(() => clientIp(req(undefined), 1)).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});

describe('gate', () => {
  it('enforces concurrency and frees the slot exactly once on release', () => {
    const g = new Gate(opts);
    const a = g.admit('a');
    expect(a.ok).toBe(true);
    expect(g.admit('b').ok).toBe(false);
    if (a.ok) { a.release(); a.release(); }
    expect(g.status.active).toBe(0);
    expect(g.admit('b').ok).toBe(true);
  });
  it('enforces the per-IP hourly limit', () => {
    const g = new Gate({ ...opts, maxConcurrent: 9 });
    for (let i = 0; i < 2; i++) { const a = g.admit('a'); if (a.ok) a.release(); }
    const third = g.admit('a');
    expect(third.ok).toBe(false);
    expect(g.admit('other').ok).toBe(true);
  });
  it('REGRESSION: refuses new runs when Qloo reports the monthly quota nearly spent', async () => {
    await new QlooClient({ apiKey: 'k', minIntervalMs: 0, fetchImpl: qlooStub({ quotaRemaining: 120 }) }).search('x', 'urn:entity:place');
    const r = new Gate(opts).admit('a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/quota/);
  });
});
