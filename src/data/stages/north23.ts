// 北境林道 · stages 2 and 3 (stage 1 「镜湖林场」 is north1.ts).
import type { StageDef } from '../../sim/stage/script';

/** 鹿鸣岭 — flat-out: long straights over crests, three big jumps across clear-cut and moorland */
export const NORTH_2: StageDef = {
  id: 'north-2', name: '鹿鸣岭', env: 'north', seed: 5233, halfWidth: 3.4,
  segments: [
    { zone: 'village', kind: 'straight', len: 230 },
    { kind: 'turn', dir: 'L', grade: 5 },
    { zone: 'logging', kind: 'straight', len: [380, 420], bend: 6, features: [{ kind: 'crest', at: 0.3, height: 2.2 }, { kind: 'jump', at: 0.75, height: 1.6 }] },
    { kind: 'turn', dir: 'R', grade: 4, mods: ['long'] },
    { zone: 'forest', kind: 'straight', len: [300, 340], features: [{ kind: 'crest', at: 0.35, height: 2.4 }, { kind: 'crest', at: 0.8, height: 2.2 }] },
    { kind: 'turn', dir: 'L', grade: 3, mods: ['tightens'] },
    { kind: 'straight', len: [200, 240] },
    { kind: 'turn', dir: 'R', grade: 5, mods: ['crest'], features: [{ kind: 'crest', at: 0.5, height: 2.0, length: 60 }] },
    { zone: 'moor', kind: 'straight', len: [460, 500], bend: -7, features: [{ kind: 'jump', at: 0.4, height: 1.9, length: 24 }, { kind: 'crest', at: 0.85, height: 2.4 }] },
    { kind: 'turn', dir: 'L', grade: 2 },
    { kind: 'straight', len: [180, 210], features: [{ kind: 'dip', at: 0.5, height: 1.8 }] },
    { kind: 'turn', dir: 'R', grade: 4 },
    { zone: 'birch', kind: 'straight', len: [320, 360], features: [{ kind: 'rollers', at: 0.4, height: 0.8, length: 28, count: 3 }, { kind: 'crest', at: 0.85, height: 2.0 }] },
    { kind: 'turn', dir: 'L', grade: 5, mods: ['long'] },
    { zone: 'logging', kind: 'straight', len: [340, 380], features: [{ kind: 'jump', at: 0.55, height: 1.8, length: 24 }] },
    { kind: 'turn', dir: 'R', grade: 3 },
    { kind: 'straight', len: [150, 180] },
    { zone: 'forest', kind: 'turn', dir: 'L', grade: 6 },
    { kind: 'straight', len: [300, 340], features: [{ kind: 'crest', at: 0.5, height: 2.3 }] },
    { zone: 'village', kind: 'turn', dir: 'R', grade: 4 },
    { kind: 'straight', len: 330 },
  ],
};

/** 黑松沟 — narrow and technical deep in the pines: linked corners, two hairpins, hardly a straight */
export const NORTH_3: StageDef = {
  id: 'north-3', name: '黑松沟', env: 'north', seed: 5347, halfWidth: 2.9,
  segments: [
    { zone: 'logging', kind: 'straight', len: 220 },
    { kind: 'turn', dir: 'R', grade: 4 },
    { zone: 'forest', kind: 'straight', len: [100, 130] },
    { kind: 's', dir: 'L', grades: [3, 3, 2, 3], gap: [8, 16], angle: [50, 75] },
    { kind: 'straight', len: [80, 110], features: [{ kind: 'crest', at: 0.5, height: 1.5 }] },
    { kind: 'turn', dir: 'R', grade: 1, mods: ['blind'] },
    { kind: 'straight', len: [90, 120] },
    { kind: 's', dir: 'L', grades: [4, 3, 4], gap: [10, 18], angle: [45, 65] },
    { kind: 'straight', len: [240, 280], features: [{ kind: 'crest', at: 0.5, height: 1.8 }] },
    { kind: 'turn', dir: 'L', grade: 'hairpin', angle: [160, 166] },
    { kind: 'straight', len: [140, 170] },
    { kind: 'turn', dir: 'R', grade: 'hairpin', angle: [160, 166] },
    { zone: 'birch', kind: 'straight', len: [140, 170] },
    { kind: 's', dir: 'R', grades: [3, 2, 3], gap: [8, 14], angle: [50, 70] },
    { kind: 'straight', len: [110, 140], features: [{ kind: 'dip', at: 0.5, height: 1.3 }] },
    { kind: 'turn', dir: 'L', grade: 'square' },
    { zone: 'forest', kind: 'straight', len: [120, 150] },
    { kind: 'turn', dir: 'R', grade: 3, mods: ['tightens'] },
    { kind: 'straight', len: [80, 100] },
    { kind: 's', dir: 'L', grades: [4, 4, 3, 4], gap: [10, 16], angle: [40, 60] },
    { kind: 'straight', len: [150, 180], features: [{ kind: 'jump', at: 0.5, height: 1.2 }] },
    { kind: 'turn', dir: 'R', grade: 2, mods: ['dontcut'] },
    { kind: 'straight', len: [100, 130] },
    { zone: 'logging', kind: 'turn', dir: 'L', grade: 4 },
    { kind: 'straight', len: 320 },
  ],
};
