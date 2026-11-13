// Tiny DOM builder for the menus (no framework).

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string; html?: string; on?: Record<string, (e: Event) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = String(v);
      else if (k === 'style') e.setAttribute('style', String(v));
      else if (k === 'html') e.innerHTML = String(v);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) e.addEventListener(ev, fn);
      else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'tabindex' || k === 'src' || k === 'alt' || k === 'title' || k === 'id') e.setAttribute(k, v === true ? '' : String(v));
      else (e as unknown as Record<string, unknown>)[k] = v;
    }
  }
  append(e, children);
  return e;
}

export function append(e: HTMLElement, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(e, c);
    else e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export const clear = (e: HTMLElement) => { while (e.firstChild) e.removeChild(e.firstChild); return e; };

/** focusable menu control: Enter / A / click → fn. `adjust` makes it a value row (← → change it) */
export function navItem<T extends HTMLElement>(e: T, fn: (() => void) | null, opts: { adjust?: (dir: -1 | 1) => void; disabled?: boolean } = {}): T {
  e.dataset.nav = '';
  e.tabIndex = -1;
  if (opts.disabled) e.setAttribute('aria-disabled', 'true');
  if (fn) e.addEventListener('click', () => { if (e.getAttribute('aria-disabled') !== 'true') fn(); });
  if (opts.adjust) ADJUST.set(e, opts.adjust);
  return e;
}
export const ADJUST = new WeakMap<HTMLElement, (dir: -1 | 1) => void>();

export const fmtTime = (t: number) => {
  if (!Number.isFinite(t)) return '–:––.––';
  const neg = t < 0; t = Math.abs(t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${neg ? '-' : ''}${m}:${s.toFixed(2).padStart(5, '0')}`;
};
export const fmtGap = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(d) < 60 ? Math.abs(d).toFixed(2) : fmtTime(Math.abs(d))}`;
export const fmtKm = (m: number) => `${(m / 1000).toFixed(2)} km`;

/** asset helper: the vite plugin lists files that exist under public/assets */
import assetList from 'virtual:asset-list';
const ASSETS = new Set<string>(assetList as string[]);
export const hasAsset = (p: string) => ASSETS.has(p);
/** first existing path of the candidates (or null) */
export const firstAsset = (...paths: string[]) => paths.find((p) => ASSETS.has(p)) ?? null;
export const bgUrl = (p: string | null) => (p ? `url("${p}")` : 'none');
