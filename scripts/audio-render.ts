// npm run audio -- engine | codriver | fx [--secs 90] [--car kestrel|all]
// Offline audio renders (no speakers involved): runs the real sim in Node and feeds the same DSP the AudioWorklet runs.
//   engine    standing start → up to 4th → lift 2.5 s → back on full → docs/audio/engine-<car>.wav + spectrogram + loudness
//             (--car all: every car, then a loudness / peak table)
//   fx        one-shots on the test pad: wall crunch + glass, a ford splash, then pulling hard
//             → docs/audio/fx-impacts.wav
//   codriver  analog robot on north-1 (whole stage), co-driver calls mixed with engine/road → docs/audio/codriver-run.wav (first --wavsecs 80 s)
//             + docs/audio/codriver-timeline.txt (each call: start/end vs. the corner, overlaps, drops)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CARS } from '../src/data/cars';
import { CAR_SOUNDS } from '../src/data/carSounds';
import { STAGES } from '../src/data/stages';
import { Surface } from '../src/data/surfaces';
import { SoundDSP } from '../src/audio/dsp/mix';
import { defaultEngineState } from '../src/audio/dsp/engine';
import { engineState, newRoadState, roadState } from '../src/audio/telemetry';
import { Codriver, type VoiceManifest } from '../src/audio/codriver';
import { TestGround } from '../src/sim/ground';
import { Car, DT } from '../src/sim/vehicle/car';
import { emptyInput } from '../src/sim/vehicle/controls';
import { Bot } from '../src/sim/driver/bot';
import { World } from '../src/sim/world';

const SR = 48000;
const TICK = Math.round(SR * DT); // 400 samples per sim tick
const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const mode = args.find((a) => !a.startsWith('--')) ?? 'engine';
const carId = opt('car', 'kestrel');
const OUT = 'docs/audio';
mkdirSync(OUT, { recursive: true });

function writeWav(path: string, pcm: Float32Array, sr = SR) {
  const n = pcm.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    let v = pcm[i];
    if (v > 1 || v < -1) { clipped++; v = Math.max(-1, Math.min(1, v)); }
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
  return clipped;
}

