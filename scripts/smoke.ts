// npm run smoke [-- --full] — end-to-end through the real menus, keyboard only, headless Chrome, on a production build
// served by scripts/serve.mjs (its own port 5223; no HMR, so other tasks editing files cannot reload the page):
//   1. new save: title → main menu → single stage (first run: the "怎么开" card) → robot drives (fast-forward) →
//      result → main menu
//   2. career: new career → car pick → season overview → briefing → three stages (result with medal + season points
//      after each, briefing in between) → rally result → season overview
//      --full: the whole career instead — three seasons, every rally, season results, unlocks, the
//      ending; the robot (the medal reference itself) must reach every season's unlock points
//   3. time challenge twice: the second run has the ghost of the first; the replay of a run with all three cameras
//   3b. P (trajectory prediction) in a run: pause / resume / settings page / restart / reload keep one saved state
//   4. settings: one item changed on every page → reload → all still set; clear the save → a new save
// After every step the save in localStorage must parse and look sane. Fails on any console error / uncaught
// exception, or when a screen does not appear in time.
// Options: --ff 12 (sim fast-forward of the robot runs)  --only single|career|time|predict|settings  --full
import { chromium } from 'playwright';
import { CHROME_ARGS } from './server';
import { ensurePreview, openUi, type Ui } from './uidrive';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FULL = args.includes('--full');
const FF = Number(opt('ff', FULL ? '24' : '12'));
const ONLY = opt('only', '');
const want = (part: string) => !ONLY || ONLY.split(',').includes(part);

