// Hash of the simulation sources + data — the same recipe as SIM_TAG in src/app/botService.ts (paths relative to
// src/, sorted, FNV-1a over "path\ncontent\n"). Robot times keyed by it go stale automatically after a physics /
// stage change.  `exclude`: paths left out (scripts/calibrate.ts keys its own cache without the keyboard-hand file).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashStr } from '../src/sim/rally/rng';

export function simTag(exclude: string[] = []): string {
  const files: string[] = [];
  const dir = (d: string) => { for (const f of readdirSync(join('src', d))) if (f.endsWith('.ts')) files.push(`${d}/${f}`); };
  dir('sim/vehicle'); dir('sim/driver'); dir('sim/stage'); dir('sim/math'); dir('data/stages');
  files.push('sim/world.ts', 'sim/ground.ts', 'data/cars.ts', 'data/surfaces.ts', 'data/envs.ts');
  files.sort();
  return hashStr(files.filter((p) => !exclude.includes(p)).map((p) => `${p}\n${readFileSync(join('src', p), 'utf8')}\n`).join('')).toString(16).padStart(8, '0');
}
