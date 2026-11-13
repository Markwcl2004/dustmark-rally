// dev tool (奖牌线校准任务): drive the analog robot through one stage and print what happens around every impact / reset.
//   npx tsx scripts/bottrace.ts --stage coast-1 --car pipit [--skill 0.9] [--from 850 --to 920]  (dump every 0.1 s in a range)
import { CARS } from '../src/data/cars';
import { STAGES } from '../src/data/stages';
import { World } from '../src/sim/world';
import { Bot } from '../src/sim/driver/bot';
import { DS } from '../src/sim/stage/centerline';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const w = new World(STAGES[opt('stage', 'coast-1')], CARS[opt('car', 'pipit')]);
w.car.assists.counterSteer = false;
const bot = new Bot(w.stage, w.car, { skill: +opt('skill', '0.9') });
const from = +opt('from', '-1'), to = +opt('to', '-1');
const hist: string[] = [];
const st = w.stage;
const line = () => {
  const c = w.car, s = w.session.progressS, i = Math.min(bot.vTarget.length - 1, Math.max(0, Math.round(s / DS)));
  const nr = st.terrain.nearest(c.pos.x, c.pos.z);
  const inp = c.controls;
  return `t ${w.session.time.toFixed(2)} s ${s.toFixed(1)} v ${(c.speed * 3.6).toFixed(0)} vt ${(bot.vTarget[i] * 3.6).toFixed(0)} d ${nr.d.toFixed(2)} line ${bot.line[i].toFixed(2)} k ${st.pointAt(s).kappa.toFixed(4)} β ${(c.slideAngle * 57.3).toFixed(0)} yaw ${c.yawRate.toFixed(2)} thr ${inp.throttle?.toFixed?.(2) ?? '-'} brk ${inp.brake?.toFixed?.(2) ?? '-'} st ${(bot as any).input?.steer?.toFixed(2)} g ${c.gear ?? ''} hit ${c.events.obstacleHit.toFixed(1)}`;
};
let last = '';
while (w.session.phase !== 'finished' && w.tick < 120 * 700) {
  w.step(bot.drive(w));
  const r = bot.wantsReset(w);
  if (w.tick % 12 === 0) { hist.push(line()); if (hist.length > 40) hist.shift(); }
  const s = w.session.progressS;
  if (from >= 0 && s >= from && s <= to && w.tick % 12 === 0) console.log(line());
  if (w.car.events.obstacleHit > 3 && w.session.phase === 'running') {
    const l = line();
    if (l !== last) console.log(`IMPACT ${w.car.events.obstacleHit.toFixed(1)} m/s  ${l}`);
    last = l;
  }
  if (r) {
    console.log(`RESET at s ${s.toFixed(0)} — last 4 s:`);
    for (const h of hist) console.log('   ' + h);
    w.session.resetCar(w.car);
  }
}
console.log(`finished ${w.session.phase} time ${w.session.time.toFixed(2)} resets ${w.session.resets} impacts ${w.session.impacts}`);
