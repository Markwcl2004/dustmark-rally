// Headless bot run of a full stage (used by `npm run bot`, `npm run botmatrix`, tests, the medal-line reference times).
import type { CarSpec } from '../../data/cars';
import type { StageDef } from '../stage/script';
import { World } from '../world';
import { Bot, KeyBot, SlowKeyBot } from './bot';
import { assistsFor, type AssistLevel } from '../vehicle/controls';

export interface BotRunResult {
  finished: boolean;
  time: number;
  total: number;
  penalties: number;
  resets: number;
  impacts: number;
  rollovers: number;
  topSpeedKmh: number;
  avgSpeedKmh: number;
  offRoadS: number;
  hash: string;
  ticks: number;
  /** key presses per second (keyboard robot) / key state changes per second (slow hand) */
  pressRate?: number;
  /** slow hand: most state changes one key made within any one second */
  maxKeyRate?: number;
  /** progress samples every second: [t, s, kmh] */
  trace: [number, number, number][];
}

export type DriverKind = 'analog' | 'keys' | 'slow';

export interface BotRunOpts {
  /** drive with 0/1 keys through a human-like key hand (standard assists on) instead of analog inputs */
  keys?: boolean;
  /** which robot: analog (pad-like), keys (quick keyboard hand), slow (holds keys, ≤ 2.5 changes/s, 0.2 s late) */
  driver?: DriverKind;
  /** assist level for the keyboard robots (default standard) */
  assist?: AssistLevel;
  maxTime?: number;
  onTick?: (w: World) => void;
}

export function runBot(stage: StageDef, car: CarSpec, skill = 0.9, opts: BotRunOpts = {}): BotRunResult {
  const { maxTime = 600, onTick } = opts;
  const w = new World(stage, car);
  const kind: DriverKind = opts.driver ?? (opts.keys ? 'keys' : 'analog');
  const bot = kind === 'keys' ? new KeyBot(w.stage, w.car, { skill }) : kind === 'slow' ? new SlowKeyBot(w.stage, w.car, { skill }) : new Bot(w.stage, w.car, { skill });
  if (opts.assist) w.car.assists = assistsFor(opts.assist);
  // the analog robot compensates the slide itself; the keyboard robots play with the assists (default standard)
  if (kind === 'analog') w.car.assists.counterSteer = false;
  const trace: [number, number, number][] = [];
  const maxTicks = Math.round((maxTime + 3) * 120);
  while (w.session.phase !== 'finished' && w.tick < maxTicks) {
    const inp = bot.drive(w);
    w.step(inp);
    if (bot.wantsReset(w)) w.session.resetCar(w.car);
    if (w.tick % 120 === 0) trace.push([+w.session.time.toFixed(2), +w.session.progressS.toFixed(1), +(w.car.speed * 3.6).toFixed(1)]);
    onTick?.(w);
  }
  const s = w.session;
  return {
    finished: s.phase === 'finished',
    time: s.finishTime || s.time,
    total: s.total,
    penalties: s.penalties,
    resets: s.resets,
    impacts: s.impacts,
    rollovers: s.rollovers,
    topSpeedKmh: s.topSpeed * 3.6,
    avgSpeedKmh: (w.stage.length / Math.max(1, s.finishTime || s.time)) * 3.6,
    offRoadS: s.offRoadTime,
    hash: w.hash(),
    pressRate: bot instanceof KeyBot ? bot.hand.presses / Math.max(1, s.finishTime || s.time) : bot instanceof SlowKeyBot ? bot.hand.changes / Math.max(1, s.finishTime || s.time) : undefined,
    maxKeyRate: bot instanceof SlowKeyBot ? bot.hand.maxPerSecond : undefined,
    ticks: w.tick,
    trace,
  };
}

/** reference split curve: stage time at every `step` metres from the start line (analog robot) */
export function refTimes(stage: StageDef, car: CarSpec, skill = 0.9, step = 10): { step: number; times: Float32Array; total: number } {
  const w = new World(stage, car);
  w.car.assists.counterSteer = false;
  const bot = new Bot(w.stage, w.car, { skill });
  const n = Math.ceil(w.stage.length / step) + 1;
  const times = new Float32Array(n).fill(-1);
  let k = 0;
  const maxTicks = 120 * 900;
  while (w.session.phase !== 'finished' && w.tick < maxTicks) {
    w.step(bot.drive(w));
    if (bot.wantsReset(w)) w.session.resetCar(w.car);
    const d = w.session.maxProgressS - w.stage.startS;
    while (k < n && d >= k * step) { times[k] = Math.max(0, w.session.time); k++; }
  }
  const total = w.session.finishTime || w.session.time;
  for (; k < n; k++) times[k] = total;
  return { step, times, total: total + w.session.penalties };
}
