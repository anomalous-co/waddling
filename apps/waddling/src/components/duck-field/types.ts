import type * as THREE from 'three';

// One duck in a scene. Positions are in world units; `scale` is a multiplier on
// the engine's baseScale (so 1.0 ≈ the default duck size). All motion is optional
// and driven generically by the engine each frame — a layout just declares it.
export interface DuckInstance {
  position: [number, number, number];
  scale: number;
  // Vertical bob: y += sin(t * wobbleSpeed) * wobbleAmp.
  wobbleAmp?: number;
  wobbleSpeed?: number;
  // Self-rotation about Y (radians/sec).
  spinSpeed?: number;
  // If set, the duck's XZ position is computed each frame on this circle,
  // overriding `position`. `phase` staggers ducks around the ring.
  orbit?: {
    center: [number, number, number];
    radius: number;
    speed: number;
    phase: number;
  };
}

// A connector drawn as a fat line between two ducks (indices into `ducks`).
export type Edge = [number, number];

// A "lake": one layer of the waddling logo rasterized onto a single flat,
// horizontal plane (with its raised white edge). Stack several at different `y`
// to rebuild the layered data-lake mark in 3D under a scene.
export interface Lake {
  layer: number;       // index into the logo's layers (0 = bottom, 2 = top surface)
  y: number;           // height of the plane in world units
  size?: number;       // plane edge length (default 44)
  rotate?: number;     // in-plane (about vertical) rotation in radians; +ve = CCW from above
}

export interface BuildContext {
  // Bounding box of the centered duck geometry (for sizing/seating math).
  bbox: THREE.Box3;
}

export interface SceneSpec {
  ducks: DuckInstance[];
  edges?: Edge[];
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    // Omit to use the engine's aspect-based default (110° portrait / 85° landscape).
    fov?: number;
  };
  // Hide the duck nearest the camera and drop edges touching it (cube lattice).
  hideNearest?: boolean;
  // Seat each duck so its base rests exactly on its position.y (rather than the
  // default, which centers the duck on its point). Lets the bottom layer sit
  // flush on a lake surface. Off for scenes where ducks should be centred
  // (sphere, orbit).
  seatOnGrid?: boolean;
  // Flat logo-layer planes laid below the ducks as a water surface (Lakehouse).
  lakes?: Lake[];
}

// A layout is a pure function from the loaded geometry to a scene description.
export type DuckSpec = (ctx: BuildContext) => SceneSpec;
