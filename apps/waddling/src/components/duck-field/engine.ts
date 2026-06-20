import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { DATA_LAKE_LAYERS } from '@/components/data-lake-icon';
import type { DuckSpec, SceneSpec } from './types';

// Real UTF-8 glyph ramp (sparse → dense) rendered to an atlas with the Canvas2D
// text API rather than hand-drawn bitmaps. Each glyph occupies a GLYPH_PX cell;
// GLYPH_RAMP.length glyphs stack vertically.
const GLYPH_RAMP = ['.', ':', '-', '=', '+', 'c', 'o', 'x', 'a', 'e', '#', '@'];
const GLYPH_PX = 8;

function createGlyphTexture() {
  const n = GLYPH_RAMP.length;
  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_PX;
  canvas.height = GLYPH_PX * n;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = `${GLYPH_PX + 1}px "Menlo", "DejaVu Sans Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let g = 0; g < n; g++) {
    ctx.fillText(GLYPH_RAMP[g], GLYPH_PX / 2, g * GLYPH_PX + GLYPH_PX / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false; // match the top-down glyph order the shader samples
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// Rasterize ONE layer of the data-lake logo (SVG paths, viewBox 0 0 364 364) onto
// a transparent texture — the "lake" primitive: a single solid lake silhouette.
// Filled white so the ASCII pass dithers it into a dense "dark section" (the empty
// transparent surround stays below the dither cutoff and reads as background).
function createLakeTexture(layerIndex: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.scale(size / 364, size / 364);
  ctx.fillStyle = '#ffffff';
  for (const d of DATA_LAKE_LAYERS[layerIndex]) ctx.fill(new Path2D(d));
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

const MERGED_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uSourceRes: { value: new THREE.Vector2(1, 1) },

    uCharW: { value: 8.0 },
    uCharH: { value: 10.0 },
    uColor: { value: new THREE.Color(0.063, 0.725, 0.506) },
    uGlow: { value: 1.0 },
    uGlyphCount: { value: GLYPH_RAMP.length },
    uGlyphTex: { value: null as THREE.Texture | null },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform vec2 uSourceRes;
    uniform sampler2D uGlyphTex;
    uniform float uCharW, uCharH, uGlow, uGlyphCount;
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;
      float cellXf = floor(gl_FragCoord.x / uCharW);
      float cellYf = floor(gl_FragCoord.y / uCharH);
      float cx = (cellXf * uCharW + uCharW * 0.5) / uResolution.x;
      float cy = (cellYf * uCharH + uCharH * 0.5) / uResolution.y;
      vec4 cellColor = texture2D(tDiffuse, vec2(cx, cy));
      float lum = dot(cellColor.rgb, vec3(0.299, 0.587, 0.114));
      // Leave the empty background un-dithered so the lit edges stand out.
      if (lum < 0.05) { gl_FragColor = vec4(0.0); return; }
      float glyphIdxF = clamp(floor(lum * (uGlyphCount - 1.0) + 0.5), 0.0, uGlyphCount - 1.0);
      float gx = floor(mod(gl_FragCoord.x, uCharW) * 8.0 / uCharW);
      float gy = floor(mod(gl_FragCoord.y, uCharH) * 8.0 / uCharH);
      // Sample the glyph atlas (uGlyphCount glyphs stacked vertically, 8px wide).
      float texY = (glyphIdxF * 8.0 + gy + 0.5) / (8.0 * uGlyphCount);
      float texX = (gx + 0.5) / 8.0;
      float row = texture2D(uGlyphTex, vec2(texX, texY)).r;
      float bit = step(0.5, row);
      // uGlow=1 (dark theme): brightness rides luminance for an emerald glow.
      // uGlow=0 (light theme): flat dark ink so the glyph density carries tone.
      vec3 litColor = uColor * mix(1.0, lum, uGlow);
      gl_FragColor = vec4(litColor * bit, bit);
    }
  `,
};

// Per-instance scratch state the engine keeps alongside each DuckInstance.
interface DuckRuntime {
  spinAngle: number;
  offsetY: number; // halfDepth * worldScale — seats the duck on its point
  worldScale: number; // scale * baseScale
}

const BASE_SCALE = 0.025;

