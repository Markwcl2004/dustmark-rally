import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages';
import { Codriver, type VoiceManifest } from '../src/audio/codriver';
import { Stage } from '../src/sim/stage/stage';

const voices = ['meijia', 'tingting'];
const manifest = (v: string) => JSON.parse(readFileSync(`public/assets/voice/${v}/manifest.json`, 'utf8')) as VoiceManifest;

describe('co-driver voice', () => {
  const stages = Object.values(STAGES).map((d) => new Stage(d));
  it('every word any stage\'s pace notes use has a clip, in every voice pack', () => {
    for (const v of voices) {
      const m = manifest(v);
      for (const st of stages) for (const n of st.notes) for (const w of n.words) expect(m.clips[w], `${v}: 「${w}」 (${st.def.id} ${n.text})`).toBeTruthy();
    }
  });
  it('clips are short and the sprite offsets are ordered', () => {
    const m = manifest('meijia');
    let prev = -1;
    for (const [w, c] of Object.entries(m.clips)) {
      expect(c.dur, w).toBeGreaterThan(0.08);
      expect(c.dur, w).toBeLessThan(1.2);
      expect(c.start).toBeGreaterThan(prev);
      prev = c.start;
    }
  });
  it('scheduler: one sentence at a time, never drops the corner itself, chained calls follow', () => {
    const st = stages[0], m = manifest('meijia');
    const cd = new Codriver(st.notes, m, { callEarly: 4 });
    // drive along at 30 m/s
    let lastEnd = -1;
    for (let t = 0, s = st.startS; s < st.finishS + 10; t += 1 / 60, s += 30 / 60) {
      for (const u of cd.update(t, s, 30)) {
        expect(u.start).toBeGreaterThanOrEqual(lastEnd);
        lastEnd = u.end;
        for (const n of u.notes) if (n.kind === 'turn') expect(u.words).toContain(n.words[0]);
      }
    }
    const rep = cd.report();
    expect(rep.length).toBeGreaterThan(5);
    expect(cd.skipped.length).toBe(0);
  });
});
