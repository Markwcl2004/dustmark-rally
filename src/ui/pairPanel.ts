// Phone pairing panel: QR code per address + steps + live connection state and link figures. Self-contained DOM component.
//   openPairPanel() / closePairPanel() / togglePairPanel()   (the settings page can call these)
//   K toggles it, Esc closes it, URL ?pair=1 opens it on load (installed by PhonePad via installPairPanel)
// Data comes from GET /pair-info, which only scripts/serve.mjs answers (loopback only). Under `npm run dev` the panel
// says to start the game with ./play.sh instead.
// Every address the server listens on gets a tab (Wi-Fi, 有线 = the "iPhone USB" interface, Ethernet; VPN / virtual
// interfaces greyed). The wired one is picked by default when present. The list is re-read every 2 s while the panel
// is open, so plugging the cable in shows the 有线 tab without closing anything.
import qrcode from 'qrcode-generator';

export interface LinkSessionFigures {
  secs: number; n: number; loss: number; stalls: number; gaps: number; gapMs: number; maxGap: number;
  ch: { dc: number; ws: number; http: number }; rtt50: number; rtt95: number;
}
export interface LinkFigures {
  /** channel most packets arrived on in the last 5 s */
  channel: '' | 'dc' | 'ws' | 'http';
  channelName: string;
  share: { dc: number; ws: number; http: number };
  udp: 'open' | 'connecting' | 'failed' | 'unsupported' | 'off' | 'unknown';
  /** round trip on the best channel, median / p95 (ms, from the phone) */
  rtt50: number; rtt95: number;
  /** round trip on the relay (WebSocket or POST) */
  relay50: number; relay95: number;
  sendHz: number; motionHz: number; reconnects: number;
  /** what arrives here, last 5 s */
  hz: number; stalls5: number; gaps5: number; maxGap5: number; loss5: number; jitter95: number;
  openGap: number;
  session: LinkSessionFigures;
  lastRun: LinkSessionFigures | null;
}

export interface PairStatus {
  /** served by serve.mjs (null = still checking) */
  server: boolean | null;
  gameLinked: boolean;
  padOn: boolean;
  mode: 'ws' | 'http' | '';
  /** phone packets arriving (< 0.5 s old) */
  fresh: boolean;
  /** packets per second */
  hz: number;
  link?: LinkFigures;
}

interface Addr { ip: string; iface: string; kind: string; label: string; virtual: boolean; url: string; listening: boolean }
interface PairInfo { ok: boolean; code: string; url: string | null; default?: string | null; addrs?: Addr[]; urls: { ip: string; url: string; primary: boolean }[]; httpsPort: number }

let statusSource: (() => PairStatus) | null = null;
let root: HTMLElement | null = null;
let timer = 0;
let infoTimer = 0;
let installed = false;

