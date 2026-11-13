// Types for scripts/serve-net.mjs (plain JS so serve.mjs runs with `node`, no build step).
export interface IfaceInfo { name: string; address: string; kind: 'usb' | 'ethernet' | 'wifi' | 'wifi-hotspot' | 'bt' | 'other' | 'virtual'; label: string; virtual: boolean; port: string; rank: number }
export declare function isPrivate4(a: string): boolean;
export declare function isIphoneHotspot(a: string): boolean;
export declare function parseHardwarePorts(text: string): Map<string, string>;
export declare const KIND_LABEL: Record<IfaceInfo['kind'], string>;
export declare function classifyIfaces(list: { name: string; address: string }[], hw: Map<string, string>, defaultIface: string | null): IfaceInfo[];
export declare function addLanCandidates(sdp: string, ip: string): string;
