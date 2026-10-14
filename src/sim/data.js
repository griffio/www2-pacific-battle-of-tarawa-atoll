// Weapons, unit organisations and vehicles, modelled on 2nd Marine Division (Nov 1943)
// and the Japanese 7th Sasebo SNLF / 3rd Special Base Force on Betio.
//
// rof = seconds between trigger pulls (bursts). burst = rounds per pull.
// acc = base hit probability at point blank vs a fully exposed man. eff = effective range.
// sup = suppression caused per round on/near the target.

export const W = {
  // ---- US ----
  m1:       { name: 'M1 Garand', cls: 'rifle', range: 460, eff: 260, rof: 1.25, burst: 1, mag: 8, ammo: 96, acc: 0.5, sup: 5, snd: 'rifle_us', reload: 2.6, ping: true },
  m1903:    { name: 'M1903A4 Springfield (scoped)', cls: 'rifle', range: 650, eff: 450, rof: 2.4, burst: 1, mag: 5, ammo: 60, acc: 0.82, sup: 5, snd: 'rifle_us', reload: 3.5, pitch: 0.95 },
  carbine:  { name: 'M1 Carbine', cls: 'rifle', range: 280, eff: 150, rof: 0.95, burst: 1, mag: 15, ammo: 90, acc: 0.42, sup: 3.5, snd: 'carbine', reload: 2 },
  thompson: { name: 'Thompson M1A1', cls: 'smg', range: 160, eff: 70, rof: 1.0, burst: 5, gap: 0.075, mag: 20, ammo: 240, acc: 0.3, sup: 4, snd: 'smg', reload: 2.8 },
  bar:      { name: 'BAR M1918A2', cls: 'auto', range: 560, eff: 360, rof: 1.5, burst: 5, gap: 0.12, mag: 20, ammo: 300, acc: 0.36, sup: 9, snd: 'bar', tracer: true, reload: 3.2 },
  m1919:    { name: 'M1919A4 .30 cal MG', cls: 'mg', range: 950, eff: 650, rof: 1.7, burst: 10, gap: 0.1, mag: 250, ammo: 1750, acc: 0.3, sup: 14, snd: 'mg_us', tracer: true, reload: 6, setup: 3.5, crew: true },
  m2hb:     { name: 'M2 .50 cal HMG', cls: 'hmg', range: 1100, eff: 750, rof: 1.6, burst: 8, gap: 0.12, mag: 105, ammo: 1200, acc: 0.3, sup: 18, snd: 'mg_50', tracer: true, reload: 7, pen: 22, vsVeh: 4 },
  bazooka:  { name: 'M1A1 Bazooka', cls: 'at', range: 220, eff: 130, rof: 7, burst: 1, mag: 1, ammo: 8, acc: 0.55, sup: 25, snd: 'bazooka', proj: 'rocket', speed: 85, he: { power: 1.6, r: 5 }, pen: 100, vsVeh: 120, vsStruct: 95, crew: true },
  flamer:   { name: 'M1A1 Flamethrower', cls: 'flame', range: 26, eff: 22, rof: 3.8, burst: 1, ammo: 7, acc: 0.9, sup: 70, snd: 'flamethrower', crew: true },
  mortar60: { name: 'M2 60 mm Mortar', cls: 'mortar', range: 1650, min: 70, eff: 1200, rof: 4.5, burst: 1, ammo: 36, acc: 1, sup: 30, snd: 'mortar_launch', he: { power: 1.5, r: 9 }, indirect: true, crew: true, setup: 6 },
  m3_75:    { name: '75 mm M3 gun', cls: 'cannon', range: 1300, eff: 900, rof: 5.5, burst: 1, ammo: 97, acc: 0.62, sup: 35, snd: 'cannon_tank', proj: 'shell', speed: 400, he: { power: 2.6, r: 9 }, pen: 85, vsVeh: 200, vsStruct: 140 },
  m6_37:    { name: '37 mm M6 gun', cls: 'cannon', range: 950, eff: 650, rof: 3.2, burst: 1, ammo: 103, acc: 0.6, sup: 20, snd: 'cannon_small', proj: 'shell', speed: 500, he: { power: 1.1, r: 5 }, pen: 55, vsVeh: 100, vsStruct: 45, canister: true },
  m1919c:   { name: 'M1919A4 coax', cls: 'mg', range: 900, eff: 600, rof: 1.6, burst: 9, gap: 0.1, mag: 250, ammo: 4000, acc: 0.3, sup: 12, snd: 'mg_us', tracer: true, reload: 5 },
  pack75:   { name: '75 mm M1A1 Pack Howitzer', cls: 'cannon', range: 1800, eff: 1200, rof: 6, burst: 1, ammo: 60, acc: 0.6, sup: 35, snd: 'cannon_field', proj: 'shell', speed: 300, he: { power: 2.6, r: 10 }, pen: 60, vsVeh: 150, vsStruct: 130, crew: true, setup: 8 },
  // ---- Japan ----
  arisaka:  { name: 'Arisaka Type 99', cls: 'rifle', range: 460, eff: 260, rof: 1.9, burst: 1, mag: 5, ammo: 90, acc: 0.5, sup: 5, snd: 'rifle_jp', reload: 3.2 },
  arisaka97:{ name: 'Type 97 sniper rifle', cls: 'rifle', range: 650, eff: 450, rof: 2.8, burst: 1, mag: 5, ammo: 60, acc: 0.8, sup: 5, snd: 'rifle_jp', reload: 3.5, pitch: 1.05 },
  type96:   { name: 'Type 96 LMG', cls: 'auto', range: 620, eff: 420, rof: 1.6, burst: 5, gap: 0.11, mag: 30, ammo: 480, acc: 0.38, sup: 10, snd: 'mg_jp', pitch: 1.18, tracer: true, reload: 3 },
  type92:   { name: 'Type 92 HMG', cls: 'mg', range: 950, eff: 700, rof: 1.8, burst: 10, gap: 0.13, mag: 30, ammo: 2200, acc: 0.33, sup: 15, snd: 'mg_jp', tracer: true, reload: 3, crew: true },
  type93:   { name: 'Type 93 13 mm twin MG', cls: 'hmg', range: 1200, eff: 800, rof: 1.8, burst: 8, gap: 0.12, ammo: 1600, acc: 0.3, sup: 18, snd: 'mg_50', pitch: 1.12, tracer: true, reload: 4, pen: 20, vsVeh: 3, crew: true },
  knee:     { name: 'Type 89 Grenade Discharger', cls: 'mortar', range: 520, min: 40, eff: 400, rof: 11, burst: 1, ammo: 18, acc: 1, sup: 25, snd: 'mortar_launch', he: { power: 1.0, r: 7 }, indirect: true },
  type94:   { name: 'Type 94 37 mm gun', cls: 'cannon', range: 1100, eff: 700, rof: 3.2, burst: 1, ammo: 80, acc: 0.55, sup: 20, snd: 'cannon_small', proj: 'shell', speed: 500, he: { power: 1.1, r: 5 }, pen: 42, vsVeh: 90, vsStruct: 40, crew: true },
  type41:   { name: 'Type 41 75 mm Mountain Gun', cls: 'cannon', range: 2200, eff: 1400, rof: 6.5, burst: 1, ammo: 60, acc: 0.5, sup: 35, snd: 'cannon_field', proj: 'shell', speed: 300, he: { power: 2.5, r: 9 }, pen: 45, vsVeh: 110, vsStruct: 120, crew: true },
  coastal:  { name: '8-inch Vickers coastal gun', cls: 'coastal', range: 6000, eff: 4000, rof: 28, burst: 1, ammo: 40, acc: 0.35, sup: 60, snd: 'cannon_heavy', proj: 'shell', speed: 600, he: { power: 6, r: 18 }, pen: 200, vsVeh: 1000, vsStruct: 400, crew: true },
  hago37:   { name: 'Type 94 37 mm tank gun', cls: 'cannon', range: 900, eff: 600, rof: 3.4, burst: 1, ammo: 119, acc: 0.52, sup: 20, snd: 'cannon_small', proj: 'shell', speed: 500, he: { power: 1.0, r: 5 }, pen: 38, vsVeh: 80, vsStruct: 30 },
  type97mg: { name: 'Type 97 MG', cls: 'mg', range: 800, eff: 550, rof: 1.7, burst: 8, gap: 0.11, ammo: 2500, acc: 0.3, sup: 11, snd: 'mg_jp', pitch: 1.1, tracer: true, reload: 3 },
  pistol:   { name: 'Type 14 Nambu pistol', cls: 'pistol', range: 50, eff: 25, rof: 1.0, burst: 1, mag: 8, ammo: 40, acc: 0.35, sup: 2, snd: 'rifle_jp', pitch: 1.4, reload: 2 },
};

