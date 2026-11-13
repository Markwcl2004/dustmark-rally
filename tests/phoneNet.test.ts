// Phone wheel networking without a phone: interface classification (Wi-Fi / iPhone USB / VPN …), WebRTC candidate
// rewriting, and scripts/serve.mjs following a fake interface list (DUSTMARK_FAKE_NET) — the wired iPhone appears and
// disappears, certificates are per address, an existing shared certificate is used but never rewritten.
// Test ports 17298 / 18298; the fake wired address is served on [::1] (it does not exist on this machine).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { classifyIfaces, addLanCandidates, parseHardwarePorts, isIphoneHotspot } from '../scripts/serve-net.mjs';

const hw = (o: Record<string, string>) => new Map(Object.entries(o));

describe('interface classification', () => {
  it('iPhone USB first and marked wired; a VPN holding the default route is listed last, never the default', () => {
    const l = classifyIfaces(
      [{ name: 'utun4', address: '10.8.0.2' }, { name: 'en0', address: '192.168.1.23' }, { name: 'en9', address: '172.20.10.2' }, { name: 'bridge100', address: '192.168.64.1' }],
      hw({ en0: 'Wi-Fi', en9: 'iPhone USB' }), 'utun4');
    expect(l.map((a) => [a.name, a.kind])).toEqual([['en9', 'usb'], ['en0', 'wifi'], ['bridge100', 'virtual'], ['utun4', 'virtual']]);
    expect(l[0].label).toContain('有线');
    expect(l.filter((a) => a.virtual).map((a) => a.name)).toEqual(['bridge100', 'utun4']);
  });
  it('the default-route interface wins among physical links; hotspot over Wi-Fi and Bluetooth are told apart', () => {
    const l = classifyIfaces(
      [{ name: 'en0', address: '172.20.10.3' }, { name: 'en7', address: '10.0.0.9' }, { name: 'en5', address: '172.20.10.4' }],
      hw({ en0: 'Wi-Fi', en7: 'USB 10/100/1000 LAN', en5: 'Bluetooth PAN' }), 'en7');
    expect(l.map((a) => [a.name, a.kind])).toEqual([['en7', 'ethernet'], ['en0', 'wifi-hotspot'], ['en5', 'bt']]);
  });
  it('without networksetup: 172.20.10.x on a secondary enN is taken for the cable, en0 for Wi-Fi, tunnels by name', () => {
    const l = classifyIfaces([{ name: 'en0', address: '192.168.0.5' }, { name: 'en8', address: '172.20.10.2' }, { name: 'ipsec0', address: '10.1.2.3' }], new Map(), 'ipsec0');
    expect(l.map((a) => [a.name, a.kind])).toEqual([['en8', 'usb'], ['en0', 'wifi'], ['ipsec0', 'virtual']]);
    expect(isIphoneHotspot('172.20.10.1')).toBe(true);
    expect(isIphoneHotspot('172.20.10.16')).toBe(false);
    expect(isIphoneHotspot('172.20.100.2')).toBe(false);
  });
  it('parses networksetup -listallhardwareports', () => {
    const m = parseHardwarePorts('\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 00:00:00:00:00:01\n\nHardware Port: iPhone USB\nDevice: en9\nEthernet Address: 00:00:00:00:00:02\n\nVLAN Configurations\n===================\n');
    expect([...m]).toEqual([['en0', 'Wi-Fi'], ['en9', 'iPhone USB']]);
  });
});

describe('WebRTC candidates', () => {
  const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=candidate:1467250027 1 udp 2122260223 0b3c1f0e-7a1d-4c55-9a42-6f1e1f3e2b11.local 54321 typ host generation 0',
    'a=candidate:2 1 tcp 1518280447 0b3c1f0e-7a1d-4c55-9a42-6f1e1f3e2b11.local 9 typ host tcptype active',
    'a=candidate:3 1 udp 2122260223 192.168.1.40 50000 typ host', ''].join('\r\n');
  it('adds the real LAN address next to each UDP mDNS host candidate, lower priority, own foundation', () => {
    const out = addLanCandidates(sdp, '172.20.10.1').split('\r\n');
    const i = out.findIndex((l) => l.includes('.local 54321'));
    expect(out[i + 1]).toBe('a=candidate:14672500279 1 udp 2122260222 172.20.10.1 54321 typ host generation 0');
    expect(out.filter((l) => l.startsWith('a=candidate')).length).toBe(4); // tcp and plain-IP candidates untouched
    expect(out[out.length - 1]).toBe('');
  });
  it('leaves the SDP alone without a usable address', () => {
    expect(addLanCandidates(sdp, '')).toBe(sdp);
    expect(addLanCandidates(sdp, 'evil\r\na=x')).toBe(sdp);
  });
});

