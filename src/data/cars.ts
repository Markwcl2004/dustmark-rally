// Vehicle parameter sets (pure data). Units SI unless noted. Body frame: +X right, +Y up, -Z forward.

export type Drive = 'awd' | 'fwd' | 'rwd';

export interface CarSpec {
  id: string;
  /** display name (fictional) */
  name: string;
  model: string;
  group: string;
  drive: Drive;
  /** one-line personality (menus) */
  personality: string;
  /** targets from DESIGN.md §6, used by probes */
  target: { zeroTo100: number; topKmh: number; hp: number };

  mass: number;
  /** body box used for inertia + collision spheres */
  dims: { length: number; width: number; height: number };
  /** inertia scale on the box approximation (≤1 → mass concentrated toward centre) */
  inertiaScale: [number, number, number];
  wheelbase: number;
  trackF: number;
  trackR: number;
  /** fraction of weight on front axle */
  frontWeight: number;
  cgHeight: number;

  wheel: { radius: number; width: number; inertia: number };
  susp: {
    travel: number;
    springF: number; springR: number;
    bumpF: number; bumpR: number;
    reboundF: number; reboundR: number;
    arbF: number; arbR: number;
    /** height above ground where lateral tire forces act on the body (roll-centre) */
    rollCenter: number;
    /** bump-stop engagement: last N metres of travel */
    bumpStop: number;
    /** bump-stop damping (N per m/s) */
    bumpStopDamp: number;
    /** high-speed bump knee (m/s) and extra damping above it (N per m/s) */
    hsKnee: number;
    hsBump: number;
  };
  engine: {
    idleRpm: number;
    redline: number;
    limiter: number;
    /** [rpm, Nm] full-load curve */
    torque: [number, number][];
    /** engine braking at redline, Nm */
    braking: number;
    /** turbo spool time constant (s), 0 = NA */
    turboLag: number;
    /** fraction of torque available off-boost */
    offBoost: number;
    /** big-turbo spool (optional): boost target rises with rpm between rpm[0]..rpm[1], builds through two lags in
     *  series (turboLag/2 each) and is felt as boost^exp — a late, sudden shove instead of a smooth first-order rise */
    spool?: { rpm: [number, number]; exp: number };
  };
  gearbox: {
    ratios: number[];
    reverse: number;
    final: number;
    shiftTime: number;
    efficiency: number;
    upRpm: number;
    downRpm: number;
  };
  diff: {
    /** torque share to the front axle (awd) */
    centerSplit: number;
    /** implicit locking 0..1 (fraction of speed difference removed per tick at 120 Hz) */
    centerLock: number;
    frontLock: number;
    rearLock: number;
  };
  brakes: { maxTorque: number; frontBias: number; handbrake: number };
  steer: { lockDeg: number; highSpeedDeg: number };
  aero: { cdA: number; clA: number };
  /** airborne pitch: pedal authority (Nm), self-levelling toward the flight path (Nm per unit), angular damping */
  air: { pedalPitch: number; levelPitch: number; damping: number };
  /** rearLat: rear-axle lateral grip relative to the front (balance knob) */
  tire: { muScale: number; loadSens: number; lateralScale: number; rearLat: number };
  /** per-car assist adjustment (novice/standard only): TC slip targets × tcSlipMul; spinGuard = body slip angle (rad)
   *  above which TC also cuts the throttle while the slide is still growing (rear-drive: power oversteer stays, the
   *  spin doesn't) */
  assist?: { tcSlipMul?: number; spinGuard?: number; csMul?: number;
    /** TC floor × this (front drive: the driven wheels also steer, so TC may cut deeper to keep them steering) */
    tcFloorMul?: number;
    /** handbrake assist: body slip (deg) where it lets the rear brake go (default 42; a lively tail wants less) */
    hbSlipDeg?: number };
}

/** recursive partial for deriving a car from another */
type Patch<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? Patch<T[K]> : T[K] };
function derive(base: CarSpec, p: Patch<CarSpec> & Pick<CarSpec, 'id' | 'name' | 'model' | 'group' | 'drive' | 'target' | 'personality'>): CarSpec {
  const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(out[k] as object), ...v };
    else out[k] = v;
  }
  return out as unknown as CarSpec;
}

