// npm run icon-sheet — renders every pace-note icon variant on one page (headless) → docs/screenshots/m2/hud-icons.jpg
import { chromium } from 'playwright';
import { BASE, CHROME_ARGS, ensureServer } from './server';

const stop = await ensureServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await page.goto(`${BASE}/?view=none`);
  // a string (not a function) so tsx's __name helpers don't leak into the page
  await page.evaluate(`(async () => {
    const { noteIcon } = await import('/src/ui/icons.ts');
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#3b4a3f;color:#f1ece0;font:14px "PingFang SC";display:flex;flex-wrap:wrap;align-content:flex-start;gap:10px;padding:16px';
    document.body.appendChild(root);
    const N = (o) => ({ s: 0, mods: [], words: [], text: '', ...o });
    const list = [];
    for (const g of [6, 5, 4, 3, 2, 1]) list.push([\`右\${'一二三四五六'[g - 1]}\`, N({ kind: 'turn', dir: 'R', grade: g })]);
    for (const g of [6, 4, 2]) list.push([\`左\${'一二三四五六'[g - 1]}\`, N({ kind: 'turn', dir: 'L', grade: g })]);
    list.push(['发卡右', N({ kind: 'turn', dir: 'R', grade: 'hairpin' })], ['发卡左', N({ kind: 'turn', dir: 'L', grade: 'hairpin' })]);
    list.push(['直角右', N({ kind: 'turn', dir: 'R', grade: 'square' })], ['直角左', N({ kind: 'turn', dir: 'L', grade: 'square' })]);
    list.push(['右三 收紧', N({ kind: 'turn', dir: 'R', grade: 3, mods: ['tightens'] })], ['左四 放开', N({ kind: 'turn', dir: 'L', grade: 4, mods: ['opens'] })]);
    list.push(['左五 过坡', N({ kind: 'turn', dir: 'L', grade: 5, mods: ['crest'] })], ['左四 别切', N({ kind: 'turn', dir: 'L', grade: 4, mods: ['dontcut'] })], ['右二 盲弯', N({ kind: 'turn', dir: 'R', grade: 2, mods: ['blind'] })]);
    list.push(['飞坡', N({ kind: 'jump', text: '飞坡' })], ['坡顶', N({ kind: 'crest', text: '坡顶' })], ['洼地', N({ kind: 'caution', text: '洼地' })], ['连续起伏', N({ kind: 'caution', text: '连续起伏' })], ['小心', N({ kind: 'caution', text: '小心' })], ['终点', N({ kind: 'finish', text: '终点' })]);
    for (const [label, n] of list) {
      const d = document.createElement('div');
      d.style.cssText = 'width:128px;display:flex;flex-direction:column;align-items:center;gap:6px;background:rgba(20,22,24,.62);padding:10px 4px;border-left:4px solid #e8b23a';
      d.innerHTML = \`<div style="width:72px;height:72px">\${noteIcon(n)}</div><div>\${label}</div>\`;
      root.appendChild(d);
    }
  
  })()`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'docs/screenshots/m2/hud-icons.jpg', type: 'jpeg', quality: 90, fullPage: true });
  console.log('saved docs/screenshots/m2/hud-icons.jpg');
} finally { await browser.close(); stop(); }
