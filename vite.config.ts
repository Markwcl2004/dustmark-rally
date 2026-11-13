import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** virtual:asset-list → array of files present under public/assets (so the game never requests missing art and logs 404s) */
function assetList(): Plugin {
  const id = 'virtual:asset-list', rid = '\0' + id;
  const scan = () => {
    const root = join(process.cwd(), 'public');
    const out: string[] = [];
    const walk = (d: string) => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else out.push('/' + relative(root, p).split('\\').join('/'));
      }
    };
    walk(join(root, 'assets'));
    return out;
  };
  return {
    name: 'asset-list',
    resolveId(s) { return s === id ? rid : undefined; },
    load(s) { return s === rid ? `export default ${JSON.stringify(scan())};` : undefined; },
    handleHotUpdate(ctx) {
      // new art files → refresh list on next reload
      if (ctx.file.includes('/public/assets/')) {
        const m = ctx.server.moduleGraph.getModuleById(rid);
        if (m) ctx.server.moduleGraph.invalidateModule(m);
      }
    },
  };
}

export default defineConfig({
  plugins: [assetList()],
  // 5198 / 5199 belong to ./play.sh / ./play-stable.sh (scripts/server.ts has the port map)
  server: { port: 5177, strictPort: true },
  preview: { port: 5178, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
