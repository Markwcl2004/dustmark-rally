// Sky dome (pale gradient + flat poster cumulus banks + sun), layered distant hills with spruce-toothed ridgelines,
// lake water (flat poster water: sky reflection, darker tree reflection band near the shore, sun glints, shore line),
// and the lights: a SunLight (three's 2-cascade sun shadow) + a hemisphere light for materials that are not posterized.
import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { hash2, noise2 } from '../sim/math/rng';
import type { Stage } from '../sim/stage/stage';
import { hasAsset, imageTexture, type Palette } from './materials';

export function sunDirection(pal: Palette) {
  const el = (pal.sunElev * Math.PI) / 180, az = (pal.sunAzim * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
}

export function buildSky(pal: Palette) {
  const geo = new THREE.SphereGeometry(9000, 48, 24);
  const L = pal.look;
  // art: a full painted sky (dusk, night, storms…) and/or a painted cloud band (RGBA) wrapped around the horizon
  const skyUrl = L.skyTex ? `/assets/sky/${L.skyTex}` : '', cloudUrl = L.cloudTex ? `/assets/sky/${L.cloudTex}` : '';
  const u = {
    top: { value: pal.skyTop.clone() }, horizon: { value: pal.skyHorizon.clone() }, haze: { value: L.hazeFar.clone() },
    sunDir: { value: sunDirection(pal) }, sunC: { value: pal.sun.clone() }, cloudC: { value: L.cloud.clone() },
    shadeC: { value: L.hazeFar.clone().lerp(pal.skyTop, 0.35) }, cover: { value: L.cloudCover },
    tSky: { value: null as THREE.Texture | null }, uSky: { value: 0 }, tCloud: { value: null as THREE.Texture | null }, uCloud: { value: 0 },
    uSunDisc: { value: L.sunDisc ?? 1 }, uStars: { value: L.stars ?? 0 },
  };
  if (skyUrl && hasAsset(skyUrl)) imageTexture(skyUrl, true, (t) => { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; u.tSky.value = t; u.uSky.value = 1; });
  if (cloudUrl && hasAsset(cloudUrl)) imageTexture(cloudUrl, true, (t) => { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; u.tCloud.value = t; u.uCloud.value = 1; });
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: u,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.99999; }`,
    fragmentShader: `
      uniform vec3 top, horizon, haze, sunDir, sunC, cloudC, shadeC; uniform float cover, uSky, uCloud, uSunDisc, uStars;
      uniform sampler2D tSky, tCloud; varying vec3 vDir;
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
      float fbm(vec2 p){ return vn(p)*0.55 + vn(p*2.03+7.1)*0.27 + vn(p*4.1+3.3)*0.13 + vn(p*8.3)*0.05; }
      void main(){
        vec3 d = normalize(vDir);
        float y = d.y;
        float az = atan(d.x, d.z);
        float ua = az / 6.2831853 + 0.5;
        // pale zenith → warm horizon band → haze at the horizon line (matches the post-process far haze)
        vec3 col = mix(horizon, top, smoothstep(0.0, 0.34, y));
        if (uSky > 0.5) {
          // painted sky: the image spans the horizon (bottom) to ~35° up; above that its top row continues
          vec3 art = texture2D(tSky, vec2(ua * 2.0, clamp(y / 0.6, 0.004, 0.996))).rgb;
          col = art;
        }
        col = mix(col, haze, 1.0 - smoothstep(-0.01, 0.07, y));
        float sunSide = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0), 2.0);
        float bank = 0.0;
        if (uCloud > 0.5) {
          // painted cloud band, three repeats around the horizon, sitting just above the far hills
          float v = (y - 0.03) / 0.24;
          if (v > 0.0 && v < 1.0) {
            // only the clean part of the painted band (u 0.40–0.98; the rest is a smeared cross-fade). Each repeat ends
            // by dissolving into the start of the clean part, so the joins are seamless instead of left as gaps
            float fu = fract(ua * 4.0);
            const float ca = 0.40, cl = 0.58, co = 0.08, cp = cl - co;
            float px = fu * cp;
            vec4 cA = texture2D(tCloud, vec2(ca + co + px, v));
            vec4 cB = texture2D(tCloud, vec2(ca + co + px - cp, v));
            float wB = smoothstep(cp - co, cp, px);
            vec4 c = vec4(mix(cA.rgb * cA.a, cB.rgb * cB.a, wB), mix(cA.a, cB.a, wB));
            c.rgb /= max(c.a, 1e-3);
            vec3 cc = mix(c.rgb, c.rgb * cloudC * 1.08, 0.3) * mix(0.97, 1.05, sunSide);
            // cover: gaps between banks around the horizon
            float gap = smoothstep(0.62 - cover * 0.5, 0.72 - cover * 0.5, vn(vec2(ua * 7.0, 2.0)) * 0.7 + vn(vec2(ua * 19.0, 5.0)) * 0.3);
            float a = smoothstep(0.35, 0.65, c.a) * gap;
            col = mix(col, cc, a);
            bank = a;
          }
        } else {
          // procedural poster cumulus: flat-bottomed banks, lumpy tops, two flat tones
          float uu = az * 3.0;
          float base = 0.06 + 0.035 * vn(vec2(uu * 0.7, 3.0));
          float hgt = (0.05 + 0.12 * fbm(vec2(uu * 0.9, 1.7))) * (0.4 + cover);
          float lump = fbm(vec2(uu * 2.6, y * 9.0));
          float yy = (y - base) / max(hgt, 0.01);
          bank = step(0.0, yy) * (1.0 - smoothstep(0.55 + 0.45 * lump - 0.15, 0.62 + 0.45 * lump - 0.15, yy));
          bank *= smoothstep(0.48 - cover * 0.3, 0.56 - cover * 0.3, fbm(vec2(uu * 0.6, 9.0)));
          vec3 lit = mix(cloudC, cloudC * vec3(1.03, 0.98, 0.9), sunSide);
          vec3 cl = mix(shadeC, lit, smoothstep(0.1, 0.24, yy + lump * 0.1));
          col = mix(col, cl, bank);
          float streak = smoothstep(0.62, 0.68, fbm(vec2(uu * 1.3, y * 26.0 + 4.0))) * smoothstep(0.16, 0.24, y) * (1.0 - smoothstep(0.36, 0.5, y)) * cover;
          col = mix(col, lit, streak * 0.8);
        }
        // stars (night)
        if (uStars > 0.0) {
          vec2 sp = vec2(az * 160.0, y * 160.0);
          float st = step(0.996, h21(floor(sp))) * smoothstep(0.08, 0.3, y);
          col += vec3(st) * uStars * (0.6 + 0.4 * h21(floor(sp) + 3.1));
        }
        float sd = max(dot(d, sunDir), 0.0);
        col += sunC * (smoothstep(0.9993, 0.9996, sd) * 0.9 * uSunDisc + pow(sd, 16.0) * 0.12) * (1.0 - bank);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.name = 'sky';
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