// Grenades / demolitions
export const GRENADE = { range: 30, power: 1.0, r: 7, fuse: 2.0 };
export const SATCHEL = { power: 6, r: 10, fuse: 6 };

// Soldier height profiles (m) by stance: 0 stand, 1 crouch, 2 prone
export const STANCE_H = [1.75, 1.0, 0.42];
export const STANCE_EXPOSE = [1.0, 0.68, 0.34];

// Unit organisations. [rank, role, weapon, opts]
export const UNITS = {
  // ---------------- USMC ----------------
  us_rifle: { side: 'US', name: 'Rifle Squad', short: 'RIFLE', icon: 'inf', morale: 75, men: [
    ['Sgt', 'leader', 'thompson'], ['Cpl', 'rifle', 'm1'], ['Pfc', 'bar', 'bar'], ['Pvt', 'rifle', 'm1'], ['Pfc', 'rifle', 'm1'],
    ['Pvt', 'bar', 'bar'], ['Pvt', 'rifle', 'm1'], ['Pfc', 'rifle', 'm1'], ['PhM3', 'medic', 'carbine']] },
  us_assault: { side: 'US', name: 'Assault Engineers', short: 'ENGR', icon: 'eng', morale: 78, men: [
    ['Sgt', 'leader', 'thompson'], ['Pfc', 'flame', 'flamer'], ['Pvt', 'asst', 'carbine'], ['Cpl', 'demo', 'm1', { satchels: 2 }],
    ['Pfc', 'demo', 'm1', { satchels: 2 }], ['Pvt', 'rifle', 'm1', { satchels: 1 }]] },
  us_mg: { side: 'US', name: 'MG Section', short: 'MG', icon: 'mg', morale: 72, men: [
    ['Sgt', 'leader', 'carbine'], ['Cpl', 'gunner', 'm1919'], ['Pfc', 'asst', 'carbine'], ['Pvt', 'ammo', 'carbine'], ['Pvt', 'ammo', 'm1']] },
  us_bazooka: { side: 'US', name: 'Bazooka Team', short: 'BAZ', icon: 'at', morale: 72, men: [
    ['Cpl', 'leader', 'carbine'], ['Pfc', 'gunner', 'bazooka'], ['Pvt', 'asst', 'carbine'], ['Pvt', 'rifle', 'm1'], ['Pfc', 'rifle', 'm1']] },
  us_mortar: { side: 'US', name: '60mm Mortar Section', short: 'MORT', icon: 'mortar', morale: 70, men: [
    ['Sgt', 'leader', 'carbine'], ['Cpl', 'gunner', 'mortar60'], ['Pfc', 'asst', 'carbine'], ['Pvt', 'ammo', 'carbine'], ['Pvt', 'ammo', 'carbine']] },
  us_scout: { side: 'US', name: 'Scout-Sniper Team', short: 'SCOUT', icon: 'recon', morale: 85, men: [
    ['Sgt', 'leader', 'thompson'], ['Pfc', 'sniper', 'm1903'], ['Cpl', 'rifle', 'm1', { satchels: 1 }], ['Pfc', 'rifle', 'm1'], ['Pvt', 'flame', 'flamer'], ['Pfc', 'bar', 'bar']] },
  us_hq: { side: 'US', name: 'Command Post', short: 'HQ', icon: 'hq', morale: 80, radio: true, men: [
    ['Col', 'leader', 'carbine'], ['Cpl', 'radio', 'carbine'], ['Maj', 'officer', 'carbine'], ['Pfc', 'runner', 'm1'], ['PhM2', 'medic', 'carbine']] },
  us_fo: { side: 'US', name: 'Naval Gunfire Team', short: 'NGF', icon: 'fo', morale: 72, radio: true, men: [
    ['Lt', 'leader', 'carbine'], ['Sgt', 'radio', 'carbine'], ['Pfc', 'rifle', 'm1'], ['Pvt', 'rifle', 'm1']] },
  us_pack: { side: 'US', name: '75mm Pack Howitzer', short: 'ARTY', icon: 'arty', morale: 70, men: [
    ['Sgt', 'leader', 'carbine'], ['Cpl', 'gunner', 'pack75'], ['Pfc', 'asst', 'carbine'], ['Pvt', 'ammo', 'carbine'], ['Pvt', 'ammo', 'carbine'], ['Pvt', 'ammo', 'carbine']] },
  // crews
  us_tankcrew: { side: 'US', name: 'Tank crew', short: 'TANK', icon: 'armor', morale: 80, men: [['Sgt', 'leader', 'thompson'], ['Cpl', 'crew', 'carbine'], ['Pfc', 'crew', 'carbine'], ['Pvt', 'crew', 'carbine'], ['Pvt', 'crew', 'carbine']] },
  us_lightcrew: { side: 'US', name: 'Tank crew', short: 'TANK', icon: 'armor', morale: 78, men: [['Sgt', 'leader', 'thompson'], ['Cpl', 'crew', 'carbine'], ['Pfc', 'crew', 'carbine'], ['Pvt', 'crew', 'carbine']] },
  us_lvtcrew: { side: 'US', name: 'Amtrac crew', short: 'LVT', icon: 'amtrac', morale: 70, men: [['Cpl', 'leader', 'carbine'], ['Pfc', 'crew', 'carbine'], ['Pvt', 'crew', 'carbine']] },
  us_boatcrew: { side: 'US', name: 'Boat crew', short: 'BOAT', icon: 'boat', morale: 65, men: [['Cox', 'leader', 'carbine'], ['S1c', 'crew', 'carbine'], ['S2c', 'crew', 'carbine']] },

  // ---------------- Japan (SNLF) ----------------
  jp_rifle: { side: 'JP', name: 'Rifle Section', short: 'RIFLE', icon: 'inf', morale: 85, men: [
    ['PO2', 'leader', 'arisaka'], ['L/Sea', 'lmg', 'type96'], ['Sea1', 'asst', 'arisaka'], ['Sea1', 'knee', 'knee'], ['Sea1', 'rifle', 'arisaka'],
    ['Sea2', 'rifle', 'arisaka'], ['Sea2', 'rifle', 'arisaka'], ['Sea2', 'rifle', 'arisaka']] },
  jp_hmg: { side: 'JP', name: 'Heavy MG Squad', short: 'HMG', icon: 'mg', morale: 85, men: [
    ['PO2', 'leader', 'arisaka'], ['L/Sea', 'gunner', 'type92'], ['Sea1', 'asst', 'arisaka'], ['Sea2', 'ammo', 'arisaka'], ['Sea2', 'ammo', 'arisaka']] },
  jp_aa: { side: 'JP', name: '13mm MG Crew', short: 'AA', icon: 'mg', morale: 82, men: [
    ['PO2', 'leader', 'arisaka'], ['L/Sea', 'gunner', 'type93'], ['Sea1', 'asst', 'arisaka'], ['Sea2', 'ammo', 'arisaka']] },
  jp_at: { side: 'JP', name: '37mm Gun Crew', short: 'AT', icon: 'at', morale: 82, men: [
    ['PO2', 'leader', 'arisaka'], ['L/Sea', 'gunner', 'type94'], ['Sea1', 'asst', 'arisaka'], ['Sea2', 'ammo', 'arisaka'], ['Sea2', 'ammo', 'arisaka']] },
  jp_mtn: { side: 'JP', name: '75mm Gun Crew', short: 'GUN', icon: 'arty', morale: 82, men: [
    ['PO1', 'leader', 'arisaka'], ['L/Sea', 'gunner', 'type41'], ['Sea1', 'asst', 'arisaka'], ['Sea2', 'ammo', 'arisaka'], ['Sea2', 'ammo', 'arisaka']] },
  jp_coastal: { side: 'JP', name: 'Coastal Gun Crew', short: 'CD', icon: 'arty', morale: 80, men: [
    ['CPO', 'leader', 'pistol'], ['PO2', 'gunner', 'coastal'], ['Sea1', 'asst', 'arisaka'], ['Sea1', 'ammo', 'arisaka'], ['Sea2', 'ammo', 'arisaka'], ['Sea2', 'ammo', 'arisaka']] },
  jp_sniper: { side: 'JP', name: 'Sniper Team', short: 'SNP', icon: 'recon', morale: 90, sniper: true, men: [
    ['L/Sea', 'sniper', 'arisaka97'], ['Sea1', 'rifle', 'arisaka']] },
  jp_knee: { side: 'JP', name: 'Grenade Discharger Sqd', short: 'GD', icon: 'mortar', morale: 82, men: [
    ['PO2', 'leader', 'arisaka'], ['Sea1', 'knee', 'knee'], ['Sea1', 'knee', 'knee'], ['Sea1', 'knee', 'knee']] },
  jp_hq: { side: 'JP', name: 'Command Section', short: 'HQ', icon: 'hq', morale: 90, men: [
    ['Lt', 'leader', 'pistol'], ['PO1', 'officer', 'arisaka'], ['Sea1', 'rifle', 'arisaka'], ['Sea1', 'rifle', 'arisaka'], ['Sea2', 'rifle', 'arisaka']] },
  jp_assault: { side: 'JP', name: 'Naval Infantry', short: 'INF', icon: 'inf', morale: 92, men: [
    ['WO', 'leader', 'pistol'], ['PO2', 'rifle', 'arisaka'], ['L/Sea', 'lmg', 'type96'], ['Sea1', 'rifle', 'arisaka'], ['Sea1', 'rifle', 'arisaka'],
    ['Sea2', 'rifle', 'arisaka'], ['Sea2', 'rifle', 'arisaka'], ['Sea2', 'rifle', 'arisaka'], ['Sea2', 'rifle', 'arisaka']] },
  jp_tankcrew: { side: 'JP', name: 'Tank crew', short: 'TANK', icon: 'armor', morale: 85, men: [['PO1', 'leader', 'pistol'], ['Sea1', 'crew', 'pistol'], ['Sea1', 'crew', 'pistol']] },
};