const KESTREL: CarSpec = {
    id: 'kestrel',
    name: '雁山',
    model: 'Kestrel R4',
    group: '顶级组',
    drive: 'awd',
    personality: '稳、准：给油就走，反打一点就回来',
    target: { zeroTo100: 4.2, topKmh: 200, hp: 380 },
    mass: 1230,
    dims: { length: 4.05, width: 1.82, height: 1.36 },
    inertiaScale: [0.85, 0.92, 0.85],
    wheelbase: 2.55,
    trackF: 1.58,
    trackR: 1.58,
    frontWeight: 0.56,
    cgHeight: 0.5,
    wheel: { radius: 0.33, width: 0.21, inertia: 1.1 },
    susp: {
      travel: 0.22,
      springF: 38000, springR: 34000,
      bumpF: 3400, bumpR: 3000,
      reboundF: 5200, reboundR: 4600,
      arbF: 7000, arbR: 9000,
      rollCenter: 0.12,
      bumpStop: 0.06, bumpStopDamp: 12000, hsKnee: 1.2, hsBump: 2500,
    },
    engine: {
      idleRpm: 1000,
      redline: 7200,
      limiter: 7500,
      torque: [[1000, 280], [2500, 440], [3500, 520], [5000, 500], [6000, 450], [7000, 385], [7600, 300]],
      braking: 150,
      turboLag: 0.22,
      offBoost: 0.55,
    },
    gearbox: {
      ratios: [3.0, 2.2, 1.72, 1.42, 1.22, 1.06],
      reverse: 3.2,
      final: 4.33,
      shiftTime: 0.07,
      efficiency: 0.86,
      upRpm: 7150,
      downRpm: 4200,
    },
    diff: { centerSplit: 0.5, centerLock: 0.35, frontLock: 0.1, rearLock: 0.22 },
    brakes: { maxTorque: 2700, frontBias: 0.66, handbrake: 3200 },
    steer: { lockDeg: 30, highSpeedDeg: 11 },
    aero: { cdA: 0.82, clA: 0.35 },
    air: { pedalPitch: 500, levelPitch: 3500, damping: 350 },
    tire: { muScale: 1.0, loadSens: 0.1, lateralScale: 1.0, rearLat: 0.97 },
    // (手感重做) a touch less launch wheelspin keeps 0–100 on the design figure with the grippier gravel
    assist: { tcSlipMul: 0.7 },
};

