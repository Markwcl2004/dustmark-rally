// Screens drawn over a running stage (pause, settings, phone pairing, result, replay bar, intro card): one screenshot each,
// to check that nothing at the bottom prints over anything else (the HUD key strip vs the footer hints).
//   npx tsx scripts/overlayshots.ts [--prefix before-] [--dir docs/screenshots/m6/final/overlay]   (DUSTMARK_PORT or 5261)
import { chromium } from 'playwright';
import { CHROME_ARGS } from './server';
import { ensurePreview, openUi, type Ui } from './uidrive';
import { SAVE_KEY, newSave } from '../src/sim/rally/save';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const DIR = opt('dir', 'docs/screenshots/m6/final/overlay');
const PRE = opt('prefix', '');
if (!process.env.DUSTMARK_PORT) process.env.DUSTMARK_PORT = '5261';
const stop = await ensurePreview(Number(process.env.DUSTMARK_PORT));
const focused = (ui: Ui) => ui.eval(() => (document.querySelector('.focus') as HTMLElement | null)?.textContent?.trim() ?? '');
async function focusOn(ui: Ui, label: string, key = 'ArrowDown', max = 14) {
  for (const k of [key, ...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].filter((x) => x !== key)]) {
    for (let i = 0; i < (k === key ? max : 6); i++) {
      if ((await focused(ui)).startsWith(label)) return;
      await ui.key(k, 1, 120);
    }
  }
  throw new Error(`could not focus "${label}"`);
}
/** bottom-strip overlap check: HUD key strip visible while a footer hint bar is up */
// (a string, not a function: tsx would wrap named arrow functions in a helper the page does not have)
const OVERLAP_JS = `(() => {
  const k = document.querySelector('.hud-keys');
  const vis = function (e) { return !!e && getComputedStyle(e).display !== 'none' && e.offsetParent !== null && e.getBoundingClientRect().height > 0; };
  const kr = vis(k) ? k.getBoundingClientRect() : null;
  const hits = [];
  if (kr) for (const e of document.querySelectorAll('#ui .hints, #ui .screen.overlay *, .pair-ov *')) {
    if (!vis(e) || e.children.length) continue;
    const r = e.getBoundingClientRect();
    if (r.right > kr.left && r.left < kr.right && r.bottom > kr.top && r.top < kr.bottom && (e.textContent || '').trim()) hits.push((e.textContent || '').trim().slice(0, 20));
  }
  return { keys: !!kr, hits };
})()`;
const overlap = (ui: Ui) => ui.page.evaluate(OVERLAP_JS) as Promise<{ keys: boolean; hits: string[] }>;
const report: string[] = [];
async function shot(ui: Ui, name: string, size: string) {
  const o = await overlap(ui);
  report.push(`${name}${size}: HUD key strip ${o.keys ? 'shown' : 'hidden'}${o.hits.length ? `, overlaps ${o.hits.length}: ${o.hits.slice(0, 4).join(' | ')}` : ''}`);
  await ui.shot(`${DIR}/${PRE}${name}${size}.jpg`);
}
const seed = (introSeen: boolean) => { const s = newSave(1_700_000_000_000); s.introSeen = introSeen; return JSON.stringify({ [SAVE_KEY]: JSON.stringify(s) }); };

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
try {
  for (const [suf, size] of [['', { width: 1600, height: 900 }], ['-720p', { width: 1280, height: 720 }]] as const) {
    const ui = await openUi('ai=1&ff=12', size, { browser, storage: seed(false) });
    try {
      await ui.waitScreen('title'); await ui.key('Space'); await ui.waitScreen('menu');
      await focusOn(ui, '单赛段'); await ui.key('Enter'); await ui.waitScreen('single-env'); await ui.key('Enter');
      await ui.waitScreen('single-stage'); await ui.key('Enter');
      await ui.waitScreen('intro', 60_000); await ui.wait(400);
      await shot(ui, 'intro', suf);
      await ui.key('Enter'); await ui.waitScreen('run');
      await ui.wait(1500);
      await shot(ui, 'run', suf);
      await ui.key('Escape'); await ui.waitScreen('pause'); await ui.wait(300);
      await shot(ui, 'pause', suf);
      await focusOn(ui, '设置'); await ui.key('Enter'); await ui.waitScreen('settings'); await ui.wait(300);
      await shot(ui, 'settings', suf);
      await ui.key('Escape'); await ui.waitScreen('pause'); await focusOn(ui, '继续', 'ArrowUp'); await ui.key('Enter'); await ui.wait(500);
      await ui.key('KeyK'); await ui.wait(1500);
      await shot(ui, 'pair', suf);
      await ui.key('KeyK'); await ui.wait(400);
      await ui.waitScreen('result', 400_000); await ui.wait(800);
      await shot(ui, 'result', suf);
      await focusOn(ui, '看回放', 'ArrowRight'); await ui.key('Enter'); await ui.waitScreen('replay'); await ui.wait(1500);
      await shot(ui, 'replay', suf);
    } finally { if (ui.errors.length) report.push(...ui.errors); await ui.close(); }
  }
} finally {
  await browser.close();
  stop();
}
console.log(report.join('\n'));
