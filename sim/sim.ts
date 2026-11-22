// Approximate local simulator for mechfight/1. Not the real server: a test bench for relative strength.
import { GameMap } from "../map.ts"
import { readFileSync } from "node:fs"

type V3 = [number, number, number]
const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
const hyp = Math.hypot
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

export class SRng {
  s: number
  constructor(seed: number) { this.s = (seed >>> 0) || 7 }
  next() { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x; return x / 4294967296 }
  gauss() { const u = Math.max(1e-9, this.next()), v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v) }
}

export interface Controller { act(obs: any): any; name?: string }
export type Factory = (hello: any, map: GameMap) => Controller

interface Weapon { kind: string; cooldown: number; ammo?: number; reload?: number; charge?: number; stats: any; equip: number }
interface Mech {
  id: number; pos: V3; vel: V3; aim: [number, number]; cmdAim: [number, number]
  hp: number; energy: number; grounded: boolean; cubes: number; upgrades: string[]
  weapons: (Weapon | null)[]; stats: any; wstats: Record<string, any>
  alive: boolean; ctrl: Controller; action: any; events: any[]; sounds: any[]; beams: any[]
  lastDmgT: number; lastSpendT: number; memory: Map<number, number>; offers: any[]; offerSeq: number
  stepAcc: number; deathT: number; place: number; kills: number; shortUntil: number; missed: number
  upCount: Record<string, number>; thresholdsHit: number
}
interface Proj { id: number; kind: string; owner: number; pos: V3; vel: V3; dist: number; range: number; dmg: number; ttl: number; stats?: any }
interface Npc { id: number; pos: V3; vel: V3; home: [number, number]; hp: number; target: number | null; cd: number; wander: [number, number]; wt: number; aim: number; alive: boolean }

export class Sim {
  house = false
  houseEvery = 60
  static maxMs = 0
  static slow = 0
  static calls = 0
  map: GameMap
  cfg: any
  rng: SRng
  t = 0
  tick = 0
  mechs: Mech[] = []
  npcs: Npc[] = []
  crates: { id: number; pos: V3; hp: number }[] = []
  cubes: { id: number; pos: V3 }[] = []
  pickups: { id: number; kind: string; pos: V3; ammo?: number }[] = []
  projs: Proj[] = []
  drops: any[] = []
  zone: any
  zonePhase = 0
  nextId = { proj: 1, cube: 5000, pick: 8000, drop: 20000 }
  deathOrder: { id: number; t: number }[] = []
  log: string[] = []

  constructor(map: GameMap, cfg: any, seed: number, factories: Factory[]) {
    this.map = map
    this.cfg = cfg
    this.rng = new SRng(seed)
    const z0 = cfg.zone
    const ph = z0.phases[0]
    this.zone = { center: [...z0.start_center], radius: z0.start_radius, next_center: [0, 0], next_radius: ph.radius, shrink_start: ph.hold_s, shrink_end: ph.hold_s + ph.shrink_s, dps: ph.dps }
    this.zone.next_center = this.pickInside(this.zone.center, this.zone.radius, ph.radius)
    // spawns
    const spawns: [number, number][] = []
    for (let i = 0; i < 16; i++) {
      for (let tries = 0; tries < 2000; tries++) {
        const p = this.randOpen(z0.start_center, z0.start_radius * cfg.match.spawn_zone_fraction)
        const sep = tries < 1500 ? cfg.match.spawn_min_separation : 60
        if (spawns.every((s) => hyp(s[0] - p[0], s[1] - p[1]) > sep)) { spawns.push(p); break }
      }
    }
    for (let i = 0; i < 16; i++) {
      const p = spawns[i]
      const m: Mech = {
        id: i, pos: [p[0], p[1], map.surfAt(p[0], p[1])], vel: [0, 0, 0], aim: [this.rng.next() * TAU - Math.PI, 0], cmdAim: [0, 0],
        hp: cfg.mech.hp, energy: cfg.mech.energy, grounded: true, cubes: 0, upgrades: [], weapons: [], stats: { ...cfg.mech },
        wstats: JSON.parse(JSON.stringify(cfg.weapons)), alive: true, ctrl: null as any, action: {}, events: [], sounds: [], beams: [],
        lastDmgT: -99, lastSpendT: -99, memory: new Map(), offers: [], offerSeq: 0, stepAcc: 0, deathT: 0, place: 0, kills: 0, shortUntil: 0, missed: 0,
        upCount: {}, thresholdsHit: 0,
      }
      m.cmdAim = [...m.aim] as [number, number]
      m.weapons = [this.mkWeapon(m, "gun"), null]
      m.weapons[0]!.equip = 0
      this.mechs.push(m)
    }
    // npcs
    for (let i = 0; i < cfg.npc.count; i++) {
      const p = this.randOpen(z0.start_center, z0.start_radius * 0.9)
      this.npcs.push({ id: 100 + i, pos: [p[0], p[1], map.surfAt(p[0], p[1])], vel: [0, 0, 0], home: p, hp: cfg.npc.hp, target: null, cd: 0, wander: p, wt: 0, aim: 0, alive: true })
    }
    for (let i = 0; i < cfg.crates.count; i++) {
      const p = this.randOpen(z0.start_center, z0.start_radius * 0.95)
      this.crates.push({ id: 1000 + i, pos: [p[0], p[1], map.surfAt(p[0], p[1])], hp: cfg.crates.hp })
    }
    const kinds = ["mortar", "laser", "lightning"]
    for (let i = 0; i < cfg.loot.floor_count; i++) {
      const p = this.randOpen(z0.start_center, z0.start_radius * 0.95)
      this.pickups.push({ id: this.nextId.pick++, kind: kinds[Math.floor(this.rng.next() * 3)], pos: [p[0], p[1], map.surfAt(p[0], p[1])] })
    }
    // controllers
    for (let i = 0; i < 16; i++) {
      const hello = { type: "hello", protocol: "mechfight/1", slot: i, seed: Math.floor(this.rng.next() * 2 ** 31), map: { dir: "", files: [] }, config: cfg }
      this.mechs[i].ctrl = factories[i](hello, map)
    }
  }

