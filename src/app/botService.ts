// Robot reference times (analog robot 0.9): medal targets and the medal-line splits on the HUD.
// Sources, in order: memory → localStorage cache → precomputed table (scripts/opptimes.ts → botTimes.json) → a
// pool of two Web Workers running the robot (≈1.5–4 s per run). Every entry is keyed by a hash of the simulation
// sources + data, so after a physics / stage change old numbers are ignored and recomputed, never shown stale.
import { botKey, type BotRun } from '../sim/rally/botTimes';
import { hashStr } from '../sim/rally/rng';
import { variantId } from '../sim/rally/catalog';
import BotWorker from './botWorker.ts?worker';
import precomputed from './botTimes.json';

/** everything that changes a robot's stage time */
const SOURCES = import.meta.glob(['../sim/vehicle/*.ts', '../sim/driver/*.ts', '../sim/stage/*.ts', '../sim/math/*.ts', '../sim/world.ts', '../sim/ground.ts', '../data/cars.ts', '../data/surfaces.ts', '../data/envs.ts', '../data/stages/*.ts'],
  { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** same recipe as scripts/opptimes.ts: paths relative to src/, sorted, FNV-1a over "path\ncontent\n" */
export const SIM_TAG = (() => {
  const parts = Object.keys(SOURCES).map((p) => [p.replace(/^\.\.\//, ''), SOURCES[p]] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return hashStr(parts.map(([p, c]) => `${p}\n${c}\n`).join('')).toString(16).padStart(8, '0');
})();

const CACHE_KEY = 'dustmark.botcache';
const MAX_ENTRIES = 240;

interface Job { key: string; stage: string; reverse: boolean; weather: string; car: string; skill: number; resolve: (r: BotRun) => void; reject: (e: Error) => void; urgent: boolean }

export class BotService {
  private mem = new Map<string, BotRun>();
  private pending = new Map<string, Promise<BotRun>>();
  private queue: Job[] = [];
  private workers: { w: Worker; busy: Job | null }[] = [];
  private nextId = 1;
  private jobs = new Map<number, Job>();
  /** total worker ms (diagnostics: window.__bots) */
  stats = { runs: 0, ms: 0, cached: 0 };

  constructor(private poolSize = 2) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, BotRun>)) if (k.startsWith(SIM_TAG + '|')) this.mem.set(k, v);
    } catch { /* no cache */ }
    for (const [k, v] of Object.entries(precomputed as Record<string, BotRun>)) if (k.startsWith(SIM_TAG + '|') && !this.mem.has(k)) this.mem.set(k, v);
  }

  key(stage: string, reverse: boolean, weather: string, car: string, skill: number) { return botKey(SIM_TAG, variantId(stage, reverse, weather), car, skill); }

  peek(stage: string, reverse: boolean, weather: string, car: string, skill: number): BotRun | null {
    return this.mem.get(this.key(stage, reverse, weather, car, skill)) ?? null;
  }

  /** a reference run (cached or computed); urgent jobs jump the queue */
  get(stage: string, reverse: boolean, weather: string, car: string, skill: number, urgent = false): Promise<BotRun> {
    const key = this.key(stage, reverse, weather, car, skill);
    const hit = this.mem.get(key);
    if (hit) { this.stats.cached++; return Promise.resolve(hit); }
    const p = this.pending.get(key);
    if (p) {
      if (urgent) { const j = this.queue.findIndex((q) => q.key === key); if (j > 0) this.queue.unshift(...this.queue.splice(j, 1)); }
      return p;
    }
    const prom = new Promise<BotRun>((resolve, reject) => {
      const job: Job = { key, stage, reverse, weather, car, skill, resolve, reject, urgent };
      if (urgent) this.queue.unshift(job); else this.queue.push(job);
    });
    this.pending.set(key, prom);
    prom.catch(() => {}).finally(() => this.pending.delete(key));
    this.pump();
    return prom;
  }

  /** how many runs are waiting or running */
  get busy() { return this.queue.length + this.workers.filter((w) => w.busy).length; }

  private pump() {
    while (this.workers.length < this.poolSize && this.queue.length > this.workers.filter((w) => !w.busy).length) {
      try {
        const w = new BotWorker();
        const slot = { w, busy: null as Job | null };
        w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; run?: BotRun; error?: string }>) => this.done(slot, e.data);
        w.onerror = (e) => { const j = slot.busy; slot.busy = null; j?.reject(new Error(e.message)); this.pump(); };
        this.workers.push(slot);
      } catch (e) { console.warn('[bots] worker unavailable', e); break; }
    }
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const j = this.queue.shift()!;
      slot.busy = j;
      const id = this.nextId++;
      this.jobs.set(id, j);
      slot.w.postMessage({ id, stage: j.stage, reverse: j.reverse, weather: j.weather, car: j.car, skill: j.skill });
    }
  }

  private done(slot: { busy: Job | null }, m: { id: number; ok: boolean; run?: BotRun; error?: string }) {
    const j = this.jobs.get(m.id);
    this.jobs.delete(m.id);
    slot.busy = null;
    if (j) {
      if (m.ok && m.run) {
        this.mem.set(j.key, m.run);
        this.stats.runs++; this.stats.ms += m.run.ms ?? 0;
        this.persist();
        j.resolve(m.run);
      } else j.reject(new Error(m.error ?? 'robot run failed'));
    }
    this.pump();
  }

  private persist() {
    try {
      const entries = [...this.mem.entries()].filter(([k]) => k.startsWith(SIM_TAG + '|')).slice(-MAX_ENTRIES);
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* storage full: memory cache still works this session */ }
  }
}

export const bots = new BotService();
(window as unknown as { __bots: BotService; __simTag: string }).__bots = bots;
(window as unknown as { __simTag: string }).__simTag = SIM_TAG;
