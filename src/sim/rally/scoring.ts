// Medal lines (DESIGN §6: reference = analog robot, skill 0.9, same stage variant and car; set with `npm run calibrate`).

/** medal targets as a multiple of the robot reference time (`npm run calibrate`, 2026-11-12): gold ≈ the reference
 *  +3 %; silver = what the slow-hand keyboard robot (standard assists) makes on ~28 % of the career's stages; bronze =
 *  ~79 % of its runs without a reset (its time is +22 % on the reference at the median) */
export const MEDAL_RATIO = { gold: 1.03, silver: 1.185, bronze: 1.25 } as const;
export type Medal = 'gold' | 'silver' | 'bronze' | null;
export const MEDAL_CN = { gold: '金', silver: '银', bronze: '铜' } as const;

export function medalTargets(ref: number) {
  return { gold: ref * MEDAL_RATIO.gold, silver: ref * MEDAL_RATIO.silver, bronze: ref * MEDAL_RATIO.bronze };
}
export function medalFor(total: number, ref: number | undefined | null): Medal {
  if (!ref || !Number.isFinite(total)) return null;
  const t = medalTargets(ref);
  return total <= t.gold ? 'gold' : total <= t.silver ? 'silver' : total <= t.bronze ? 'bronze' : null;
}
export const medalRank = (m: Medal) => (m === 'gold' ? 3 : m === 'silver' ? 2 : m === 'bronze' ? 1 : 0);
