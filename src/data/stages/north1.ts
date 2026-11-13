// 北境林道 · 第一赛段「镜湖林场」— fast forest gravel: crests, two big jumps, a lakeside run, one hairpin, S-bends.
// Scenery zones (envs.ts NORDIC_ZONES): 村口 → 密林 → 伐木场 → 白桦林 → 湖岸 → 密林(发卡) → 高地荒原 → 白桦林 → 村口终点.
import type { StageDef } from '../../sim/stage/script';

export const NORTH_1: StageDef = {
  id: 'north-1',
  name: '镜湖林场',
  env: 'north',
  seed: 4127,
  halfWidth: 3.3,
  segments: [
    { zone: 'village', kind: 'straight', len: 230 },
    { kind: 'turn', dir: 'R', grade: 5 },
    { zone: 'forest', kind: 'straight', len: [110, 140], features: [{ kind: 'crest', at: 0.55, height: 2.0 }] },
    { kind: 'turn', dir: 'L', grade: 4 },
    // 高速段：连续坡顶
    { kind: 'straight', len: [330, 370], bend: 8, features: [{ kind: 'crest', at: 0.28, height: 2.2 }, { kind: 'crest', at: 0.72, height: 2.6 }] },
    { kind: 'turn', dir: 'R', grade: 6, mods: ['long'] },
    { kind: 'turn', dir: 'L', grade: 5, mods: ['crest'], features: [{ kind: 'crest', at: 0.5, height: 2.2, length: 60 }] },
    // 飞坡一
    { zone: 'logging', kind: 'straight', len: [230, 260], features: [{ kind: 'jump', at: 0.55, height: 1.5 }] },
    { kind: 'turn', dir: 'R', grade: 3, mods: ['tightens'] },
    { kind: 'straight', len: [50, 70] },
    { kind: 'turn', dir: 'L', grade: 4, mods: ['dontcut'] },
    { kind: 'straight', len: [90, 120] },
    // 连续 S 弯
    { zone: 'birch', kind: 's', dir: 'R', grades: [3, 3, 4, 4], gap: [6, 14], angle: [45, 70] },
    { kind: 'straight', len: [140, 170], features: [{ kind: 'crest', at: 0.5, height: 2.2 }] },
    { kind: 'turn', dir: 'L', grade: 5 },
    // 湖边一段
    { zone: 'lake', kind: 'straight', len: [160, 190], lake: 'R' },
    { kind: 'turn', dir: 'R', grade: 6, lake: 'R' },
    { kind: 'straight', len: [140, 170], lake: 'R', features: [{ kind: 'rollers', at: 0.5, height: 0.7, length: 26, count: 3 }] },
    { kind: 'turn', dir: 'L', grade: 4 },
    { zone: 'forest', kind: 'straight', len: [70, 90] },
    // 发卡
    { kind: 'turn', dir: 'L', grade: 'hairpin' },
    { kind: 'straight', len: [60, 80] },
    { kind: 'turn', dir: 'R', grade: 4, mods: ['opens'] },
    { kind: 'straight', len: [120, 150] },
    { kind: 'turn', dir: 'R', grade: 4 },
    { kind: 'turn', dir: 'L', grade: 4, mods: ['cut'] },
    // 飞坡二（大）
    { zone: 'moor', kind: 'straight', len: [260, 290], features: [{ kind: 'jump', at: 0.5, height: 1.9, length: 24 }] },
    { kind: 'turn', dir: 'R', grade: 5 },
    { kind: 'straight', len: [200, 230], features: [{ kind: 'crest', at: 0.25, height: 2.0 }, { kind: 'crest', at: 0.6, height: 2.4 }, { kind: 'dip', at: 0.88, height: 1.6 }] },
    { zone: 'birch', kind: 'turn', dir: 'L', grade: 3 },
    { kind: 'straight', len: [60, 80] },
    { kind: 'turn', dir: 'R', grade: 2, mods: ['blind'] },
    { kind: 'straight', len: [110, 130] },
    { zone: 'village', kind: 'turn', dir: 'L', grade: 5 },
    { kind: 'straight', len: 330 },
  ],
};
