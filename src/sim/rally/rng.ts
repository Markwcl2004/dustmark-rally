// String hash shared by the robot-time tables (scripts/simtag.ts, src/app/botService.ts). Pure, deterministic.

/** FNV-1a over a string → uint32 */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
