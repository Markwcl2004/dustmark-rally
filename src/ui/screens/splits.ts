// What the HUD splits compare against (solo game, DESIGN §6): the personal best on the stage (its ghost trace) when
// there is one; otherwise the medal lines — at each split the next line up from where the run is (behind bronze →
// bronze, between bronze and silver → silver, faster than silver → gold).
import { app } from '../../app/app';
import type { Compare, Game } from '../../app/game';
import { curveAt, type BotRun } from '../../sim/rally/botTimes';
import { decodeGhost, ghostTimeAt } from '../../sim/rally/ghost';
import { MEDAL_CN, MEDAL_RATIO } from '../../sim/rally/scoring';
import type { Session } from '../../sim/rally/session';

export interface SplitTarget { stage: string; reverse: boolean; weather: string; car: string }

/** set game.compare: personal best, else the medal lines (once the reference run is known) */
export function soloCompare(game: Game, c: SplitTarget, pbLabel = '个人最好') {
  const g = app.ghostFor(c.stage, c.reverse);
  if (g) {
    try {
      const tr = decodeGhost(g.data);
      game.compare = { label: pbLabel, at: (d) => ghostTimeAt(tr, d) };
      return;
    } catch { /* unreadable ghost: medal lines */ }
  }
  void app.ref(c.stage, c.reverse, c.weather, c.car).then((run) => { if (!game.compare) game.compare = medalLineCompare(game, run); }).catch(() => {});
}

const TIERS = ['bronze', 'silver', 'gold'] as const;

/** the medal line just above the run at each split (chosen when the split is crossed, kept for the result screen) */
export function medalLineCompare(game: Game, run: BotRun): Compare | null {
  if (!run.curve) return null;
  const curve = run.curve;
  const memo = new Map<number, number>();
  let sess: Session | null = null;
  const cmp: Compare = {
    label: '奖牌线',
    at(d) {
      const s = game.world.session;
      if (s !== sess) { memo.clear(); sess = s; } // restarted: a new session
      const base = curveAt(curve, d);
      let ti = memo.get(d);
      if (ti === undefined) {
        const now = s.time + s.penalties;
        ti = 0;
        for (let i = 0; i < TIERS.length; i++) if (now <= base * MEDAL_RATIO[TIERS[i]]) ti = Math.min(TIERS.length - 1, i + 1);
        memo.set(d, ti);
      }
      const tier = TIERS[ti];
      cmp.label = `${MEDAL_CN[tier]}牌线`;
      return base * MEDAL_RATIO[tier];
    },
  };
  return cmp;
}
