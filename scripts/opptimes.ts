// npm run opptimes — precompute the robot reference runs (analog robot, skill 0.9: medal lines + split curves) for
// every stage variant × car into src/app/botTimes.json, so the medal targets and splits are there without waiting
// for the in-browser workers. Entries are keyed by the same hash of the simulation sources as the browser
// (src/app/botService.ts SIM_TAG): after a physics / stage change they are ignored and the workers take over again.
//   default: every stage × direction × weather × car (single stage / time challenge / career all covered)
//   --default-weather: only each stage's default weather (smaller table; the career's other weathers then run in the
//   workers)   --jobs N  parallel processes (default 6)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { simTag } from './simtag';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

interface Job { stage: string; reverse: boolean; weather: string; car: string; skill: number }

if (args[0] === '--worker') {
  // child: run the jobs given as JSON on stdin, print one JSON line per result
  const { CARS } = await import('../src/data/cars');
  const { stageDef } = await import('../src/sim/rally/catalog');
  const { runReference } = await import('../src/sim/rally/botTimes');
  const jobs: Job[] = JSON.parse(readFileSync(0, 'utf8'));
  for (const j of jobs) {
    const def = stageDef(j.stage, j.reverse, j.weather);
    if (!def || !CARS[j.car]) continue;
    const r = runReference(def, CARS[j.car], j.skill);
    process.stdout.write(JSON.stringify({ job: j, run: r }) + '\n');
  }
  process.exit(0);
}

const { listEnvs, listCars, variantId, carsInGroup, stageLength } = await import('../src/sim/rally/catalog');
const { botKey, REF_SKILL } = await import('../src/sim/rally/botTimes');
const { buildSeason } = await import('../src/sim/rally/career');
const tag = simTag();
const seen = new Set<string>();
const jobs: Job[] = [];
const add = (j: Job) => { const k = JSON.stringify(j); if (!seen.has(k)) { seen.add(k); jobs.push(j); } };
const envs = listEnvs();
// career first (the calendar's variants with the season's two cars), then every variant × car
for (let season = 0; season < 3; season++) {
  const plan = buildSeason(season, envs, stageLength);
  for (const r of plan.rallies) for (const sp of r.stages) for (const c of carsInGroup(season)) if (c.available) add({ stage: sp.id, reverse: sp.reverse, weather: sp.weather, car: c.id, skill: REF_SKILL });
}
for (const e of envs) for (const s of e.stages) {
  if (!s.available) continue;
  const weathers = args.includes('--default-weather') ? [s.defaultWeather] : s.weathers.filter((w) => w.available).map((w) => w.id);
  for (const reverse of s.reversible ? [false, true] : [false]) for (const weather of weathers) for (const c of listCars()) if (c.available) add({ stage: s.id, reverse, weather, car: c.id, skill: REF_SKILL });
}
const N = Math.max(1, Number(opt('jobs', '6')));
console.log(`sim tag ${tag}: ${jobs.length} robot runs on ${N} processes …`);
const out: Record<string, unknown> = {};
const t0 = Date.now();
let done = 0;
await Promise.all(Array.from({ length: N }, (_, w) => new Promise<void>((resolve) => {
  const mine = jobs.filter((_, i) => i % N === w);
  const p = spawn('npx', ['tsx', 'scripts/opptimes.ts', '--worker'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const { job, run } = JSON.parse(line) as { job: Job; run: { total: number } };
      out[botKey(tag, variantId(job.stage, job.reverse, job.weather), job.car, job.skill)] = run;
      if (++done % 10 === 0) console.log(`  ${done}/${jobs.length}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  });
  p.on('close', () => resolve());
  p.stdin.end(JSON.stringify(mine));
})));
// stable order (diff-friendly): by key
writeFileSync('src/app/botTimes.json', JSON.stringify(Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))));
console.log(`wrote ${Object.keys(out).length} entries to src/app/botTimes.json in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
