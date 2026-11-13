// Pace notes generated straight from the script pieces (not reverse-engineered from geometry).
import type { Piece } from './centerline';
import { GRADE_CN, MOD_CN, type Dir, type Grade, type TurnMod } from './script';

export type NoteKind = 'turn' | 'jump' | 'crest' | 'finish' | 'caution';

export interface PaceNote {
  /** position of the thing being called (corner entry / jump lip) */
  s: number;
  kind: NoteKind;
  text: string;
  dir?: Dir;
  grade?: Grade;
  mods: TurnMod[];
  /** distance call to the next note ("一百") */
  dist?: number;
  /** "接": next note follows immediately */
  into?: boolean;
  /** voice clip ids for M2 (word list) */
  words: string[];
}

const CN_DIST: Record<number, string> = { 50: '五十', 100: '一百', 150: '一百五', 200: '两百', 250: '两百五', 300: '三百', 350: '三百五', 400: '四百', 500: '五百' };

export function distWord(d: number) {
  const r = Math.min(500, Math.round(d / 50) * 50);
  return CN_DIST[r] ? { r, w: CN_DIST[r] } : r === 450 ? { r: 400, w: CN_DIST[400] } : null;
}

export function buildPacenotes(pieces: Piece[], finishS: number, extra: PaceNote[] = []): PaceNote[] {
  const notes: PaceNote[] = [...extra];
  for (const p of pieces) {
    if (p.kind === 'turn') {
      const dirW = p.dir === 'L' ? '左' : '右';
      const g = p.grade!;
      const gradeW = GRADE_CN[String(g)];
      const head = g === 'hairpin' || g === 'square' ? `${gradeW}${dirW}` : `${dirW}${gradeW}`;
      const mods = (p.mods ?? []).filter((m) => m !== 'crest' || true);
      notes.push({ s: p.s0, kind: 'turn', text: head, dir: p.dir, grade: g, mods, words: [head, ...mods.map((m) => MOD_CN[m])] });
    }
    for (const f of p.features) {
      if (f.kind === 'jump') notes.push({ s: f.s - 6, kind: 'jump', text: '飞坡', mods: [], words: ['飞坡'] });
      else if (f.kind === 'crest') notes.push({ s: f.s - 8, kind: 'crest', text: '坡顶', mods: [], words: ['坡顶'] });
      else if (f.kind === 'dip') notes.push({ s: f.s - f.length / 2, kind: 'caution', text: '洼地', mods: [], words: ['洼地'] });
      else if (f.kind === 'ford') notes.push(f.water ? { s: f.s - f.length / 2, kind: 'caution', text: '小心 涉水', mods: [], words: ['小心', '涉水'] } : { s: f.s - f.length / 2, kind: 'caution', text: '洼地', mods: [], words: ['洼地'] });
      else if (f.kind === 'rollers') notes.push({ s: f.s - (f.length * f.count) / 2, kind: 'caution', text: '连续起伏', mods: [], words: ['连续起伏'] });
    }
  }
  notes.push({ s: finishS, kind: 'finish', text: '终点', mods: [], words: ['终点'] });
  notes.sort((a, b) => a.s - b.s);
  // distance calls and links
  for (let i = 0; i < notes.length - 1; i++) {
    const n = notes[i], next = notes[i + 1];
    // distance from the end of this item to the next one
    const endS = n.kind === 'turn' ? (pieces.find((p) => p.kind === 'turn' && p.s0 === n.s)?.s1 ?? n.s) : n.s;
    const gap = next.s - endS;
    if (gap < 30) { n.into = true; n.words.push('接'); }
    else if (gap >= 70) {
      const dw = distWord(gap);
      if (dw) { n.dist = dw.r; n.words.push(dw.w); }
    }
  }
  for (const n of notes) {
    const modTxt = n.mods.map((m) => MOD_CN[m]).join(' ');
    n.text = [n.text, modTxt, n.into ? '接' : n.dist ? CN_DIST[n.dist] : ''].filter(Boolean).join(' ');
  }
  return notes;
}
