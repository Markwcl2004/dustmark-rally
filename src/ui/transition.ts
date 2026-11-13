// Screen change: three skewed colour bands sweep across, the content swaps under them, they sweep off.
import { nav } from './nav';

let root: HTMLElement | null = null;
let busy: Promise<void> = Promise.resolve();

function bands() {
  if (root) return root;
  root = document.createElement('div');
  root.id = 'wipe';
  for (let i = 0; i < 3; i++) root.appendChild(document.createElement('i'));
  document.body.appendChild(root);
  return root;
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** run `swap` under the wipe; colours: three band colours (default red / yellow / ink) */
export function wipe(swap: () => void | Promise<void>, colors: string[] = ['#c8362a', '#e8b23a', '#1b1b1b']): Promise<void> {
  const run = async () => {
    const el = bands();
    const b = Array.from(el.children) as HTMLElement[];
    b.forEach((x, i) => { x.style.background = colors[i % colors.length]; });
    nav.locked = true;
    el.className = 'reset';
    await frame();
    el.className = 'in';
    await wait(260);
    try { await swap(); } finally {
      await frame();
      el.className = 'out';
      await wait(300);
      el.className = '';
      nav.locked = false;
    }
  };
  busy = busy.then(run, run);
  return busy;
}