  mkWeapon(m: Mech, kind: string): Weapon {
    const st = m.wstats[kind]
    const w: Weapon = { kind, cooldown: 0, stats: st, equip: 0 }
    if (kind === "gun") { w.ammo = st.mag; w.reload = 0 }
    if (kind === "laser") w.charge = 0
    return w
  }

  randOpen(c: number[], r: number): [number, number] {
    for (let k = 0; k < 5000; k++) {
      const a = this.rng.next() * TAU, rr = Math.sqrt(this.rng.next()) * r
      const x = c[0] + Math.cos(a) * rr, y = c[1] + Math.sin(a) * rr
      if (x < this.map.minX + 30 || y < this.map.minY + 30 || x > this.map.minX + this.map.nx - 30 || y > this.map.minY + this.map.ny - 30) continue
      if (this.map.blocked[this.map.gIdx(x, y)]) continue
      return [x, y]
    }
    return [c[0], c[1]]
  }
  pickInside(c: number[], r: number, r2: number): [number, number] {
    for (let k = 0; k < 500; k++) {
      const a = this.rng.next() * TAU, rr = Math.sqrt(this.rng.next()) * (r - r2)
      const x = c[0] + Math.cos(a) * rr, y = c[1] + Math.sin(a) * rr
      if (x < this.map.minX + 20 || y < this.map.minY + 20 || x > this.map.minX + this.map.nx - 20 || y > this.map.minY + this.map.ny - 20) continue
      return [x, y]
    }
    return [c[0], c[1]]
  }

