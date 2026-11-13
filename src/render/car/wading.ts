// Fords (sim: `wheel.inWater`): the audio splash one-shot when a wheel enters water, and optionally a spray feed for
// renderers that do not spray by themselves (StageView already sprays from wheels on the Water surface, so the game
// passes null). Per frame: game.wading.update(car, dt, null, (v) => audio.splash(v))
import type { Car } from '../../sim/vehicle/car';

export class WadingFx {
  private acc = [0, 0, 0, 0];
  private was = [false, false, false, false];

  update(car: Car, dt: number, splash: ((x: number, y: number, z: number, vx: number, vz: number, n: number) => void) | null, sound?: (strength: number) => void) {
    const v = car.speed;
    let entered = 0;
    for (const w of car.wheels) {
      const i = w.index;
      if (w.inWater && !this.was[i]) entered = Math.max(entered, v);
      this.was[i] = w.inWater;
      if (!splash || !w.inWater || v < 1.5) { this.acc[i] = 0; continue; }
      // a sheet of spray proportional to speed (≈ 30 sprites/s per wheel at 50 km/h)
      this.acc[i] += dt * v * 2.2;
      const n = Math.floor(this.acc[i]);
      if (n > 0) {
        this.acc[i] -= n;
        splash(w.contact.x, w.contact.y, w.contact.z, car.vel.x, car.vel.z, Math.min(n, 12));
      }
    }
    if (entered > 2 && sound) sound(Math.min(1.5, entered / 15));
  }
}
