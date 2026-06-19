'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

function createGlyphTexture() {
  const GLYPH_DATA = [
    60, 126, 231, 219, 219, 207, 126, 60,
    60, 102, 102, 60, 102, 102, 102, 60,
    0, 36, 126, 36, 36, 126, 36, 0,
    98, 100, 8, 16, 32, 70, 70, 0,
    0, 0, 60, 66, 66, 66, 60, 0,
    0, 66, 36, 24, 24, 36, 66, 0,
    0, 0, 16, 84, 56, 84, 16, 0,
    0, 0, 8, 8, 126, 8, 8, 0,
    0, 0, 24, 24, 0, 24, 24, 0,
    0, 0, 0, 0, 0, 24, 24, 0,
  ];
  const data = new Uint8Array(8 * 80 * 4);
  for (let g = 0; g < 10; g++) {
    for (let y = 0; y < 8; y++) {
      const row = GLYPH_DATA[g * 8 + y];
      for (let x = 0; x < 8; x++) {
        const bit = (row >> (7 - x)) & 1;
        const v = bit * 255;
        const i = (g * 8 + y) * 8 * 4 + x * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, 8, 80, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

const SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uSourceRes: { value: new THREE.Vector2(1, 1) },
    uCharW: { value: 8.0 },
    uCharH: { value: 14.0 },
    uColorMode: { value: 0.0 },
    uGlyphTex: { value: null },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse, uGlyphTex;
    uniform vec2 uResolution, uSourceRes;
    uniform float uCharW, uCharH, uColorMode;
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;
      float cellXf = floor(gl_FragCoord.x / uCharW);
      float cellYf = floor(gl_FragCoord.y / uCharH);
      float cx = (cellXf * uCharW + uCharW * 0.5) / uResolution.x;
      float cy = (cellYf * uCharH + uCharH * 0.5) / uResolution.y;
      vec4 cellColor = texture2D(tDiffuse, vec2(cx, cy));
      float lum = dot(cellColor.rgb, vec3(0.299, 0.587, 0.114));
      float glyphIdxF = clamp(floor(lum * 9.0 + 0.5), 0.0, 9.0);
      int glyphIdx = int(glyphIdxF);
      float gx = floor(mod(gl_FragCoord.x, uCharW) * 8.0 / uCharW);
      float gy = floor(mod(gl_FragCoord.y, uCharH) * 8.0 / uCharH);
      float texY = (float(glyphIdx) * 8.0 + gy + 0.5) / 80.0;
      float texX = (gx + 0.5) / 8.0;
      float row = texture2D(uGlyphTex, vec2(texX, texY)).r;
      float bit = step(0.5, row);
      vec3 green = vec3(0.063, 0.725, 0.506);
      vec3 litColor = mix(green * lum, cellColor.rgb, uColorMode);
      gl_FragColor = vec4(mix(vec3(0.0), litColor, bit), bit);
    }
  `,
};

interface Props { className?: string; }

export function SingleDuckScene({ className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: true });
    renderer.setClearColor(0x000000, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#000000');
    scene.add(new THREE.AmbientLight('#ffffff', 1.2));
    const key = new THREE.DirectionalLight('#ffffff', 2);
    key.position.set(5, 8, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight('#8899cc', 1);
    rim.position.set(-3, 2, -3);
    scene.add(rim);

    const aspect = container.clientWidth / container.clientHeight;
    const fov = aspect < 1 ? 55 : 45;
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.5, 60);

    // ── Half-res ──
    const pr = Math.min(window.devicePixelRatio, 1.5);
    const rw = Math.floor(container.clientWidth * pr * 0.5);
    const rh = Math.floor(container.clientHeight * pr * 0.5);
    const renderTarget = new THREE.WebGLRenderTarget(rw, rh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    SHADER.uniforms.uSourceRes.value.set(rw, rh);

    const composer = new EffectComposer(renderer, renderTarget);
    composer.addPass(new RenderPass(scene, camera));
    const mergePass = new ShaderPass(SHADER);
    mergePass.uniforms['uGlyphTex'].value = createGlyphTexture();
    mergePass.renderToScreen = true;
    composer.addPass(mergePass);
    SHADER.uniforms.uResolution.value.set(container.clientWidth, container.clientHeight);

    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.fov = (w / h) < 1 ? 55 : 45;
      camera.updateProjectionMatrix();
      const pr2 = Math.min(window.devicePixelRatio, 1.5);
      renderer.setPixelRatio(pr2);
      renderer.setSize(w, h);
      const rw2 = Math.floor(w * pr2 * 0.5);
      const rh2 = Math.floor(h * pr2 * 0.5);
      renderTarget.setSize(rw2, rh2);
      mergePass.uniforms['uSourceRes'].value.set(rw2, rh2);
      composer.setSize(rw2, rh2);
      mergePass.uniforms['uResolution'].value.set(w, h);
    };
    window.addEventListener('resize', onResize);
    // ShaderPass clones SHADER.uniforms, so the uResolution written to the shared
    // singleton above never reaches the render material. Seed the cloned uniforms
    // once at startup, otherwise the first frame divides by (1,1) → all black.
    onResize();

    const duckData: { gridX: number; gridY: number; gridZ: number; scale: number; offsetY: number; rotSpeed: number; angle: number }[] = [];
    let duckMeshes: THREE.InstancedMesh | null = null;
    const gridSize = 2;
    const spacing = 5.0;
    const half = (gridSize - 1) * spacing * 0.5;
    const baseScale = 0.025;

    const stlLoader = new STLLoader();
    stlLoader.load(`/RubberDuck.stl?v=${Date.now()}`, (geometry) => {
      geometry.center();
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      // computeBoundingBox() just populated boundingBox — non-null here.
      const bbox = geometry.boundingBox!;
      const halfDepth = (bbox.max.z - bbox.min.z) / 2;

      const mat = new THREE.MeshStandardMaterial({ color: '#ffcc44', roughness: 0.35, metalness: 0.05 });
      duckMeshes = new THREE.InstancedMesh(geometry, mat, gridSize ** 3);

      let i = 0;
      for (let layer = 0; layer < gridSize; layer++) {
        for (let row = 0; row < gridSize; row++) {
          for (let col = 0; col < gridSize; col++) {
            const px = col * spacing - half;
            const pz = row * spacing - half;
            const py = layer * spacing - half;
            const scaleVar = baseScale * (0.85 + Math.random() * 0.3);
            duckData.push({ gridX: px, gridY: py, gridZ: pz, scale: scaleVar, offsetY: halfDepth * scaleVar, rotSpeed: 0.3 + Math.random() * 0.7, angle: Math.random() * Math.PI * 2 });
            i++;
          }
        }
      }
      scene.add(duckMeshes);

      // Lines
      const linePositions: number[] = [];
      for (let layer = 0; layer < gridSize; layer++) {
        for (let row = 0; row < gridSize; row++) {
          for (let col = 0; col < gridSize; col++) {
            const idx = layer * gridSize * gridSize + row * gridSize + col;
            const a = duckData[idx];
            for (const [dl, dr, dc] of [[1,0,0],[0,1,0],[0,0,1]] as [number,number,number][]) {
              const l2 = layer + dl, r2 = row + dr, c2 = col + dc;
              if (l2 < gridSize && r2 < gridSize && c2 < gridSize) {
                const idx2 = l2 * gridSize * gridSize + r2 * gridSize + c2;
                const b = duckData[idx2];
                linePositions.push(a.gridX, a.gridY, a.gridZ, b.gridX, b.gridY, b.gridZ);
              }
            }
          }
        }
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
      const lineColors = new Float32Array(linePositions.length);
      lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
      scene.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false })));

      // 3/4 view camera — zoomed out for mobile
      camera.position.set(6.0, 5.0, 8.0);
      camera.lookAt(0, 0, 0);
    });

    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const dt = 0.016;
      const elapsed = performance.now() * 0.001;
      if (duckMeshes) {
        const dummy = new THREE.Object3D();
        const rotX = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
        duckData.forEach((d, i) => {
          d.angle += d.rotSpeed * dt;
          dummy.position.set(d.gridX, d.gridY, d.gridZ);
          dummy.rotation.set(0, d.angle, 0);
          dummy.scale.setScalar(d.scale);
          dummy.updateMatrix();
          const up = new THREE.Matrix4().makeTranslation(0, d.offsetY, 0);
          duckMeshes!.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(dummy.matrix, up).multiply(rotX));
        });
        duckMeshes.instanceMatrix.needsUpdate = true;

        // Blink lines
        const isLight = document.documentElement.classList.contains('light');
        const lineR = isLight ? 0.15 : 1.0;
        const lineG = isLight ? 0.08 : 0.35;
        scene.traverse((c) => {
          if (c instanceof THREE.LineSegments && c.geometry.attributes.color) {
            const colors = c.geometry.attributes.color.array;
            const sc = colors.length / 6;
            for (let s = 0; s < sc; s++) {
              const on = (Math.sin(s * 127.1 + elapsed * 3.7) + Math.sin(s * 311.7 + elapsed * 2.3) + Math.sin(s * 521.3 + elapsed * 5.1)) > 0.0;
              const rr = on ? lineR : 0.0, rg = on ? lineG : 0.0;
              colors[s * 6] = rr; colors[s * 6 + 1] = rg;
              colors[s * 6 + 3] = rr; colors[s * 6 + 4] = rg;
            }
            c.geometry.attributes.color.needsUpdate = true;
          }
        });
      }
      composer.render();
    };
    animId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      renderer.dispose();
      renderTarget.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