const stopServer = await ensurePreview(5223);

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${s}`);
const focused = (ui: Ui) => ui.eval(() => (document.querySelector('.focus') as HTMLElement | null)?.textContent?.trim() ?? '');
const failures: string[] = [];
const stats = { stages: 0, loadMs: [] as number[], saveChecks: 0 };

/** move the focus with a key until the focused control's text starts with `label` */
async function focusOn(ui: Ui, label: string, key = 'ArrowDown', max = 14) {
  // the given direction first, then the others (layouts differ)
  for (const k of [key, ...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].filter((x) => x !== key)]) {
    for (let i = 0; i < (k === key ? max : 6); i++) {
      if ((await focused(ui)).startsWith(label)) return;
      await ui.key(k, 1, 120);
    }
  }
  if ((await focused(ui)).startsWith(label)) return;
  throw new Error(`could not focus "${label}" (focused: "${await focused(ui)}")`);
}

/** the save must parse, have the current shape, and (optionally) pass a check */
async function checkSave(ui: Ui, where: string, extra?: (s: any) => string | null) {
  const r = await ui.eval(() => { try { return { ok: true, s: JSON.parse(localStorage.getItem('dustmark.save') ?? 'null') }; } catch (e) { return { ok: false, s: String(e) }; } });
  stats.saveChecks++;
  const s = r.s;
  const bad = !r.ok ? `unparsable save (${s})` : !s ? 'no save' : typeof s.v !== 'number' || !s.settings || !s.records || !s.stats ? 'save lacks fields' : extra?.(s) ?? null;
  if (bad) { failures.push(`save @ ${where}: ${bad}`); log(`SAVE PROBLEM @ ${where}: ${bad}`); }
  return s;
}

/** from the stage start to the result screen (the first run of a save shows the intro card first) */
async function driveStage(ui: Ui, label: string) {
  await ui.waitScreen(/^(run|intro)$/, 60_000);
  if ((await ui.screen()) === 'intro') {
    log(`${label}: intro card shown ("怎么开") — any key`);
    await ui.wait(300);
    await ui.key('Enter');
    await ui.waitScreen('run', 10_000);
  }
  const load = await ui.eval(() => (window as any).__loadMs);
  stats.loadMs.push(load);
  await ui.waitScreen('result', 400_000);
  const r = await ui.eval(() => { const g = (window as any).__game; const s = g.world.session; return { t: s.finishTime, pen: s.penalties, fs: g.frameStats(), ghost: !!g.ghostCar }; });
  stats.stages++;
  log(`${label}: ${r.t.toFixed(2)} s (+${r.pen} s), load ${Math.round(load)} ms, frames avg ${r.fs.avg.toFixed(1)} / p95 ${r.fs.p95.toFixed(1)} ms${r.ghost ? ', ghost car on' : ''}`);
  return r;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
try {
  // ---------------------------------------------------------------- 1. single stage on a new save
  if (want('single')) {
    log('single stage: title → menu → stage (intro card) → result → menu');
    const ui = await openUi(`ai=1&ff=${FF}`, { width: 1600, height: 900 }, { browser });
    try {
      await ui.waitScreen('title');
      await checkSave(ui, 'title (new save)');
      await ui.key('Space');
      await ui.waitScreen('menu');
      await focusOn(ui, '单赛段');
      await ui.key('Enter');
      await ui.waitScreen('single-env');
      await ui.key('Enter');
      await ui.waitScreen('single-stage');
      await ui.key('Enter');
      await driveStage(ui, 'single');
      await focusOn(ui, '回菜单', 'ArrowRight');
      await ui.key('Enter');
      await ui.waitScreen('menu');
      const s = await checkSave(ui, 'single done', (x) => (!Object.keys(x.records).length ? 'no record saved' : !x.introSeen ? 'intro not marked as seen' : null));
      log(`single: back in the menu; records ${Object.keys(s.records ?? {}).join(', ') || 'none'}`);
    } finally { failures.push(...ui.errors.map((e) => `single: ${e}`)); await ui.close(); }
  }

  // ---------------------------------------------------------------- 2. career
  if (want('career')) {
    log(FULL ? 'career (full): three seasons → ending' : 'career: new career → first rally (3 stages) → rally result');
    const ui = await openUi(`ai=1&ff=${FF}`, { width: 1600, height: 900 }, { browser });
    const tc = Date.now();
    try {
      await ui.waitScreen('title');
      await ui.key('Enter');
      await ui.waitScreen('menu');
      await ui.key('Enter'); // 生涯 is the first item
      for (let season = 0; season < (FULL ? 3 : 1); season++) {
        await ui.waitScreen('car-pick');
        await ui.wait(300);
        await ui.key('Enter');
        await ui.waitScreen('career');
        const car = await checkSave(ui, `season ${season + 1} start`, (x) => (x.career?.season !== season ? `career season ${x.career?.season} ≠ ${season}` : null));
        log(`season ${season + 1}: ${car.career.car}, calendar ${car.career.plan.rallies.map((r: any) => r.name).join(' / ')}`);
        for (let rally = 0; rally < (FULL ? 4 : 1); rally++) {
          await ui.key('Enter'); // 开始 · <rally>
          await ui.waitScreen('briefing');
          for (let k = 1; k <= 3; k++) {
            await ui.key('Enter');
            await driveStage(ui, `S${season + 1} R${rally + 1} SS${k}`);
            const medal = await ui.eval(() => (document.querySelector('.rs-medal span') as HTMLElement)?.textContent?.replace(/\s+/g, ' ') ?? '');
            await focusOn(ui, '继续', 'ArrowLeft');
            await ui.key('Enter');
            await ui.waitScreen(k === 3 ? 'rally-result' : 'briefing');
            await checkSave(ui, `S${season + 1} R${rally + 1} SS${k} recorded`, (x) => (x.career?.current && x.career.current.stage !== k ? `rally progress ${x.career?.current?.stage} ≠ ${k}` : null));
            log(`  stage result: ${medal}`);
          }
          await ui.waitScreen('rally-result');
          const rr = await ui.eval(() => (document.querySelector('.rr-pos b') as HTMLElement)?.textContent);
          log(`rally ${rally + 1}: ${rr} points`);
          await checkSave(ui, `rally ${rally + 1} result`, (x) => (x.career?.rallies?.length !== rally + 1 ? `rallies recorded ${x.career?.rallies?.length}` : null));
          await ui.key('Enter');
          await ui.waitScreen(/^(career|season-result)$/);
        }
        if (!FULL) break;
        // season over: overview → 赛季结算 (rally-result already went there when it was the last rally)
        if ((await ui.screen()) === 'career') { await ui.key('Enter'); await ui.waitScreen('season-result'); }
        const sr = await ui.eval(() => (document.querySelector('.sr-me b') as HTMLElement)?.textContent);
        const s = await checkSave(ui, `season ${season + 1} result`, (x) => (x.career?.history?.length !== season + 1 ? 'season not in the history' : null));
        const need = s.career?.seasonEnd?.need;
        log(`season ${season + 1}: ${sr} points (needs ${need}), unlocked group ${s.unlockedGroup} (${((Date.now() - tc) / 60000).toFixed(1)} min so far)`);
        if (!s.career?.seasonEnd?.qualified) { failures.push(`career: season ${season + 1} ended on ${sr} points (needs ${need}) — the reference robot should reach them`); break; }
        if (season < 2 && s.unlockedGroup !== season + 1) failures.push(`career: group ${season + 1} not unlocked after season ${season + 1}`);
        await ui.key('Enter'); // 进入下一赛季 / 看结局
      }
      if (FULL && !failures.some((f) => f.startsWith('career'))) {
        await ui.waitScreen('ending');
        await checkSave(ui, 'ending', (x) => (!x.career?.champion || !x.seenEnding ? 'champion / ending not recorded' : null));
        log(`career: ending shown — full career in ${((Date.now() - tc) / 60000).toFixed(1)} min`);
        await ui.key('Enter');
        await ui.waitScreen('menu');
      } else if (!FULL) {
        await ui.waitScreen('career');
        const c = (await checkSave(ui, 'career first rally', (x) => (x.career?.rally !== 1 || !x.career?.rallies?.length ? 'rally not recorded in the save' : null))).career;
        log(`career: saved — season ${c.season + 1}, next rally ${c.rally + 1}, points ${c.points}`);
      }
      const bots = await ui.eval(() => (window as any).__bots.stats);
      log(`robot runs in workers: ${bots.runs} (${(bots.ms / 1000).toFixed(1)} s worker time), cache hits ${bots.cached}`);
    } finally { failures.push(...ui.errors.map((e) => `career: ${e}`)); await ui.close(); }
  }

  // ---------------------------------------------------------------- 3. time challenge ×2 (ghost) + replay cameras
  if (want('time')) {
    log('time challenge: run 1 → replay (3 cameras) → run 2 with the ghost');
    const ui = await openUi(`ai=1&ff=${FF}&intro=0`, { width: 1600, height: 900 }, { browser });
    try {
      const startTime = async () => {
        await ui.waitScreen('menu');
        await focusOn(ui, '计时挑战');
        await ui.key('Enter');
        await ui.waitScreen('time-env');
        await ui.key('Enter');
        await ui.waitScreen('time-stage');
        await ui.key('Enter');
      };
      await ui.waitScreen('title');
      await ui.key('Enter');
      await startTime();
      const r1 = await driveStage(ui, 'time 1');
      if (r1.ghost) failures.push('time 1: a ghost on a new save');
      const s = await checkSave(ui, 'time 1', (x) => (!Object.values(x.records).some((r: any) => r.ghost) ? 'no ghost stored' : null));
      const ghosts = await ui.eval(() => Object.keys(localStorage).filter((k) => k.startsWith('dustmark.ghost.')).map((k) => `${k} ${localStorage.getItem(k)!.length} B`));
      log(`time 1: record ${Object.keys(s.records).join(', ')}, ${ghosts.join(', ')}`);
      // replay: TV → chase → helicopter
      await focusOn(ui, '看回放', 'ArrowRight');
      await ui.key('Enter');
      await ui.waitScreen('replay');
      await ui.eval(() => (window as any).__game.replaySeek(30));
      const cams: string[] = [];
      for (let i = 0; i < 3; i++) {
        await ui.wait(1200);
        cams.push(await ui.eval(() => { const g = (window as any).__game; return `${g.replay.cam}:${g.view.chase.mode}`; }));
        if (i < 2) await ui.key('KeyC');
      }
      const snd = await ui.eval(() => { const a = (window as any).__game.audio; return { running: !!a?.running, paused: !!a?.paused }; });
      log(`replay cameras ${cams.join(' → ')} (audio running ${snd.running})`);
      if (new Set(cams.map((c) => c.split(':')[0])).size !== 3) failures.push(`replay: camera did not cycle (${cams.join(', ')})`);
      await ui.key('Escape');
      await ui.waitScreen('result');
      await focusOn(ui, '回菜单', 'ArrowRight');
      await ui.key('Enter');
      await startTime();
      const r2 = await driveStage(ui, 'time 2');
      if (!r2.ghost) failures.push('time 2: no ghost car against the stored best');
      await focusOn(ui, '回菜单', 'ArrowRight');
      await ui.key('Enter');
      await ui.waitScreen('menu');
      await checkSave(ui, 'time 2');
    } finally { failures.push(...ui.errors.map((e) => `time: ${e}`)); await ui.close(); }
  }

  // ---------------------------------------------------------------- 3b. P (trajectory prediction): one switch, saved
  if (want('predict')) {
    log('predict: P in a run → pause → resume → settings shows it → restart → reload: same state, saved');
    const ui = await openUi('ai=1&ff=2', { width: 1600, height: 900 }, { browser });
    const st = () => ui.eval(() => { const g = (window as any).__game; return { on: !!g?.predict?.enabled, setting: !!g?.settings.predict, saved: !!JSON.parse(localStorage.getItem('dustmark.save') ?? '{}').settings?.predict, tag: (document.querySelector('.hud-predict') as HTMLElement | null)?.style.display !== 'none' }; });
    const want1 = async (where: string, on: boolean) => {
      const s = await st();
      const bad = s.on !== on || s.setting !== on || s.saved !== on || (where.startsWith('run') && s.tag !== on);
      log(`  ${where}: overlay ${s.on} · setting ${s.setting} · saved ${s.saved} · HUD tag ${s.tag}`);
      if (bad) failures.push(`predict @ ${where}: expected ${on}, got ${JSON.stringify(s)}`);
    };
    try {
      await ui.waitScreen('title'); await ui.key('Space'); await ui.waitScreen('menu');
      await focusOn(ui, '单赛段'); await ui.key('Enter'); await ui.waitScreen('single-env'); await ui.key('Enter');
      await ui.waitScreen('single-stage'); await ui.key('Enter');
      await ui.waitScreen(/^(run|intro)$/, 60_000);
      if ((await ui.screen()) === 'intro') { await ui.wait(300); await ui.key('Enter'); await ui.waitScreen('run', 10_000); }
      await want1('run, before P', false);
      await ui.key('KeyP'); await ui.wait(300);
      await want1('run, after P', true);
      await ui.key('Escape'); await ui.waitScreen('pause'); await ui.key('Enter'); await ui.wait(400);
      await want1('run, after pause → resume', true);
      await ui.key('Escape'); await ui.waitScreen('pause'); await focusOn(ui, '设置'); await ui.key('Enter'); await ui.waitScreen('settings');
      const row = await ui.eval(() => [...document.querySelectorAll('.vrow')].find((x) => x.querySelector('.vr-label')?.textContent === '轨迹预测')?.querySelector('.vr-val')?.textContent ?? '?');
      log(`  settings over the run: 轨迹预测 = ${row}`);
      if (row !== '开') failures.push(`predict: settings page shows ${row} while it is on`);
      await ui.key('Escape'); await ui.waitScreen('pause'); await focusOn(ui, '重跑'); await ui.key('Enter'); await ui.wait(800);
      await want1('run, after restart', true);
      // the band comes back after a restart (the sim clock starts again from 0)
      const band = await ui.page.waitForFunction(() => (window as any).__game?.predict?.group.visible, null, { timeout: 8000 }).then(() => true).catch(() => false);
      log(`  band drawn after the restart: ${band}`);
      if (!band) failures.push('predict: no band after a restart');
      await ui.page.reload();
      await ui.page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
      const saved = await ui.eval(() => !!JSON.parse(localStorage.getItem('dustmark.save') ?? '{}').settings?.predict);
      log(`  menu, after a reload: saved ${saved}`);
      if (!saved) failures.push('predict: not kept across a reload');
    } finally { failures.push(...ui.errors.map((e) => `predict: ${e}`)); await ui.close(); }
  }

  // ---------------------------------------------------------------- 4. settings persist across a reload; clear save
  if (want('settings')) {
    log('settings: change one item per page → reload → still set; clear the save');
    const ui = await openUi('screen=settings&intro=0', { width: 1600, height: 900 }, { browser });
    try {
      await ui.waitScreen('settings');
      const before = await ui.eval(() => JSON.parse(localStorage.getItem('dustmark.save') ?? '{}').settings);
      // first row of each page, one step right (save page: nothing to change)
      for (const tab of ['drive', 'feel', 'event', 'sound', 'video', 'control']) {
        await ui.wait(150);
        await ui.key('ArrowRight');
        await ui.wait(150);
        log(`  ${tab}: ${await focused(ui)}`);
        await ui.key('KeyE');
      }
      await ui.key('Escape');
      await ui.waitScreen('menu');
      await ui.page.reload();
      await ui.page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
      const after = await ui.eval(() => JSON.parse(localStorage.getItem('dustmark.save') ?? '{}').settings);
      const diff = (a: any, b: any, p = ''): string[] => Object.keys(a).flatMap((k) => (typeof a[k] === 'object' ? diff(a[k], b[k] ?? {}, `${p}${k}.`) : a[k] !== b[k] ? [`${p}${k} ${JSON.stringify(a[k])}→${JSON.stringify(b[k])}`] : []));
      const changed = diff(before, after);
      log(`settings after reload: ${changed.join(', ')}`);
      for (const k of ['assist', 'callEarly', 'vol.master', 'quality', 'pad.deadzone']) if (!changed.some((c) => c.startsWith(k + ' '))) failures.push(`settings: ${k} not kept across the reload`);
      // 手感 lives next to the settings (save.feel): its first slider (抓地) went one step up from 1.00
      const feel = await ui.eval(() => JSON.parse(localStorage.getItem('dustmark.save') ?? '{}').feel);
      log(`feel after reload: ${JSON.stringify(feel)}`);
      if (feel?.grip !== 1.05) failures.push(`settings: feel.grip not kept across the reload (${JSON.stringify(feel)})`);
      // clear the save: settings › 存档 › 清除存档 › 清除
      await ui.page.goto(ui.page.url().replace(/\?.*$/, '?screen=settings&intro=0'));
      await ui.page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 });
      await ui.waitScreen('settings');
      for (let i = 0; i < 6; i++) await ui.key('KeyE');
      await ui.wait(200);
      await focusOn(ui, '清除存档');
      await ui.key('Enter');
      await ui.waitScreen('dialog');
      await focusOn(ui, '清除', 'ArrowLeft');
      await ui.key('Enter');
      await ui.waitScreen('title');
      const fresh = await checkSave(ui, 'after clear', (x) => (Object.keys(x.records).length || x.career || x.introSeen || x.settings.assist !== 'standard' || (x.feel && x.feel.grip !== 1) ? 'save not reset' : null));
      const left = await ui.eval(() => Object.keys(localStorage).filter((k) => k.startsWith('dustmark.ghost.')).length);
      if (left) failures.push(`clear save: ${left} ghosts left`);
      log(`cleared: new save (records ${Object.keys(fresh.records).length}, career ${fresh.career ? 'yes' : 'none'}, ghosts ${left})`);
    } finally { failures.push(...ui.errors.map((e) => `settings: ${e}`)); await ui.close(); }
  }
} catch (e) {
  failures.push(String((e as Error).stack ?? e));
} finally {
  await browser.close();
  stopServer();
}
const loads = [...stats.loadMs].sort((a, b) => a - b);
console.log(`\n${stats.stages} stages driven, ${stats.saveChecks} save checks; stage load (menu → playable, excl. wipes) median ${Math.round(loads[loads.length >> 1] ?? 0)} ms, max ${Math.round(loads[loads.length - 1] ?? 0)} ms`);
if (failures.length) { console.log('\nSMOKE FAILED'); for (const f of failures) console.log(' - ' + f); process.exit(1); }
console.log(`\nSMOKE OK in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