const CSS = `
.pair-ov{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(20,18,14,.62);font-family:"PingFang SC","Hiragino Sans GB","Helvetica Neue",sans-serif}
.pair-card{display:flex;gap:28px;background:#f1ece0;color:#1b1b1b;padding:24px 30px 20px;box-shadow:10px 10px 0 #c8362a;max-width:min(940px,96vw);max-height:94vh;overflow:auto;text-shadow:none}
.pair-qr{flex:none;width:236px;display:flex;flex-direction:column;align-items:center;gap:8px}
.pair-qr .q{width:236px;height:236px;background:#fff;border:3px solid #1b1b1b;display:flex;align-items:center;justify-content:center}
.pair-qr .q svg{width:220px;height:220px;display:block}
.pair-qr .code{font:700 13px Menlo,monospace;letter-spacing:3px}
.pair-qr .via{font-size:13px;font-weight:800;text-align:center}
.pair-body{display:flex;flex-direction:column;gap:10px;min-width:0}
.pair-body h2{margin:0;font-size:28px;font-weight:900;letter-spacing:3px}
.pair-body h2 small{display:block;font-size:12px;letter-spacing:5px;color:#c8362a;font-weight:700;margin-top:4px}
.pair-tabs{display:flex;flex-wrap:wrap;gap:6px}
.pair-tabs button{font:inherit;font-size:13px;font-weight:800;padding:5px 9px;border:2px solid #1b1b1b;background:#f1ece0;color:#1b1b1b;cursor:pointer;text-align:left;line-height:1.25}
.pair-tabs button small{display:block;font:11px Menlo,monospace;opacity:.7;font-weight:400}
.pair-tabs button.pt-on{background:#1b1b1b;color:#e8b23a}
.pair-tabs button.pt-usb{border-color:#2e7d3a}
.pair-tabs button.pt-usb.pt-on{background:#2e7d3a;color:#f1ece0}
.pair-tabs button.pt-dim{opacity:.5}
.pair-body ol{margin:0;padding-left:1.4em;font-size:15px;line-height:1.6}
.pair-body ol b{background:#1b1b1b;color:#f1ece0;padding:0 5px;margin:0 3px;font-weight:700}
.pair-url{font:700 13px Menlo,monospace;background:#1b1b1b;color:#e8b23a;padding:5px 9px;user-select:text;word-break:break-all}
.pair-warn{font-size:12px;line-height:1.5;background:#e8b23a;padding:4px 8px}
.pair-st{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:800}
.pair-st i{width:12px;height:12px;border-radius:50%;background:#e8b23a;flex:none}
.pair-st.ok i{background:#5aa865}.pair-st.off i{background:#c8362a}
.pair-link{font:12px/1.55 Menlo,"PingFang SC",monospace;background:rgba(27,27,27,.07);padding:6px 9px;white-space:pre-wrap}
.pair-link:empty{display:none}
.pair-link b{font-weight:800}
.pair-foot{font-size:12px;opacity:.65;letter-spacing:1px}
.pair-msg{font-size:18px;font-weight:800;line-height:1.6;max-width:460px}
`;