function analyse(wav: string, title: string): { lufs: number; tp: number } {
  const png = wav.replace(/\.wav$/, '-spectrum.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-lavfi', `showspectrumpic=s=1600x700:legend=1:scale=log:fscale=log:stop=8000:color=intensity`, png]);
  const vd = execFileSync('ffmpeg', ['-hide_banner', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  let stderr = '';
  try { execFileSync('ffmpeg', ['-hide_banner', '-i', wav, '-af', 'volumedetect,loudnorm=print_format=summary', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? ''); }
  const out = execFileSync('sh', ['-c', `ffmpeg -hide_banner -i '${wav}' -af volumedetect,loudnorm=print_format=summary -f null - 2>&1 | grep -E 'mean_volume|max_volume|Input Integrated|Input True Peak|Input LRA'`], { encoding: 'utf8' });
  void vd; void stderr;
  console.log(`${title}: ${wav}\n  spectrogram ${png}\n${out.split('\n').filter(Boolean).map((l) => '  ' + l.replace(/^\[.*?\]\s*/, '').trim()).join('\n')}`);
  const num = (re: RegExp) => { const m = out.match(re); return m ? Number(m[1]) : NaN; };
  return { lufs: num(/Input Integrated:\s*(-?[\d.]+)/), tp: num(/Input True Peak:\s*(-?[\d.]+)/) };
}

function engineRun(carId: string) {
  const spec = CARS[carId];
  const dsp = new SoundDSP(CAR_SOUNDS[carId], SR, TICK);
  const g = new TestGround(Surface.Gravel);
  const car = new Car(spec);
  car.reset(g, 0, 0, 0, -1);
  const es = defaultEngineState(), rs = newRoadState();
  const total = 15;
  const pcm = new Float32Array(Math.round(total * SR));
  const buf = new Float32Array(TICK);
  let t = 0, phase = 'idle', liftAt = -1, log: string[] = [];
  const inp = emptyInput();
  for (let k = 0; k * TICK < pcm.length - TICK; k++) {
    // script: 1 s idle, full throttle until 4th gear at 6800 rpm, lift 2.5 s, full again 3 s, then lift to the end
    if (phase === 'idle' && t > 1.0) { phase = 'launch'; log.push(`${t.toFixed(2)} s launch`); }
    if (phase === 'launch' && car.gear === 4 && car.rpm > spec.engine.redline - 400) { phase = 'lift'; liftAt = t; log.push(`${t.toFixed(2)} s lift in 4th at ${car.rpm.toFixed(0)} rpm, ${(car.speed * 3.6).toFixed(0)} km/h`); }
    if (phase === 'lift' && t - liftAt > 2.5) { phase = 'again'; liftAt = t; log.push(`${t.toFixed(2)} s back on throttle at ${car.rpm.toFixed(0)} rpm, gear ${car.gear}`); }
    if (phase === 'again' && t - liftAt > 3.0) { phase = 'coast'; log.push(`${t.toFixed(2)} s lift (coast) at ${car.rpm.toFixed(0)} rpm, gear ${car.gear}, ${(car.speed * 3.6).toFixed(0)} km/h`); }
    inp.throttle = phase === 'launch' || phase === 'again' ? 1 : 0;
    inp.digital = true;
    const prevGear = car.gear;
    car.step(inp, g);
    if (car.gear !== prevGear) log.push(`${t.toFixed(2)} s gear ${prevGear}→${car.gear} at ${(car.speed * 3.6).toFixed(0)} km/h`);
    t += DT;
    dsp.setEngine(engineState(car, es));
    dsp.setRoad(roadState(car, rs));
    dsp.render(buf, TICK);
    pcm.set(buf, k * TICK);
  }
  // coda: manual gearbox, 2nd gear held flat out against the rev limiter for 2.5 s
  const c2 = new Car(spec);
  c2.reset(g, 0, 0, 0, -1);
  c2.transmission = 'manual';
  const v0 = 45 / 3.6;
  c2.vel.set(0, 0, -v0); for (const w of c2.wheels) w.omega = v0 / spec.wheel.radius;
  c2.gear = 2; c2.pendingGear = 2;
  const coda = new Float32Array(Math.round(3.0 * SR));
  let limTicks = 0;
  for (let k = 0; k * TICK < coda.length - TICK; k++) {
    c2.step({ ...inp, throttle: k * DT < 2.5 ? 1 : 0, digital: true }, g);
    if (c2.limiterCut) limTicks++;
    dsp.setEngine(engineState(c2, es)); dsp.setRoad(roadState(c2, rs)); dsp.render(buf, TICK);
    coda.set(buf, k * TICK);
  }
  log.push(`coda: 2nd gear on the limiter for ${(limTicks * DT).toFixed(2)} s (from ${(total).toFixed(1)} s in the file)`);
  const all = new Float32Array(pcm.length + coda.length);
  all.set(pcm); all.set(coda, pcm.length);
  const wav = `${OUT}/engine-${carId}.wav`;
  const clipped = writeWav(wav, all);
  console.log(log.join('\n'));
  console.log(`pops ${dsp.engine.pops}, clipped samples ${clipped}`);
  return { ...analyse(wav, `engine run ${carId}`), clipped };
}

/** impact / splash one-shots on the test pad (no physics needed beyond telemetry) */
function fxRun() {
  const spec = CARS[carId];
  const dsp = new SoundDSP(CAR_SOUNDS[carId], SR, TICK);
  const g = new TestGround(Surface.Gravel);
  const car = new Car(spec);
  car.reset(g, 0, 0, 0, -1);
  const es = defaultEngineState(), rs = newRoadState();
  const buf = new Float32Array(TICK);
  const total = 16;
  const pcm = new Float32Array(Math.round(total * SR));
  const log: string[] = [];
  for (let k = 0; k * TICK < pcm.length - TICK; k++) {
    const t = k * DT;
    // 0–4 s accelerate; 4.0 s a heavy wall hit; 5–9 s cruise at ~50 km/h; 9.5 s a ford splash; 10–16 s pulling hard
    if (Math.abs(t - 4.0) < DT / 2) { dsp.road.impact('hit', 13); log.push('4.00 s heavy impact 13 m/s (crunch + glass)'); }
    if (Math.abs(t - 9.5) < DT / 2) { dsp.road.splash(1.2); log.push('9.50 s splash 1.2'); }
    const thr = t < 4 ? 1 : t < 9 ? (car.speed < 14 ? 0.6 : 0.2) : t < 10 ? 0 : 1;
    car.step({ ...emptyInput(), throttle: thr, digital: true }, g);
    dsp.setEngine(engineState(car, es)); dsp.setRoad(roadState(car, rs));
    dsp.render(buf, TICK);
    pcm.set(buf, k * TICK);
  }
  const wav = `${OUT}/fx-impacts.wav`;
  const clipped = writeWav(wav, pcm);
  console.log(log.join('\n'));
  console.log(`clipped samples ${clipped}`);
  analyse(wav, 'impact fx');
}

function loadVoice(voice: string): { manifest: VoiceManifest; pcm: Float32Array } {
  const dir = `public/assets/voice/${voice}`;
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')) as VoiceManifest;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', `${dir}/${manifest.file}`, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  return { manifest, pcm: Float32Array.from(pcm) };
}

function codriverRun() {
  const secs = +opt('secs', '100');
  const voice = opt('voice', 'meijia');
  const callEarly = +opt('callearly', '4');
  const { manifest, pcm: vpcm } = loadVoice(voice);
  const w = new World(STAGES[opt('stage', 'north-1')], CARS[carId]);
  w.car.assists.counterSteer = false;
  const bot = new Bot(w.stage, w.car, { skill: 0.9 });
  const dsp = new SoundDSP(CAR_SOUNDS[carId], SR, TICK);
  const cd = new Codriver(w.stage.notes, manifest, { callEarly });
  const es = defaultEngineState(), rs = newRoadState();
  const pcm = new Float32Array(Math.round(secs * SR));
  const vbus = new Float32Array(pcm.length);
  const buf = new Float32Array(TICK);
  const lines: string[] = [];
  let k = 0;
  const VOICE_GAIN = 0.9;
  while (k * TICK < pcm.length - TICK && w.session.phase !== 'finished') {
    w.step(bot.drive(w));
    const now = k * DT;
    const st = w.session;
    const events = cd.update(now, st.progressS, Math.max(0, w.car.fwdSpeed), st.phase === 'running' || st.phase === 'countdown');
    for (const u of events) {
      // place each word clip into the voice bus
      let at = Math.round(u.start * SR);
      for (const word of u.words) {
        const c = manifest.clips[word];
        const from = Math.round(c.start * SR), len = Math.round(c.dur * SR);
        for (let i = 0; i < len && at + i < vbus.length; i++) vbus[at + i] += vpcm[from + i] * VOICE_GAIN;
        at += len + Math.round(manifest.gap * SR);
      }
    }
    dsp.ducking = cd.speaking(now) ? 1 : 0;
    dsp.setEngine(engineState(w.car, es));
    dsp.setRoad(roadState(w.car, rs));
    if (w.car.events.landed > 0) dsp.road.impact('land', w.car.events.landed);
    if (w.car.events.bottomOut > 1) dsp.road.impact('bottom', w.car.events.bottomOut);
    if (w.car.events.obstacleHit > 0.5) dsp.road.impact('hit', w.car.events.obstacleHit);
    dsp.render(buf, TICK);
    pcm.set(buf, k * TICK);
    k++;
  }
  const n = k * TICK;
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) mix[i] = pcm[i] + vbus[i];
  // timeline report
  const rep = cd.report();
  let overlaps = 0, late = 0;
  for (let i = 0; i < rep.length; i++) {
    const r = rep[i];
    if (i > 0 && r.start < rep[i - 1].end - 1e-6) overlaps++;
    if (r.lateBy > 0) late++;
    lines.push(`${r.start.toFixed(2).padStart(7)}–${r.end.toFixed(2).padStart(7)} s  「${r.words.join(' ')}」${r.dropped.length ? `  (省略: ${r.dropped.join(' ')})` : ''}  ` +
      `→ 第一处在 ${r.reachAt < 0 ? '—' : r.reachAt.toFixed(2) + ' s'}，说完余量 ${r.margin === null ? '—' : r.margin.toFixed(2) + ' s'}${r.lateBy > 0 ? '  晚了 ' + r.lateBy.toFixed(2) + ' s' : ''}`);
  }
  const skipped = cd.skipped.map((s) => s.text);
  const head = [`co-driver timeline: ${STAGES[opt('stage', 'north-1')].id}, analog robot skill 0.9, callearly ${callEarly} s, voice ${voice}, ${(n / SR).toFixed(1)} s rendered`,
    `utterances ${rep.length}, overlaps ${overlaps}, finished after the reference point ${late}, skipped notes ${skipped.length}${skipped.length ? ' (' + skipped.join(' / ') + ')' : ''}`,
    `min margin ${Math.min(...rep.filter((r) => r.margin !== null).map((r) => r.margin as number)).toFixed(2)} s; words dropped in ${rep.filter((r) => r.dropped.length).length} utterances`, ''];
  writeFileSync(`${OUT}/codriver-timeline.txt`, head.concat(lines).join('\n') + '\n');
  console.log(head.join('\n'));
  const wav = `${OUT}/codriver-run.wav`;
  const wavSecs = +opt('wavsecs', '80');
  const clipped = writeWav(wav, mix.subarray(0, Math.min(mix.length, Math.round(wavSecs * SR))));
  console.log(`clipped samples ${clipped}`);
  analyse(wav, 'co-driver run');
}

if (mode === 'engine') {
  const ids = carId === 'all' ? Object.keys(CAR_SOUNDS) : [carId];
  const rows = ids.map((id) => ({ id, ...engineRun(id) }));
  if (rows.length > 1) {
    const mean = rows.reduce((a, r) => a + r.lufs, 0) / rows.length;
    console.log('\ncar        LUFS    Δ mean   true peak  clipped');
    for (const r of rows) console.log(`${r.id.padEnd(9)} ${r.lufs.toFixed(1).padStart(6)}  ${(r.lufs - mean >= 0 ? '+' : '') + (r.lufs - mean).toFixed(1)}    ${r.tp.toFixed(1).padStart(6)}     ${r.clipped}`);
  }
}
else if (mode === 'codriver') codriverRun();
else if (mode === 'fx') fxRun();
else { console.error('mode: engine | codriver | fx'); process.exit(2); }