/** rings of hills around the stage; the nearer rings get a spruce-tooth ridgeline (forested hills in the concept art).
 *  Colours are "real" colours: the post-process aerial perspective hazes them by distance. */
export function buildMountains(stage: Stage, pal: Palette, seed: number) {
  const cor = stage.corridor;
  const cx = cor.minX + (cor.nx * cor.cell) / 2, cz = cor.minZ + (cor.nz * cor.cell) / 2;
  const span = Math.max(cor.nx, cor.nz) * cor.cell;
  const group = new THREE.Group();
  group.name = 'mountains';
  const forest = pal.pine.clone().lerp(pal.mountainNear, 0.25);
  const art = stage.env.art;
  // painted far layers per art set: file, aspect, repeats around the horizon, how much of the image hangs below the horizon
  const FAR: Record<string, [string, number, number, number][]> = {
    nordic: [['nordic_1.png', 8, 3, 0.12], ['nordic_2.png', 8, 3, 0.12]],
    savanna: [['savanna_2.png', 4, 6, 0.15]],
    snow: [['snow_1.png', 8, 3, 0.12], ['snow_2.png', 8, 3, 0.12]],
    coast: [['coast_1.png', 8, 4, 0.15], ['coast_2.png', 4, 6, 0.2]],
  };
  const farList = (FAR[art] ?? []).filter(([f]) => hasAsset(`/assets/far/${f}`));
  const farArt = farList.map(([f]) => `/assets/far/${f}`);
  const toothy = art === 'nordic' || art === 'snow';
  const flat = art === 'savanna' ? 0.35 : 1;
  const rings = [
    { r: span * 0.5 + 900, h: 70 * flat, col: forest, seed: seed + 4, k: 7, teeth: toothy ? 1.0 : 0, base: -20 },
    { r: span * 0.5 + 1900, h: 230 * flat, col: pal.mountainNear.clone().lerp(pal.pine, 0.3), seed: seed + 1, k: 5, teeth: toothy ? 0.7 : 0, base: -40 },
    { r: span * 0.5 + 3600, h: 430 * flat, col: pal.mountainFar.clone().lerp(pal.mountainNear, 0.3), seed: seed + 2, k: 3, teeth: 0, base: -60 },
  ].slice(0, art === 'coast' ? 0 : farArt.length ? 1 : 3);
  // painted far silhouettes (greyscale layers, tinted here): two wrapped rings behind the procedural near ring
  farArt.forEach((url, i) => {
    const r = span * 0.5 + (i === 0 ? 2100 : 3800);
    const [, aspect, reps, below] = farList[i];
    const tex = imageTexture(url, true, (t) => { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; });
    tex.wrapS = THREE.RepeatWrapping;
    const H = (2 * Math.PI * r) / (aspect * reps);
    const g = new THREE.CylinderGeometry(r, r, H, 256, 1, true);
    g.translate(0, H / 2 - H * below - 30 + (stage.terrain.coast ? stage.terrain.coast.seaLevel + 30 : 0), 0);
    const lo = (i === 0 ? pal.mountainNear.clone().lerp(pal.pine, 0.2) : pal.mountainFar.clone().lerp(pal.mountainNear, 0.25)).multiplyScalar(0.8);
    const hi = (i === 0 ? pal.mountainNear.clone().lerp(pal.skyHorizon, 0.35) : pal.mountainFar.clone().lerp(pal.skyHorizon, 0.45));
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: false, depthWrite: true,
      uniforms: { t: { value: tex }, lo: { value: lo }, hi: { value: hi }, reps: { value: reps } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D t; uniform vec3 lo, hi; uniform float reps; varying vec2 vUv;
        void main(){ vec4 c = texture2D(t, vec2(vUv.x * reps, vUv.y)); if (c.a < 0.5) discard;
          float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
          vec3 col = mix(lo, hi, smoothstep(0.2, 0.95, l));
          // snow caps / white layers stay bright
          col = mix(col, mix(hi, vec3(1.0), 0.5), smoothstep(0.9, 0.98, l));
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    m.position.set(cx, 0, cz);
    m.frustumCulled = false;
    m.renderOrder = -6;
    group.add(m);
  });
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  for (const ring of rings) {
    const seg = ring.teeth ? 2400 : 360;
    const pos: number[] = [], colr: number[] = [], idx: number[] = [];
    const lowC = ring.col.clone().lerp(pal.look.hazeFar, 0.25);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const u = Math.cos(a), v = Math.sin(a);
      let h = 0.55 + 0.45 * noise2(u * ring.k, v * ring.k, ring.seed) + 0.18 * noise2(u * ring.k * 3, v * ring.k * 3, ring.seed + 9);
      h = Math.max(0.1, h) * ring.h;
      // spruce teeth: every other vertex pokes up (tree tips), varying height; gaps where the forest thins
      if (ring.teeth) {
        const forested = noise2(u * 9, v * 9, ring.seed + 5) > -0.35 ? 1 : 0.15;
        h += (i % 2 ? 1 : 0) * (6 + 12 * hash2(i, 3, ring.seed)) * ring.teeth * forested * (ring.r / 2000);
      }
      const r = ring.r * (1 + 0.05 * noise2(u * 4, v * 4, ring.seed + 3));
      const x = cx + u * r, z = cz + v * r;
      pos.push(x, ring.base, z, x, h + (ring.base > -30 && !toothy ? 10 : 0), z);
      colr.push(lowC.r, lowC.g, lowC.b, ring.col.r, ring.col.g, ring.col.b);
      if (i < seg) { const b = i * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.renderOrder = -5;
    group.add(m);
  }
  return group;
}

export function buildWater(stage: Stage, pal: Palette) {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uDeep: { value: pal.water.clone().multiplyScalar(0.7) }, uSky: { value: pal.skyTop.clone().lerp(pal.skyHorizon, 0.35) },
      uTop: { value: pal.skyTop.clone() }, uHor: { value: pal.skyHorizon.clone().lerp(pal.skyTop, 0.3) },
      uTree: { value: pal.pineDark.clone().lerp(pal.water, 0.3) }, uSun: { value: pal.sun.clone() }, uShore: { value: new THREE.Color('#f4efe0') },
      uSunDir: { value: sunDirection(pal) }, uTime: { value: 0 }, uFrozen: { value: stage.env.road.kind === 'snow' ? 1 : 0 },
    },
    vertexShader: `varying vec3 vW; varying vec2 vL; varying vec2 vCam;
      void main(){ vL = position.xz; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        vCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xz;
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform vec3 uDeep, uSky, uTop, uHor, uTree, uSun, uShore, uSunDir; uniform float uTime, uFrozen; varying vec3 vW; varying vec2 vL; varying vec2 vCam;
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
      void main(){
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1.0 - max(V.y, 0.0), 4.0);
        // ripples bend the reflection a little
        float tt = uTime * (1.0 - uFrozen);
        float rip = vn(vec2(vW.x * 0.05, vW.z * 0.9) + tt * 0.05) * vn(vec2(vW.x * 0.9, vW.z * 0.05) - tt * 0.04);
        vec3 N = normalize(vec3((vn(vW.xz * 0.35 + tt * 0.2) - 0.5) * 0.06, 1.0, (vn(vW.zx * 0.31 - tt * 0.17) - 0.5) * 0.06));
        vec3 R = reflect(-V, N);
        // fake sky reflection: horizon → zenith gradient of the sky dome
        vec3 skyR = mix(uHor, uTop, smoothstep(0.0, 0.45, R.y));
        vec3 col = mix(uDeep, skyR, 0.18 + 0.72 * fres);
        // far shore: the forest mirrored as a dark band hanging from the shoreline (only on the side away from the camera)
        float rho = length(vL);
        vec2 dl = vL / max(rho, 1e-3), dc = normalize(vCam - vL);
        float away = smoothstep(0.1, -0.5, dot(dl, dc));
        float band = smoothstep(0.5 + 0.08 * vn(vec2(atan(vL.y, vL.x) * 9.0, 1.0)), 0.8, rho);
        col = mix(col, uTree, band * away * (0.45 + 0.4 * fres));
        // poster ripple streaks, sun glitter path
        col = mix(col, skyR * 1.08, smoothstep(0.55, 0.62, rip) * 0.4);
        float g = pow(max(dot(R, uSunDir), 0.0), 40.0);
        col += uSun * g * smoothstep(0.35, 0.6, rip + 0.25) * 1.4;
        // shoreline foam: a broken cream line where the water meets the bank
        float foamN = vn(vec2(atan(vL.y, vL.x) * 60.0, uTime * 0.3)) * 0.035;
        float foam = smoothstep(0.84 + foamN, 0.87 + foamN, rho) * (1.0 - smoothstep(0.9, 0.93, rho));
        col = mix(col, uShore, foam * 0.75);
        col = mix(col, uShore * 0.9, smoothstep(0.92, 0.95, rho) * 0.5);
        if (uFrozen > 0.5) {
          // frozen: pale blue-white ice with snow drifts and dark cracks, no ripples
          float drift = smoothstep(0.45, 0.7, vn(vW.xz * 0.04) * 0.7 + vn(vW.xz * 0.15) * 0.3);
          col = mix(mix(uDeep, uSky, 0.5 + 0.4 * fres), vec3(0.95, 0.96, 0.99), drift * 0.8);
          float crack = 1.0 - smoothstep(0.0, 0.02, abs(vn(vW.xz * 0.08) - 0.5));
          col = mix(col, uDeep * 0.6, crack * 0.5 * (1.0 - drift));
        }
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  for (const L of stage.terrain.lakes) {
    const g = new THREE.CircleGeometry(1, 128);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.scale.set(L.a * 0.985, 1, L.b * 0.985);
    m.rotation.y = -Math.atan2(L.uz, L.ux);
    m.position.set(L.cx, L.level, L.cz);
    m.name = 'lake';
    group.add(m);
  }
  group.userData.material = mat;
  // fords: muddy shallow water filling the river channel across the road
  if (stage.terrain.fords.some((f) => f.water)) {
    const fm = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        // body colour: the palette's water muddied a little toward the local soil (a ford is brown-green, not slate)
        uTime: mat.uniforms.uTime, uCol: { value: pal.water.clone().lerp(pal.dirt, 0.3).multiplyScalar(0.62) }, uSky: { value: pal.look.hazeFar.clone().lerp(pal.skyTop, 0.35).lerp(pal.water, 0.15) }, uFoam: { value: new THREE.Color('#f2ece0') }, uSun: { value: pal.sun.clone() }, uSunDir: { value: sunDirection(pal) },
        uBank: { value: pal.dirt.clone().lerp(pal.water, 0.35) },
        // sky reflection at grazing angles: the haze colour of this env/weather (what the sky looks like just above the
        // far bank) → the sky top; the palette's skyHorizon alone is a near-white cream in most looks
        uHor: { value: pal.look.hazeFar.clone().lerp(pal.skyHorizon, 0.3) }, uTop: { value: pal.look.hazeNear.clone().lerp(pal.skyTop, 0.5) },
        // ripple sources: xyz = where the car disturbed the water, w = when (view.ts feeds them while a wheel is in water)
        uRip: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, -1e5, 0, -100)) },
      },
      // out: horizontal direction from the channel's centre line toward this vertex's bank (tells the far bank from the near one)
      vertexShader: `attribute vec2 out2; varying vec3 vW; varying vec2 vL; varying vec2 vOut; void main(){ vL = uv; vOut = out2; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uTime; uniform vec3 uCol, uSky, uFoam, uSun, uSunDir, uBank, uHor, uTop; uniform vec4 uRip[8]; varying vec3 vW; varying vec2 vL; varying vec2 vOut;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec3 V = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(V.y, 0.0), 3.0);
          // across the channel: shallow sandy edges, deeper darker middle
          float e = min(vL.y, 1.0 - vL.y);
          float deep = smoothstep(0.05, 0.4, e);
          vec3 col = mix(mix(uBank, uCol, 0.55), uCol * 0.82, deep);
          // slow current: elongated poster streaks drifting downstream (vL.x runs along the channel, ~480 m)
          float flow = vn(vec2(vL.x * 260.0 - uTime * 0.9, vL.y * 7.0)) * 0.65 + vn(vec2(vL.x * 700.0 - uTime * 1.7, vL.y * 19.0)) * 0.35;
          // fine detail fades with distance: further away the streaks and flecks only add up to a pale smear
          float det = 1.0 - 0.75 * smoothstep(16.0, 42.0, distance(vW, cameraPosition));
          col = mix(col, mix(col, uSky, 0.55) * 1.1, smoothstep(0.6, 0.68, flow) * 0.7 * det);
          col = mix(col, col * 0.78, smoothstep(0.32, 0.24, flow) * 0.45);
          col = mix(col, uSky, (0.06 + 0.22 * fres) * deep);
          // drifting foam flecks
          float fl = step(0.86, vn(vec2(vL.x * 1400.0 - uTime * 2.2, vL.y * 40.0))) * (0.5 + 0.5 * (1.0 - deep));
          col = mix(col, uFoam, fl * 0.7 * det);
          vec3 R = reflect(-V, vec3(0.0, 1.0, 0.0));
          // seen at a low angle the surface mirrors the sky (horizon colour, the env's own tint), streaks break it up
          vec3 skyR = mix(uHor, uTop, smoothstep(0.02, 0.35, R.y));
          col = mix(col, skyR, fres * (0.22 + 0.22 * deep) + fres * 0.25 * smoothstep(0.45, 0.7, flow + 0.1));
          col += uSun * pow(max(dot(R, uSunDir), 0.0), 50.0) * 0.8 * (0.5 + flow);
          // the bank on the far side: its mirror image as a soft darker band (no hard line where water meets ground)
          float far = smoothstep(-0.1, 0.35, dot(vOut, normalize(vW.xz - cameraPosition.xz)));
          float wob = (vn(vec2(vL.x * 520.0, 3.0)) - 0.5) * 0.08;
          col = mix(col, uBank * 0.32 + skyR * 0.06, far * (1.0 - smoothstep(0.04, 0.34 + wob, e)) * 0.8);
          // ripples where the car went through: expanding rings, fading with age
          float rip = 0.0;
          for (int i = 0; i < 8; i++) {
            vec4 r = uRip[i];
            float age = uTime - r.w;
            if (age < 0.0 || age > 2.2) continue;
            float d = distance(vW.xz, r.xz);
            float rad = 0.8 + age * 2.6;
            rip += (1.0 - smoothstep(0.0, 0.22 + age * 0.08, abs(d - rad))) * (1.0 - age / 2.2);
          }
          col = mix(col, mix(uFoam, uSky, 0.3), clamp(rip, 0.0, 1.0) * 0.75);
          // foamy, broken shore line against the banks
          // (thin and faint on the far side: from the road it is a line along the horizon)
          float shore = 1.0 - smoothstep(0.03, 0.09, e + (vn(vec2(vL.x * 900.0, uTime * 0.3)) - 0.5) * 0.05);
          col = mix(col, uFoam, shore * mix(0.8, 0.3, far));
          // the far edge melts into the bank (wavy, so the waterline is not a ruled line); the near one stays crisp
          float edge = smoothstep(0.0, 0.012 + 0.1 * far, e + wob * 0.3 * far);
          gl_FragColor = vec4(col, mix(0.72, 0.92, deep) * edge);
          #include <colorspace_fragment>
        }`,
    });
    group.userData.ford = fm;
    for (const F of stage.terrain.fords) {
      if (!F.water) continue;
      // a ribbon following the channel's centre line (same meander as the carve)
      const N = 104, half = 240, pos: number[] = [], uv: number[] = [], out: number[] = [], idx: number[] = [];
      for (let i = 0; i <= N; i++) {
        const u = -half + (2 * half * i) / N;
        const mean = (7 * Math.sin(u / 37 + F.s) + 4 * Math.sin(u / 13)) * THREE.MathUtils.smoothstep(Math.abs(u), 8, 40);
        const w = F.hw * 0.66 * (1 + 0.25 * Math.sin(u / 23 + 1.3));
        const bx = F.cx + F.ux * u, bz = F.cz + F.uz * u;
        const lv = F.level + Math.max(0, Math.abs(u) - 20) * 0.01;
        for (const side of [-1, 1]) {
          const v = mean + side * w;
          pos.push(bx - F.uz * v, lv, bz + F.ux * v);
          uv.push(i / N, side < 0 ? 0 : 1);
          out.push(-F.uz * side, F.ux * side);
        }
        if (i < N) { const b = i * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('out2', new THREE.Float32BufferAttribute(out, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, fm);
      m.name = 'ford';
      m.renderOrder = 2;
      group.add(m);
    }
  }
  // sea (coast): a large plane at sea level with a poster-flat ocean shader
  const cst = stage.terrain.coast;
  if (cst) {
    const cor = stage.corridor;
    const cx = cor.minX + (cor.nx * cor.cell) / 2, cz = cor.minZ + (cor.nz * cor.cell) / 2;
    const sm = new THREE.ShaderMaterial({
      uniforms: { uTime: mat.uniforms.uTime, uSea: { value: pal.sea.clone() }, uDeep: { value: pal.sea.clone().multiplyScalar(0.62) }, uSky: { value: pal.skyHorizon.clone().lerp(pal.skyTop, 0.4) }, uSun: { value: pal.sun.clone() }, uSunDir: { value: sunDirection(pal) }, uFoam: { value: new THREE.Color('#f4f1e6') }, uLevel: { value: cst.seaLevel } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uTime, uLevel; uniform vec3 uSea, uDeep, uSky, uSun, uSunDir, uFoam; varying vec3 vW;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec3 V = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(V.y, 0.0), 5.0);
          float d = length(vW.xz - cameraPosition.xz);
          vec3 col = mix(uDeep, uSea, smoothstep(80.0, 1500.0, d));
          col = mix(col, uSky, fres * 0.55);
          // poster wave dashes and a sun glitter path
          float w = vn(vec2(vW.x * 0.02, vW.z * 0.12) + uTime * 0.03) * vn(vec2(vW.x * 0.11, vW.z * 0.02) - uTime * 0.025);
          col = mix(col, uSea * 1.25 + 0.05, smoothstep(0.5, 0.56, w) * 0.5 * (1.0 - smoothstep(300.0, 1500.0, d)));
          vec3 R = reflect(-V, vec3(0.0, 1.0, 0.0));
          float g = pow(max(dot(R, uSunDir), 0.0), 18.0);
          col = mix(col, uSun, g * smoothstep(0.35, 0.6, w + 0.2) * 0.85);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000).rotateX(-Math.PI / 2), sm);
    sea.position.set(cx, cst.seaLevel, cz);
    sea.name = 'sea';
    sea.frustumCulled = false;
    group.add(sea);
  }
  return group;
}

export interface Lights { sun: SunLight; hemi: THREE.HemisphereLight; dir: THREE.Vector3 }

/** sun with three's 2-cascade shadow (practical split over `range` m of view depth), plus hemisphere fill for non-poster materials */
export function buildLights(pal: Palette, shadowSize: number, range: number): Lights {
  const sun = new SunLight(pal.sun, pal.sunIntensity * Math.PI);
  const dir = sunDirection(pal);
  sun.position.copy(dir);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = range;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  sun.shadow.radius = 1;
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  const hemi = new THREE.HemisphereLight(pal.hemiSky, pal.hemiGround, pal.hemiIntensity * Math.PI);
  return { sun, hemi, dir };
}
