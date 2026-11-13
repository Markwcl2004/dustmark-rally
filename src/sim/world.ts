// The deterministic simulation: one stage, one car, one session. Fixed 120 Hz ticks.
import type { CarSpec } from '../data/cars';
import { hashNumbers } from './math/hash';
import { Session } from './rally/session';
import type { StageDef } from './stage/script';
import { getStage, Stage } from './stage/stage';
import { Car, DT } from './vehicle/car';
import { emptyInput, type DriverInput } from './vehicle/controls';

export { DT };

export class World {
  readonly stage: Stage;
  readonly car: Car;
  session: Session;
  tick = 0;
  /** true: the car is held on the line during the countdown (robots, tests). false (human play): the input goes
   *  through, so creeping over the line before the green light is a false start (+10 s, Session) */
  holdAtStart = true;
  private held = emptyInput();

  constructor(stageDef: StageDef, carSpec: CarSpec, opts: { cached?: boolean } = {}) {
    this.stage = opts.cached === false ? new Stage(stageDef) : getStage(stageDef);
    this.car = new Car(carSpec);
    this.session = new Session(this.stage);
    this.placeAtStart();
  }

  placeAtStart() {
    const p = this.stage.pointAt(this.stage.startS - 4);
    this.car.reset(this.stage, p.x, p.z, p.dx, p.dz);
    this.session = new Session(this.stage);
    this.tick = 0;
  }

  step(input: DriverInput) {
    let inp = input;
    if (this.session.phase === 'countdown' && this.holdAtStart) {
      // car held on the line; engine can rev in neutral feel (throttle ignored by drivetrain via brake hold)
      // car held on the line by the standstill brake hold
      inp = this.held;
      this.held.brake = 0; this.held.throttle = 0; this.held.handbrake = 0; this.held.steer = input.steer; this.held.digital = input.digital;
    } else if (this.session.phase === 'finished') {
      inp = this.held;
      // below the automatic gearbox's "stopped + brake → reverse" threshold (0.5); the handbrake parks it
      this.held.throttle = 0; this.held.brake = 0.45; this.held.steer = input.steer; this.held.digital = input.digital; this.held.handbrake = this.car.speed < 2 ? 1 : 0;
    }
    this.car.step(inp, this.stage, DT);
    this.session.update(this.car, DT);
    this.tick++;
  }

  hash() {
    const nums: number[] = [this.tick, this.session.progressS, this.session.penalties];
    this.car.stateNumbers(nums);
    return hashNumbers(nums);
  }
}
