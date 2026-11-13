// npm run audio:check — headless Chrome (muted): the AudioWorklet DSP renders in an OfflineAudioContext and matches the
// Node render of the same state; the live game graph comes up after a key press and produces signal (analyser).
import { chromium } from 'playwright';
import { CAR_SOUNDS } from '../src/data/carSounds';
import { SoundDSP } from '../src/audio/dsp/mix';
import { BASE, CHROME_ARGS, ensureServer } from './server';

const state = { rpm: 5200, load: 0.9, throttle: 1, boost: 0.8, shiftCut: false, limiter: false, speed: 30, redline: 7200 };
const road = { speed: 30, surfMix: [0, 0, 1, 0, 0, 0, 0, 0, 0], slide: 2, loose: 1, grounded: 4 };
// Node reference
const dsp = new SoundDSP(CAR_SOUNDS.kestrel, 48000, 128);
dsp.setEngine(state); dsp.setRoad({ ...road, surfMix: Float32Array.from(road.surfMix) });
const buf = new Float32Array(128);
let ss = 0, n = 0;
for (let i = 0; i < (48000 * 2) / 128; i++) { dsp.render(buf, 128); if (i > 100) for (const x of buf) { ss += x * x; n++; } }
const nodeRms = 20 * Math.log10(Math.sqrt(ss / n));

const stop = await ensureServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...CHROME_ARGS, '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?bot=1&t=5`);
  await page.waitForFunction(() => (window as any).__ready, null, { timeout: 90_000 });
  const offline = await page.evaluate(async ([st, rd, sound]) => {
    const url = (await import('/src/audio/worklet.ts?worker&url' as string)).default;
    const ctx = new OfflineAudioContext(2, 48000 * 2, 48000);
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'dustmark-sound', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { sound } });
    node.port.postMessage({ t: 'state', engine: st, road: rd, duck: 0 });
    await new Promise((r) => setTimeout(r, 100)); // let the message reach the audio thread before rendering
    node.connect(ctx.destination);
    const out = await ctx.startRendering();
    const d = out.getChannelData(0);
    let s = 0, c = 0;
    for (let i = 12800; i < d.length; i++) { s += d[i] * d[i]; c++; }
    return 20 * Math.log10(Math.sqrt(s / c));
  }, [state, road, CAR_SOUNDS.kestrel] as const);
  // live graph: press a key (gesture) and tap the master with an analyser
  await page.keyboard.press('KeyX');
  await page.waitForFunction(() => (window as any).__game?.audio?.running, null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const live = await page.evaluate(async () => {
    const a = (window as any).__game.audio;
    const an = new AnalyserNode(a.ctx, { fftSize: 4096 });
    a.master.connect(an);
    await new Promise((r) => setTimeout(r, 400));
    const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d);
    let s = 0; for (const x of d) s += x * x;
    return { rms: 20 * Math.log10(Math.sqrt(s / d.length) + 1e-9), voice: !!a.voiceBuf, words: a.manifest ? Object.keys(a.manifest.clips).length : 0, state: a.ctx.state, sr: a.ctx.sampleRate, base: a.ctx.baseLatency };
  });
  console.log(`Node DSP ${nodeRms.toFixed(1)} dBFS vs browser worklet (OfflineAudioContext) ${offline.toFixed(1)} dBFS`);
  console.log(`live game graph: ${JSON.stringify(live)}`);
  if (errors.length) console.log('page errors:', errors.slice(0, 6));
  const ok = Math.abs(nodeRms - offline) < 1.5 && live.rms > -60 && live.voice;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally { await browser.close(); stop(); }
