// Career (DESIGN §6 玩法 1): three seasons = 入门组 / 经典组 / 顶级组; four rallies a season (one per environment);
// three stages a rally (direction / weather combinations, longer and harsher in later seasons). Solo — no rivals
// (user decision 2026-11-12): every stage is timed against the medal lines (robot reference × MEDAL_RATIO), a medal
// is worth MEDAL_POINTS, and SEASON_UNLOCK_POINTS of a season unlock the next group and its cars (last season: the
// career is won). One restart per rally. No car damage and no service park (user decision 2026-11-12).
// Pure state + functions; the reference time of each stage comes in from outside (robot runs, botTimes.ts).
import type { EnvInfo } from './catalog';
import { medalFor, medalRank, type Medal } from './scoring';

export const SEASONS = 3;
export const RALLIES_PER_SEASON = 4;
export const STAGES_PER_RALLY = 3;
/** restarts per rally */
export const RESTARTS_PER_RALLY = 1;

/** medal → season points (a finish without a medal, or a retirement, is 0) */
export const MEDAL_POINTS = { gold: 3, silver: 2, bronze: 1 } as const;
/** points a season needs to unlock the next group (last season: to win the career). Set with `npm run calibrate`:
 *  the slow-hand keyboard robot on standard assists makes every season with either car, first try, no restarts, with
 *  2–5 points to spare (it scored 13–15 / 8–10 / 8–11 a season; on novice assists 10–13 / 9 / 11–13) */
export const SEASON_UNLOCK_POINTS = [8, 6, 6];
/** the most a season can give */
export const SEASON_MAX_POINTS = RALLIES_PER_SEASON * STAGES_PER_RALLY * MEDAL_POINTS.gold;
export const medalPoints = (m: Medal) => (m ? MEDAL_POINTS[m] : 0);

export const SEASON_CN = ['第一赛季 · 入门组', '第二赛季 · 经典组', '第三赛季 · 顶级组'];
const RALLY_NAME: Record<string, string> = { north: '松岭拉力赛', savanna: '赤土拉力赛', snow: '雪岭冬季拉力赛', coast: '山海拉力赛' };

export interface StagePlan { id: string; reverse: boolean; weather: string }
export interface RallyPlan { env: string; name: string; stages: StagePlan[] }
export interface SeasonPlan { season: number; group: number; rallies: RallyPlan[] }

export interface StageResult {
  /** stage time incl. penalties (s); a retirement keeps the time it had */
  total: number;
  /** of which penalties on the stage (s) */
  penalties: number;
  /** medal-line reference (robot 0.9, s) the medal was judged on; null if it was not available */
  ref: number | null;
  medal: Medal;
  points: number;
  retired?: boolean;
}

export interface RallyProgress {
  plan: RallyPlan;
  /** index of the next stage to run (STAGES_PER_RALLY = all done) */
  stage: number;
  results: StageResult[];
  /** carried from stage to stage */
  restartsLeft: number;
  /** a stage was started and not finished (window closed / quit): resumes at that stage's start */
  inStage?: boolean;
}

export interface RallySummary { env: string; name: string; medals: Medal[]; points: number; /** sum of the stage times (s) */ time: number }

export interface CareerState {
  season: number;
  /** index of the current (or next) rally in the season */
  rally: number;
  car: string;
  livery: number;
  plan: SeasonPlan;
  /** medal points this season */
  points: number;
  rallies: RallySummary[];
  current: RallyProgress | null;
  history: { season: number; points: number; qualified: boolean }[];
  /** all three seasons done, the last one with enough points */
  champion: boolean;
  /** the season's final result once computed (set by finishSeason, cleared by nextSeason) */
  seasonEnd?: SeasonEnd | null;
}

export interface SeasonEnd { points: number; need: number; qualified: boolean; unlockGroup: number | null; careerDone: boolean }

// ---- calendar ----

/** per season, three picks per rally: [stage rank by length (short → long), reverse?, weather index] */
const TEMPLATES: [number, boolean, number][][] = [
  [[0, false, 0], [1, false, 0], [0, true, 1]],
  [[1, false, 0], [2, false, 1], [1, true, 2]],
  [[2, false, 1], [2, true, 2], [1, true, 0]],
];

/** season calendar from the catalogue. Environments without stages yet borrow another environment's stages
 *  (so the career is playable while content is still being added); the rally then runs there. */
