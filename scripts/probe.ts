// npm run probe -- [name|all] [--car kestrel] [--drive awd|fwd|rwd] [--assist novice|standard|hardcore] [--json]
// Handling acceptance probes (DESIGN.md §4). Runs in Node on test pads, prints measured numbers.
import { CARS, withDrive, type Drive } from '../src/data/cars';
import { PROBES, setProbeAssist } from '../src/sim/vehicle/probes';
import type { AssistLevel } from '../src/sim/vehicle/controls';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const name = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? 'all';
let spec = CARS[opt('car') ?? 'kestrel'];
if (!spec) { console.error('unknown car'); process.exit(2); }
if (opt('drive')) spec = withDrive(spec, opt('drive') as Drive);
if (opt('assist')) setProbeAssist(opt('assist') as AssistLevel);
const names = name === 'all' ? Object.keys(PROBES) : name.split(',');
let fails = 0;
const out: unknown[] = [];
for (const n of names) {
  const p = PROBES[n];
  if (!p) { console.error(`unknown probe ${n}; have ${Object.keys(PROBES).join(', ')}`); process.exit(2); }
  const t0 = performance.now();
  const r = p(spec);
  out.push(r);
  if (!r.pass) fails++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(10)} ${r.summary}  (${(performance.now() - t0).toFixed(0)} ms)`);
}
if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
console.log(`\n${spec.name} ${spec.model} (${spec.drive}, assist ${opt('assist') ?? 'standard'}): ${names.length - fails}/${names.length} probes pass`);
process.exit(fails ? 1 : 0);
