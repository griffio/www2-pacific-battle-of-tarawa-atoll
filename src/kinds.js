// Sprite kinds shared between simulation (render list building) and WGSL shader.
export const K = {
  SHADOW: 0, SOLDIER: 1, BODY: 2, PALM: 3, STUMP: 4, BUILDING: 5, BUNKER: 6, PILLBOX: 7, SEAWALL: 8, PIER: 9,
  LVT: 10, LCVP: 11, LCM: 12, SHERMAN: 13, STUART: 14, HAGO: 15, COASTGUN: 16, FIELDGUN: 17, WIRE: 18, TRAP: 19,
  HULK: 20, BLOCKHOUSE: 21, SMOKE: 22, FIRE: 23, FLASH: 24, TRACER: 25, SPARK: 26, SPLASH: 27, DUST: 28, SANDBAG: 29,
  TRENCH: 30, HUT: 31, RUBBLE: 32, ROCKET: 33, PLANE: 34, FOXHOLE: 35, TRUCK: 36, CRATE: 37, FLAME: 38, RING: 39,
  SHIP: 40, DEBRIS: 41, REVET: 42, WAKE: 43, GLOW: 44, MGNEST: 45, RAFT: 46, SELBOX: 47, ATLAS: 48, MUZZLE: 49,
};
// Decal kinds (drawn into the persistent ground decal texture)
export const DK = { CRATER: 0, SCORCH: 1, TRACK: 2, STAIN: 3, FOXHOLE: 4, TRENCH: 5, PATH: 6 };
