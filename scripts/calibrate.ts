// npm run calibrate — medal lines and the career's season points threshold (solo career: no rivals).
//   1. robot runs (cached in node_modules/.cache/dustmark-calibrate.json, keyed by the sim sources): every career
//      calendar stage × both cars of the season's group × the stand-ins for players (PLAYERS below)
//   2. per player: time against the reference (analog robot 0.9 = the game's medal reference), resets, the medal
//      distribution under MEDAL_RATIO, the medal points a season would bring (career rules, no restarts) and whether
//      that unlocks the next group (SEASON_UNLOCK_POINTS); plus the ratio percentiles the lines were set from.
//   Options: --jobs N (default 6)  --rank-only (no new robot runs)  --only a0.9,slow (subset of PLAYERS)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { simTag } from './simtag';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

interface Job { stage: string; reverse: boolean; weather: string; car: string; kind: string }
interface Run { total: number; time: number; resets: number; impacts: number; finished: boolean }

/** the stand-ins (src/sim/driver/bot.ts):
 *  a0.9   熟练玩家 — analog robot, skill 0.9 (wheel / pad, practised); also the medal reference itself
 *  a0.8   中间参考 — analog robot, skill 0.8
 *  slow   保守键盘玩家 — slow-hand keyboard robot (holds keys, ≥ 0.4 s between changes of a key, 0.2 s late), standard assists
 *  slowN  新手键盘玩家 — the same robot on novice assists */
const PLAYERS: Record<string, { name: string; driver: 'analog' | 'slow'; skill: number; assist?: 'standard' | 'novice' }> = {
  'a0.9': { name: '熟练玩家（模拟量 0.9）', driver: 'analog', skill: 0.9 },
  'a0.8': { name: '中间参考（模拟量 0.8）', driver: 'analog', skill: 0.8 },
  slow: { name: '保守键盘玩家（慢手，标准辅助）', driver: 'slow', skill: 0.9, assist: 'standard' },
  slowN: { name: '新手键盘玩家（慢手，新手辅助）', driver: 'slow', skill: 0.9, assist: 'novice' },
};

if (args[0] === '--worker') {
  const { CARS } = await import('../src/data/cars');
  const { stageDef } = await import('../src/sim/rally/catalog');
  const { runBot } = await import('../src/sim/driver/run');
  const jobs: Job[] = JSON.parse(readFileSync(0, 'utf8'));
  for (const j of jobs) {
    const def = stageDef(j.stage, j.reverse, j.weather), P = PLAYERS[j.kind];
    if (!def || !CARS[j.car] || !P) continue;
    const r = runBot(def, CARS[j.car], P.skill, { driver: P.driver, assist: P.assist });
    const run: Run = { total: Math.round(r.total * 100) / 100, time: Math.round(r.time * 100) / 100, resets: r.resets, impacts: r.impacts, finished: r.finished };
    process.stdout.write(JSON.stringify({ job: j, run }) + '\n');
  }
  process.exit(0);
}

const { listEnvs, carsInGroup, stageLength, variantId } = await import('../src/sim/rally/catalog');
const { buildSeason, MEDAL_POINTS, SEASON_UNLOCK_POINTS, STAGES_PER_RALLY, RALLIES_PER_SEASON } = await import('../src/sim/rally/career');
const { MEDAL_RATIO, medalFor } = await import('../src/sim/rally/scoring');

const tag = simTag();
const keyOf = (j: Job) => `${tag}|${variantId(j.stage, j.reverse, j.weather)}|${j.car}|${j.kind}:${JSON.stringify(PLAYERS[j.kind])}`;
const CACHE = 'node_modules/.cache/dustmark-calibrate.json';
const cache: Record<string, Run> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

const envs = listEnvs();
const plans = [0, 1, 2].map((s) => buildSeason(s, envs, stageLength));
const KINDS = opt('only', Object.keys(PLAYERS).join(',')).split(',').filter((k) => PLAYERS[k]);
if (!KINDS.includes('a0.9')) KINDS.unshift('a0.9');
const jobs: Job[] = [];
for (const plan of plans) for (const r of plan.rallies) for (const sp of r.stages) for (const c of carsInGroup(plan.season)) if (c.available)
  for (const kind of KINDS) { const j = { stage: sp.id, reverse: sp.reverse, weather: sp.weather, car: c.id, kind }; if (!cache[keyOf(j)] && !jobs.some((x) => keyOf(x) === keyOf(j))) jobs.push(j); }