  zoneNow() {
    const z = this.zone
    if (this.t <= z.shrink_start) return { c: z.center, r: z.radius }
    const f = clamp((this.t - z.shrink_start) / (z.shrink_end - z.shrink_start), 0, 1)
    return { c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f], r: z.radius + (z.next_radius - z.radius) * f }
  }
  updateZone() {
    const z = this.zone
    if (this.t >= z.shrink_end && this.zonePhase < this.cfg.zone.phases.length) {
      this.zonePhase++
      z.center = [...z.next_center]; z.radius = z.next_radius
      const ph = this.cfg.zone.phases[this.zonePhase]
      if (ph) {
        z.next_radius = ph.radius
        z.next_center = this.pickInside(z.center, z.radius, ph.radius)
        z.shrink_start = this.t + ph.hold_s
        z.shrink_end = z.shrink_start + ph.shrink_s
        z.dps = ph.dps
      } else { z.shrink_start = z.shrink_end = 1e9 }
    }
  }

  // floor height under a point for a mech whose feet are at z
  floorAt(x: number, y: number, z: number, h: number) {
    const m = this.map
    const k = m.idx(x, y)
    const g = m.surf[k]
    const pt = m.pTop[k]
    if (pt === -Infinity) return g
    if (pt <= z + 1.2) return Math.max(g, pt)
    if (m.pBase[k] >= z + h) return g
    if (m.wall[k] === 0) return g // decks etc. that we classified walkable
    return Infinity
  }
  canStand(x: number, y: number, z: number, r: number, h: number) {
    for (let k = 0; k < 9; k++) {
      const px = k === 8 ? x : x + Math.cos((k * TAU) / 8) * r
      const py = k === 8 ? y : y + Math.sin((k * TAU) / 8) * r
      const f = this.floorAt(px, py, z, h)
      if (f === Infinity) return false
      if (k === 8 ? f > z + 1.2 : f > z + 1.2 + r * 1.1) return false
    }
    if (x < this.map.minX + 2 || y < this.map.minY + 2 || x > this.map.minX + this.map.nx - 3 || y > this.map.minY + this.map.ny - 3) return false
    return true
  }

  scale(m: Mech) { return 1 + this.cfg.cubes.size_per_cube * m.cubes }

  canSee(a: Mech, tp: V3, th: number) {
    const sc = this.scale(a)
    const dx = tp[0] - a.pos[0], dy = tp[1] - a.pos[1]
    const d = hyp(dx, dy)
    const near = this.cfg.vision.near_range + a.stats.near_range_bonus
    const range = this.cfg.vision.range + a.stats.vision_bonus
    if (d > range) return false
    if (d > near) {
      if (Math.abs(wrap(Math.atan2(dy, dx) - a.aim[0])) > (this.cfg.vision.fov_deg * Math.PI) / 360) return false
    }
    const ez = a.pos[2] + a.stats.eye_height * sc
    return this.map.los(a.pos[0], a.pos[1], ez, tp[0], tp[1], tp[2] + th * 0.5) || this.map.los(a.pos[0], a.pos[1], ez, tp[0], tp[1], tp[2] + th)
  }

  emitSound(kind: string, at: V3, except: number) {
    const range = this.cfg.sound.range[kind] ?? 100
    for (const m of this.mechs) {
      if (!m.alive || m.id === except) continue
      const d = hyp(at[0] - m.pos[0], at[1] - m.pos[1])
      if (d > range) continue
      const b = Math.atan2(at[1] - m.pos[1], at[0] - m.pos[0]) + this.rng.gauss() * (this.cfg.sound.bearing_noise_deg * Math.PI / 180) * m.stats.hearing
      m.sounds.push({ kind, bearing: wrap(b), dist: d < this.cfg.sound.near ? "near" : d < this.cfg.sound.mid ? "mid" : "far", age: 0 })
    }
  }

  buildObs(m: Mech): any {
    const sc = this.scale(m)
    const vis: any[] = []
    for (const o of this.mechs) {
      if (o === m || !o.alive) continue
      const hc = m.ctrl as any
      if (this.house && hc.house) {
        // house bots never see each other; inactive ones ignore the player; active ones always know where the player is
        if ((o.ctrl as any).house || !hc.active) continue
        m.memory.set(o.id, this.t)
      }
      const oh = o.stats.height * this.scale(o)
      if ((m.ctrl as any).omni || this.canSee(m, o.pos, oh)) m.memory.set(o.id, this.t)
      const last = m.memory.get(o.id)
      if (last != null && this.t - last <= this.cfg.vision.memory_s) {
        vis.push({ id: o.id, kind: "mech", pos: o.pos.map((v) => +v.toFixed(2)), vel: o.vel.map((v) => +v.toFixed(2)), aim: [...o.aim], hp: Math.round(o.hp * 100) / 100, max_hp: this.maxHp(o), cubes: o.cubes, weapons: o.weapons.filter(Boolean).map((w) => w!.kind), charging: o.weapons.some((w) => w?.kind === "laser" && (w.charge ?? 0) > 0) })
      }
    }
    for (const n of this.npcs) {
      if (!n.alive) continue
      if (this.canSee(m, n.pos, 3.5)) m.memory.set(n.id, this.t)
      const last = m.memory.get(n.id)
      if (last != null && this.t - last <= this.cfg.vision.memory_s) vis.push({ id: n.id, kind: "npc", pos: [...n.pos], vel: [...n.vel], aim: [n.aim, 0], hp: n.hp, max_hp: this.cfg.npc.hp })
    }
    const seeItem = (p: V3, h: number) => this.canSee(m, p, h)
    const obs = {
      type: "obs", tick: this.tick, t: +this.t.toFixed(2), alive: this.mechs.filter((x) => x.alive).length,
      self: {
        id: m.id, pos: [...m.pos], vel: [...m.vel], aim: [...m.aim], hp: m.hp, max_hp: this.maxHp(m), energy: m.energy, max_energy: m.stats.energy,
        grounded: m.grounded, cubes: m.cubes, upgrades: [...m.upgrades], in_zone: this.inZone(m),
        weapons: m.weapons.map((w) => w ? { kind: w.kind, cooldown: Math.max(w.cooldown, w.equip), stats: w.stats, ...(w.kind === "gun" ? { ammo: w.ammo, reload: w.reload } : {}), ...(w.kind === "laser" ? { charge: w.charge } : {}) } : null),
        stats: { ...m.stats, radius: m.stats.radius * sc, height: m.stats.height * sc, eye_height: m.stats.eye_height * sc, muzzle_height: m.stats.muzzle_height * sc },
      },
      mechs: vis,
      projectiles: this.projs.filter((p) => p.owner !== m.id && seeItem(p.pos, 0)).map((p) => ({ id: p.id, kind: p.kind, pos: [...p.pos], vel: [...p.vel] })),
      crates: this.crates.filter((c) => c.hp > 0 && hyp(c.pos[0] - m.pos[0], c.pos[1] - m.pos[1]) < 200 && seeItem(c.pos, 2.4)).map((c) => ({ id: c.id, pos: [...c.pos], hp: c.hp })),
      cubes: this.cubes.filter((c) => hyp(c.pos[0] - m.pos[0], c.pos[1] - m.pos[1]) < 200 && seeItem(c.pos, 0.5)).map((c) => ({ id: c.id, pos: [...c.pos] })),
      pickups: this.pickups.filter((c) => hyp(c.pos[0] - m.pos[0], c.pos[1] - m.pos[1]) < 200 && seeItem(c.pos, 0.5)).map((c) => ({ id: c.id, kind: c.kind, pos: [...c.pos] })),
      sounds: m.sounds, beams: m.beams, events: m.events,
      drops: this.drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: d.pos, radius: this.cfg.drops.radius, lands_in: Math.max(0, d.landT - this.t), capture_s: this.cfg.drops.capture_s, progress: d.progress, holder: d.holder })),
      zone: { ...this.zone, center: [...this.zone.center], next_center: [...this.zone.next_center] },
      offer: m.offers[0] ?? null,
    }
    m.sounds = []; m.beams = []; m.events = []
    return obs
  }

  maxHp(m: Mech) { return m.stats.hp * (1 + this.cfg.cubes.hp_per_cube * Math.min(m.cubes, this.cfg.cubes.stat_cap)) }
  inZone(m: Mech) { const z = this.zoneNow(); return hyp(m.pos[0] - z.c[0], m.pos[1] - z.c[1]) <= z.r }

  damage(target: Mech, amount: number, weapon: string, by: Mech | null, from: V3 | null, byId: number | null = null) {
    if (!target.alive) return 0
    if (this.house && by && by !== target && (by.ctrl as any).house && (target.ctrl as any).house) return 0
    let a = amount
    let rear = false
    if (by && from) {
      const bearing = Math.atan2(from[1] - target.pos[1], from[0] - target.pos[0])
      if (Math.abs(wrap(bearing - target.aim[0])) > (this.cfg.mech.front_arc_deg * Math.PI) / 360) { a *= this.cfg.mech.rear_mult; rear = true }
    }
    if (weapon !== "zone") a *= 1 - Math.min(0.9, target.stats.armor)
    if (by && by.id === target.id) a *= this.cfg.mech.self_damage_mult
    target.hp -= a
    ;(target as any).taken = ((target as any).taken ?? {}); (target as any).taken[weapon] = ((target as any).taken[weapon] ?? 0) + a
    if (by) { (by as any).dealt = ((by as any).dealt ?? {}); (by as any).dealt[weapon] = ((by as any).dealt[weapon] ?? 0) + a }
    ;(target as any).lastW = weapon
    target.lastDmgT = this.t
    const bearing = from ? Math.atan2(from[1] - target.pos[1], from[0] - target.pos[0]) : null
    target.events.push({ type: "damaged", amount: a, weapon, bearing, by: by ? by.id : byId, ...(rear ? { rear: true } : {}) })
    if (by && by.id !== target.id) { by.lastDmgT = this.t; by.events.push({ type: "hit", target: target.id, amount: a, weapon, ...(rear ? { rear: true } : {}) }) }
    if (target.hp <= 0) this.kill(target, by)
    return a
  }
  kill(m: Mech, by: Mech | null) {
    m.alive = false
    m.hp = 0
    m.deathT = this.t
    this.deathOrder.push({ id: m.id, t: this.tick })
    if (by && by.id !== m.id) { by.kills++; by.events.push({ type: "kill", target: m.id }) }
    this.emitSound("death", m.pos, m.id)
    const n = m.cubes + this.cfg.cubes.death_drop_extra
    for (let i = 0; i < n; i++) this.cubes.push({ id: this.nextId.cube++, pos: [m.pos[0] + this.rng.gauss() * 2, m.pos[1] + this.rng.gauss() * 2, m.pos[2]] })
    for (const w of m.weapons) if (w && w.kind !== "gun") this.pickups.push({ id: this.nextId.pick++, kind: w.kind, pos: [...m.pos] })
  }
  damageNpc(n: Npc, amount: number, by: Mech) {
    n.hp -= amount
    n.target = by.id
    by.events.push({ type: "hit", target: n.id, amount, weapon: "x" })
    if (n.hp <= 0) {
      n.alive = false
      for (let i = 0; i < this.cfg.npc.cubes; i++) this.cubes.push({ id: this.nextId.cube++, pos: [n.pos[0] + this.rng.gauss(), n.pos[1] + this.rng.gauss(), n.pos[2]] })
    }
  }
  damageCrate(c: any, amount: number, by: Mech) {
    c.hp -= amount
    by.events.push({ type: "hit", target: c.id, amount, weapon: "x" })
    if (c.hp <= 0) {
      this.emitSound("crate", c.pos, -1)
      this.cubes.push({ id: this.nextId.cube++, pos: [...c.pos] })
      if (this.rng.next() < this.cfg.loot.crate_weapon_chance) this.pickups.push({ id: this.nextId.pick++, kind: ["mortar", "laser", "lightning"][Math.floor(this.rng.next() * 3)], pos: [c.pos[0] + 1, c.pos[1], c.pos[2]] })
    }
  }
  dmgMul(m: Mech) { return 1 + this.cfg.cubes.damage_per_cube * Math.min(m.cubes, this.cfg.cubes.stat_cap) }

  // ray vs actors: returns first actor hit along segment a->b (excluding owner)
  rayHit(a: V3, b: V3, owner: number, rad: number): { kind: string; obj: any; f: number } | null {
    let best: any = null, bf = 2
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const L2 = dx * dx + dy * dy
    const test = (cx: number, cy: number, z0: number, h: number, r: number, kind: string, obj: any) => {
      // closest approach in xy
      let f = L2 > 0 ? ((cx - a[0]) * dx + (cy - a[1]) * dy) / L2 : 0
      f = clamp(f, 0, 1)
      const px = a[0] + dx * f, py = a[1] + dy * f, pz = a[2] + dz * f
      if (hyp(px - cx, py - cy) <= r + rad && pz >= z0 - rad && pz <= z0 + h + rad && f < bf) { bf = f; best = { kind, obj, f } }
    }
    for (const m of this.mechs) if (m.alive && m.id !== owner) { const s = this.scale(m); test(m.pos[0], m.pos[1], m.pos[2], m.stats.height * s, m.stats.radius * s, "mech", m) }
    for (const n of this.npcs) if (n.alive && n.id !== owner) test(n.pos[0], n.pos[1], n.pos[2], 3.5, 1.8, "npc", n)
    for (const c of this.crates) if (c.hp > 0) test(c.pos[0], c.pos[1], c.pos[2], 2.4, 1.4, "crate", c)
    return best
  }
  wallAlong(a: V3, b: V3): number {
    const L = hyp(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const n = Math.max(1, Math.ceil(L / 1.0))
    for (let s = 1; s <= n; s++) {
      const f = s / n
      if (this.map.solid(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)) return (s - 1) / n
    }
    return 2
  }
  applyHit(h: { kind: string; obj: any }, dmg: number, weapon: string, by: Mech, from: V3) {
    if (h.kind === "mech") this.damage(h.obj, dmg, weapon, by, from)
    else if (h.kind === "npc") this.damageNpc(h.obj, dmg, by)
    else this.damageCrate(h.obj, dmg, by)
  }

  fireWeapons(m: Mech, dt: number) {
    const fire: boolean[] = m.action.fire ?? [false, false]
    const sc = this.scale(m)
    const dir: V3 = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
    for (let s = 0; s < 2; s++) {
      const w = m.weapons[s]
      if (!w) continue
      w.cooldown = Math.max(0, w.cooldown - dt)
      w.equip = Math.max(0, w.equip - dt)
      if (w.kind === "gun") {
        if (w.reload! > 0) { w.reload! -= dt; if (w.reload! <= 0) { w.reload = 0; w.ammo = w.stats.mag } }
        if (s === 0 && m.action.reload && w.reload === 0 && w.ammo! < w.stats.mag) { w.reload = w.stats.reload; this.emitSound("reload", m.pos, m.id) }
      }
      const held = !!fire[s]
      if (w.kind === "laser") {
        if (held && w.cooldown <= 0 && w.equip <= 0 && this.t >= m.shortUntil) {
          const prev = w.charge!
          w.charge = w.charge! + dt
          if (prev === 0) this.emitSound("laser_charge", m.pos, m.id)
          if (w.charge! >= w.stats.charge + this.cfg.weapons.laser.hold_s) this.fireLaser(m, w, dir, sc)
        } else if (!held && w.charge! > 0) {
          if (w.charge! >= w.stats.min_charge) this.fireLaser(m, w, dir, sc)
          else w.charge = w.charge! + dt
        }
        continue
      }
      if (!held || w.cooldown > 0 || w.equip > 0) continue
      const muzzle: V3 = [m.pos[0] + dir[0] * 3, m.pos[1] + dir[1] * 3, m.pos[2] + m.stats.muzzle_height * sc + dir[2] * 3]
      if (w.kind === "gun") {
        if (w.reload! > 0) continue
        if (w.ammo! <= 0) { w.reload = w.stats.reload; continue }
        const sp = (w.stats.spread_deg * Math.PI) / 180
        const yaw = m.aim[0] + this.rng.gauss() * sp, pitch = m.aim[1] + this.rng.gauss() * sp
        const v: V3 = [Math.cos(pitch) * Math.cos(yaw) * w.stats.speed, Math.cos(pitch) * Math.sin(yaw) * w.stats.speed, Math.sin(pitch) * w.stats.speed]
        this.projs.push({ id: this.nextId.proj++, kind: "gun", owner: m.id, pos: muzzle, vel: v, dist: 0, range: w.stats.range, dmg: w.stats.damage * this.dmgMul(m), ttl: 5 })
        w.ammo!--
        w.cooldown = w.stats.cooldown
        if (w.ammo === 0) w.reload = w.stats.reload
        this.emitSound("gun", m.pos, m.id)
      } else if (w.kind === "mortar") {
        const v: V3 = [dir[0] * w.stats.speed, dir[1] * w.stats.speed, dir[2] * w.stats.speed]
        const tube: V3 = [m.pos[0] + dir[0] * 3, m.pos[1] + dir[1] * 3, m.pos[2] + (m.stats.height + 0.5) * sc + dir[2] * 3]
        this.projs.push({ id: this.nextId.proj++, kind: "mortar", owner: m.id, pos: tube, vel: v, dist: 0, range: 1e9, dmg: w.stats.damage * this.dmgMul(m), ttl: w.stats.ttl, stats: w.stats })
        w.cooldown = w.stats.cooldown
        this.emitSound("mortar", m.pos, m.id)
      } else if (w.kind === "lightning") {
        if (m.energy < w.stats.energy) continue
        m.energy -= w.stats.energy
        m.lastSpendT = this.t
        w.cooldown = w.stats.cooldown
        this.emitSound("lightning", m.pos, m.id)
        // nearest target in cone
        const cands: { kind: string; obj: any; pos: V3; d: number }[] = []
        const mz = m.pos[2] + m.stats.muzzle_height * sc
        const consider = (kind: string, obj: any, p: V3, hc: number) => {
          const d = hyp(p[0] - m.pos[0], p[1] - m.pos[1])
          if (d > w.stats.range) return
          if (Math.abs(wrap(Math.atan2(p[1] - m.pos[1], p[0] - m.pos[0]) - m.aim[0])) > (w.stats.cone_deg * Math.PI) / 360) return
          if (!this.map.los(m.pos[0], m.pos[1], mz, p[0], p[1], p[2] + hc)) return
          cands.push({ kind, obj, pos: p, d })
        }
        for (const o of this.mechs) if (o.alive && o !== m) consider("mech", o, o.pos, 4.5)
        for (const n of this.npcs) if (n.alive) consider("npc", n, n.pos, 1.7)
        for (const c of this.crates) if (c.hp > 0) consider("crate", c, c.pos, 1.2)
        cands.sort((a, b) => a.d - b.d)
        if (!cands.length) continue
        let cur = cands[0]
        let dmg = w.stats.damage * this.dmgMul(m)
        const hitSet = new Set<any>()
        let from: V3 = [...m.pos] as V3
        for (let j = 0; j <= w.stats.chain && cur; j++) {
          hitSet.add(cur.obj)
          this.applyHit(cur, dmg, "lightning", m, from)
          if (cur.kind === "mech") {
            const lw = (cur.obj as Mech).weapons.find((x) => x?.kind === "laser")
            if (lw) { lw.charge = 0; (cur.obj as Mech).shortUntil = this.t + w.stats.short_s }
          }
          from = cur.pos
          dmg *= w.stats.chain_falloff
          let nxt: any = null, nd = Infinity
          for (const o of this.mechs) if (o.alive && o !== m && !hitSet.has(o)) { const d = hyp(o.pos[0] - cur.pos[0], o.pos[1] - cur.pos[1]); if (d < w.stats.chain_range && d < nd) { nd = d; nxt = { kind: "mech", obj: o, pos: o.pos, d } } }
          for (const n of this.npcs) if (n.alive && !hitSet.has(n)) { const d = hyp(n.pos[0] - cur.pos[0], n.pos[1] - cur.pos[1]); if (d < w.stats.chain_range && d < nd) { nd = d; nxt = { kind: "npc", obj: n, pos: n.pos, d } } }
          cur = nxt
        }
      }
    }
  }
  fireLaser(m: Mech, w: Weapon, dir: V3, sc: number) {
    const frac = clamp(w.charge! / w.stats.charge, 0, 1)
    const dmg = w.stats.damage * (w.stats.min_frac + (1 - w.stats.min_frac) * frac) * this.dmgMul(m)
    w.charge = 0
    w.cooldown = w.stats.cooldown
    const a: V3 = [m.pos[0] + dir[0] * 3, m.pos[1] + dir[1] * 3, m.pos[2] + m.stats.muzzle_height * sc + dir[2] * 3]
    const b: V3 = [a[0] + dir[0] * w.stats.range, a[1] + dir[1] * w.stats.range, a[2] + dir[2] * w.stats.range]
    const wf = this.wallAlong(a, b)
    const h = this.rayHit(a, b, m.id, 0.05)
    this.emitSound("laser", m.pos, m.id)
    if (h && h.f < wf) {
      let d = dmg
      if (h.kind === "mech" && (h.obj as Mech).weapons.some((x) => x?.kind === "mortar")) d *= 1 + w.stats.cookoff
      this.applyHit(h, d, "laser", m, a)
    }
  }

  stepProjectiles(dt: number) {
    const keep: Proj[] = []
    for (const p of this.projs) {
      const a: V3 = [...p.pos] as V3
      if (p.kind === "mortar") p.vel[2] -= p.stats.gravity * dt
      const b: V3 = [a[0] + p.vel[0] * dt, a[1] + p.vel[1] * dt, a[2] + p.vel[2] * dt]
      const owner = this.mechs[p.owner]
      const wf = this.wallAlong(a, b)
      const h = this.rayHit(a, b, p.kind === "npc" ? p.owner : p.owner, 0.3)
      let done = false
      if (h && h.f <= wf) {
        if (p.kind === "gun") this.applyHit(h, p.dmg, "gun", owner, a)
        else if (p.kind === "npc") { if (h.kind === "mech") this.damage(h.obj, p.dmg, "npc", null, a, p.owner) }
        else { const f = h.f; this.explode(p, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], h.obj) }
        done = true
      } else if (wf <= 1) {
        if (p.kind === "mortar") this.explode(p, [a[0] + (b[0] - a[0]) * wf, a[1] + (b[1] - a[1]) * wf, a[2] + (b[2] - a[2]) * wf], null)
        done = true
      }
      p.pos = b
      p.dist += hyp(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      p.ttl -= dt
      if (!done && p.dist < p.range && p.ttl > 0) keep.push(p)
    }
    this.projs = keep
  }
  explode(p: Proj, at: V3, direct: any) {
    const owner = this.mechs[p.owner]
    const st = p.stats
    this.emitSound("explosion", at, -1)
    if (direct) this.applyHit({ kind: direct.id < 16 ? "mech" : direct.id < 1000 ? "npc" : "crate", obj: direct }, p.dmg, "mortar", owner, at)
    for (const m of this.mechs) {
      if (!m.alive || m === direct) continue
      const c: V3 = [m.pos[0], m.pos[1], m.pos[2] + 4.5]
      const d = Math.max(0, hyp(c[0] - at[0], c[1] - at[1], c[2] - at[2]) - m.stats.radius)
      if (d > st.splash_radius) continue
      if (!this.map.los(at[0], at[1], at[2] + 0.5, c[0], c[1], c[2])) continue
      const f = 1 - (1 - st.splash_edge) * (d / st.splash_radius)
      this.damage(m, st.splash * f * this.dmgMul(owner), "mortar", owner, at)
      const ux = m.pos[0] - at[0], uy = m.pos[1] - at[1]
      const L = hyp(ux, uy) || 1
      m.vel[0] += (ux / L) * st.knock * f; m.vel[1] += (uy / L) * st.knock * f; m.vel[2] += st.knock_up * f
      m.grounded = false
      m.energy = Math.max(0, m.energy - st.drain * f)
    }
  }

  stepNpcs(dt: number) {
    const c = this.cfg.npc
    for (const n of this.npcs) {
      if (!n.alive) continue
      n.cd = Math.max(0, n.cd - dt)
      let tgt: Mech | null = n.target != null ? this.mechs[n.target] : null
      if (tgt && (!tgt.alive || hyp(tgt.pos[0] - n.pos[0], tgt.pos[1] - n.pos[1]) > c.deaggro_range || hyp(n.pos[0] - n.home[0], n.pos[1] - n.home[1]) > c.chase_leash)) { n.target = null; tgt = null }
      if (!tgt && hyp(n.pos[0] - n.home[0], n.pos[1] - n.home[1]) < c.leash) {
        for (const m of this.mechs) {
          if (!m.alive) continue
          if (hyp(m.pos[0] - n.pos[0], m.pos[1] - n.pos[1]) < c.aggro_range && this.map.los(n.pos[0], n.pos[1], n.pos[2] + 3, m.pos[0], m.pos[1], m.pos[2] + 4.5)) { tgt = m; break }
        }
      }
      let goal: [number, number]
      if (tgt) {
        goal = [tgt.pos[0], tgt.pos[1]]
        n.aim = Math.atan2(tgt.pos[1] - n.pos[1], tgt.pos[0] - n.pos[0])
        if (n.cd <= 0 && this.map.los(n.pos[0], n.pos[1], n.pos[2] + 3, tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5)) {
          const d = hyp(tgt.pos[0] - n.pos[0], tgt.pos[1] - n.pos[1], tgt.pos[2] + 4.5 - n.pos[2] - 3)
          const ft = d / c.projectile_speed
          const tx = tgt.pos[0] + tgt.vel[0] * ft, ty = tgt.pos[1] + tgt.vel[1] * ft, tz = tgt.pos[2] + 4.5
          const sp = (c.spread_deg * Math.PI) / 180
          const yaw = Math.atan2(ty - n.pos[1], tx - n.pos[0]) + this.rng.gauss() * sp
          const pitch = Math.atan2(tz - n.pos[2] - 3, hyp(tx - n.pos[0], ty - n.pos[1])) + this.rng.gauss() * sp
          this.projs.push({ id: this.nextId.proj++, kind: "npc", owner: n.id, pos: [n.pos[0] + Math.cos(yaw) * 2.2, n.pos[1] + Math.sin(yaw) * 2.2, n.pos[2] + 3], vel: [Math.cos(pitch) * Math.cos(yaw) * c.projectile_speed, Math.cos(pitch) * Math.sin(yaw) * c.projectile_speed, Math.sin(pitch) * c.projectile_speed], dist: 0, range: 300, dmg: c.damage, ttl: 4 })
          n.cd = c.cooldown
          this.emitSound("npc_gun", n.pos, -1)
        }
        if (hyp(goal[0] - n.pos[0], goal[1] - n.pos[1]) < 20) goal = [n.pos[0], n.pos[1]]
      } else {
        n.wt -= dt
        if (n.wt <= 0) { n.wt = 3 + this.rng.next() * 4; const a = this.rng.next() * TAU, r = this.rng.next() * c.leash; n.wander = [n.home[0] + Math.cos(a) * r, n.home[1] + Math.sin(a) * r] }
        goal = n.wander
      }
      const dx = goal[0] - n.pos[0], dy = goal[1] - n.pos[1]
      const L = hyp(dx, dy)
      if (L > 1) {
        const nx = n.pos[0] + (dx / L) * c.speed * dt, ny = n.pos[1] + (dy / L) * c.speed * dt
        if (this.map.wallDistAt(nx, ny) > 2) { n.pos = [nx, ny, this.map.surfAt(nx, ny)]; n.vel = [(dx / L) * c.speed, (dy / L) * c.speed, 0] }
        else n.vel = [0, 0, 0]
      } else n.vel = [0, 0, 0]
    }
  }

  stepMech(m: Mech, dt: number) {
    const a = m.action
    const st = m.stats
    const sc = this.scale(m)
    // aim slew
    if (a.aim) m.cmdAim = [a.aim[0], clamp(a.aim[1], st.min_pitch, st.max_pitch)]
    const dy = wrap(m.cmdAim[0] - m.aim[0])
    const maxY = st.turn_rate * dt
    m.aim[0] = wrap(m.aim[0] + clamp(dy, -maxY, maxY))
    const dp = m.cmdAim[1] - m.aim[1]
    m.aim[1] += clamp(dp, -st.pitch_rate * dt, st.pitch_rate * dt)
    // move
    let mv = a.move ?? [0, 0]
    let L = hyp(mv[0], mv[1])
    if (L > 1) { mv = [mv[0] / L, mv[1] / L]; L = 1 }
    const charging = m.weapons.some((w) => w?.kind === "laser" && (w.charge ?? 0) > 0)
    let speed = st.walk_speed
    let spent = false
    if (a.boost && m.grounded && L > 0.1 && m.energy > 0) { speed = st.boost_speed; m.energy -= st.boost_drain * dt; spent = true }
    if (charging) speed *= st.charge_move_mult
    const want = [mv[0] * speed, mv[1] * speed]
    const acc = (m.grounded ? st.ground_accel : st.air_accel) * dt
    const dvx = want[0] - m.vel[0], dvy = want[1] - m.vel[1]
    const dv = hyp(dvx, dvy)
    if (m.grounded || L > 0.05) {
      if (dv <= acc) { m.vel[0] = want[0]; m.vel[1] = want[1] } else { m.vel[0] += (dvx / dv) * acc; m.vel[1] += (dvy / dv) * acc }
    }
    // vertical
    if (a.jump && m.grounded) { m.vel[2] = st.jump_speed; m.grounded = false }
    if (!m.grounded) {
      m.vel[2] -= st.gravity * dt
      if (a.boost && m.energy > 0) { m.vel[2] = Math.min(st.max_rise_speed, m.vel[2] + st.jet_accel * dt); m.energy -= st.jet_drain * dt; spent = true; this.maybeSound(m, "jet") }
    }
    if (spent) m.lastSpendT = this.t
    m.energy = Math.max(0, m.energy)
    const r = st.radius * sc, h = st.height * sc
    let [x, y, z] = m.pos
    const nx = x + m.vel[0] * dt, ny = y + m.vel[1] * dt
    if (this.canStand(nx, ny, z, r, h)) { x = nx; y = ny }
    else if (this.canStand(nx, y, z, r, h)) { x = nx; m.vel[1] *= 0.5 }
    else if (this.canStand(x, ny, z, r, h)) { y = ny; m.vel[0] *= 0.5 }
    else { m.vel[0] = 0; m.vel[1] = 0 }
    z += m.vel[2] * dt
    const fl = this.floorAt(x, y, Math.max(z, m.pos[2]), h)
    if (fl !== Infinity && z <= fl) { z = fl; m.vel[2] = 0; m.grounded = true }
    else if (fl !== Infinity && m.grounded && z - fl < 1.3 && m.vel[2] <= 0) { z = fl; m.vel[2] = 0 } // walk down small steps
    else m.grounded = false
    m.pos = [x, y, z]
    // steps
    const hs = hyp(m.vel[0], m.vel[1])
    if (m.grounded && hs > this.cfg.sound.step_speed) {
      m.stepAcc += dt
      if (m.stepAcc >= this.cfg.sound.step_every) { m.stepAcc = 0; this.emitSound(speed > st.walk_speed ? "boost" : "step", m.pos, m.id) }
    }
    // energy regen
    if (this.t - m.lastSpendT > st.energy_regen_delay) m.energy = Math.min(st.energy, m.energy + st.energy_regen * dt)
    // hp regen
    const inZ = this.inZone(m)
    if (!inZ) { this.damage(m, this.zone.dps * dt, "zone", null, null); }
    else if (this.t - m.lastDmgT > st.regen_delay) m.hp = Math.min(this.maxHp(m), m.hp + st.regen_per_s * dt)
  }
  jetSoundT = new Map<number, number>()
  maybeSound(m: Mech, kind: string) {
    const last = this.jetSoundT.get(m.id) ?? -9
    if (this.t - last > 0.5) { this.jetSoundT.set(m.id, this.t); this.emitSound(kind, m.pos, m.id) }
  }

  handleOneShots(m: Mech) {
    const a = m.action
    // offer pick
    if (m.offers.length) {
      const o = m.offers[0]
      if (a.pick != null && o.choices[a.pick]) this.applyUpgrade(m, o.choices[a.pick].id)
      else if (this.t >= o.expires) this.applyUpgrade(m, o.choices[0].id)
    }
    if (a.take != null) {
      const p = this.pickups.find((q) => q.id === a.take)
      if (!p) m.events.push({ type: "take_failed", id: a.take, reason: "gone" })
      else if (hyp(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]) > this.cfg.loot.pickup_radius || Math.abs(p.pos[2] - m.pos[2]) > 4) m.events.push({ type: "take_failed", id: a.take, reason: "range" })
      else if (m.weapons.some((w) => w?.kind === p.kind)) m.events.push({ type: "take_failed", id: a.take, reason: "have" })
      else {
        let slot = m.weapons.findIndex((w) => !w)
        if (slot < 0 && a.drop != null) slot = a.drop
        if (slot < 0) m.events.push({ type: "take_failed", id: a.take, reason: "full" })
        else {
          const old = m.weapons[slot]
          if (old) { const id = this.nextId.pick++; this.pickups.push({ id, kind: old.kind, pos: [...m.pos] }); m.events.push({ type: "dropped", id, kind: old.kind, slot }) }
          const w = this.mkWeapon(m, p.kind)
          w.equip = Math.max(this.cfg.loot.equip_s, w.stats.cooldown)
          m.weapons[slot] = w
          this.pickups = this.pickups.filter((q) => q !== p)
          m.events.push({ type: "took", id: p.id, kind: p.kind, slot })
        }
      }
    } else if (a.drop != null && m.weapons[a.drop]) {
      const old = m.weapons[a.drop]!
      const id = this.nextId.pick++
      this.pickups.push({ id, kind: old.kind, pos: [...m.pos] })
      m.weapons[a.drop] = null
    }
  }
  applyUpgrade(m: Mech, id: string) {
    const def = this.cfg.upgrades.find((u: any) => u.id === id)
    m.offers.shift()
    if (!def) return
    m.upgrades.push(id)
    m.upCount[id] = (m.upCount[id] ?? 0) + 1
    const oldMax = this.maxHp(m)
    for (const e of def.effects) {
      const [root, a, b] = e.path.split(".")
      let obj: any, key: string
      if (root === "mech") { obj = m.stats; key = a } else { obj = m.wstats[a]; key = b }
      if (e.mul != null) obj[key] *= e.mul
      if (e.add != null) obj[key] = (obj[key] ?? 0) + e.add
    }
    const nm = this.maxHp(m)
    if (nm > oldMax) m.hp += nm - oldMax
    m.events.push({ type: "upgrade", id })
  }
  gainCube(m: Mech, n = 1) {
    const oldMax = this.maxHp(m)
    m.cubes += n
    m.hp += this.maxHp(m) - oldMax
    const th = this.cfg.cubes.upgrade_thresholds
    while (m.thresholdsHit < th.length && m.cubes >= th[m.thresholdsHit]) {
      m.thresholdsHit++
      const avail = this.cfg.upgrades.filter((u: any) => (m.upCount[u.id] ?? 0) < u.max && (!u.requires || m.weapons.some((w) => w?.kind === u.requires)))
      const choices: any[] = []
      while (choices.length < 3 && avail.length) choices.push(avail.splice(Math.floor(this.rng.next() * avail.length), 1)[0])
      m.offers.push({ id: ++m.offerSeq, expires: this.t + this.cfg.bot.offer_timeout_s, choices: choices.map((c) => ({ id: c.id, name: c.name, desc: c.desc })) })
    }
  }

  step() {
    const dt = 1 / this.cfg.match.tick_hz
    const decide = this.tick % this.cfg.match.decide_every === 0
    const alive = this.mechs.filter((m) => m.alive)
    if (decide && this.house) {
      // escalation: weakest first, one more hunter per player kill and per minute
      const kills = this.mechs.filter((m) => !(m.ctrl as any).house).reduce((s, m) => s + m.kills, 0)
      const n = 1 + kills + Math.floor(this.t / (this.houseEvery ?? 60))
      const hs = alive.filter((m) => (m.ctrl as any).house).sort((a, b) => (a.ctrl as any).tier - (b.ctrl as any).tier || a.id - b.id)
      hs.forEach((m, i) => ((m.ctrl as any).active = i < n))
    }
    if (decide) {
      for (const m of alive) {
        const obs = this.buildObs(m)
        let act: any
        const t0 = performance.now()
        try { act = m.ctrl.act(obs) } catch (e) { act = null; if (m.missed++ < 3) console.error("bot", m.id, "threw", e) }
        const dtm = performance.now() - t0
        if (m.ctrl.name === 'MINE') { Sim.maxMs = Math.max(Sim.maxMs, dtm); if (dtm > 15) Sim.slow++; Sim.calls++ }
        if (act) m.action = act
        else m.action = { move: m.action.move, aim: m.action.aim, boost: m.action.boost }
        this.handleOneShots(m)
      }
    }
    for (const m of alive) {
      if (!m.alive) continue
      this.stepMech(m, dt)
      if (m.alive) this.fireWeapons(m, dt)
    }
    // one-shot fields only for the first tick of the decision
    if (decide) for (const m of alive) { m.action = { ...m.action, jump: false, take: undefined, drop: undefined, pick: undefined, reload: false } }
    this.stepProjectiles(dt)
    this.stepNpcs(dt)
    // cubes
    for (const c of [...this.cubes]) {
      let best: Mech | null = null, bd = Infinity
      for (const m of this.mechs) {
        if (!m.alive) continue
        const d = hyp(c.pos[0] - m.pos[0], c.pos[1] - m.pos[1])
        if (d < this.cfg.cubes.pickup_radius && Math.abs(c.pos[2] - m.pos[2]) < 4 && d < bd) { bd = d; best = m }
      }
      if (best) { this.cubes = this.cubes.filter((x) => x !== c); this.gainCube(best); best.events.push({ type: "pickup", cubes: best.cubes }) }
    }
    // drops
    const dc = this.cfg.drops
    for (const ct of dc.times) {
      if (Math.abs(this.t - ct) < dt / 2 && !this.drops.some((d) => d.callT === ct)) {
        const zc = this.zone.next_center, zr = this.zone.next_radius
        const p = this.randOpen(zc, zr * dc.spread)
        this.drops.push({ id: this.nextId.drop++, callT: ct, landT: ct + dc.fall_s, pos: [p[0], p[1], this.map.surfAt(p[0], p[1])], progress: 0, holder: null, taken: false })
      }
    }
    for (const d of this.drops) {
      if (d.taken || this.t < d.landT) continue
      const inside = this.mechs.filter((m) => m.alive && hyp(m.pos[0] - d.pos[0], m.pos[1] - d.pos[1]) < dc.radius)
      if (inside.length === 1) {
        if (d.holder !== inside[0].id) { d.holder = inside[0].id; d.progress = 0 }
        d.progress += dt
        if (d.progress >= dc.capture_s) {
          const m = inside[0]
          d.taken = true
          this.gainCube(m, dc.cubes)
          m.hp = this.maxHp(m); m.energy = m.stats.energy
          m.events.push({ type: "drop", id: d.id, cubes: m.cubes })
        }
      } else if (inside.length === 0) { d.holder = null; d.progress = 0 }
    }
    this.tick++
    this.t = this.tick * dt
    this.updateZone()
  }

  run(maxT?: number) {
    const dur = maxT ?? this.cfg.match.duration_s
    while (this.t < dur && this.mechs.filter((m) => m.alive).length > 1) this.step()
    // placements
    const alive = this.mechs.filter((m) => m.alive).sort((a, b) => b.hp - a.hp)
    let place = 1
    for (const m of alive) m.place = place++
    const byTick = new Map<number, number[]>()
    for (const d of this.deathOrder) { if (!byTick.has(d.t)) byTick.set(d.t, []); byTick.get(d.t)!.push(d.id) }
    const ticks = [...byTick.keys()].sort((a, b) => b - a)
    let p = alive.length + 1
    for (const tk of ticks) {
      const ids = byTick.get(tk)!
      for (const id of ids) this.mechs[id].place = p
      p += ids.length
    }
    return this.mechs.map((m) => ({ id: m.id, name: m.ctrl.name, place: m.place, kills: m.kills, cubes: m.cubes, deathT: m.alive ? this.t : m.deathT, cause: m.alive ? 'alive' : (m as any).lastW, dealt: (m as any).dealt ?? {}, taken: (m as any).taken ?? {} }))
  }
}

export function loadConfig(): any {
  const kit = "/tmp/claude-0/kit/mechfight-kit/check/stream.jsonl.gz"
  const zlib = require("node:zlib")
  const txt = zlib.gunzipSync(readFileSync(kit)).toString()
  return JSON.parse(txt.split("\n")[0]).config
}