// Mount a self-contained ASCII-dithered duck scene into `container`. The `spec`
// describes the arrangement (ducks/edges/camera); everything generic — renderer,
// post-process, lights, resize, theme sync, motion, disposal — lives here.
// Returns a cleanup function; call it on unmount.
export function mountDuckField(container: HTMLElement, spec: DuckSpec): () => void {
  // ── Renderer ──
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: true });
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(container.clientWidth, container.clientHeight, false);
  renderer.domElement.style.display = 'block';
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  // ── Scene ──
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#000000');
  scene.add(new THREE.AmbientLight('#8899cc', 1.0));

  const key = new THREE.DirectionalLight('#ffeedd', 3);
  key.position.set(10, 14, 8);
  scene.add(key);

  const rim = new THREE.DirectionalLight('#7799ff', 2);
  rim.position.set(-5, 3, -6);
  scene.add(rim);

  // ── Camera (framed once the spec is built; refit on every resize) ──
  const aspectFov = (a: number) => (a < 1 ? 110 : 85);
  const aspect = container.clientWidth / container.clientHeight;
  const camera = new THREE.PerspectiveCamera(aspectFov(aspect), aspect, 0.5, 60);

  // Frame parameters captured from the spec: the look-at target, the viewing
  // direction, the bounding radius of the content, and the desired vertical fov.
  // fitCamera() then pulls the camera back along the direction until the content
  // fits the current aspect — so the same scene stays fully visible whether it's
  // a wide hero or a narrow mobile column.
  let frameTarget: THREE.Vector3 | null = null;
  const frameDir = new THREE.Vector3(0, 0, 1);
  let frameRadius = 1;
  let frameFov: number | undefined;

  const fitCamera = () => {
    if (!frameTarget) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    const a = w / h;
    const vFov = ((frameFov ?? aspectFov(a)) * Math.PI) / 180;
    const vHalf = vFov / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * a);
    // Pull back to fit whichever axis is tighter (width on portrait/mobile).
    const dist = (frameRadius / Math.sin(Math.min(vHalf, hHalf))) * 1.03;
    camera.aspect = a;
    camera.fov = frameFov ?? aspectFov(a);
    camera.near = Math.max(0.1, dist - frameRadius * 2);
    camera.far = dist + frameRadius * 3 + 10;
    camera.position.copy(frameTarget).addScaledVector(frameDir, dist);
    camera.lookAt(frameTarget);
    camera.updateProjectionMatrix();
    controls.target.copy(frameTarget);
    controls.update();
  };

  // ── Controls (all disabled — camera is fixed) ──
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.enableRotate = false;
  controls.autoRotate = false;
  renderer.domElement.style.pointerEvents = 'none';

  // ── Half-res target ──
  const pr0 = Math.min(window.devicePixelRatio, 1.5);
  const rw = Math.floor(container.clientWidth * pr0 * 0.5);
  const rh = Math.floor(container.clientHeight * pr0 * 0.5);
  const renderTarget = new THREE.WebGLRenderTarget(rw, rh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  MERGED_SHADER.uniforms.uSourceRes.value.set(rw, rh);

  // ── Composer ──
  const composer = new EffectComposer(renderer, renderTarget);
  composer.addPass(new RenderPass(scene, camera));

  const glyphTex = createGlyphTexture();
  const mergePass = new ShaderPass(MERGED_SHADER);
  mergePass.uniforms['uGlyphTex'].value = glyphTex;
  mergePass.renderToScreen = true;
  composer.addPass(mergePass);
  MERGED_SHADER.uniforms.uResolution.value.set(container.clientWidth, container.clientHeight);

  // Fat connector lines, added to the main scene so they're dithered by the
  // ASCII pass and depth-tested against the ducks (an edge passing behind a duck
  // is occluded rather than drawn over it).
  let lineSegments: LineSegments2 | null = null;
  let lineMaterial: LineMaterial | null = null;
  const lakeMeshes: THREE.Mesh[] = [];
  let hiddenIndex = -1;

  // ── Resize ──
  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    const pr2 = Math.min(window.devicePixelRatio, 1.5);
    renderer.setPixelRatio(pr2);
    renderer.setSize(w, h);
    const rw2 = Math.floor(w * pr2 * 0.5);
    const rh2 = Math.floor(h * pr2 * 0.5);
    renderTarget.setSize(rw2, rh2);
    mergePass.uniforms['uSourceRes'].value.set(rw2, rh2);
    composer.setSize(rw2, rh2);
    // uResolution must match the drawing buffer (device pixels), not CSS px — the
    // merge shader divides gl_FragCoord (device px) by it. On HiDPI the mismatch
    // stretches the top/right third past the texture edge.
    mergePass.uniforms['uResolution'].value.set(w * pr2, h * pr2);
    // LineMaterial sizes its width against this; match the half-res ASCII target.
    if (lineMaterial) lineMaterial.resolution.set(rw2, rh2);
    // Re-fit the framing to the new aspect (no-op until the spec is built).
    fitCamera();
  };
  window.addEventListener('resize', onResize);
  // Observe the container itself, not just the window, so the scene stays framed
  // when a parent component resizes it (responsive layouts, mobile, embeds).
  const resizeObs = new ResizeObserver(() => onResize());
  resizeObs.observe(container);
  // Initialize the merge pass's uniforms on the actual (cloned) pass material.
  // ShaderPass clones MERGED_SHADER.uniforms, so the uResolution written to the
  // shared singleton above never reaches the render material — without this the
  // first frame divides gl_FragCoord by (1,1) and the whole scene samples black.
  onResize();

  // ── Load STL, then build the spec ──
  let ducks: SceneSpec['ducks'] = [];
  let runtime: DuckRuntime[] = [];
  let duckMeshes: THREE.InstancedMesh | null = null;

  const stlLoader = new STLLoader();
  stlLoader.load(`/RubberDuck.stl?v=1`, (geometry) => {
    geometry.center();
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    const halfDepth = (bbox.max.z - bbox.min.z) / 2;

    // Approximate centre of mass = mean of the (centred) vertices. Connector
    // edges attach here rather than at the grid point so they meet at the duck's
    // body rather than its feet/pivot.
    const localCom = new THREE.Vector3();
    const posAttr = geometry.getAttribute('position');
    for (let v = 0; v < posAttr.count; v++) {
      localCom.x += posAttr.getX(v); localCom.y += posAttr.getY(v); localCom.z += posAttr.getZ(v);
    }
    localCom.multiplyScalar(1 / posAttr.count);

    const built = spec({ bbox });
    ducks = built.ducks;

    runtime = ducks.map((d) => {
      const worldScale = d.scale * BASE_SCALE;
      // offsetY is applied in geometry space (before the instance scale). Using
      // halfDepth seats the duck's base on position.y; the default keeps the duck
      // roughly centred on its point (the historical cube/sphere behaviour).
      const offsetY = built.seatOnGrid ? halfDepth : halfDepth * worldScale;
      return { spinAngle: Math.random() * Math.PI * 2, worldScale, offsetY };
    });

    const material = new THREE.MeshStandardMaterial({ color: '#ffcc44', roughness: 0.35, metalness: 0.05 });
    duckMeshes = new THREE.InstancedMesh(geometry, material, ducks.length);
    scene.add(duckMeshes);

    // ── Lake planes: each a single logo-layer silhouette laid flat as the water
    // surface, so the ducks sit on top of it in the 3/4 isometric view. ──
    for (const lake of built.lakes ?? []) {
      const tex = createLakeTexture(lake.layer);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const sz = lake.size ?? 44;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sz, sz), mat);
      mesh.rotation.x = -Math.PI / 2; // horizontal surface
      mesh.rotation.z = lake.rotate ?? 0; // spin the silhouette about the vertical
      mesh.position.set(0, lake.y, 0);
      scene.add(mesh);
      lakeMeshes.push(mesh);
    }

    // ── Camera framing ──
    // The spec's camera defines the viewing direction + target + fov; fitCamera
    // derives the distance so the whole scene fits the current aspect ratio.
    frameTarget = new THREE.Vector3(...built.camera.target);
    frameDir.set(...built.camera.position).sub(frameTarget).normalize();
    frameFov = built.camera.fov;

    // Bounding radius of the content about the target: farthest duck centre (+ the
    // duck's own bounding-sphere radius) and the lake corners. Using the half
    // diagonal — not the largest dimension — keeps the fit tight so the content
    // fills the frame rather than floating in padding.
    const dx = bbox.max.x - bbox.min.x;
    const dyy = bbox.max.y - bbox.min.y;
    const dz = bbox.max.z - bbox.min.z;
    // Largest dimension (not the half-diagonal, which over-pads a non-cubic duck
    // and leaves the content floating small inside the frame).
    const duckHalf = 0.5 * Math.max(dx, dyy, dz); // geometry units; ×worldScale below
    let radius = 0;
    for (let k = 0; k < ducks.length; k++) {
      const [px, py, pz] = ducks[k].position;
      const ws = runtime[k].worldScale;
      // seatOnGrid puts the base on position.y, so the duck's centre sits ~halfDepth above it.
      const cy = built.seatOnGrid ? halfDepth * ws : 0;
      const d = Math.hypot(px - frameTarget.x, py + cy - frameTarget.y, pz - frameTarget.z);
      radius = Math.max(radius, d + duckHalf * ws);
    }
    for (const lake of built.lakes ?? []) {
      // The lake silhouette is a rounded blob filling ~80% of its square plane —
      // fit to that, not the (transparent) plane corners, or the scene floats in
      // empty padding. Lake is centred at x=z=0; rotation doesn't change its radius.
      const rs = ((lake.size ?? 44) / 2) * 0.8;
      const dxz = Math.hypot(frameTarget.x, frameTarget.z) + rs;
      radius = Math.max(radius, Math.hypot(dxz, lake.y - frameTarget.y));
    }
    frameRadius = radius;
    fitCamera();

    // Hide the duck nearest the camera — it looms over the framing (cube lattice).
    if (built.hideNearest) {
      let nearest = Infinity;
      for (let k = 0; k < ducks.length; k++) {
        const [px, py, pz] = ducks[k].position;
        const dx = px - camera.position.x;
        const dy = py - camera.position.y;
        const dz = pz - camera.position.z;
        const dist = dx * dx + dy * dy + dz * dz;
        if (dist < nearest) { nearest = dist; hiddenIndex = k; }
      }
    }

    // ── Edges → fat lines, attached at each duck's centre of mass ──
    // World COM at rest (spin = 0): T(grid)·S(worldScale)·T(0,offsetY,0)·rotX·com.
    const comWorld = (idx: number): [number, number, number] => {
      const d = ducks[idx];
      const rt = runtime[idx];
      const dm = new THREE.Matrix4().compose(
        new THREE.Vector3(d.position[0], d.position[1], d.position[2]),
        new THREE.Quaternion(),
        new THREE.Vector3(rt.worldScale, rt.worldScale, rt.worldScale),
      );
      const upM = new THREE.Matrix4().makeTranslation(0, rt.offsetY, 0);
      const m = dm.multiply(upM).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      const p = localCom.clone().applyMatrix4(m);
      return [p.x, p.y, p.z];
    };

    const edges = built.edges ?? [];
    const linePositions: number[] = [];
    for (const [i, j] of edges) {
      if (i === hiddenIndex || j === hiddenIndex) continue; // skip edges into the hidden duck
      const a = comWorld(i);
      const b = comWorld(j);
      linePositions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }

    if (linePositions.length > 0) {
      // Fat lines so the connectors survive the half-res ASCII pass (a 1px line
      // all but vanishes after downsampling). depthTest on → ducks occlude the
      // edges that pass behind them; transparent so they don't write depth.
      const lineGeo = new LineSegmentsGeometry();
      lineGeo.setPositions(linePositions);
      lineGeo.setColors(new Float32Array(linePositions.length));
      const pr = Math.min(window.devicePixelRatio, 1.5);
      lineMaterial = new LineMaterial({
        vertexColors: true,
        transparent: true,
        linewidth: 5,
        worldUnits: false,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      lineMaterial.resolution.set(
        Math.floor(container.clientWidth * pr * 0.5),
        Math.floor(container.clientHeight * pr * 0.5),
      );
      lineSegments = new LineSegments2(lineGeo, lineMaterial);
      scene.add(lineSegments);
    }
  });

  // ── Animation ──
  const timer = new THREE.Timer(); // Timer replaces the deprecated THREE.Clock
  let frameCount = 0;
  let running = true;

  // Render only when the tab is visible AND this scene is on (or near) screen.
  // Several DuckFields can share one page; off-screen ones shouldn't burn frames.
  let tabVisible = document.visibilityState === 'visible';
  let onScreen = true;
  const updateRunning = () => {
    const next = tabVisible && onScreen;
    if (next && !running) timer.update(); // reset so the resumed frame's dt doesn't jump
    running = next;
  };
  const onVisibility = () => {
    tabVisible = document.visibilityState === 'visible';
    updateRunning();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const viewObs = new IntersectionObserver(
    (entries) => { onScreen = entries[entries.length - 1].isIntersecting; updateRunning(); },
    { rootMargin: '120px' },
  );
  viewObs.observe(container);

  const dummy = new THREE.Object3D();
  const rotX = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  const up = new THREE.Matrix4();
  const composed = new THREE.Matrix4();

  let animId = 0;
  const animate = () => {
    animId = requestAnimationFrame(animate);
    if (!running) return;
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1); // clamp after a stall/resume
    const elapsed = performance.now() * 0.001;
    frameCount++;

    if (duckMeshes) {
      for (let i = 0; i < ducks.length; i++) {
        const d = ducks[i];
        const rt = runtime[i];
        let px: number, py: number, pz: number;
        if (d.orbit) {
          const a = d.orbit.phase + elapsed * d.orbit.speed;
          px = d.orbit.center[0] + Math.cos(a) * d.orbit.radius;
          py = d.orbit.center[1];
          pz = d.orbit.center[2] + Math.sin(a) * d.orbit.radius;
        } else {
          px = d.position[0]; py = d.position[1]; pz = d.position[2];
        }
        const wobble = d.wobbleAmp ? Math.sin(elapsed * (d.wobbleSpeed ?? 1)) * d.wobbleAmp : 0;
        rt.spinAngle += (d.spinSpeed ?? 0) * dt;
        dummy.position.set(px, py + wobble, pz);
        dummy.rotation.set(0, rt.spinAngle, 0);
        dummy.scale.setScalar(i === hiddenIndex ? 0 : rt.worldScale);
        dummy.updateMatrix();
        up.makeTranslation(0, rt.offsetY, 0);
        composed.multiplyMatrices(dummy.matrix, up).multiply(rotX);
        duckMeshes.setMatrixAt(i, composed);
      }
      duckMeshes.instanceMatrix.needsUpdate = true;
    }

    if (frameCount % 3 === 0) {
      const isLight = document.documentElement.classList.contains('light');
      // Light theme: dark ink, no luminance glow — density alone gives detail and
      // avoids washed-out green on white. Dark theme: emerald glow.
      mergePass.uniforms['uColor'].value.setRGB(
        isLight ? 0.055 : 0.063,
        isLight ? 0.11 : 0.725,
        isLight ? 0.09 : 0.506,
      );
      mergePass.uniforms['uGlow'].value = isLight ? 0.0 : 1.0;
    }

    if (frameCount % 3 === 0 && lineSegments) {
      // Push the connectors to a luminance that maps to dense, visible glyphs
      // against the (theme-dependent) background: bright on dark, a touch softer
      // on light so they don't slam to heavy '@' marks on white. Where an edge
      // passes behind a duck it's already occluded by the depth test.
      const isLight = document.documentElement.classList.contains('light');
      const v = isLight ? 0.7 : 1.0;
      const attr = lineSegments.geometry.getAttribute('instanceColorStart') as THREE.InterleavedBufferAttribute;
      const colors = attr.data.array as Float32Array;
      const segCount = colors.length / 6;
      for (let s = 0; s < segCount; s++) {
        const r1 = Math.sin(s * 127.1 + elapsed * 3.7);
        const r2 = Math.sin(s * 311.7 + elapsed * 2.3);
        const r3 = Math.sin(s * 521.3 + elapsed * 5.1);
        // Shimmer but never drop low — keeps the whole lattice connected.
        const c = v * (0.7 + 0.3 * (r1 + r2 + r3) / 3);
        colors[s * 6] = c; colors[s * 6 + 1] = c; colors[s * 6 + 2] = c;
        colors[s * 6 + 3] = c; colors[s * 6 + 4] = c; colors[s * 6 + 5] = c;
      }
      attr.data.needsUpdate = true;
    }

    composer.render();
  };
  animId = requestAnimationFrame(animate);

  return () => {
    cancelAnimationFrame(animId);
    window.removeEventListener('resize', onResize);
    resizeObs.disconnect();
    viewObs.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) { ext.loseContext(); }
    glyphTex.dispose();
    for (const m of lakeMeshes) {
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      m.geometry.dispose();
    }
    lineMaterial?.dispose();
    lineSegments?.geometry.dispose();
    duckMeshes?.geometry.dispose();
    (duckMeshes?.material as THREE.Material | undefined)?.dispose();
    renderer.dispose();
    renderTarget.dispose();
    controls.dispose();
    if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
  };
}
