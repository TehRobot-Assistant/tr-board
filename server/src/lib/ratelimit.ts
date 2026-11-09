/**
 * In-memory fixed-window counters (one process, so no Redis). Keys are client
 * IPs or account emails. Correct IPs need TRUST_PROXY behind a reverse proxy
 * (review M3): without it every request shares the proxy's address and one
 * abuser fills the bucket for everyone.
 *
 * Memory is bounded: past `maxKeys`, expired windows are swept, and if that
 * isn't enough the oldest entries go (Map keeps insertion order). Dropping a
 * live entry only forgives that key early, it never blocks anyone.
 */
export class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private maxKeys = 10_000,
  ) {}

  /** current count for key (0 if none / expired) */
  count(key: string): number {
    const cur = this.hits.get(key);
    return cur && cur.resetAt > Date.now() ? cur.n : 0;
  }

  /** true once `key` has used up its window */
  blocked(key: string): boolean {
    return this.count(key) >= this.limit;
  }

  /** record one hit; returns true if this hit is over the limit */
  hit(key: string): boolean {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.make(key, now);
      return 1 > this.limit;
    }
    cur.n += 1;
    return cur.n > this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private make(key: string, now: number): void {
    if (this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      for (const k of this.hits.keys()) {
        if (this.hits.size < this.maxKeys) break;
        this.hits.delete(k);
      }
    }
    this.hits.delete(key);
    this.hits.set(key, { n: 1, resetAt: now + this.windowMs });
  }
}