export function buildSeason(season: number, envs: EnvInfo[], lengthOf: (id: string, reverse: boolean) => number): SeasonPlan {
  const avail = (e: EnvInfo) => e.stages.filter((s) => s.available);
  const playable = envs.filter((e) => avail(e).length > 0);
  const rallies: RallyPlan[] = [];
  const order = envs.slice(0, RALLIES_PER_SEASON);
  order.forEach((slot, ri) => {
    const env = avail(slot).length ? slot : playable[ri % Math.max(1, playable.length)];
    if (!env) return;
    const stages = [...avail(env)].sort((a, b) => lengthOf(a.id, false) - lengthOf(b.id, false));
    const weathers = env.weathers.filter((w) => w.available);
    const wIds = weathers.length ? weathers.map((w) => w.id) : ['clear'];
    const picks: StagePlan[] = [];
    for (const [rk, rev, wi] of TEMPLATES[Math.min(season, TEMPLATES.length - 1)]) {
      // a borrowed environment shifts its picks so the rallies differ
      const shift = env === slot ? 0 : ri;
      const st = stages[Math.min(stages.length - 1, rk + shift) % stages.length];
      const reverse = rev && st.reversible;
      let weather = wIds[(wi + shift) % wIds.length];
      // the same stage + direction twice in a rally: vary the weather (or the direction) if possible
      for (let k = 0; picks.some((p) => p.id === st.id && p.reverse === reverse && p.weather === weather) && k < wIds.length; k++) weather = wIds[(wi + shift + k + 1) % wIds.length];
      picks.push({ id: st.id, reverse, weather });
    }
    rallies.push({ env: env.id, name: (env === slot ? '' : '加赛 · ') + (RALLY_NAME[env.id] ?? `${env.name}拉力赛`), stages: picks });
  });
  return { season, group: season, rallies };
}

// ---- state machine ----

export function newCareer(car: string, livery: number, plan: SeasonPlan): CareerState {
  return { season: plan.season, rally: 0, car, livery, plan, points: 0, rallies: [], current: null, history: [], champion: false };
}

export function currentRallyPlan(c: CareerState): RallyPlan | undefined { return c.current?.plan ?? c.plan.rallies[c.rally]; }
export const seasonOver = (c: CareerState) => c.rally >= c.plan.rallies.length;

export function startRally(c: CareerState): RallyProgress {
  const plan = c.plan.rallies[c.rally];
  if (!plan) throw new Error('season over');
  c.current = { plan, stage: 0, results: [], restartsLeft: RESTARTS_PER_RALLY };
  return c.current;
}

/** what a stage finished now counts: medal and points */
export function judgeStage(player: { total: number; retired?: boolean }, ref: number | null) {
  const medal = player.retired ? null : medalFor(player.total, ref);
  return { medal, points: medalPoints(medal) };
}

/** stage just finished (or retired): store the time, medal and points */
export function recordStage(c: CareerState, player: { total: number; penalties: number; retired?: boolean }, ref: number | null): StageResult {
  const r = c.current;
  if (!r || r.stage >= r.plan.stages.length) throw new Error('no stage to record');
  const j = judgeStage(player, ref);
  const res: StageResult = { total: player.total, penalties: player.penalties, ref, medal: j.medal, points: j.points, retired: player.retired || undefined };
  r.results.push(res);
  r.stage++;
  return res;
}

export const rallyPoints = (r: RallyProgress) => r.results.reduce((s, x) => s + x.points, 0);
export const rallyTime = (r: RallyProgress) => r.results.reduce((s, x) => s + x.total, 0);

/** all stages done → medals and points into the season; advances to the next rally */
export function finishRally(c: CareerState): RallySummary {
  const r = c.current;
  if (!r || r.stage < r.plan.stages.length) throw new Error('rally not finished');
  const sum: RallySummary = { env: r.plan.env, name: r.plan.name, medals: r.results.map((x) => x.medal), points: rallyPoints(r), time: Math.round(rallyTime(r) * 100) / 100 };
  c.points += sum.points;
  c.rallies.push(sum);
  c.rally++;
  c.current = null;
  return sum;
}

