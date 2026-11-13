// Trajectory-prediction switch (P) end-to-end check, headless: one source of truth (save.settings.predict) across
// countdown / driving / pause / settings over the game / restart / next career stage / reload / replay / intro card /
// double press / held key; the worker path really answers in the browser and the band follows the car.
//   npx tsx scripts/predictcheck.ts [--shots docs/screenshots/m6/final/predict] [--port 5261]
// Exit code 1 on any failed expectation or console error.
import { chromium } from 'playwright';
import { CHROME_ARGS } from './server';
import { ensurePreview, openUi, type Ui } from './uidrive';
import { SAVE_KEY, newSave } from '../src/sim/rally/save';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const SHOTS = opt('shots', '');
if (!process.env.DUSTMARK_PORT) process.env.DUSTMARK_PORT = opt('port', '5261');
const stop = await ensurePreview(Number(process.env.DUSTMARK_PORT));
const fails: string[] = [];
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${s}`);

function seed(predict: boolean, legacyKey?: string) {
  const s = newSave(1_700_000_000_000);
  s.introSeen = true;
  s.settings.predict = predict;
  const st: Record<string, string> = { [SAVE_KEY]: JSON.stringify(s) };
  if (legacyKey !== undefined) st['dustmark.predict'] = legacyKey;
  return JSON.stringify(st);
}

interface St { on: boolean | null; setting: boolean | null; saved: boolean | null; key: string | null; tag: string; band: boolean; mode: string; hz: number; phase: string; screen: string; worker: string }
const state = (ui: Ui) => ui.eval((): St => {
  const g = (window as any).__game, p = g?.predict;
  let saved: boolean | null = null;
  try { saved = JSON.parse(localStorage.getItem('dustmark.save') ?? 'null')?.settings?.predict ?? null; } catch { /* */ }
  const tagEl = document.querySelector('.hud-predict') as HTMLElement | null;
  return {
    on: p ? p.enabled : null, setting: g ? g.settings.predict : null, saved, key: localStorage.getItem('dustmark.predict'),
    tag: tagEl && tagEl.style.display !== 'none' ? tagEl.textContent ?? '' : '', band: !!p?.group.visible,
    mode: p?.stats.mode ?? '', hz: p?.stats.hz ?? 0, phase: g?.world.session.phase ?? '', screen: (window as any).__screen ?? '', worker: p?.workerState ?? '',
  };
});
const fmt = (s: St) => `on=${s.on} setting=${s.setting} saved=${s.saved} key=${s.key} tag="${s.tag}" band=${s.band} mode=${s.mode}/${s.worker} hz=${s.hz} phase=${s.phase} screen=${s.screen}`;
async function expect(ui: Ui, label: string, want: boolean, o: { band?: boolean; settingsRow?: boolean } = {}) {
  const s = await state(ui);
  const bad: string[] = [];
  if (s.on !== want) bad.push(`overlay ${s.on}`);
  if (s.setting !== want) bad.push(`game setting ${s.setting}`);
  if (s.saved !== want) bad.push(`saved ${s.saved}`);
  if (s.screen === 'run' && !!s.tag !== want) bad.push(`HUD tag "${s.tag}"`);
  if (o.band !== undefined && s.band !== o.band) bad.push(`band visible ${s.band}`);
  log(`${bad.length ? 'FAIL' : 'ok  '} ${label}: ${fmt(s)}${bad.length ? '  ← ' + bad.join(', ') : ''}`);
  if (bad.length) fails.push(`${label}: ${bad.join(', ')}`);
  return s;
}
const shot = async (ui: Ui, n: string) => { if (SHOTS) await ui.shot(`${SHOTS}/${n}.jpg`); };
const focused = (ui: Ui) => ui.eval(() => (document.querySelector('.focus') as HTMLElement | null)?.textContent?.trim() ?? '');
async function focusOn(ui: Ui, label: string, key = 'ArrowDown', max = 14) {
  for (const k of [key, ...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].filter((x) => x !== key)]) {
    for (let i = 0; i < (k === key ? max : 6); i++) {
      if ((await focused(ui)).startsWith(label)) return;
      await ui.key(k, 1, 120);
    }
  }
  throw new Error(`could not focus "${label}" (focused: "${await focused(ui)}")`);
}
/** the 轨迹预测 row value on the settings page currently shown */
const settingsRow = (ui: Ui) => ui.eval(() => {
  const r = [...document.querySelectorAll('.vrow')].find((x) => x.querySelector('.vr-label')?.textContent === '轨迹预测');
  return r?.querySelector('.vr-val')?.textContent ?? '?';
});
async function toSingleStage(ui: Ui) {
  await ui.waitScreen('title'); await ui.key('Space'); await ui.waitScreen('menu');
  await focusOn(ui, '单赛段'); await ui.key('Enter'); await ui.waitScreen('single-env'); await ui.key('Enter');
  await ui.waitScreen('single-stage'); await ui.key('Enter');
  await ui.waitScreen('run', 60_000);
}
const waitPhase = (ui: Ui, ph: string) => ui.page.waitForFunction((p) => (window as any).__game?.world.session.phase === p, ph, { timeout: 30_000 });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
try {
  // ------------------------------------------------------------------ single stage, keyboard driving
  {
    const ui = await openUi('', { width: 1600, height: 900 }, { browser, storage: seed(false) });
    try {
      await toSingleStage(ui);
      await expect(ui, 'start (save off)', false);
      // countdown
      await waitPhase(ui, 'countdown');
      await ui.key('KeyP');
      await ui.wait(700);
      const cd = await expect(ui, 'P during the countdown', true);
      log(`     countdown band drawn: ${cd.band}`);
      await shot(ui, 'p-countdown');
      // driving: hold throttle, steer, band must appear within 2 s and follow the turn
      await waitPhase(ui, 'running');
      await ui.page.keyboard.down('ArrowUp');
      await ui.wait(2500);
      await ui.page.keyboard.down('ArrowLeft');
      const tP = Date.now();
      await ui.page.waitForFunction(() => (window as any).__game.predict.group.visible, null, { timeout: 4000 }).catch(() => {});
      log(`     band visible ${Date.now() - tP} ms after steering`);
      await ui.wait(600);
      const drv = await expect(ui, 'driving, steering left', true, { band: true });
      if (drv.mode !== 'worker') fails.push(`worker path not used in the browser (mode ${drv.mode}, state ${drv.worker})`);
      // the band follows the car: where the car is 0.8 s later vs where the band said
      const cmp = await ui.eval(async () => {
        const g = (window as any).__game, p = g.predict, tr = p.cur;
        if (!tr) return null;
        const age = (g.world.tick - tr.tag) / 120;
        const t = age + 0.8;
        const pos = tr.posAt(t, { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; } });
        const pred = { x: pos.x, z: pos.z };
        await new Promise((r) => setTimeout(r, 800));
        const c = g.world.car.pos;
        return { err: Math.hypot(pred.x - c.x, pred.z - c.z), speed: g.world.car.speed * 3.6, age };
      });
      log(`     prediction vs actual 0.8 s ahead: ${cmp ? `${cmp.err.toFixed(2)} m at ${cmp.speed.toFixed(0)} km/h (prediction age ${(cmp.age * 1000).toFixed(0)} ms)` : 'no trajectory'}`);
      if (!cmp || cmp.err > 3) fails.push(`prediction does not match the driven path (${cmp?.err.toFixed(2)} m)`);
      await shot(ui, 'p-driving-left');
      await ui.page.keyboard.up('ArrowLeft');
      await ui.page.keyboard.down('ArrowRight');
      await ui.wait(900);
      await shot(ui, 'p-driving-right');
      await ui.page.keyboard.up('ArrowRight');
      await ui.page.keyboard.up('ArrowUp');
      // pause → resume
      await ui.key('Escape'); await ui.waitScreen('pause');
      await expect(ui, 'paused', true);
      await ui.key('Enter'); await ui.wait(500);
      await expect(ui, 'after pause → resume', true);
      // pause → settings: the row shows the live state; change it there
      await ui.key('Escape'); await ui.waitScreen('pause');
      await focusOn(ui, '设置'); await ui.key('Enter'); await ui.waitScreen('settings');
      const row = await settingsRow(ui);
      log(`${row === '开' ? 'ok  ' : 'FAIL'} settings over the game shows 轨迹预测 = ${row}`);
      if (row !== '开') fails.push(`settings over the game shows ${row} while on`);
      await focusOn(ui, '轨迹预测'); await ui.key('ArrowRight'); await ui.wait(200);
      await expect(ui, 'settings over the game: switched off', false);
      await ui.key('Escape'); await ui.waitScreen('pause'); await focusOn(ui, '继续', 'ArrowUp'); await ui.key('Enter'); await ui.wait(400);
      await expect(ui, 'back in the stage after the settings', false);
      // P again → pause → change something else (volume) in settings → must not touch the switch
      await ui.key('KeyP'); await ui.wait(300);
      await expect(ui, 'P again', true);
      await ui.key('Escape'); await ui.waitScreen('pause');
      await focusOn(ui, '设置'); await ui.key('Enter'); await ui.waitScreen('settings');
      await focusOn(ui, '变速箱'); await ui.key('ArrowRight'); await ui.key('ArrowLeft'); await ui.wait(200);
      await ui.key('Escape'); await ui.waitScreen('pause'); await focusOn(ui, '继续', 'ArrowUp'); await ui.key('Enter'); await ui.wait(400);
      await expect(ui, 'after changing another setting over the game', true);
      // restart
      await ui.key('Escape'); await ui.waitScreen('pause'); await focusOn(ui, '重跑'); await ui.key('Enter'); await ui.wait(800);
      await expect(ui, 'after restart (pause menu)', true);
      // Enter = restart key
      await waitPhase(ui, 'running');
      await ui.key('Enter'); await ui.wait(800);
      await expect(ui, 'after restart (Enter)', true);
      // double press, held key
      await ui.key('KeyP', 2, 60); await ui.wait(300);
      await expect(ui, 'P twice quickly', true);
      await ui.page.keyboard.down('KeyP'); await ui.wait(900); await ui.page.keyboard.up('KeyP'); await ui.wait(300);
      await expect(ui, 'P held 0.9 s (one toggle)', false);
      await ui.key('KeyP'); await ui.wait(300);
      await expect(ui, 'P once more', true);
      // reload: the saved setting comes back
      await ui.page.reload();
      await ui.page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
      await toSingleStage(ui);
      await expect(ui, 'after a page reload, new stage', true);
      // main menu settings → off → new stage
      await ui.key('Escape'); await ui.waitScreen('pause'); await focusOn(ui, '退出'); await ui.key('Enter');
      await ui.waitScreen(/single-stage|menu/);
      for (let i = 0; i < 6 && (await ui.screen()) !== 'menu'; i++) { await ui.key('Escape'); await ui.wait(900); }
      await ui.waitScreen('menu');
      await focusOn(ui, '设置'); await ui.key('Enter'); await ui.waitScreen('settings');
      const row2 = await settingsRow(ui);
      log(`${row2 === '开' ? 'ok  ' : 'FAIL'} menu settings shows 轨迹预测 = ${row2}`);
      if (row2 !== '开') fails.push(`menu settings shows ${row2}`);
      await focusOn(ui, '轨迹预测'); await ui.key('ArrowRight'); await ui.wait(200);
      await ui.key('Escape'); await ui.waitScreen('menu');
      await focusOn(ui, '单赛段'); await ui.key('Enter'); await ui.waitScreen('single-env'); await ui.key('Enter'); await ui.waitScreen('single-stage'); await ui.key('Enter');
      await ui.waitScreen('run', 60_000);
      await expect(ui, 'menu settings off → new stage', false);
    } catch (e) { fails.push('single: ' + (e as Error).message); await ui.shot('node_modules/.cache/predictcheck-failed.jpg').catch(() => {}); }
    finally { fails.push(...ui.errors.map((e) => 'single: ' + e)); await ui.close(); }
  }
  // ------------------------------------------------------------------ old localStorage key, intro card, career next stage, replay
  {
    const s0 = newSave(1_700_000_000_000);
    s0.introSeen = false;
    const ui = await openUi('ai=1&ff=12', { width: 1600, height: 900 }, { browser, storage: JSON.stringify({ [SAVE_KEY]: JSON.stringify(s0), 'dustmark.predict': '1' }) });
    try {
      await ui.waitScreen('title');
      const leg = await state(ui);
      log(`     legacy key '1' + save off → after boot: saved=${leg.saved} key=${leg.key}`);
      await ui.key('Enter'); await ui.waitScreen('menu'); await ui.key('Enter');
      await ui.waitScreen('car-pick'); await ui.wait(300); await ui.key('Enter');
      await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('briefing'); await ui.key('Enter');
      await ui.waitScreen(/^(run|intro)$/, 60_000);
      if ((await ui.screen()) === 'intro') {
        const before = (await state(ui)).on;
        await ui.key('KeyP'); await ui.wait(300);
        const after = (await state(ui)).on;
        log(`${before === after ? 'ok  ' : 'FAIL'} P on the intro card: ${before} → ${after} (ignored while the card is up)`);
        if (before !== after) fails.push('P toggled under the intro card');
        await shot(ui, 'p-intro');
        await ui.key('Enter'); await ui.waitScreen('run', 10_000);
      }
      const cur = (await state(ui)).on!;
      await ui.key('KeyP'); await ui.wait(300);
      await expect(ui, 'career stage 1: P', !cur);
      await ui.waitScreen('result', 400_000);
      await expect(ui, 'career stage 1 result', !cur);
      // replay: P does nothing
      await focusOn(ui, '看回放', 'ArrowRight'); await ui.key('Enter'); await ui.waitScreen('replay');
      await ui.key('KeyP'); await ui.wait(300);
      await expect(ui, 'P during the replay (ignored)', !cur);
      await ui.key('Escape'); await ui.waitScreen('result');
      await focusOn(ui, '继续', 'ArrowLeft'); await ui.key('Enter');
      await ui.waitScreen('briefing'); await ui.key('Enter');
      await ui.waitScreen('run', 60_000);
      await expect(ui, 'career stage 2 (next stage)', !cur);
    } catch (e) { fails.push('career: ' + (e as Error).message); await ui.shot('node_modules/.cache/predictcheck-failed2.jpg').catch(() => {}); }
    finally { fails.push(...ui.errors.map((e) => 'career: ' + e)); await ui.close(); }
  }
} finally {
  await browser.close();
  stop();
}
console.log(fails.length ? `\nFAIL (${fails.length}):\n  ${fails.join('\n  ')}` : '\nPASS');
process.exit(fails.length ? 1 : 0);
