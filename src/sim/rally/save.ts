// The save: one versioned JSON in localStorage (DESIGN §3), ghosts in their own keys next to it.
//   dustmark.save              { v, settings, garage, unlockedGroup, records, career, stats, … }
//   dustmark.ghost.<variant>   GhostData (best run on that stage + direction)
//   dustmark.save.bak.<time>   a copy of an unreadable save (kept, newest 3)
// Loading never throws: a corrupt or future-version save is backed up and replaced by a new one.
import { buildSeason, normalizeCareer, type CareerState } from './career';
import { listEnvs, stageLength } from './catalog';
import type { GhostData } from './ghost';
import type { Medal } from './scoring';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings';

export const SAVE_VERSION = 1;
export const SAVE_KEY = 'dustmark.save';
export const GHOST_PREFIX = 'dustmark.ghost.';
export const BACKUP_PREFIX = 'dustmark.save.bak.';
/** trajectory prediction switch stored by the P key before the save existed (src/render/predictOverlay.ts) */
export const LEGACY_PREDICT_KEY = 'dustmark.predict';

export interface StageRecord { best: number; car: string; date: number; medal: Medal; ghost: boolean }

export interface SaveData {
  v: number;
  created: number;
  updated: number;
  settings: Settings;
  garage: { car: string; liveries: Record<string, number> };
  /** highest unlocked group (0 入门 / 1 经典 / 2 顶级) */
  unlockedGroup: number;
  /** best times by stage variant ("north-1", "north-1~r") */
  records: Record<string, StageRecord>;
  career: CareerState | null;
  stats: { runs: number; km: number };
  seenEnding: boolean;
  /** the "怎么开" card was shown (first stage of a new save) */
  introSeen: boolean;
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

/** in-memory storage (tests, blocked localStorage) */
export class MemoryKV implements KV {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

export function newSave(now = Date.now()): SaveData {
  return {
    v: SAVE_VERSION, created: now, updated: now,
    settings: normalizeSettings(DEFAULT_SETTINGS),
    garage: { car: 'pipit', liveries: {} },
    unlockedGroup: 0,
    records: {},
    career: null,
    stats: { runs: 0, km: 0 },
    seenEnding: false,
    introSeen: false,
  };
}

/** migration hooks: MIGRATIONS[n] turns a version-n save into version n+1 */
export const MIGRATIONS: Record<number, (s: any, kv: KV) => any> = {
  // v0: no save object yet, only loose keys (the P-key prediction switch)
  0: (_s, kv) => {
    const s = newSave();
    const p = kv.getItem(LEGACY_PREDICT_KEY);
    if (p !== null) s.settings.predict = p === '1';
    return s;
  },
};

export type LoadStatus = 'new' | 'ok' | 'migrated' | 'corrupt';

function keys(kv: KV) { const out: string[] = []; for (let i = 0; i < kv.length; i++) { const k = kv.key(i); if (k) out.push(k); } return out; }

function backup(kv: KV, raw: string, now: number) {
  const k = BACKUP_PREFIX + now;
  try { kv.setItem(k, raw); } catch { /* full: the corrupt copy is lost, the game still starts */ }
  const old = keys(kv).filter((x) => x.startsWith(BACKUP_PREFIX)).sort();
  while (old.length > 3) kv.removeItem(old.shift()!);
  return k;
}

/** fill fields an older or hand-edited save may lack (keeps unknown extra fields; drops the fields of the career
 *  with rivals: the per-save seed for their form, the difficulty setting, positions — see normalizeCareer) */
function normalize(s: any): SaveData {
  const d = newSave(typeof s.created === 'number' ? s.created : Date.now());
  const { seed: _seed, ...rest } = s;
  return {
    ...d, ...rest,
    v: SAVE_VERSION,
    settings: normalizeSettings(s.settings),
    garage: { car: typeof s.garage?.car === 'string' ? s.garage.car : d.garage.car, liveries: s.garage?.liveries && typeof s.garage.liveries === 'object' ? s.garage.liveries : {} },
    unlockedGroup: Math.max(0, Math.min(2, Number(s.unlockedGroup) || 0)),
    records: s.records && typeof s.records === 'object' ? s.records : {},
    career: normalizeCareer(s.career, (season) => buildSeason(season, listEnvs(), stageLength)),
    stats: { runs: Number(s.stats?.runs) || 0, km: Number(s.stats?.km) || 0 },
    seenEnding: !!s.seenEnding,
    introSeen: !!s.introSeen,
  };
}

export function loadSave(kv: KV, now = Date.now()): { save: SaveData; status: LoadStatus; backupKey?: string } {
  let raw: string | null = null;
  try { raw = kv.getItem(SAVE_KEY); } catch { raw = null; }
  if (raw === null) {
    const s = MIGRATIONS[0](null, kv) as SaveData;
    return { save: s, status: 'new' };
  }
  let obj: any;
  try {
    obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || typeof obj.v !== 'number' || obj.v > SAVE_VERSION || obj.v < 1) throw new Error('bad save');
  } catch {
    const backupKey = backup(kv, raw, now);
    return { save: newSave(now), status: 'corrupt', backupKey };
  }
  let status: LoadStatus = 'ok';
  try {
    while (obj.v < SAVE_VERSION) {
      const m = MIGRATIONS[obj.v];
      if (!m) throw new Error(`no migration from v${obj.v}`);
      obj = m(obj, kv);
      status = 'migrated';
    }
    return { save: normalize(obj), status };
  } catch {
    const backupKey = backup(kv, raw, now);
    return { save: newSave(now), status: 'corrupt', backupKey };
  }
}

/** write the save; false if storage refused it (full / blocked) */
export function writeSave(kv: KV, s: SaveData, now = Date.now()): boolean {
  s.updated = now;
  try { kv.setItem(SAVE_KEY, JSON.stringify(s)); return true; } catch { return false; }
}

export function readGhost(kv: KV, variant: string): GhostData | null {
  try {
    const raw = kv.getItem(GHOST_PREFIX + variant);
    if (!raw) return null;
    const g = JSON.parse(raw);
    return g && typeof g.data === 'string' && typeof g.total === 'number' ? g : null;
  } catch { return null; }
}

/** store a ghost; on a full storage, drop other ghosts (oldest first) and try again */
export function writeGhost(kv: KV, variant: string, g: GhostData): boolean {
  const raw = JSON.stringify(g);
  for (let attempt = 0; attempt < 8; attempt++) {
    try { kv.setItem(GHOST_PREFIX + variant, raw); return true; } catch {
      const others = keys(kv).filter((k) => k.startsWith(GHOST_PREFIX) && k !== GHOST_PREFIX + variant)
        .map((k) => ({ k, date: (() => { try { return JSON.parse(kv.getItem(k) ?? '{}').date ?? 0; } catch { return 0; } })() }))
        .sort((a, b) => a.date - b.date);
      if (!others.length) return false;
      kv.removeItem(others[0].k);
    }
  }
  return false;
}

/** 清除存档: the save, ghosts and the legacy key (robot-time cache and backups stay) */
export function clearSave(kv: KV) {
  for (const k of keys(kv)) if (k === SAVE_KEY || k.startsWith(GHOST_PREFIX) || k === LEGACY_PREDICT_KEY) kv.removeItem(k);
}

/** first stage of a save: no finished run anywhere (records, career results) and the card not seen yet */
export function needsIntro(s: SaveData): boolean {
  if (s.introSeen) return false;
  if (Object.keys(s.records).length) return false;
  const c = s.career;
  return !(c && (c.rallies.length || c.history.length || (c.current?.results.length ?? 0) > 0));
}

/** a new best on a stage variant? → updates the record (returns true when it is a new best) */
export function updateRecord(s: SaveData, variant: string, total: number, car: string, medal: Medal, now = Date.now()): boolean {
  const r = s.records[variant];
  const rankOf = (m: Medal) => (m === 'gold' ? 3 : m === 'silver' ? 2 : m === 'bronze' ? 1 : 0);
  if (r && r.best <= total) {
    if (rankOf(medal) > rankOf(r.medal)) r.medal = medal;
    return false;
  }
  s.records[variant] = { best: total, car, date: now, medal: r && rankOf(r.medal) > rankOf(medal) ? r.medal : medal, ghost: r?.ghost ?? false };
  return true;
}
