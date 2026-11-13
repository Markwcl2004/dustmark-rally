// npm run voice -- [--voice Tingting] [--rate 290] [--check]
// Builds the co-driver word sprite: every word the pace-note generator can produce (plus a few spares) is spoken by
// macOS `say`, trimmed, levelled, band-limited like a helmet intercom, lightly compressed, packed into one Ogg/Opus
// sprite + manifest.json under public/assets/voice/<voice>/. The output is committed, so the game never needs `say`.
//   --check  only list the vocabulary and whether the current manifest covers every stage's notes
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGES } from '../src/data/stages';
import { Stage } from '../src/sim/stage/stage';
import { GRADE_CN, MOD_CN } from '../src/sim/stage/script';
import { distWord } from '../src/sim/stage/pacenotes';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const VOICE = opt('voice', 'Tingting');
const RATE = +opt('rate', '290');
const SR = 48000;
const GAP = 0.03; // silence between words when played back to back (s)
const PAD = 0.12; // silence between clips inside the sprite (s)
const outDir = join('public/assets/voice', VOICE.toLowerCase());
const tmp = join('/tmp', `dustmark-voice-${process.pid}`);

/** every word the generator can emit (DESIGN §7), independent of the current stage scripts */
export function baseVocabulary(): string[] {
  const words = new Set<string>();
  for (const d of ['左', '右']) for (const g of ['1', '2', '3', '4', '5', '6']) words.add(d + GRADE_CN[g]);
  for (const d of ['左', '右']) { words.add(GRADE_CN.hairpin + d); words.add(GRADE_CN.square + d); }
  for (const m of Object.values(MOD_CN)) words.add(m);
  for (let d = 50; d <= 600; d += 50) { const w = distWord(d); if (w) words.add(w.w); }
  for (const w of ['接', '飞坡', '坡顶', '洼地', '连续起伏', '终点']) words.add(w);
  // spares for M3 content (fords, ice, narrows) so new caution notes don't need a rebuild right away
  for (const w of ['小心', '涉水', '冰面', '窄路', '桥', '跳跃']) words.add(w);
  return [...words];
}

function stageWords(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const def of Object.values(STAGES)) {
    const st = new Stage(def);
    for (const n of st.notes) for (const w of n.words) { if (!m.has(w)) m.set(w, []); m.get(w)!.push(def.id); }
  }
  return m;
}

const sw = stageWords();
const vocab = [...new Set([...baseVocabulary(), ...sw.keys()])];
if (args.includes('--check')) {
  const mf = existsSync(join(outDir, 'manifest.json')) ? JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) : { clips: {} };
  const missing = [...sw.keys()].filter((w) => !mf.clips[w]);
  console.log(`vocabulary ${vocab.length} words; stages use ${sw.size}; missing from ${outDir}: ${missing.length ? missing.join(' ') : 'none'}`);
  process.exit(missing.length ? 1 : 0);
}

mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });

function readWavF32(path: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 26 });
  return Float32Array.from(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4));
}

// 1) synthesize + trim + intercom band + compression (ffmpeg), 2) level in JS, 3) pack
const chain = [
  'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.005',
  'areverse', 'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.01', 'areverse',
  'highpass=f=320:poles=2', 'lowpass=f=3300:poles=2',
  'equalizer=f=1800:t=q:w=1.2:g=4',
  'acompressor=threshold=-22dB:ratio=5:attack=2:release=60:makeup=4',
  'asoftclip=type=tanh:threshold=0.9',
].join(',');

const clips: { word: string; pcm: Float32Array }[] = [];
vocab.forEach((word, i) => {
  const aiff = join(tmp, `${i}.aiff`), wav = join(tmp, `${i}.wav`);
  execFileSync('say', ['-v', VOICE, '-r', String(RATE), '-o', aiff, word]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-af', chain, '-ar', String(SR), '-ac', '1', wav]);
  const pcm = readWavF32(wav);
  // level: speech RMS → -17 dBFS, then a soft ceiling at -2 dBFS, 4 ms fades
  let ss = 0, cnt = 0;
  for (const x of pcm) if (Math.abs(x) > 0.01) { ss += x * x; cnt++; }
  const rms = Math.sqrt(ss / Math.max(1, cnt));
  const g = Math.pow(10, -17 / 20) / Math.max(1e-4, rms);
  const ceil = Math.pow(10, -2 / 20), fade = Math.round(0.004 * SR);
  for (let k = 0; k < pcm.length; k++) {
    let y = pcm[k] * g;
    y = ceil * Math.tanh(y / ceil);
    if (k < fade) y *= k / fade;
    if (k > pcm.length - fade) y *= (pcm.length - k) / fade;
    pcm[k] = y;
  }
  clips.push({ word, pcm });
});

const pad = Math.round(PAD * SR);
const total = clips.reduce((a, c) => a + c.pcm.length + pad, pad);
const sprite = new Float32Array(total);
const manifest = { voice: VOICE.toLowerCase(), file: 'words.ogg', sampleRate: SR, gap: GAP, rate: RATE, clips: {} as Record<string, { start: number; dur: number }> };
let at = pad;
for (const c of clips) {
  sprite.set(c.pcm, at);
  manifest.clips[c.word] = { start: +(at / SR).toFixed(5), dur: +(c.pcm.length / SR).toFixed(5) };
  at += c.pcm.length + pad;
}
const rawPath = join(tmp, 'sprite.f32');
writeFileSync(rawPath, Buffer.from(sprite.buffer));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', rawPath, '-c:a', 'libopus', '-b:a', '40k', '-application', 'voip', join(outDir, 'words.ogg')]);
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
// a reference sentence for listening / ASR checks
const sentence = ['左四', '收紧', '接', '右三', '别切', '一百', '飞坡'];
const sent: number[] = [];
for (const w of sentence) { const c = clips.find((x) => x.word === w)!; sent.push(...c.pcm, ...new Array(Math.round(GAP * SR)).fill(0)); }
writeFileSync(join(tmp, 'sentence.f32'), Buffer.from(Float32Array.from(sent).buffer));
mkdirSync('docs/audio', { recursive: true });
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', join(tmp, 'sentence.f32'), `docs/audio/voice-sentence-${manifest.voice}.wav`]);
rmSync(tmp, { recursive: true, force: true });
const durs = clips.map((c) => c.pcm.length / SR);
console.log(`${clips.length} words → ${outDir}/words.ogg (${(sprite.length / SR).toFixed(1)} s sprite) + manifest.json; ` +
  `word length ${Math.min(...durs).toFixed(2)}–${Math.max(...durs).toFixed(2)} s, mean ${(durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(2)} s; ` +
  `reference sentence ${(sent.length / SR).toFixed(2)} s → docs/audio/voice-sentence-${manifest.voice}.wav`);
