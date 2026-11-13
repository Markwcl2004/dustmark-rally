// Pure helpers for scripts/serve.mjs (no side effects, so tests can import them):
//   classifyIfaces()   which local IPv4 addresses the phone can reach, what kind of link each one is, which to offer first
//   addLanCandidates() WebRTC: next to every mDNS (.local) host candidate, the same candidate on the address the relay
//                      actually sees for that device, so ICE works on networks that drop multicast DNS
//   parseHardwarePorts()  `networksetup -listallhardwareports` → device → port name

export const isPrivate4 = (a) => {
  const [x, y] = String(a).split('.').map(Number);
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
};
/** iPhone Personal Hotspot hands out 172.20.10.0/28 (the phone itself is 172.20.10.1) over Wi-Fi, USB and Bluetooth */
export const isIphoneHotspot = (a) => /^172\.20\.10\.(\d+)$/.test(a) && Number(a.split('.')[3]) < 16;

/** @param {string} text output of `networksetup -listallhardwareports` @returns {Map<string,string>} device → port */
export function parseHardwarePorts(text) {
  const out = new Map();
  let port = null;
  for (const line of String(text).split('\n')) {
    const p = line.match(/^Hardware Port:\s*(.+?)\s*$/);
    if (p) { port = p[1]; continue; }
    const d = line.match(/^Device:\s*(\S+)/);
    if (d && port) { out.set(d[1], port); port = null; }
  }
  return out;
}

// tunnels, VPNs and VM / container bridges; bridge0 is the Thunderbolt bridge (a real cable), bridge100+ are made by
// macOS Internet Sharing / virtual machines
const VIRTUAL_NAME = /^(utun|ipsec|ppp|tun|tap|gif|stf|vmnet|vmenet|vboxnet|feth|zt|wg|tailscale|docker|veth|llw|awdl|anpi|bridge[1-9]\d{2})/i;

export const KIND_LABEL = {
  usb: '有线 · iPhone USB（推荐）',
  ethernet: '以太网',
  wifi: 'Wi-Fi',
  'wifi-hotspot': 'Wi-Fi · 连着 iPhone 热点',
  bt: '蓝牙热点（慢，不推荐）',
  other: '其他网卡',
  virtual: 'VPN / 虚拟网卡（手机多半连不上）',
};

/**
 * @param {{name:string, address:string}[]} list  non-internal private IPv4 addresses
 * @param {Map<string,string>} hw  device → hardware port name (empty when networksetup is unavailable)
 * @param {string|null} defaultIface  interface of the default route
 * @returns {{name:string, address:string, kind:string, label:string, virtual:boolean, port:string, rank:number}[]} best first
 */
export function classifyIfaces(list, hw, defaultIface) {
  const out = [];
  for (const { name, address } of list) {
    const port = hw.get(name) ?? '';
    let kind;
    if (/iphone/i.test(port)) kind = 'usb';
    else if (/bluetooth|蓝牙/i.test(port)) kind = 'bt';
    else if (/wi-?fi|airport|无线/i.test(port)) kind = isIphoneHotspot(address) ? 'wifi-hotspot' : 'wifi';
    else if (VIRTUAL_NAME.test(name)) kind = 'virtual';
    else if (/ethernet|lan|以太网|thunderbolt|雷雳/i.test(port)) kind = 'ethernet';
    else if (!port && isIphoneHotspot(address) && /^en\d+$/.test(name) && name !== 'en0') kind = 'usb'; // no networksetup: best guess
    else if (!port && name === 'en0') kind = 'wifi';
    else kind = 'other';
    let rank = { usb: 0, ethernet: 3, wifi: 3, 'wifi-hotspot': 3, bt: 6, other: 7, virtual: 9 }[kind];
    if (name === defaultIface && kind !== 'virtual') rank -= 1; // of the physical links, the one the Mac uses to go online
    out.push({ name, address, kind, label: KIND_LABEL[kind], virtual: kind === 'virtual', port, rank });
  }
  return out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/**
 * Next to each `a=candidate:… <name>.local <port> typ host …` line, add the same candidate on `ip` (lower priority,
 * different foundation). iOS Safari and Chrome both hide host addresses behind random mDNS names; resolving them needs
 * multicast between the two devices, which some routers drop. The relay knows the real address of each side.
 * @param {string} sdp @param {string} ip IPv4 of the device that wrote `sdp`, as seen by the relay
 */
export function addLanCandidates(sdp, ip) {
  if (typeof sdp !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip ?? '')) return sdp;
  const lines = sdp.split('\r\n'), out = [];
  for (const line of lines) {
    out.push(line);
    const m = line.match(/^a=candidate:(\S{1,31}) (\d) (udp) (\d+) ([0-9a-f-]+\.local) (\d+) typ host(.*)$/i);
    if (m) out.push(`a=candidate:${m[1]}9 ${m[2]} ${m[3]} ${Math.max(0, Number(m[4]) - 1)} ${ip} ${m[6]} typ host${m[7]}`);
  }
  return out.join('\r\n');
}
