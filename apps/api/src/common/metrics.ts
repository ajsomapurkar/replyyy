/** In-process operational counters exposed on /health and the ops console. */
class Metrics {
  counters: Record<string, number> = {
    offerTimeouts: 0,
    staleWithdrawals: 0,
    assignmentConflicts: 0,
    wsConnections: 0,
    wsReconnects: 0,
    dispatchRuns: 0,
    routingFallbacks: 0,
  };
  private dispatchMs: number[] = [];
  inc(k: string, n = 1) {
    this.counters[k] = (this.counters[k] ?? 0) + n;
  }
  recordDispatch(ms: number) {
    this.dispatchMs.push(ms);
    if (this.dispatchMs.length > 200) this.dispatchMs.shift();
  }
  dispatchLatency() {
    const s = [...this.dispatchMs].sort((a, b) => a - b);
    return { samples: s.length, p50: s[Math.floor(s.length * 0.5)] ?? null, p95: s[Math.floor(s.length * 0.95)] ?? null };
  }
}
export const metrics = new Metrics();
