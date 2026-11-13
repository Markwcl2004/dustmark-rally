// npx tsx scripts/feelshots.ts — 键位与手感设置: screenshots to docs/screenshots/m6/feel/ and checks that the 手感
// sliders reach the car (save → reload → run → car.tune; 恢复默认; URL wins; old save without the field; restart picks
// up a change made in the pause menu). Builds and serves on its own port (default 5241; --port n).
import { chromium } from 'playwright';
import { CHROME_ARGS } from './server';
import { ensurePreview, openUi, type Ui } from './uidrive';
import { SAVE_KEY, newSave } from '../src/sim/rally/save';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const DIR = 'docs/screenshots/m6/feel';
const fails: string[] = [];
const log = (...a: unknown[]) => console.log(...a);
const expect = (what: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) fails.push(`${what}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
};

const stop = await ensurePreview(Number(opt('port', '5241')));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
const savedFeel = (ui: Ui) => ui.eval(() => JSON.parse(localStorage.getItem('dustmark.save') ?? '{}').feel ?? null);
const tune = (ui: Ui) => ui.eval(() => { const t = (window as any).__game.world.car.tune; return { grip: t.grip, slipCap: Number.isNaN(t.slipCap) ? 'NaN' : t.slipCap, push: t.push, steerRate: t.steerRate, gentle: t.gentle, inputGentle: (window as any).__game.input.gentle }; });
const focusText = (ui: Ui) => ui.eval(() => (document.querySelector('.focus') as HTMLElement | null)?.textContent?.trim() ?? '');
const focusOn = async (ui: Ui, label: string, key = 'ArrowDown', max = 16) => {
  for (let i = 0; i < max; i++) { if ((await focusText(ui)).startsWith(label)) return; await ui.key(key, 1, 120); }
  throw new Error('cannot focus ' + label);
};
/** menu: settings › 手感 (second tab) */
const openFeel = async (ui: Ui) => { await ui.waitScreen('settings'); await ui.wait(200); await ui.key('KeyE'); await ui.wait(300); };
/** menu → single stage (first environment, first stage) → the run (no robot) */
const startSingle = async (ui: Ui) => {
  await ui.waitScreen('single-env'); await ui.key('Enter'); await ui.waitScreen('single-stage'); await ui.wait(600);
  await ui.key('Enter'); await ui.waitScreen('run', 60_000); await ui.wait(800);
};
// seeded save: the intro already seen (no first-run card in the way)
const seen = () => { const s = newSave(1_700_000_000_000); s.introSeen = true; return s; };
const store = (s: object) => JSON.stringify({ [SAVE_KEY]: JSON.stringify(s) });

try {
  for (const size of [{ width: 1600, height: 900 }, { width: 1512, height: 982 }]) {
    const suf = size.width === 1600 ? '' : '-1512';
    log(`screens ${size.width}×${size.height}`);
    // settings › 手感 (defaults), 控制 (key map)
    let ui = await openUi('screen=settings&intro=0', size, { browser, storage: store(seen()) });
    try {
      await openFeel(ui); await ui.shot(`${DIR}/settings-feel${suf}.jpg`);
      await ui.key('ArrowRight', 2); await ui.key('ArrowDown'); await ui.key('ArrowRight', 8); await ui.wait(200);
      await ui.shot(`${DIR}/settings-feel-changed${suf}.jpg`); // 抓地 1.10, 漂移角上限 → 关
      for (let i = 0; i < 4; i++) await ui.key('KeyE');
      await ui.wait(300); await ui.shot(`${DIR}/settings-control${suf}.jpg`);
    } finally { fails.push(...ui.errors); await ui.close(); }
    // first-run card (career's first stage, robot so nothing moves behind it)
    ui = await openUi('screen=career&intro=1&ai=1', size, { browser, storage: JSON.stringify({}) });
    try {
      await ui.waitScreen('car-pick'); await ui.key('Enter'); await ui.waitScreen('career'); await ui.key('Enter'); await ui.waitScreen('briefing');
      await ui.key('Enter'); await ui.waitScreen('intro', 60_000); await ui.wait(600); await ui.shot(`${DIR}/intro${suf}.jpg`);
    } finally { fails.push(...ui.errors); await ui.close(); }
    // pause menu + 手感 over the game, during a single stage
    ui = await openUi('screen=single&intro=0', size, { browser, storage: store(seen()) });
    try {
      await startSingle(ui);
      // after the countdown, hold the throttle a moment so the pause shows a moving stage
      await ui.wait(3500); await ui.page.keyboard.down('ArrowUp'); await ui.wait(2500); await ui.page.keyboard.up('ArrowUp');
      await ui.key('Escape'); await ui.waitScreen('pause'); await ui.shot(`${DIR}/pause${suf}.jpg`);
      await focusOn(ui, '手感'); await ui.key('Enter'); await ui.waitScreen('settings'); await ui.wait(300);
      await ui.shot(`${DIR}/pause-feel${suf}.jpg`);
      await ui.key('Escape'); await ui.waitScreen('pause'); await ui.key('Escape'); await ui.wait(1500);
      await ui.shot(`${DIR}/hud-keys${suf}.jpg`);
    } finally { fails.push(...ui.errors); await ui.close(); }
  }

  log('checks');
  // 1. a save from before this change (no feel field): loads, the page shows defaults, the car gets the defaults
  {
    const ui = await openUi('screen=single&intro=0', { width: 1600, height: 900 }, { browser, storage: store(seen()) });
    try {
      expect('old save: no feel field stored', await ui.eval(() => 'feel' in JSON.parse(localStorage.getItem('dustmark.save') ?? '{}')), false);
      await startSingle(ui);
      expect('old save: car.tune', await tune(ui), { grip: 1, slipCap: 'NaN', push: 1, steerRate: 1, gentle: 0.5, inputGentle: 0.5 });
    } finally { fails.push(...ui.errors.map((e) => 'old save: ' + e)); await ui.close(); }
  }
  // 2. 抓地 → 1.30 on the page, saved, kept across a reload, reaches the car; 恢复默认 → 1.00 on the car
  {
    const ui = await openUi('screen=settings&intro=0', { width: 1600, height: 900 }, { browser, storage: store(seen()) });
    try {
      await openFeel(ui);
      expect('focus on 抓地', (await focusText(ui)).slice(0, 2), '抓地');
      await ui.key('ArrowRight', 8); // 1.00 → 1.30 (clamped)
      await ui.key('ArrowDown', 3); await ui.key('ArrowRight', 2); // 方向键速度 1.0 → 1.2
      await ui.key('ArrowDown'); await ui.key('ArrowLeft', 2); // 轻踩 50% → 40%
      expect('saved feel', await savedFeel(ui), { grip: 1.3, slipCap: 35, push: 1, steerRate: 1.2, gentle: 0.4 });
      await ui.page.reload(); await ui.page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
      await openFeel(ui);
      expect('after reload: 抓地 row', await ui.eval(() => document.querySelector('[data-feel="grip"] .vr-val')?.textContent), '1.30×');
      expect('after reload: saved feel', await savedFeel(ui), { grip: 1.3, slipCap: 35, push: 1, steerRate: 1.2, gentle: 0.4 });
      await ui.key('Escape'); await ui.waitScreen('menu');
      await ui.page.goto(ui.page.url().replace(/\?.*$/, '?screen=single&intro=0')); await ui.page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
      await startSingle(ui);
      expect('run: car.tune', await tune(ui), { grip: 1.3, slipCap: 'NaN', push: 1, steerRate: 1.2, gentle: 0.4, inputGentle: 0.4 });
      // pause › 手感 › 恢复默认 › back › 重跑 → the restarted car has the defaults
      await ui.key('Escape'); await ui.waitScreen('pause');
      await focusOn(ui, '手感'); await ui.key('Enter'); await ui.waitScreen('settings'); await ui.wait(200);
      await focusOn(ui, '恢复默认'); await ui.key('Enter'); await ui.wait(200);
      expect('pause › 恢复默认: saved feel', await savedFeel(ui), { grip: 1, slipCap: 35, push: 1, steerRate: 1, gentle: 0.5 });
      expect('pause › 恢复默认: focus stays on the button', (await focusText(ui)).slice(0, 4), '恢复默认');
      expect('same run before the restart: car.tune unchanged', (await tune(ui)).grip, 1.3);
      await ui.key('Escape'); await ui.waitScreen('pause');
      await focusOn(ui, '重跑'); await ui.key('Enter'); await ui.wait(800);
      expect('after 重跑: car.tune', await tune(ui), { grip: 1, slipCap: 'NaN', push: 1, steerRate: 1, gentle: 0.5, inputGentle: 0.5 });
    } finally { fails.push(...ui.errors.map((e) => 'slider: ' + e)); await ui.close(); }
  }
  // 3. URL wins over the save (saved grip 1.3 + slipcap off; URL grip=0.9) — the page says so
  {
    const s = seen() as ReturnType<typeof seen> & { feel?: object };
    s.feel = { grip: 1.3, slipCap: 0, push: 0.5, steerRate: 1, gentle: 0.5 };
    const ui = await openUi('screen=settings&intro=0&grip=0.9', { width: 1600, height: 900 }, { browser, storage: store(s) });
    try {
      await openFeel(ui);
      expect('URL note on 抓地', await ui.eval(() => document.querySelector('[data-feel="grip"]')?.parentElement?.querySelector('.feel-url')?.textContent?.slice(0, 18)), '网址里写了 grip=0.9，开跑时');
      expect('no URL note elsewhere', await ui.eval(() => document.querySelectorAll('.feel-url').length), 1);
      await ui.shot(`${DIR}/settings-feel-url.jpg`);
      await ui.key('Escape'); await ui.waitScreen('menu');
      await ui.page.goto(ui.page.url().replace(/\?.*$/, '?screen=single&intro=0&grip=0.9')); await ui.page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
      await startSingle(ui);
      expect('URL grip=0.9 + saved 1.3: car.tune', await tune(ui), { grip: 0.9, slipCap: 0, push: 0.5, steerRate: 1, gentle: 0.5, inputGentle: 0.5 });
    } finally { fails.push(...ui.errors.map((e) => 'url: ' + e)); await ui.close(); }
  }
  // 4. a hand-edited / broken feel field: clamped, no error
  {
    const s = seen() as ReturnType<typeof seen> & { feel?: object };
    s.feel = { grip: 9, slipCap: 'x', push: -1, gentle: null } as object;
    const ui = await openUi('screen=single&intro=0', { width: 1600, height: 900 }, { browser, storage: store(s) });
    try {
      await startSingle(ui);
      expect('broken feel: car.tune', await tune(ui), { grip: 1.3, slipCap: 'NaN', push: 0, steerRate: 1, gentle: 0.5, inputGentle: 0.5 });
    } finally { fails.push(...ui.errors.map((e) => 'broken: ' + e)); await ui.close(); }
  }
  // 5. robot runs ignore the saved feel (tools stay reproducible)
  {
    const s = seen() as ReturnType<typeof seen> & { feel?: object };
    s.feel = { grip: 1.3, slipCap: 20, push: 2, steerRate: 2, gentle: 0.8 };
    const ui = await openUi('screen=single&intro=0&ai=1', { width: 1600, height: 900 }, { browser, storage: store(s) });
    try {
      await startSingle(ui);
      expect('robot run: car.tune', await tune(ui), { grip: 1, slipCap: 'NaN', push: 1, steerRate: 1, gentle: 0.5, inputGentle: 0.5 });
    } finally { fails.push(...ui.errors.map((e) => 'robot: ' + e)); await ui.close(); }
  }
  // 6. __teleport no longer holds the finished Game
  {
    const ui = await openUi('screen=single&intro=0', { width: 1600, height: 900 }, { browser, storage: store(seen()) });
    try {
      await startSingle(ui);
      expect('__teleport is not a closure over this Game', await ui.eval(() => String((window as any).__teleport).includes('this.')), false);
      await ui.key('Escape'); await ui.waitScreen('pause'); await focusOn(ui, '退出到菜单'); await ui.key('Enter');
      await ui.wait(400); if ((await ui.screen()) === 'dialog') { await focusOn(ui, '退出', 'ArrowLeft'); await ui.key('Enter'); }
      await ui.waitScreen(/menu|single-.*/, 30_000);
      expect('after quitting: window.__game', await ui.eval(() => (window as any).__game === undefined), true);
      expect('after quitting: __teleport is a no-op', await ui.eval(() => { (window as any).__teleport(10); return 'ok'; }), 'ok');
    } finally { fails.push(...ui.errors.map((e) => 'teleport: ' + e)); await ui.close(); }
  }
} catch (e) {
  fails.push(String((e as Error).stack ?? e));
} finally {
  await browser.close();
  stop();
}
if (fails.length) { log('\nFAILED'); for (const f of fails) log(' - ' + f); process.exit(1); }
log('\nall feel checks ok');
