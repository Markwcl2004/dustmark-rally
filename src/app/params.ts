// URL parameters for direct entry (DESIGN.md §11): ?stage=&car=&weather=&cam=&bot=1&t=  (+ s, v, pause, quality, scale, dynres, bench, hud, view)
import { DEFAULT_STAGE } from '../data/stages';
import type { CamMode } from '../render/camera';

const q = new URLSearchParams(location.search);
/** the URL names this parameter explicitly (it then overrides the saved settings) */
export const urlHas = (k: string) => q.has(k);
/** the URL asks for a direct start (tools: shots / bench / bot / tour …): skip the title and menus */
export const directStart = ['stage', 'view', 'bot', 'bench', 's', 't', 'cam', 'car'].some((k) => q.has(k));
const num = (k: string) => (q.has(k) && q.get(k) !== '' ? Number(q.get(k)) : undefined);

export const params = {
  view: q.get('view') ?? 'stage',
  stage: q.get('stage') ?? DEFAULT_STAGE,
  car: q.get('car') ?? 'kestrel',
  /** M1 has one lighting setup ("clear evening"); other values are accepted and reported */
  weather: q.get('weather') ?? 'clear',
  cam: (q.get('cam') as CamMode | null) ?? undefined,
  bot: q.get('bot') === '1',
  /** fast-forward the sim to this stage time (s) before showing */
  t: num('t'),
  /** teleport to this distance along the road (m from stage start), skipping the countdown */
  s: num('s'),
  /** initial speed in km/h when teleporting */
  v: num('v'),
  /** with s: start yawed this many degrees off the road heading (+ = nose right), still moving along the road → instant slide */
  yaw: num('yaw'),
  /** cam=tv: trackside camera at this distance along the road (m from start), side offset and height */
  tvS: num('tvs'), tvD: num('tvd') ?? 11, tvH: num('tvh') ?? 2.5,
  pause: q.get('pause') === '1',
  quality: q.get('quality') ?? 'default',
  scale: num('scale'),
  dynres: q.get('dynres') !== '0',
  bench: q.get('bench') === '1',
  hud: q.get('hud') !== '0',
  livery: num('livery') ?? 0,
  angle: num('angle'),
  elev: num('elev'),
  perf: q.get('perf') === '1',
  /** driving assists: novice | standard | hardcore (DESIGN §4) */
  assist: (['novice', 'standard', 'hardcore'].includes(q.get('assist') ?? '') ? q.get('assist') : 'standard') as 'novice' | 'standard' | 'hardcore',
  /** co-driver: call this many seconds of road ahead (default 4) */
  callEarly: num('callearly') ?? 4,
  /** co-driver voice pack under public/assets/voice/ */
  voice: q.get('voice') ?? 'meijia',
  /** start muted (M toggles) */
  mute: q.get('mute') === '1',
  /** trajectory prediction (P toggles the saved setting; the URL wins at the start of a direct run) and its horizon in s (1.5–4) */
  predict: q.has('predict') ? q.get('predict') !== '0' : undefined,
  predictT: num('predictT') ?? 2.5,
  /** menus / smoke tests: sim fast-forward factor (robot driving only), unlock everything, open a screen directly */
  ff: Math.max(1, Math.min(32, num('ff') ?? 1)),
  unlock: q.get('unlock') === '1',
  /** menus: the robot drives the runs started from the menus (smoke tests); ?bot=1 would skip the menus */
  ai: q.get('ai') === '1',
  screen: q.get('screen') ?? '',
  /** intro=0: never show the first-run "怎么开" card (screenshot tools) */
  intro: q.get('intro') !== '0',
};