/** season points so far, what unlocks, and how many stages are left to get there */
export function seasonProgress(c: CareerState) {
  const need = SEASON_UNLOCK_POINTS[Math.min(c.season, SEASON_UNLOCK_POINTS.length - 1)];
  const points = c.points + (c.current ? rallyPoints(c.current) : 0);
  const stagesLeft = (c.plan.rallies.length - c.rally) * STAGES_PER_RALLY - (c.current?.stage ?? 0);
  const last = c.season >= SEASONS - 1;
  return { points, need, max: SEASON_MAX_POINTS, toGo: Math.max(0, need - points), stagesLeft, reached: points >= need, reachable: points + stagesLeft * MEDAL_POINTS.gold >= need, last };
}

/** medals of the season so far (finished rallies + the current one) */
export function seasonMedals(c: CareerState) {
  const n = { gold: 0, silver: 0, bronze: 0, none: 0 };
  const all = [...c.rallies.flatMap((x) => x.medals), ...(c.current?.results.map((x) => x.medal) ?? [])];
  for (const m of all) n[m ?? 'none']++;
  return n;
}

/** season over → points against the unlock threshold; enough points unlock the next group (or win the career) */
export function finishSeason(c: CareerState): SeasonEnd {
  if (c.seasonEnd) return c.seasonEnd;
  const need = SEASON_UNLOCK_POINTS[Math.min(c.season, SEASON_UNLOCK_POINTS.length - 1)];
  const qualified = c.points >= need;
  const last = c.season >= SEASONS - 1;
  c.history.push({ season: c.season, points: c.points, qualified });
  if (qualified && last) c.champion = true;
  c.seasonEnd = { points: c.points, need, qualified, unlockGroup: qualified && !last ? c.season + 1 : null, careerDone: qualified && last };
  return c.seasonEnd;
}

/** next season (after enough points) or the same season again (after missing them) */
export function nextSeason(c: CareerState, plan: SeasonPlan, car: string, livery: number) {
  c.season = plan.season; c.plan = plan; c.rally = 0; c.points = 0; c.rallies = []; c.current = null; c.seasonEnd = null;
  c.car = car; c.livery = livery;
}

/** restart the current stage (career): uses up the rally's restart */
export function useRestart(r: RallyProgress) {
  if (r.restartsLeft <= 0) return false;
  r.restartsLeft--;
  return true;
}

/** the best medal of a list */
export const bestMedal = (ms: Medal[]) => ms.reduce<Medal>((b, m) => (medalRank(m) > medalRank(b) ? m : b), null);

/** a career from an older save (rivals, positions and a points table per driver): keep the season, car, livery and
 *  the seasons already run; the current season starts again from its first rally (its old results were positions
 *  against rivals, which no longer exist). Anything unreadable → null (no career). */
export function normalizeCareer(raw: unknown, rebuild: (season: number) => SeasonPlan): CareerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, any>;
  const season = Math.max(0, Math.min(SEASONS - 1, Number(o.season) || 0));
  if (typeof o.car !== 'string') return null;
  const solo = typeof o.points === 'number' && Array.isArray(o.rallies) && o.rallies.every((x: any) => x && Array.isArray(x.medals)) &&
    (!o.current || (Array.isArray(o.current.results) && o.current.results.every((x: any) => x && typeof x.total === 'number' && 'medal' in x)));
  if (solo && o.plan && Array.isArray(o.plan.rallies)) {
    // fields of the car-damage / service-park era are dropped (a late-service penalty already added stays in its stage time)
    const cur = o.current ? (({ damage: _d, serviceDone: _s, servicePenalty: _p, ...rest }) => ({ ...rest, results: rest.results.map(({ servicePen: _x, ...x }: any) => x) }))(o.current) : null;
    return { ...(o as CareerState), current: cur as RallyProgress | null, history: Array.isArray(o.history) ? o.history : [] };
  }
  const history = Array.isArray(o.history) ? o.history.map((h: any) => ({ season: Number(h?.season) || 0, points: 0, qualified: Number(h?.position) <= 3 || !!h?.qualified })) : [];
  const done = history.some((h: { season: number; qualified: boolean }) => h.season >= SEASONS - 1 && h.qualified);
  return {
    season, rally: 0, car: o.car, livery: Number(o.livery) || 0, plan: rebuild(season), points: 0, rallies: [], current: null, history,
    champion: !!o.champion || done, seasonEnd: null,
  };
}
