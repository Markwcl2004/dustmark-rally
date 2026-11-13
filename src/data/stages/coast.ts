// 山海公路 · three stages. Asphalt with painted lines and gravel verges, a cliff and the sea on one side, guard rails
// and dry-stone walls, hairpin after hairpin. Zones (envs.ts COAST_ZONES): cliff 崖路, olive 橄榄坡, village 渔村,
// cypress 柏树林, gravel 砂石近路, seacliff 临崖 (sea cliff right outside the guard rail; only on stretches that are the most
// seaward part of the road, otherwise the shoreline is pushed out past the other road).
import type { StageDef } from '../../sim/stage/script';

/** 望海崖 — up the cliff: a ladder of hairpins with the sea below the guard rail */
export const COAST_1: StageDef = {
  id: 'coast-1', name: '望海崖', env: 'coast', seed: 9127, halfWidth: 3.5, sea: 'R',
  segments: [
    { zone: 'village', kind: 'straight', len: 220 },
    { kind: 'turn', dir: 'L', grade: 4 },
    { zone: 'seacliff', kind: 'straight', len: [260, 300], bend: -6 },
    { zone: 'cliff', kind: 'turn', dir: 'R', grade: 3 },
    { kind: 'straight', len: [140, 170] },
    { kind: 'turn', dir: 'L', grade: 'hairpin', angle: [160, 166] },
    { kind: 'straight', len: [150, 180] },
    { kind: 'turn', dir: 'R', grade: 'hairpin', angle: [160, 166] },
    { kind: 'straight', len: [170, 200] },
    { kind: 'turn', dir: 'L', grade: 'hairpin', angle: [158, 164] },
    { kind: 'straight', len: [180, 210], features: [{ kind: 'crest', at: 0.6, height: 1.2 }] },
    { kind: 'turn', dir: 'R', grade: 4, mods: ['long'] },
    { zone: 'seacliff', kind: 'straight', len: [200, 230] },
    { zone: 'olive', kind: 's', dir: 'L', grades: [3, 3, 4], gap: [14, 22], angle: [45, 65] },
    { kind: 'straight', len: [180, 220] },
    { zone: 'cliff', kind: 'turn', dir: 'R', grade: 2, mods: ['tightens'] },
    { kind: 'straight', len: [200, 240], bend: 8 },
    { kind: 'turn', dir: 'L', grade: 'square' },
    { kind: 'straight', len: [130, 160] },
    { kind: 'turn', dir: 'R', grade: 5 },
    { zone: 'seacliff', kind: 'straight', len: [260, 300], features: [{ kind: 'crest', at: 0.5, height: 1.4 }] },
    { zone: 'village', kind: 'turn', dir: 'L', grade: 5 },
    { kind: 'straight', len: 320 },
  ],
};

/** 白屋渔村 — through a fishing village between white walls, out along the cliff, back through olive terraces */
export const COAST_2: StageDef = {
  id: 'coast-2', name: '白屋渔村', env: 'coast', seed: 9241, halfWidth: 3.3, sea: 'L',
  segments: [
    { zone: 'village', kind: 'straight', len: 230 },
    { kind: 'turn', dir: 'R', grade: 'square' },
    { kind: 'straight', len: [110, 130] },
    { kind: 'turn', dir: 'L', grade: 3, mods: ['blind'] },
    { kind: 'straight', len: [90, 120] },
    { kind: 'turn', dir: 'R', grade: 2 },
    { kind: 'straight', len: [150, 180] },
    { zone: 'cliff', kind: 'turn', dir: 'L', grade: 4 },
    { kind: 'straight', len: [280, 320], bend: 7, features: [{ kind: 'crest', at: 0.4, height: 1.3 }] },
    { kind: 's', dir: 'R', grades: [3, 4, 3, 4], gap: [14, 24], angle: [40, 60] },
    { kind: 'straight', len: [200, 230] },
    { kind: 'turn', dir: 'L', grade: 'hairpin', angle: [160, 166] },
    { kind: 'straight', len: [180, 210] },
    { kind: 'turn', dir: 'R', grade: 'hairpin', angle: [160, 166] },
    { zone: 'seacliff', kind: 'straight', len: [220, 260] },
    { zone: 'olive', kind: 'turn', dir: 'L', grade: 3, mods: ['tightens'] },
    { kind: 'straight', len: [180, 210], features: [{ kind: 'dip', at: 0.5, height: 1.2 }] },
    { kind: 'turn', dir: 'R', grade: 4 },
    { zone: 'seacliff', kind: 'straight', len: [240, 280] },
    { zone: 'cypress', kind: 's', dir: 'L', grades: [4, 3], gap: [14, 20], angle: [40, 55] },
    { kind: 'straight', len: [200, 240] },
    { zone: 'village', kind: 'turn', dir: 'R', grade: 4 },
    { kind: 'straight', len: [120, 150] },
    { kind: 'turn', dir: 'L', grade: 'square' },
    { kind: 'straight', len: 320 },
  ],
};

/** 柏树长坡 — fast and downhill through cypress and umbrella pines, with a gravel short-cut across the hill */
export const COAST_3: StageDef = {
  id: 'coast-3', name: '柏树长坡', env: 'coast', seed: 9353, halfWidth: 3.6, sea: 'R',
  segments: [
    { zone: 'cypress', kind: 'straight', len: 240 },
    { kind: 'turn', dir: 'R', grade: 5 },
    { kind: 'straight', len: [420, 470], bend: -7, features: [{ kind: 'crest', at: 0.5, height: 1.5 }] },
    { kind: 'turn', dir: 'L', grade: 4, mods: ['long'] },
    { kind: 'straight', len: [300, 340] },
    { kind: 'turn', dir: 'R', grade: 3, mods: ['tightens'] },
    { zone: 'cliff', kind: 'straight', len: [330, 370], bend: 8 },
    { kind: 'turn', dir: 'L', grade: 'hairpin', angle: [160, 166] },
    { kind: 'straight', len: [220, 250] },
    { kind: 'turn', dir: 'R', grade: 2 },
    { zone: 'gravel', kind: 'straight', len: [220, 260], features: [{ kind: 'jump', at: 0.55, height: 1.2 }] },
    { kind: 's', dir: 'L', grades: [3, 4, 3], gap: [12, 20], angle: [45, 65] },
    { kind: 'straight', len: [180, 210] },
    { zone: 'olive', kind: 'turn', dir: 'R', grade: 4 },
    { zone: 'seacliff', kind: 'straight', len: [380, 420], features: [{ kind: 'crest', at: 0.4, height: 1.5 }, { kind: 'rollers', at: 0.8, height: 0.5, length: 22, count: 3 }] },
    { zone: 'olive', kind: 'turn', dir: 'L', grade: 1 },
    { kind: 'straight', len: [150, 180] },
    { zone: 'cypress', kind: 'turn', dir: 'R', grade: 5, mods: ['long'] },
    { zone: 'seacliff', kind: 'straight', len: [400, 440], features: [{ kind: 'crest', at: 0.5, height: 1.4 }] },
    { zone: 'cypress', kind: 'turn', dir: 'L', grade: 3 },
    { zone: 'village', kind: 'straight', len: [180, 210] },
    { kind: 'turn', dir: 'R', grade: 'square' },
    { kind: 'straight', len: 320 },
  ],
};