export const CARS: Record<string, CarSpec> = {
  // 岭雀 Pipit 16V — entry hatch A: 1.6 16V, front drive, stable, pushes wide when you overdo it
  pipit: derive(KESTREL, {
    id: 'pipit', name: '岭雀', model: 'Pipit 16V', group: '入门组', drive: 'fwd',
    personality: '好开：推头，松油门车头收线，手刹甩进弯',
    target: { zeroTo100: 8.5, topKmh: 175, hp: 150 },
    mass: 1080,
    dims: { length: 3.75, width: 1.68, height: 1.38 },
    wheelbase: 2.44, trackF: 1.47, trackR: 1.45, frontWeight: 0.61, cgHeight: 0.5,
    wheel: { radius: 0.305, width: 0.19, inertia: 0.85 },
    susp: { springF: 31000, springR: 25000, bumpF: 2900, bumpR: 2400, reboundF: 4400, reboundR: 3600, arbF: 5000, arbR: 11000 },
    engine: { idleRpm: 950, redline: 7600, limiter: 7900, torque: [[1000, 105], [2500, 132], [4000, 150], [5500, 162], [6500, 160], [7200, 150], [7900, 128]], braking: 90, turboLag: 0, offBoost: 1 },
    gearbox: { ratios: [3.0, 2.15, 1.65, 1.3, 1.05], reverse: 3.3, final: 4.94, shiftTime: 0.12, efficiency: 0.88, upRpm: 7500, downRpm: 3900 },
    diff: { centerSplit: 1, centerLock: 0, frontLock: 0.12, rearLock: 0 },
    brakes: { maxTorque: 1900, frontBias: 0.7, handbrake: 2600 },
    steer: { lockDeg: 32, highSpeedDeg: 11 },
    aero: { cdA: 0.72, clA: 0.1 },
    tire: { muScale: 1.0, loadSens: 0.1, lateralScale: 1.0, rearLat: 0.97 },
    assist: { tcFloorMul: 0.5, tcSlipMul: 0.5 },
  }),
  // 津桥 Wren TS-R — entry hatch B: 2.0 16V, front drive, lively rear that steps out on a lift
  wren: derive(KESTREL, {
    id: 'wren', name: '津桥', model: 'Wren TS-R', group: '入门组', drive: 'fwd',
    personality: '尾巴活：松油门车尾就甩，前驱里最能横着走',
    target: { zeroTo100: 8.0, topKmh: 180, hp: 165 },
    mass: 1120,
    dims: { length: 3.85, width: 1.7, height: 1.36 },
    wheelbase: 2.48, trackF: 1.49, trackR: 1.47, frontWeight: 0.62, cgHeight: 0.5,
    wheel: { radius: 0.31, width: 0.2, inertia: 0.9 },
    susp: { springF: 32000, springR: 27000, bumpF: 3000, bumpR: 2300, reboundF: 4500, reboundR: 3400, arbF: 4500, arbR: 12000 },
    engine: { idleRpm: 950, redline: 7300, limiter: 7600, torque: [[1000, 120], [2500, 155], [4000, 180], [5000, 186], [6000, 180], [7000, 168], [7600, 145]], braking: 100, turboLag: 0, offBoost: 1 },
    gearbox: { ratios: [3.0, 2.12, 1.6, 1.25, 1.0], reverse: 3.3, final: 4.94, shiftTime: 0.1, efficiency: 0.88, upRpm: 7250, downRpm: 3900 },
    diff: { centerSplit: 1, centerLock: 0, frontLock: 0.18, rearLock: 0 },
    brakes: { maxTorque: 2000, frontBias: 0.66, handbrake: 2700 },
    steer: { lockDeg: 32, highSpeedDeg: 11 },
    aero: { cdA: 0.74, clA: 0.12 },
    tire: { muScale: 1.0, loadSens: 0.1, lateralScale: 1.0, rearLat: 0.94 },
    assist: { tcFloorMul: 0.5, tcSlipMul: 0.45, hbSlipDeg: 43 },
  }),
  // 洛川 Heron 2000 SC — 1970s rear-drive coupé: carburettor 2.0 twin-cam, light, narrow tyres, steers on the throttle
  heron: derive(KESTREL, {
    id: 'heron', name: '洛川', model: 'Heron 2000 SC', group: '经典组', drive: 'rwd',
    personality: '全程横着走：给油车尾就出来，要用油门转向',
    target: { zeroTo100: 6.5, topKmh: 190, hp: 240 },
    mass: 980,
    dims: { length: 4.0, width: 1.66, height: 1.32 },
    // rally-prepped: battery/spare moved back → 46/54
    wheelbase: 2.36, trackF: 1.38, trackR: 1.4, frontWeight: 0.46, cgHeight: 0.48,
    wheel: { radius: 0.3, width: 0.165, inertia: 0.85 },
    susp: { springF: 28000, springR: 25000, bumpF: 2600, bumpR: 2300, reboundF: 4000, reboundR: 3500, arbF: 7000, arbR: 6500 },
    engine: { idleRpm: 1000, redline: 7800, limiter: 8100, torque: [[1000, 150], [2500, 200], [4000, 240], [5500, 255], [6500, 248], [7200, 237], [7800, 215], [8100, 190]], braking: 90, turboLag: 0, offBoost: 1 },
    gearbox: { ratios: [3.0, 2.0, 1.48, 1.16, 0.95], reverse: 3.2, final: 5.07, shiftTime: 0.12, efficiency: 0.88, upRpm: 7700, downRpm: 4600 },
    diff: { centerSplit: 0, centerLock: 0, frontLock: 0, rearLock: 0.2 },
    // period brakes: torque-limited below the tyre limit (keeps 100→0 in the 50–65 m band despite the gravel tyres)
    brakes: { maxTorque: 500, frontBias: 0.62, handbrake: 2600 },
    steer: { lockDeg: 34, highSpeedDeg: 12 },
    aero: { cdA: 0.74, clA: 0.05 },
    tire: { muScale: 1.0, loadSens: 0.1, lateralScale: 1.0, rearLat: 1.05 },
    // standard assists: TC near the tyre peak, a spin guard past 17° of growing slide, stronger counter-steer help
    assist: { tcSlipMul: 0.9, spinGuard: 0.3, csMul: 1.6, hbSlipDeg: 47 },
  }),
  // 赤峰 Shrike TX4 — 1980s four-wheel-drive monster: big-turbo five, huge lag then a shove, nose-heavy
  shrike: derive(KESTREL, {
    id: 'shrike', name: '赤峰', model: 'Shrike TX4', group: '经典组', drive: 'awd',
    personality: '暴力：涡轮迟滞大，一来劲就推着走，车头重',
    target: { zeroTo100: 3.8, topKmh: 210, hp: 450 },
    mass: 1100,
    dims: { length: 3.95, width: 1.8, height: 1.38 },
    inertiaScale: [0.9, 0.92, 0.9],
    wheelbase: 2.4, trackF: 1.52, trackR: 1.54, frontWeight: 0.6, cgHeight: 0.52,
    wheel: { radius: 0.32, width: 0.235, inertia: 1.05 },
    susp: { springF: 40000, springR: 32000, bumpF: 3500, bumpR: 2900, reboundF: 5300, reboundR: 4300, arbF: 8000, arbR: 7000 },
    engine: { idleRpm: 1000, redline: 7000, limiter: 7300, torque: [[1000, 250], [2500, 420], [3500, 540], [4500, 575], [5500, 550], [6500, 490], [7300, 400]], braking: 140, turboLag: 0.4, offBoost: 0.35, spool: { rpm: [2000, 3400], exp: 2 } },
    gearbox: { ratios: [2.9, 2.05, 1.6, 1.3, 1.08], reverse: 3.2, final: 3.89, shiftTime: 0.11, efficiency: 0.86, upRpm: 6950, downRpm: 4300 },
    diff: { centerSplit: 0.45, centerLock: 0.4, frontLock: 0.1, rearLock: 0.25 },
    brakes: { maxTorque: 700, frontBias: 0.7, handbrake: 3200 },
    steer: { lockDeg: 32, highSpeedDeg: 10 },
    aero: { cdA: 0.86, clA: 0.15 },
    tire: { muScale: 1.0, loadSens: 0.1, lateralScale: 1.0, rearLat: 0.96 },
    assist: { tcSlipMul: 0.45 },
  }),
  kestrel: KESTREL,
  // 海岱 Petrel X4 — modern four-wheel drive B: shorter wheelbase, quicker to rotate, livelier over bumps
  petrel: derive(KESTREL, {
    id: 'petrel', name: '海岱', model: 'Petrel X4', group: '顶级组', drive: 'awd',
    personality: '灵：短轴距转得快、过坡更跳，要手稳',
    target: { zeroTo100: 4.0, topKmh: 200, hp: 380 },
    mass: 1190,
    dims: { length: 3.95, width: 1.82, height: 1.36 },
    inertiaScale: [0.82, 0.84, 0.85],
    wheelbase: 2.44, trackF: 1.58, trackR: 1.57, frontWeight: 0.57,
    susp: { springF: 41000, springR: 37000, reboundF: 4700, reboundR: 4100, arbF: 6500, arbR: 10500 },
    diff: { centerSplit: 0.45, centerLock: 0.32, frontLock: 0.1, rearLock: 0.26 },
    steer: { lockDeg: 31, highSpeedDeg: 11.5 },
    tire: { muScale: 1.05, loadSens: 0.1, lateralScale: 0.96, rearLat: 0.94 },
    assist: { tcSlipMul: 0.6 },
  }),
};