function ensureStyle() {
  if (document.getElementById('pair-css')) return;
  const s = document.createElement('style');
  s.id = 'pair-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), m = 4; // 4-module quiet zone
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" data-url="${esc(text)}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#1b1b1b"/></svg>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function fetchInfo(): Promise<PairInfo | null> {
  try {
    const r = await fetch('/pair-info', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    const j = (await r.json()) as PairInfo;
    return j?.ok ? j : null;
  } catch { return null; }
}

/** addresses from /pair-info (older servers only send `urls`) */
function addrsOf(info: PairInfo): Addr[] {
  if (info.addrs) return info.addrs;
  return info.urls.map((u) => ({ ip: u.ip, iface: '', kind: 'other', label: '局域网', virtual: false, url: u.url, listening: true }));
}

function statusLine(): { cls: string; text: string } {
  const s = statusSource?.();
  if (!s) return { cls: 'off', text: '手机输入模块未加载' };
  if (!s.gameLinked) return { cls: 'off', text: '游戏还没连上本地服务…' };
  if (s.fresh) {
    const ch = s.link?.channelName ?? (s.mode === 'http' ? 'HTTPS 备用' : 'WebSocket');
    return { cls: 'ok', text: `手机已连接（${ch} · ${s.hz} 包/秒）` };
  }
  if (s.padOn) return { cls: '', text: '手机已打开页面，等待点“开始”…' };
  return { cls: '', text: '等待手机连接…' };
}

const n0 = (v: number) => (Number.isFinite(v) ? String(Math.round(v)) : '–');
const secs = (ms: number) => (ms / 1000).toFixed(2);
function mmss(s: number) { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function shareText(ch: { dc: number; ws: number; http: number }) {
  const tot = ch.dc + ch.ws + ch.http;
  if (!tot) return '—';
  return (['dc', 'ws', 'http'] as const).filter((k) => ch[k] > 0).map((k) => `${{ dc: 'UDP', ws: 'WS', http: 'POST' }[k]} ${Math.round((100 * ch[k]) / tot)}%`).join(' / ');
}
function sessionText(title: string, s: LinkFigures['session']) {
  return `<b>${title}</b>（${mmss(s.secs)}，${s.n} 包）：断流 ${s.gaps} 次${s.gaps ? `（最长 ${secs(s.maxGap)} s，合计 ${secs(s.gapMs)} s）` : ''} · 卡顿 ${s.stalls} 次 · 丢包 ${s.loss.toFixed(1)}% · 往返 ${n0(s.rtt50)} / ${n0(s.rtt95)} ms · 通道 ${shareText(s.ch)}`;
}
/** live link figures (empty when no phone) */
function linkText(): string {
  const s = statusSource?.();
  const f = s?.link;
  if (!s || !f || (!s.fresh && !f.session.n && !f.lastRun)) return '';
  const lines: string[] = [];
  if (s.fresh) {
    const udp = { open: '已通', connecting: '连接中', failed: '没连通（只走 WS/POST）', unsupported: '浏览器不支持', off: '未启用', unknown: '—' }[f.udp];
    lines.push(`<b>通道</b> ${f.channelName}（近 5 秒 ${shareText(f.share)}） · UDP ${udp}`);
    lines.push(`<b>往返</b> ${n0(f.rtt50)} / ${n0(f.rtt95)} ms（中位 / p95）${f.channel === 'dc' ? ` · 中继 ${n0(f.relay50)} / ${n0(f.relay95)} ms` : ''} · 手机发 ${n0(f.sendHz)} Hz（陀螺仪 ${n0(f.motionHz)} Hz） · 游戏收 ${n0(f.hz)} Hz`);
    lines.push(`<b>近 5 秒</b> 卡顿(>50 ms) ${f.stalls5} · 断流(>150 ms) ${f.gaps5}${f.gaps5 ? `（最长 ${secs(f.maxGap5)} s）` : ''} · 丢包 ${f.loss5.toFixed(1)}% · 到达抖动 p95 ${n0(f.jitter95)} ms · 重连 ${f.reconnects} 次`);
  }
  if (f.session.n) lines.push(sessionText('本局', f.session));
  if (f.lastRun) lines.push(sessionText('上一局', f.lastRun));
  return lines.join('\n');
}

function steps(kind: string): string {
  if (kind === 'usb') {
    return `<ol>
        <li>iPhone 用<b>数据线</b>连着电脑，<b>个人热点</b>保持打开</li>
        <li>用 iPhone <b>相机</b>扫左边的二维码，在 Safari 打开</li>
        <li>出现证书警告时点 <b>显示详细信息</b> → <b>访问此网站</b></li>
        <li>点 <b>开始</b>，允许“动作与方向”，然后横握手机</li>
      </ol>
      <div class="pair-warn">开着个人热点时，电脑可能改用手机流量上网。避免：系统设置 › 网络 › “…” › 设定服务顺序，把 Wi-Fi 拖到 iPhone USB 上面。</div>`;
  }
  return `<ol>
        <li>手机和电脑连<b>同一个 Wi-Fi</b>${kind === 'wifi-hotspot' ? '（电脑现在连的就是这台 iPhone 的热点）' : ''}</li>
        <li>用 iPhone <b>相机</b>扫左边的二维码，在 Safari 打开</li>
        <li>出现证书警告时点 <b>显示详细信息</b> → <b>访问此网站</b></li>
        <li>点 <b>开始</b>，允许“动作与方向”，然后横握手机</li>
      </ol>
      ${kind === 'virtual' ? '<div class="pair-warn">这是 VPN / 虚拟机的网卡地址，手机一般连不上。请选 Wi-Fi 或有线。</div>' : ''}
      ${kind === 'bt' ? '<div class="pair-warn">蓝牙热点带宽小、延迟抖动大，能用但不推荐。</div>' : ''}
      <div class="pair-foot">想更稳：iPhone 打开个人热点，用数据线连电脑，这里会多出“有线”一项（不用重启游戏）。</div>`;
}

export function isPairPanelOpen() { return !!root; }

export async function openPairPanel() {
  if (root) return;
  ensureStyle();
  const ov = document.createElement('div');
  ov.className = 'pair-ov';
  ov.innerHTML = '<div class="pair-card"><div class="pair-msg">读取配对信息…</div></div>';
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) closePairPanel(); });
  document.body.appendChild(ov);
  root = ov;
  const info = await fetchInfo();
  if (root !== ov) return; // closed meanwhile
  const card = ov.querySelector('.pair-card') as HTMLElement;
  if (!info) {
    card.innerHTML = `<div class="pair-body"><h2>手机方向盘<small>PHONE WHEEL</small></h2>
      <div class="pair-msg">请用 <span class="pair-url">./play.sh</span> 启动游戏以使用手机方向盘。<br>（当前页面不是由 play.sh 的本地服务提供的，没有配对信息。）</div>
      <div class="pair-foot">K / Esc 关闭</div></div>`;
    return;
  }

  let picked: string | null = null; // the player's choice while the panel is open
  let shownKey = '';
  const render = (inf: PairInfo) => {
    const addrs = addrsOf(inf);
    const def = addrs.find((a) => a.ip === inf.default) ?? addrs.find((a) => a.listening && !a.virtual) ?? addrs.find((a) => a.listening) ?? addrs[0];
    const sel = addrs.find((a) => a.ip === picked) ?? def;
    const key = JSON.stringify([addrs.map((a) => [a.ip, a.kind, a.listening]), sel?.ip, inf.code]);
    if (key === shownKey) return;
    shownKey = key;
    if (!sel) {
      card.innerHTML = `<div class="pair-body"><h2>手机方向盘<small>PHONE WHEEL</small></h2>
        <div class="pair-msg">没找到局域网地址。请让电脑连上 Wi-Fi，或者用数据线连 iPhone 并打开它的个人热点；几秒后这里会自动出现二维码。</div>
        <div class="pair-st" id="pair-st"><i></i><span></span></div>
        <div class="pair-foot">K / Esc 关闭</div></div>`;
      return;
    }
    const tabs = addrs.length > 1 ? `<div class="pair-tabs">${addrs.map((a) => `<button data-ip="${esc(a.ip)}" class="${a.ip === sel.ip ? 'pt-on' : ''} ${a.kind === 'usb' ? 'pt-usb' : ''} ${a.virtual || !a.listening ? 'pt-dim' : ''}">${esc(a.label)}<small>${esc(a.ip)}${a.iface ? ` · ${esc(a.iface)}` : ''}</small></button>`).join('')}</div>` : '';
    card.innerHTML = `
      <div class="pair-qr"><div class="q">${qrSvg(sel.url)}</div><div class="via">${esc(sel.label)}</div><div class="code">配对码 ${esc(inf.code)}</div></div>
      <div class="pair-body">
        <h2>手机方向盘<small>PHONE WHEEL · iPhone Safari</small></h2>
        ${tabs}
        ${steps(sel.kind)}
        ${sel.listening ? '' : '<div class="pair-warn">服务没能在这个地址上监听（网卡可能刚变化，10 秒内会重试），手机暂时连不上它。</div>'}
        <div class="pair-url">${esc(sel.url)}</div>
        <div class="pair-st" id="pair-st"><i></i><span></span></div>
        <div class="pair-link" id="pair-link"></div>
        <div class="pair-foot">K / Esc 关闭 · 连不上：确认同一 Wi-Fi；路由器开了"AP 隔离"就改用有线或手机热点</div>
      </div>`;
    card.querySelectorAll<HTMLButtonElement>('.pair-tabs button').forEach((b) => b.addEventListener('click', () => { picked = b.dataset.ip ?? null; render(inf); tick(); }));
  };
  let lastLink = '';
  const tick = () => {
    const el = ov.querySelector('#pair-st') as HTMLElement | null;
    if (el) {
      const s = statusLine();
      el.className = `pair-st ${s.cls}`;
      (el.querySelector('span') as HTMLElement).textContent = s.text;
    }
    const lk = ov.querySelector('#pair-link') as HTMLElement | null;
    if (lk) { const t = linkText(); if (t !== lastLink || !lk.innerHTML) { lk.innerHTML = t; lastLink = t; } }
  };
  render(info);
  tick();
  timer = window.setInterval(tick, 250);
  // interfaces come and go (cable plugged in): follow them while open
  infoTimer = window.setInterval(async () => {
    const inf = await fetchInfo();
    if (root === ov && inf) { render(inf); lastLink = ''; tick(); }
  }, 2000);
}

export function closePairPanel() {
  if (!root) return;
  root.remove();
  root = null;
  clearInterval(timer);
  clearInterval(infoTimer);
}

export function togglePairPanel() { if (root) closePairPanel(); else void openPairPanel(); }

/** K toggles, Esc closes (without also pausing the game), ?pair=1 opens on load. Called once by PhonePad. */
export function installPairPanel(source: () => PairStatus) {
  statusSource = source;
  if (installed) return;
  installed = true;
  // capture phase on window runs before the game's own keydown listener (bubble phase on window)
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.code === 'KeyK') { togglePairPanel(); e.preventDefault(); }
    else if (e.code === 'Escape' && root) { closePairPanel(); e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  if (new URLSearchParams(location.search).get('pair') === '1') void openPairPanel();
}
