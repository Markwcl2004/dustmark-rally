// Pace-note icons (inline SVG, 64×64). Corners are a thick road arrow whose bend grows with severity
// (6 gentle … 1 very tight), square = hard elbow, hairpin = U-turn; modifiers add small marks (收紧 spiral-in,
// 放开 spiral-out, 过坡/坡顶 hump, 别切 inner bar). Jump, crest, dip, caution, finish have their own pictograms.
import type { PaceNote } from '../sim/stage/pacenotes';

/** total turn drawn per grade (deg) */
const BEND: Record<string, number> = { 6: 28, 5: 48, 4: 70, 3: 95, 2: 122, 1: 148 };
/** arc radius per grade (icon units) */
const RAD: Record<string, number> = { 6: 34, 5: 26, 4: 20, 3: 16, 2: 13, 1: 11 };

const svg = (inner: string, color: string) =>
  `<svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

function arrowHead(x: number, y: number, dx: number, dy: number, size = 9) {
  const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, nx = -uy, ny = ux;
  const bx = x - ux * size, by = y - uy * size;
  return `<path d="M${(bx + nx * size * 0.8).toFixed(1)} ${(by + ny * size * 0.8).toFixed(1)} L${(x + ux * 2).toFixed(1)} ${(y + uy * 2).toFixed(1)} L${(bx - nx * size * 0.8).toFixed(1)} ${(by - ny * size * 0.8).toFixed(1)}" stroke-width="6"/>`;
}

function corner(n: PaceNote, color: string) {
  const dir = n.dir === 'L' ? -1 : 1;
  const mods = new Set(n.mods);
  let body = '';
  if (n.grade === 'hairpin') {
    const X = (x: number) => (dir > 0 ? x : 64 - x);
    body = `<path d="M${X(20)} 58 V30 A12 12 0 0 ${dir > 0 ? 1 : 0} ${X(44)} 30 V44" stroke-width="8"/>` + arrowHead(X(44), 50, 0, 1);
  } else if (n.grade === 'square') {
    const ex = 32 + dir * 22;
    body = `<path d="M${32 - dir * 8} 58 V24 H${ex}" stroke-width="8" stroke-linejoin="miter"/>` + arrowHead(ex + dir * 2, 24, dir, 0);
  } else {
    const g = String(n.grade ?? 4);
    const ang = (BEND[g] ?? 70) * (Math.PI / 180);
    const R = RAD[g] ?? 20;
    // stem then an arc; tighter grades start further from the side they turn to
    const sx = 32 - dir * (6 + (34 - R) * 0.35), sy = 58, ty = 40 - Math.min(10, R * 0.25);
    const cx = sx + dir * R, cy = ty;
    let ex = cx - dir * R * Math.cos(ang), ey = cy - R * Math.sin(ang);
    let arc = `A${R} ${R} 0 0 ${dir > 0 ? 1 : 0} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    if (mods.has('tightens')) {
      // radius shrinks along the corner: two arcs, the second tighter
      const a1 = ang * 0.5, mx = cx - dir * R * Math.cos(a1), my = cy - R * Math.sin(a1);
      const R2 = R * 0.62, c2x = mx + (cx - mx) * (R2 / R), c2y = my + (cy - my) * (R2 / R);
      ex = c2x - dir * R2 * Math.cos(ang), ey = c2y - R2 * Math.sin(ang);
      arc = `A${R} ${R} 0 0 ${dir > 0 ? 1 : 0} ${mx.toFixed(1)} ${my.toFixed(1)} A${R2.toFixed(1)} ${R2.toFixed(1)} 0 0 ${dir > 0 ? 1 : 0} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    } else if (mods.has('opens')) {
      const a1 = ang * 0.5, mx = cx - dir * R * Math.cos(a1), my = cy - R * Math.sin(a1);
      const R2 = R * 1.7, c2x = mx + (cx - mx) * (R2 / R), c2y = my + (cy - my) * (R2 / R);
      ex = c2x - dir * R2 * Math.cos(ang * 0.85), ey = c2y - R2 * Math.sin(ang * 0.85);
      arc = `A${R} ${R} 0 0 ${dir > 0 ? 1 : 0} ${mx.toFixed(1)} ${my.toFixed(1)} A${R2.toFixed(1)} ${R2.toFixed(1)} 0 0 ${dir > 0 ? 1 : 0} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    }
    const tx = dir * Math.sin(ang), tyv = -Math.cos(ang);
    body = `<path d="M${sx.toFixed(1)} ${sy} V${ty.toFixed(1)} ${arc}" stroke-width="8"/>` + arrowHead(ex, ey, tx, tyv);
  }
  // modifier marks
  if (mods.has('crest')) body += `<path d="M6 16 Q14 6 22 16" stroke-width="4"/>`;
  if (mods.has('dontcut')) { const x = n.dir === 'L' ? 10 : 54; body += `<path d="M${x} 30 V50" stroke-width="5" stroke="#e8b23a"/>`; }
  if (mods.has('blind')) body += `<path d="M44 8 Q52 2 60 8 Q52 14 44 8 Z M48 12 L58 4" stroke-width="3"/>`;
  return body;
}

export function noteIcon(n: PaceNote, color = 'currentColor'): string {
  if (n.kind === 'turn') return svg(corner(n, color), color);
  if (n.kind === 'jump') return svg(`<path d="M4 54 H24 Q34 54 38 40" stroke-width="7"/><path d="M42 30 Q50 14 60 26" stroke-width="4" stroke-dasharray="1 7"/><path d="M40 58 H60" stroke-width="5"/>`, color);
  if (n.kind === 'crest') return svg(`<path d="M4 52 Q32 10 60 52" stroke-width="7"/><path d="M14 22 L32 14 L50 22" stroke-width="3" stroke-dasharray="2 5"/>`, color);
  if (n.kind === 'finish') {
    const sq = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => ((r + c) % 2 ? `<rect x="${12 + c * 11}" y="${8 + r * 9}" width="11" height="9"/>` : '')).join('')).join('');
    return `<svg viewBox="0 0 64 64" width="100%" height="100%"><g fill="${color}">${sq}</g><path d="M12 8 V60" stroke="${color}" stroke-width="5"/><rect x="12" y="8" width="44" height="36" fill="none" stroke="${color}" stroke-width="3"/></svg>`;
  }
  // caution family: dip / rollers / generic
  if (n.text.startsWith('洼地')) return svg(`<path d="M4 22 Q32 62 60 22" stroke-width="7"/><path d="M28 10 v10 M36 10 v10" stroke-width="4"/>`, color);
  if (n.text.startsWith('连续起伏')) return svg(`<path d="M2 44 Q10 26 18 44 T34 44 T50 44 T66 44" stroke-width="6"/>`, color);
  return svg(`<path d="M32 6 L60 56 H4 Z" stroke-width="6"/><path d="M32 24 v14" stroke-width="7"/><circle cx="32" cy="47" r="2.5" fill="${color}" stroke="none"/>`, color);
}
