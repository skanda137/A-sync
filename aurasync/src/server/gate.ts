import type { IncomingMessage } from 'node:http';
import { qlooQuota } from '../core/qloo';

export interface GateOptions {
  perIpPerHour: number;
  dailyCap: number;
  maxConcurrent: number;
  minQlooRemaining: number; // refuse new runs when Qloo reports fewer calls left this month
}

export type Admission = { ok: true; release: () => void } | { ok: false; message: string };

export class Gate {
  private readonly hits = new Map<string, number[]>();
  private active = 0;
  private day = new Date().toDateString();
  private dayCount = 0;

  constructor(private readonly o: GateOptions, private readonly now: () => number = Date.now) {}

  get status() {
    return { active: this.active, runsToday: this.dayCount };
  }

  admit(ip: string): Admission {
    const today = new Date(this.now()).toDateString();
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
    }
    const q = qlooQuota();
    if (q.monthRemaining !== null && q.monthRemaining < this.o.minQlooRemaining) {
      return { ok: false, message: 'Qloo monthly API quota is nearly exhausted; runs are paused to keep the demo alive for judging.' };
    }
    if (this.dayCount >= this.o.dailyCap) return { ok: false, message: 'Daily demo budget reached. Try again tomorrow.' };
    if (this.active >= this.o.maxConcurrent) return { ok: false, message: 'Server is busy with other runs. Retry in a minute.' };
    const t = this.now();
    const recent = (this.hits.get(ip) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= this.o.perIpPerHour) return { ok: false, message: 'Rate limit: too many runs from this address this hour.' };
    recent.push(t);
    this.hits.set(ip, recent);
    this.dayCount++;
    this.active++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.active--;
      },
    };
  }
}

/**
 * Client address. hops = number of trusted reverse proxies in front of this server (0 = none: use the socket).
 * With hops = N the address is the Nth entry from the RIGHT of X-Forwarded-For, i.e. what the outermost trusted
 * proxy saw. Entries further left are client-supplied and spoofable, so they are never used.
 */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, hops: number): string {
  const socket = req.socket.remoteAddress ?? 'unknown';
  if (hops <= 0) return socket;
  const parts = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const pick = parts[parts.length - hops];
  if (!pick) throw new Error(`TRUSTED_PROXY_HOPS=${hops} but X-Forwarded-For has ${parts.length} entries; check proxy setup`);
  return pick;
}
