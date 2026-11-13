// Livery canvas layout. One canvas per car+livery holds five projected views and a strip of explicit-uv decals.
// Projected views (shader picks by model-space normal):
//   L  left side  (viewer at -x): canvas x = z (front → left)      canvas y = yMax - y
//   R  right side (viewer at +x): canvas x = zMax - z (front → right)
//   T  top        (viewer above): canvas x = zMax - z (nose → right)  canvas y = x + xMax  (rotation, not a mirror)
//   F  front      (viewer at -z): canvas x = xMax - x                canvas y = yMax - y
//   B  rear       (viewer at +z): canvas x = x + xMax
// Each side is drawn separately so text on both flanks reads correctly (never mirrored).
export const CANVAS_W = 2048, CANVAS_H = 2560;
export type Rect = [number, number, number, number]; // px x, y, w, h

export const REG = {
  L: [0, 0, 2048, 640] as Rect,
  R: [0, 640, 2048, 640] as Rect,
  T: [0, 1280, 2048, 512] as Rect,
  F: [0, 1792, 1024, 448] as Rect,
  B: [1024, 1792, 1024, 448] as Rect,
  wingTop: [0, 2240, 1024, 128] as Rect,
  nameStrip: [0, 2376, 1024, 64] as Rect,
  sunStrip: [0, 2448, 1024, 64] as Rect,
  plateL: [1032, 2240, 240, 160] as Rect,
  plateR: [1280, 2240, 240, 160] as Rect,
  wingLow: [1032, 2408, 488, 96] as Rect,
  flap: [1536, 2240, 200, 240] as Rect,
  flapF: [1744, 2240, 200, 240] as Rect,
};
/** inner padding of projected views (keeps mip bleeding between views off the car) */
export const PAD = 10;

/** rect → canvas-fraction rect (x, y, w, h) for uv mapping, optionally padded */
export const frac = (r: Rect, pad = 0): [number, number, number, number] =>
  [(r[0] + pad) / CANVAS_W, (r[1] + pad) / CANVAS_H, (r[2] - 2 * pad) / CANVAS_W, (r[3] - 2 * pad) / CANVAS_H];
