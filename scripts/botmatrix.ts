// npm run botmatrix -- [--stages a,b] [--cars a,b] [--keys | --driver analog|keys|slow] [--assist novice|standard|hardcore] [--skill 0.9] [--reverse] [--weather] [--json out.json] [--jobs N]
// Robot over every stage that exists × every car: time, finished, resets, impacts. Markdown table to stdout.
// Default: forward runs in each stage's default weather; --reverse adds the -r runs, --weather the @weather variants.
// --driver slow: the slow-hand keyboard robot (手感重做), the stand-in for a person; its column of the acceptance matrix.
// --jobs N: run on N child processes (default 1 = in this process); results are identical (the sim is deterministic).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { CAR_ORDER, CARS } from '../src/data/cars';
import { STAGES } from '../src/data/stages';
import { runBot, type DriverKind } from '../src/sim/driver/run';
import type { AssistLevel } from '../src/sim/vehicle/controls';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const driver = (args.includes('--keys') ? 'keys' : opt('driver') ?? 'analog') as DriverKind;
const assist = (opt('assist') ?? 'standard') as AssistLevel;
const skill = +(opt('skill') ?? 0.9);
interface Row { stage: string; car: string; finished: boolean; time: number; total: number; resets: number; impacts: number; offRoad: number; keyRate?: number }
const one = (s: string, c: string): Row => {
  const r = runBot(STAGES[s], CARS[c], skill, { driver, assist });
  return { stage: s, car: c, finished: r.finished, time: r.time, total: r.total, resets: r.resets, impacts: r.impacts, offRoad: r.offRoadS, keyRate: r.maxKeyRate };
};

if (args[0] === '--worker') {
  const jobs: [string, string][] = JSON.parse(readFileSync(0, 'utf8'));
  for (const [s, c] of jobs) process.stdout.write(JSON.stringify(one(s, c)) + '\n');
  process.exit(0);
}

const stages = (opt('stages')?.split(',') ?? Object.keys(STAGES)).filter((id) => STAGES[id] && (args.includes('--weather') || !id.includes('@')) && (args.includes('--reverse') || !id.endsWith('-r') || opt('stages')?.split(',').includes(id)));
const cars = opt('cars')?.split(',') ?? [...CAR_ORDER];
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const N = Math.max(1, Number(opt('jobs') ?? 1));
const all: [string, string][] = stages.flatMap((s) => cars.map((c) => [s, c] as [string, string]));
const got = new Map<string, Row>();
if (N === 1) for (const [s, c] of all) got.set(`${s}|${c}`, one(s, c));
else {
  const passArgs = args.filter((a, i) => !['--jobs', '--json'].includes(a) && !['--jobs', '--json'].includes(args[i - 1]));
  await Promise.all(Array.from({ length: N }, (_, w) => new Promise<void>((resolve) => {
    const mine = all.filter((_, i) => i % N === w);
    if (!mine.length) return resolve();
    const p = spawn('npx', ['tsx', 'scripts/botmatrix.ts', '--worker', ...passArgs], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const r = JSON.parse(buf.slice(0, i)) as Row; buf = buf.slice(i + 1); got.set(`${r.stage}|${r.car}`, r); }
    });
    p.on('close', () => resolve());
    p.stdin.end(JSON.stringify(mine));
  })));
}
console.log(`| 赛段 | ${cars.join(' | ')} |`);
console.log(`|---|${cars.map(() => '---').join('|')}|`);
let bad = 0;
const rows: Row[] = [];
for (const s of stages) {
  const cells: string[] = [];
  for (const c of cars) {
    const r = got.get(`${s}|${c}`);
    if (!r) { cells.push('—'); bad++; continue; }
    rows.push(r);
    const ok = r.finished && r.resets === 0 && r.impacts === 0;
    if (!ok) bad++;
    cells.push(`${r.finished ? fmt(r.time) : 'DNF'}${r.resets ? ` R${r.resets}` : ''}${r.impacts ? ` I${r.impacts}` : ''}`);
  }
  console.log(`| ${s} | ${cells.join(' | ')} |`);
}
console.log(`\n${driver} robot (${driver === 'analog' ? 'pad' : assist + ' assists'}), skill ${skill}: ${stages.length * cars.length - bad}/${stages.length * cars.length} clean (R = resets, I = impacts > 3 m/s)`);
if (opt('json')) writeFileSync(opt('json')!, JSON.stringify(rows));