// Vehicles. Speeds in m/s. armor in mm (front, side, rear).
export const VEH = {
  LVT1: { name: 'LVT-1 Alligator', kind: 'amph', sprite: 10, len: 6.6, wid: 3.0, sw: 1.8, sl: 3.6, hp: 140, armor: [0, 0, 0], cap: 2, crew: 'us_lvtcrew', weps: ['m2hb', 'm1919c'], openTop: true, engine: 'engine_lvt' },
  LVT2: { name: 'LVT-2 Water Buffalo', kind: 'amph', sprite: 10, len: 7.9, wid: 3.3, sw: 2.3, sl: 4.2, hp: 180, armor: [9, 6, 6], cap: 2, crew: 'us_lvtcrew', weps: ['m2hb', 'm1919c'], openTop: true, engine: 'engine_lvt', variant: 1 },
  LCVP: { name: 'LCVP Higgins boat', kind: 'boat', sprite: 11, len: 11, wid: 3.3, sw: 4.2, sl: 0, hp: 110, armor: [6, 0, 0], cap: 2, draft: 1.05, crew: 'us_boatcrew', weps: ['m1919c'], openTop: true, engine: 'engine_boat' },
  LCM: { name: 'LCM-3 tank lighter', kind: 'boat', sprite: 12, len: 15, wid: 4.3, sw: 3.2, sl: 0, hp: 140, armor: [6, 0, 0], cap: 1, capVeh: true, draft: 1.2, crew: 'us_boatcrew', weps: [], openTop: true, engine: 'engine_boat' },
  RAFT: { name: 'Rubber boat', kind: 'boat', sprite: 46, len: 5, wid: 2, sw: 1.6, sl: 0, hp: 20, armor: [0, 0, 0], cap: 1, draft: 0.3, crew: null, weps: [], openTop: true, engine: null },
  M4A2: { name: 'M4A2 Sherman', kind: 'track', sprite: 13, len: 5.9, wid: 2.6, sw: 0, sl: 2.4, hp: 320, armor: [76, 38, 38], crew: 'us_tankcrew', weps: ['m3_75', 'm1919c', 'm1919c'], mounts: ['turret', 'coax', 'hull'], wade: 1.3, engine: 'engine_tank', turret: true },
  M3A1: { name: 'M3A1 Stuart', kind: 'track', sprite: 14, len: 4.5, wid: 2.2, sw: 0, sl: 3.0, hp: 220, armor: [44, 25, 25], crew: 'us_lightcrew', weps: ['m6_37', 'm1919c', 'm1919c'], mounts: ['turret', 'coax', 'hull'], wade: 0.9, engine: 'engine_tank', turret: true },
  HAGO: { name: 'Type 95 Ha-Go', kind: 'track', sprite: 15, len: 4.4, wid: 2.1, sw: 0, sl: 3.2, hp: 150, armor: [12, 12, 10], crew: 'jp_tankcrew', weps: ['hago37', 'type97mg'], mounts: ['turret', 'hull'], wade: 0.8, engine: 'engine_tank', turret: true },
};