/** menu order: entry → classic → top */
export const CAR_ORDER = ['pipit', 'wren', 'heron', 'shrike', 'kestrel', 'petrel'] as const;

/** flat roster for menus / career (DESIGN §6 车辆表). Targets are the design figures; measured probe values are in PROGRESS. */
export interface CarInfo {
  id: string;
  /** 中文名 (fictional maker) */
  name: string;
  /** Latin model designation */
  model: string;
  /** 入门组 / 经典组 / 顶级组 */
  group: string;
  drive: Drive;
  /** 前驱 / 后驱 / 四驱 */
  driveCn: string;
  hp: number;
  massKg: number;
  /** one-line personality */
  personality: string;
  /** 0–100 km/h on gravel (s) */
  zeroTo100: number;
  topKmh: number;
}

const DRIVE_CN: Record<Drive, string> = { fwd: '前驱', rwd: '后驱', awd: '四驱' };

export const CAR_LIST: CarInfo[] = CAR_ORDER.map((id) => {
  const c = CARS[id];
  return { id, name: c.name, model: c.model, group: c.group, drive: c.drive, driveCn: DRIVE_CN[c.drive], hp: c.target.hp, massKg: c.mass, personality: c.personality, zeroTo100: c.target.zeroTo100, topKmh: c.target.topKmh };
});

/** front-drive / rear-drive variants used by structure tests (not shipped as separate cars in M1) */
export function withDrive(spec: CarSpec, drive: Drive): CarSpec {
  return { ...spec, id: `${spec.id}-${drive}`, drive };
}
