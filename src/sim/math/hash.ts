// FNV-1a over the IEEE-754 bytes of a list of numbers → 8-hex-digit state hash.
export function hashNumbers(nums: number[]): string {
  const f = new Float64Array(nums);
  const b = new Uint8Array(f.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