// Name pools
export const US_NAMES = ('Adams Allen Anderson Baker Barnes Bell Bennett Brooks Brown Bryant Butler Campbell Carter Clark Coleman Collins Cook Cooper Cox Davis Diaz ' +
  'Edwards Evans Fisher Flores Foster Garcia Gonzalez Gray Green Griffin Hall Harris Hayes Henderson Hill Howard Hughes Jackson James Jenkins Johnson Jones Kelly ' +
  'Kennedy King Kowalski Lee Lewis Long Lopez Martin Martinez Miller Mitchell Moore Morgan Morris Murphy Nelson Olsen Parker Perez Perry Peterson Phillips Powell ' +
  'Price Reed Richardson Rivera Roberts Robinson Rogers Ross Russell Sanders Scott Simmons Smith Stewart Sullivan Taylor Thomas Thompson Torres Turner Walker ' +
  'Ward Washington Watson White Williams Wilson Wood Wright Young Novak Schmidt Romano DeLuca Kaminski Olson Hoffman Brennan Flanagan Becker Larsen Sorensen').split(' ');
export const JP_NAMES = ('Abe Aoki Endo Fujii Fujita Fukuda Goto Hara Hasegawa Hashimoto Hayashi Ikeda Inoue Ishii Ishikawa Ito Kato Kikuchi Kimura Kobayashi Kondo ' +
  'Matsumoto Miura Miyazaki Mori Murakami Nakajima Nakamura Nakano Nishimura Ogawa Okada Ono Saito Sakamoto Sasaki Sato Shimizu Suzuki Takahashi Takeda Tanaka ' +
  'Watanabe Yamada Yamaguchi Yamamoto Yoshida Yamashita Okamoto Hirano Kudo Sugiyama Noguchi Matsuda Kojima Arai Takagi Ueda Ota').split(' ');

export const SHERMAN_NAMES = ['China Gal', 'Cobra', 'Commando', 'Colorado', 'Condor', 'Charlie', 'Cecilia', 'Chicago', 'Cannonball', 'Cold Steel'];