// ---------------------------------------------------------------- the server following a fake interface list
const PORT = 17298, HPORT = 18298;
const dir = mkdtempSync(join(tmpdir(), 'dustmark-net-'));
const certDir = join(dir, 'certs');
const netFile = join(dir, 'net.json');
let srv: ChildProcess;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WIFI = { name: 'en0', address: '192.168.77.23' };
const USB = { name: 'en9', address: '172.20.10.2', bind: '::1' };
const writeNet = (ifaces: object[]) => writeFileSync(netFile, JSON.stringify({ ifaces, hw: { en0: 'Wi-Fi', en9: 'iPhone USB' }, default: 'en0' }));
const info = async () => (await fetch(`http://localhost:${PORT}/pair-info`)).json();
/** the certificate a TLS server presents (SAN text + SHA-256 fingerprint) */
function peerCert(host: string): Promise<{ san: string; fp: string } | null> {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: HPORT, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      resolve({ san: c.subjectaltname ?? '', fp: c.fingerprint256 });
      s.end();
    });
    s.on('error', () => resolve(null));
  });
}
const fileFp = (f: string) => new crypto.X509Certificate(readFileSync(f)).fingerprint256;
let legacyHash = '';

beforeAll(async () => {
  // an existing shared certificate from an earlier version (covers 127.0.0.1 and the Wi-Fi address)
  execFileSync('mkdir', ['-p', certDir]);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(certDir, 'pad-key.pem'),
    '-out', join(certDir, 'pad-cert.pem'), '-days', '365', '-subj', '/CN=legacy', '-addext', `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${WIFI.address}`], { stdio: 'ignore' });
  writeFileSync(join(certDir, 'pad-cert.json'), JSON.stringify({ ips: [WIFI.address] }));
  legacyHash = crypto.createHash('sha256').update(readFileSync(join(certDir, 'pad-cert.pem'))).update(readFileSync(join(certDir, 'pad-key.pem'))).digest('hex');
  writeNet([WIFI]);
  srv = spawn(process.execPath, ['scripts/serve.mjs', '--dir', 'dist', '--port', String(PORT), '--https-port', String(HPORT), '--cert-dir', certDir, '--quiet'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DUSTMARK_FAKE_NET: netFile } });
  let out = '';
  srv.stdout!.on('data', (d) => (out += d));
  srv.stderr!.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('[dustmark] game'); i++) await sleep(100);
  if (!out.includes('[dustmark] game')) throw new Error('serve.mjs did not start: ' + out);
}, 20000);
afterAll(() => { srv?.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });

describe('serve.mjs with a fake interface list', () => {
  it('Wi-Fi only: offered (not listening: the address is fake), 127.0.0.1 uses the existing shared certificate', async () => {
    const j = await info();
    expect(j.addrs.map((a: { ip: string; kind: string }) => [a.ip, a.kind])).toEqual([[WIFI.address, 'wifi']]);
    expect(j.addrs[0].listening).toBe(false);
    const c = await peerCert('127.0.0.1');
    expect(c!.fp).toBe(fileFp(join(certDir, 'pad-cert.pem')));
  });

  it('the iPhone cable appears → listened on within ~2 s, the default, its own certificate; the shared one untouched', async () => {
    writeNet([WIFI, USB]);
    let j: any = null;
    for (let i = 0; i < 40; i++) { await sleep(150); j = await info(); if (j.addrs.find((a: { kind: string; listening: boolean }) => a.kind === 'usb' && a.listening)) break; }
    const usb = j.addrs.find((a: { kind: string }) => a.kind === 'usb');
    expect(usb).toMatchObject({ ip: USB.address, iface: 'en9', listening: true, virtual: false });
    expect(usb.label).toContain('有线');
    expect(j.default).toBe(USB.address);
    expect(j.url).toBe(`https://${USB.address}:${HPORT}/pad?k=${j.code}`);
    const c = await peerCert('::1');
    expect(c!.san).toContain(`IP Address:${USB.address}`);
    expect(c!.fp).toBe(fileFp(join(certDir, `pad-ip-${USB.address}-cert.pem`)));
    // the page is served there
    const r = await new Promise<number>((res) => {
      const s = tls.connect({ host: '::1', port: HPORT, rejectUnauthorized: false }, () => { s.write(`GET /pad?k=${j.code} HTTP/1.1\r\nHost: [::1]\r\nConnection: close\r\n\r\n`); });
      let b = ''; s.on('data', (d) => (b += d)); s.on('end', () => res(Number(b.split(' ')[1]))); s.on('error', () => res(0));
    });
    expect(r).toBe(200);
    const h = crypto.createHash('sha256').update(readFileSync(join(certDir, 'pad-cert.pem'))).update(readFileSync(join(certDir, 'pad-key.pem'))).digest('hex');
    expect(h).toBe(legacyHash);
    expect(existsSync(join(certDir, `pad-ip-${WIFI.address}-cert.pem`))).toBe(false); // covered by the shared one
  });

  it('the cable goes away → no longer offered or listened on; plugged in again → the same certificate as before', async () => {
    const fp1 = fileFp(join(certDir, `pad-ip-${USB.address}-cert.pem`));
    writeNet([WIFI]);
    let j: any = null;
    for (let i = 0; i < 40; i++) { await sleep(150); j = await info(); if (!j.addrs.find((a: { kind: string }) => a.kind === 'usb')) break; }
    expect(j.addrs.map((a: { ip: string }) => a.ip)).toEqual([WIFI.address]);
    expect(j.default).toBe(null);
    expect(await peerCert('::1')).toBe(null);
    writeNet([WIFI, USB]);
    let c = null;
    for (let i = 0; i < 40 && !c; i++) { await sleep(150); c = await peerCert('::1'); }
    expect(c!.fp).toBe(fp1);
  });
});
