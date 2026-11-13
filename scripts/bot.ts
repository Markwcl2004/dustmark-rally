// npm run bot -- --stage north-1 --car kestrel --skill 0.9 [--keys | --driver analog|keys|slow] [--assist novice|standard|hardcore] [--compare] [--trace]
// Runs the robot driver through a whole stage in Node: time, finished?, accidents, state hash.
//   --keys / --driver keys   keyboard robot: only 0/1 keys with human reaction delay and key timing, standard assists
//   --driver slow            slow hand (手感重做): holds keys, ≤ 2.5 changes/s per key, 0.2 s late, no self-prediction
//   --compare  run analog + the chosen keyboard robot and report its time relative to the analog one
import { CARS } from '../src/data/cars';
import { DEFAULT_STAGE, STAGES } from '../src/data/stages';
import { runBot, type BotRunResult, type DriverKind } from '../src/sim/driver/run';
import type { AssistLevel } from '../src/sim/vehicle/controls';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const stage = STAGES[opt('stage', DEFAULT_STAGE)];
const car = CARS[opt('car', 'kestrel')];
if (!stage || !car) { console.error(`unknown stage/car. stages: ${Object.keys(STAGES)} cars: ${Object.keys(CARS)}`); process.exit(2); }
const skill = +opt('skill', args.includes('slow') ? '0.9' : '0.9');
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const clean = (r: BotRunResult) => r.finished && r.resets === 0 && r.impacts === 0 && r.rollovers === 0;

const kind = (args.includes('--keys') ? 'keys' : opt('driver', 'analog')) as DriverKind;
const assist = opt('assist', 'standard') as AssistLevel;
function run(driver: DriverKind) {
  const t0 = performance.now();
  const r = runBot(stage, car, skill, { driver, assist });
  const ms = performance.now() - t0;
  console.log(`[${driver}${driver === 'analog' ? '' : ', ' + assist}] stage ${stage.id} 「${stage.name}」  car ${car.name} ${car.model}  skill ${skill}`);
  console.log(`finished: ${r.finished}   time ${fmt(r.time)}   total ${fmt(r.total)} (penalties ${r.penalties}s, resets ${r.resets})`);
  console.log(`top speed ${r.topSpeedKmh.toFixed(1)} km/h   avg ${r.avgSpeedKmh.toFixed(1)} km/h   impacts ${r.impacts}   rollovers ${r.rollovers}   off-road ${r.offRoadS.toFixed(1)} s` + (r.pressRate !== undefined ? `   key ${driver === 'slow' ? 'changes' : 'presses'} ${r.pressRate.toFixed(1)}/s` : '') + (r.maxKeyRate !== undefined ? ` (one key: max ${r.maxKeyRate} in any 1 s)` : ''));
  console.log(`state hash ${r.hash}   ticks ${r.ticks}   sim ${(ms / r.ticks * 1000).toFixed(1)} µs/tick (${ms.toFixed(0)} ms incl. stage build)`);
  if (args.includes('--trace')) for (const t of r.trace) console.log(t.join('\t'));
  return r;
}

if (args.includes('--compare')) {
  const kd = kind === 'analog' ? 'keys' : kind;
  const lim = kd === 'slow' ? 0.15 : 0.12;
  const a = run('analog'), k = run(kd);
  const rel = k.total / a.total - 1;
  const ok = clean(a) && clean(k) && rel <= lim;
  console.log(`\n${kd} vs analog: ${fmt(k.total)} vs ${fmt(a.total)}  (${rel >= 0 ? '+' : ''}${(rel * 100).toFixed(1)} %, target ≤ +${lim * 100} %)  ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}
const r = run(kind);
process.exit(clean(r) ? 0 : 1);
