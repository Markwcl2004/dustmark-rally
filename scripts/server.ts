// Reuse a running dev server on the tools port (5177) or start one for the duration of the script.
// Port map: 5177 tools' vite dev server (`npm run dev` too) · 5223 / 5224 smoke / uishots build servers ·
// 5198 ./play.sh · 5199 ./play-stable.sh (the user's test drive — tools never touch 5198/5199 or their +1000 HTTPS ports)
import { spawn, type ChildProcess } from 'node:child_process';

/** the tools' own dev-server port (vite.config.ts server.port) */
export const TOOLS_PORT = 5177;
// DUSTMARK_PORT: point the tools at another server (e.g. a no-HMR instance, so edits by other tasks cannot reload the page mid-bench)
export const PORT = Number(process.env.DUSTMARK_PORT ?? TOOLS_PORT);
if (PORT === 5198 || PORT === 5199) console.warn(`[tools] DUSTMARK_PORT=${PORT} is a play.sh / play-stable.sh port: the tools will drive that build`);
export const BASE = `http://localhost:${PORT}`;

async function up(): Promise<boolean> {
  try { const r = await fetch(BASE + '/'); return r.ok; } catch { return false; }
}

export async function ensureServer(): Promise<() => void> {
  if (await up()) return () => {};
  const child: ChildProcess = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: false });
  for (let i = 0; i < 150; i++) {
    if (await up()) return () => { child.kill('SIGTERM'); };
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('vite dev server did not start');
}

/** headless Chrome on the real Apple GPU (Metal ANGLE); rAF unthrottled */
export const CHROME_ARGS = [
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--enable-unsafe-swiftshader=false',
];
