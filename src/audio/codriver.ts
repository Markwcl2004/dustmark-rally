// Co-driver call scheduling (pure logic; the browser plays the result, offline renders mix it in Node).
// - a note is called when the car is ~callEarly seconds of road away from it (by current speed)
// - notes chained with 接 are read as one sentence
// - one sentence at a time, never overlapping; if there isn't time to say everything before the corner, minor
//   words go first (distance → 可切/长/放开/盲弯 → 过坡/别切/收紧), never the direction + grade
// - a note the car has already reached without being called is skipped
import type { PaceNote } from '../sim/stage/pacenotes';

export interface VoiceClip { start: number; dur: number }
export interface VoiceManifest {
  voice: string;
  /** sprite file next to the manifest */
  file: string;
  sampleRate: number;
  /** silence between words (s) */
  gap: number;
  clips: Record<string, VoiceClip>;
}

export interface Utterance {
  notes: PaceNote[];
  /** first note index */
  first: number;
  words: string[];
  dropped: string[];
  /** schedule (codriver clock, s) */
  start: number;
  end: number;
  /** when the car reached the first called item (filled later; -1 = not yet) */
  reachAt: number;
  margin: number | null;
  lateBy: number;
}

export interface CodriverOpts {
  /** seconds of road ahead at the current speed (default 4) */
  callEarly?: number;
  /** pause between sentences (s) */
  pause?: number;
  /** speed floor for timing (m/s) so a slow car still gets its call a sensible distance out */
  minSpeed?: number;
}

/** drop order for minor words (first = dropped first). Anything not listed (heads, 接, 飞坡 …) is never dropped. */
const DROP_ORDER = ['一百', '一百五', '两百', '两百五', '三百', '三百五', '四百', '五百', '五十', '可切', '长', '放开', '盲弯', '过坡', '别切', '收紧'];

export class Codriver {
  private next = 0;
  private busyUntil = -1;
  private utterances: Utterance[] = [];
  readonly skipped: PaceNote[] = [];
  private pendingReach: Utterance[] = [];
  private lastCalled = -1;
  readonly callEarly: number;
  private pause: number;
  private minSpeed: number;

  constructor(readonly notes: PaceNote[], readonly manifest: VoiceManifest, opts: CodriverOpts = {}) {
    this.callEarly = opts.callEarly ?? 4;
    this.pause = opts.pause ?? 0.18;
    this.minSpeed = opts.minSpeed ?? 12;
  }

  reset() { this.next = 0; this.busyUntil = -1; this.utterances = []; this.pendingReach = []; this.skipped.length = 0; this.lastCalled = -1; }

  /** jump (teleport / reset to road): forget calls behind s */
  seek(s: number) {
    this.next = 0;
    while (this.next < this.notes.length && this.notes[this.next].s < s + 5) this.next++;
  }

  private clipDur(w: string) { return this.manifest.clips[w]?.dur ?? 0; }
  private dur(words: string[]) { let d = 0; for (const w of words) d += this.clipDur(w) + this.manifest.gap; return Math.max(0, d - this.manifest.gap); }

  /** is a sentence playing at codriver time `now`? */
  speaking(now: number) { return now < this.busyUntil; }

  /** index of the note the HUD should highlight: the one being read, else the next one to be read */
  highlight(now: number) {
    for (let i = this.utterances.length - 1; i >= 0; i--) {
      const u = this.utterances[i];
      if (now >= u.start && now < u.end + 0.4) return u.first;
      if (u.end < now) break;
    }
    return this.next;
  }

  /** index of the first note not yet called */
  get nextIndex() { return this.next; }

  /**
   * advance the co-driver. now: clock (s); s: car progress along the road (m); v: forward speed (m/s).
   * returns sentences that start now (schedule their words from u.start).
   */
  update(now: number, s: number, v: number, active = true): Utterance[] {
    // record when the car reaches called items (for self-checks)
    for (let i = this.pendingReach.length - 1; i >= 0; i--) {
      const u = this.pendingReach[i];
      if (s >= u.notes[0].s) {
        u.reachAt = now; u.margin = now - u.end; u.lateBy = Math.max(0, u.end - now);
        this.pendingReach.splice(i, 1);
      }
    }
    const out: Utterance[] = [];
    if (!active) return out;
    // skip notes the car has already reached
    while (this.next < this.notes.length && this.notes[this.next].s < s + 2) this.skipped.push(this.notes[this.next++]);
    if (this.next >= this.notes.length || now < this.busyUntil + this.pause) return out;
    const vv = Math.max(v, this.minSpeed);
    const first = this.notes[this.next];
    const tReach = (first.s - s) / vv;
    // a note that follows a "接" is due as soon as the previous sentence is done
    const chained = this.next > 0 && this.notes[this.next - 1].into && this.lastCalled === this.next - 1;
    if (tReach > this.callEarly && !chained) return out;
    // gather the 接 chain (up to 3 notes)
    const group: PaceNote[] = [first];
    let j = this.next;
    while (this.notes[j].into && j + 1 < this.notes.length && group.length < 3) group.push(this.notes[++j]);
    const words = group.flatMap((n) => n.words).filter((w) => this.manifest.clips[w]);
    const dropped: string[] = [];
    // fit before the first item (leave 0.25 s)
    const avail = tReach - 0.25;
    for (const minor of DROP_ORDER) {
      if (this.dur(words) <= avail) break;
      for (let k = words.length - 1; k >= 0; k--) if (words[k] === minor) { dropped.push(minor); words.splice(k, 1); }
    }
    const start = now, end = now + this.dur(words);
    const u: Utterance = { notes: group, first: this.next, words, dropped, start, end, reachAt: -1, margin: null, lateBy: 0 };
    this.utterances.push(u);
    this.pendingReach.push(u);
    this.busyUntil = end;
    this.next = j + 1;
    this.lastCalled = j;
    out.push(u);
    return out;
  }

  report() { return this.utterances; }
}
