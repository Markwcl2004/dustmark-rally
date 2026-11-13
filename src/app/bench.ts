// Frame-time benchmark: bot drives for a fixed duration; percentile stats exposed on window.__benchResult.
export interface BenchResult {
  durationS: number; frames: number;
  avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number;
  over16_7Pct: number; over50Count: number; pass: boolean;
  cpu: { simAvgMs: number; simP99Ms: number; renderAvgMs: number; renderP99Ms: number };
  drawCallsAvg: number; trianglesAvg: number; drawCallsMax: number; trianglesMax: number;
  resolution: string; renderScale: number; quality: string; gpu: string;
  scaleChanges: number[]; heapMB: number; distanceM: number; avgKmh: number;
  longest: { atS: number; ms: number; simMs: number; renderMs: number; note: string }[];
}

const pct = (a: Float64Array, p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;

export class Bench {
  readonly warmup = 2;
  private start = -1;
  private f: number[] = []; private s: number[] = []; private r: number[] = []; private at: number[] = [];
  private calls = 0; private tris = 0; private callsMax = 0; private trisMax = 0;
  private notes: string[] = [];
  private lastRes = '';
  constructor(readonly duration = 60) {}
  elapsed(now: number) { return this.start < 0 ? 0 : (now - this.start) / 1000; }
  record(now: number, frameMs: number, simMs: number, renderMs: number, calls: number, tris: number, res = '') {
    if (this.start < 0) this.start = now;
    const el = this.elapsed(now);
    if (el < this.warmup) return;
    this.f.push(frameMs); this.s.push(simMs); this.r.push(renderMs); this.at.push(el);
    this.notes.push(res !== this.lastRes && this.lastRes ? `res ${this.lastRes}→${res}` : '');
    this.lastRes = res;
    this.calls += calls; this.tris += tris;
    this.callsMax = Math.max(this.callsMax, calls); this.trisMax = Math.max(this.trisMax, tris);
  }
  done(now: number) { return this.elapsed(now) >= this.duration + this.warmup; }
  result(meta: Pick<BenchResult, 'resolution' | 'renderScale' | 'quality' | 'gpu' | 'scaleChanges' | 'distanceM' | 'avgKmh'>): BenchResult {
    const f = Float64Array.from(this.f).sort(), s = Float64Array.from(this.s).sort(), r = Float64Array.from(this.r).sort();
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const over = this.f.filter((x) => x > 16.7).length, over50 = this.f.filter((x) => x > 50).length;
    const p99 = pct(f, 99);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const order = this.f.map((_, i) => i).sort((a, b) => this.f[b] - this.f[a]).slice(0, 6);
    return {
      durationS: this.duration, frames: f.length,
      avgMs: +avg(this.f).toFixed(3), p50Ms: +pct(f, 50).toFixed(3), p95Ms: +pct(f, 95).toFixed(3), p99Ms: +p99.toFixed(3), maxMs: +(f[f.length - 1] ?? 0).toFixed(2),
      over16_7Pct: +((over / Math.max(1, f.length)) * 100).toFixed(2), over50Count: over50, // vsync-locked runs report 16.8 ms frames from timer rounding; a dropped frame shows up as ≥ 25 ms
      pass: p99 <= 16.95 && over50 === 0,
      cpu: { simAvgMs: +avg(this.s).toFixed(3), simP99Ms: +pct(s, 99).toFixed(3), renderAvgMs: +avg(this.r).toFixed(3), renderP99Ms: +pct(r, 99).toFixed(3) },
      drawCallsAvg: Math.round(this.calls / Math.max(1, f.length)), trianglesAvg: Math.round(this.tris / Math.max(1, f.length)),
      drawCallsMax: this.callsMax, trianglesMax: this.trisMax,
      heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : -1,
      longest: order.map((i) => ({ atS: +this.at[i].toFixed(2), ms: +this.f[i].toFixed(2), simMs: +this.s[i].toFixed(2), renderMs: +this.r[i].toFixed(2), note: [this.notes[i - 1], this.notes[i]].filter(Boolean).join(' ') })),
      ...meta,
    };
  }
}