if (jobs.length && !args.includes('--rank-only')) {
  const N = Math.max(1, Number(opt('jobs', '6')));
  // slow-hand runs cost ~50× an analog one: spread them evenly
  jobs.sort((a, b) => Number(PLAYERS[b.kind].driver === 'slow') - Number(PLAYERS[a.kind].driver === 'slow'));
  console.log(`sim tag ${tag}: ${jobs.length} robot runs on ${N} processes …`);
  const t0 = Date.now();
  let done = 0;
  await Promise.all(Array.from({ length: N }, (_, w) => new Promise<void>((resolve) => {
    const mine = jobs.filter((_, i) => i % N === w);
    const p = spawn('npx', ['tsx', 'scripts/calibrate.ts', '--worker'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const { job, run } = JSON.parse(line) as { job: Job; run: Run };
        cache[keyOf(job)] = run;
        if (++done % 10 === 0) { console.log(`  ${done}/${jobs.length}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`); mkdirSync('node_modules/.cache', { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache)); }
      }
    });
    p.on('close', () => resolve());
    p.stdin.end(JSON.stringify(mine));
  })));
  mkdirSync('node_modules/.cache', { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`robot runs done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const get = (sp: { id: string; reverse: boolean; weather: string }, car: string, kind: string) => cache[keyOf({ stage: sp.id, reverse: sp.reverse, weather: sp.weather, car, kind })];
const pct = (x: number) => `${Math.round(x * 100)}%`;
const q = (xs: number[], f: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(f * s.length)))] : NaN; };
const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '—');

// ---- every (season, stage, car) cell per player ----
interface Cell { season: number; rally: number; k: number; car: string; ref: number; run: Run; ratio: number }
const cells: Record<string, Cell[]> = {};
for (const kind of KINDS) {
  cells[kind] = [];
  for (const plan of plans) plan.rallies.forEach((r, ri) => r.stages.forEach((sp, k) => { for (const c of carsInGroup(plan.season)) {
    const a = get(sp, c.id, 'a0.9'), me = get(sp, c.id, kind);
    if (a && me) cells[kind].push({ season: plan.season, rally: ri, k, car: c.id, ref: a.total, run: me, ratio: me.total / a.total });
  } }));
}

console.log(`\n## 代理相对参考成绩（模拟量 0.9，同车同赛段同天气）：生涯赛历 ${plans.reduce((n, p) => n + p.rallies.length * STAGES_PER_RALLY, 0)} 个赛段 × 组内两车`);
console.log('| 代理 | 跑数 | 完赛 | 零重置 | 用时比 中位 | 平均 | 10% | 25% | 75% | 90% | 零重置跑的 70% 分位 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const kind of KINDS) {
  const cs = cells[kind], xs = cs.map((c) => c.ratio), clean = cs.filter((c) => c.run.resets === 0);
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  console.log(`| ${PLAYERS[kind].name} | ${cs.length} | ${cs.filter((c) => c.run.finished).length} | ${clean.length} (${pct(clean.length / Math.max(1, cs.length))}) | ${r3(q(xs, 0.5))} | ${r3(mean)} | ${r3(q(xs, 0.1))} | ${r3(q(xs, 0.25))} | ${r3(q(xs, 0.75))} | ${r3(q(xs, 0.9))} | ${r3(q(clean.map((c) => c.ratio), 0.7))} |`);
}
for (const kind of KINDS) {
  const rs = cells[kind].filter((c) => c.run.resets > 0);
  if (rs.length && PLAYERS[kind].driver === 'slow') console.log(`  ${PLAYERS[kind].name} 有重置的跑：${rs.map((c) => `S${c.season + 1}R${c.rally + 1}SS${c.k + 1} ${c.car} R${c.run.resets}`).join('，')}`);
}

console.log(`\n## 奖牌（金 ×${MEDAL_RATIO.gold} / 银 ×${MEDAL_RATIO.silver} / 铜 ×${MEDAL_RATIO.bronze} 参考成绩）`);
console.log('| 代理 | 金 | 银及以上 | 铜及以上 | 无奖牌 | 零重置跑拿到铜及以上 |');
console.log('|---|---|---|---|---|---|');
for (const kind of KINDS) {
  const cs = cells[kind], n = Math.max(1, cs.length);
  const m = cs.map((c) => (c.run.finished ? medalFor(c.run.total, c.ref) : null));
  const clean = cs.filter((c) => c.run.resets === 0), cleanM = clean.filter((c) => c.run.finished && medalFor(c.run.total, c.ref));
  console.log(`| ${PLAYERS[kind].name} | ${pct(m.filter((x) => x === 'gold').length / n)} | ${pct(m.filter((x) => x === 'gold' || x === 'silver').length / n)} | ${pct(m.filter((x) => x).length / n)} | ${pct(m.filter((x) => !x).length / n)} | ${cleanM.length}/${clean.length} (${pct(cleanM.length / Math.max(1, clean.length))}) |`);
}

// ---- season points: every stage of the season once, no restarts (the robot runs start on a new car each stage) ----
console.log(`\n## 赛季分数（金 ${MEDAL_POINTS.gold} / 银 ${MEDAL_POINTS.silver} / 铜 ${MEDAL_POINTS.bronze} / 完赛 0；满分 ${RALLIES_PER_SEASON * STAGES_PER_RALLY * MEDAL_POINTS.gold}；解锁门槛 ${SEASON_UNLOCK_POINTS.join(' / ')} 分）`);
console.log(`| 代理 | ${plans.map((p) => `赛季 ${p.season + 1}（每台车）`).join(' | ')} | 三季都过 |`);
console.log(`|---|${plans.map(() => '---').join('|')}|---|`);
for (const kind of KINDS) {
  let allOk = true;
  const cols = plans.map((plan) => carsInGroup(plan.season).filter((c) => c.available).map((c) => {
    const cs = cells[kind].filter((x) => x.season === plan.season && x.car === c.id);
    const pts = cs.reduce((a, x) => { const m = x.run.finished ? medalFor(x.run.total, x.ref) : null; return a + (m ? MEDAL_POINTS[m] : 0); }, 0);
    const ok = pts >= SEASON_UNLOCK_POINTS[plan.season];
    if (!ok) allOk = false;
    return `${c.id} ${pts}${ok ? '' : ' ✗'}${cs.length < RALLIES_PER_SEASON * STAGES_PER_RALLY ? `（${cs.length} 段）` : ''}`;
  }).join('，'));
  console.log(`| ${PLAYERS[kind].name} | ${cols.join(' | ')} | ${allOk ? '是' : '否'} |`);
}
