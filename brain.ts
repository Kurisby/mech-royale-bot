// Mech Royale bot brain. Survival-first: avoid early fights, farm safe cubes, stay inside the zone
// with cover, fight with accurate leading aim and face threats (front armor).
import { GameMap, type P2 } from "./map.ts"

type V3 = [number, number, number]
const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const hyp = Math.hypot
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

class Rng {
  s: number
  constructor(seed: number) { this.s = (seed >>> 0) || 1 }
  next() {
    let x = this.s
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    this.s = x
    return x / 4294967296
  }
}

interface Track {
  id: number
  pos: V3
  vel: V3
  aim: [number, number]
  hp: number
  maxHp: number
  weapons: string[]
  charging: boolean
  cubes: number
  seenT: number // last time it was in obs.mechs
  firstT: number
  visible: boolean // currently listed
  losT: number // last time we had a clear line to it
}

const UPGRADE_PRIO = [
  "plating", "armor", "nanites", "gun_damage", "gun_rate", "laser_damage", "laser_charge",
  "lightning_efficiency", "lightning_range", "gyros", "gun_velocity", "sensors", "mortar_reload", "servos",
  "gun_mag", "capacitor", "reactor", "jets", "mortar_velocity", "mortar_splash", "lightning_chain", "laser_pierce",
]
const WEAPON_PRIO: Record<string, number> = { laser: 3, lightning: 2, mortar: 1, gun: 0 }

export interface BrainOpts {
  name?: string
  aggression?: number // 0..1
  farm?: boolean
  hunt?: boolean
  focus?: boolean
  chase?: boolean
  roof?: boolean
  zoneFirst?: boolean
  jink?: boolean
  style?: string
  stealth?: boolean
  homeMode?: string
  duck?: boolean
  coverCheck?: boolean
  lootFar?: boolean
  tactical?: boolean
  precharge?: boolean
}

export class Brain {
  name: string
  map: GameMap
  cfg: any
  rng: Rng
  me = 0
  tracks = new Map<number, Track>()
  npcs = new Map<number, Track>()
  t = 0
  lastPos: V3 = [0, 0, 0]
  // nav
  path: P2[] | null = null
  pathGoal: P2 | null = null
  pathT = -99
  pathI = 0
  stuckT = 0
  stuckRef: V3 = [0, 0, 0]
  stuckRefT = 0
  unstickUntil = 0
  unstickDir: P2 = [1, 0]
  // goals
  home: P2 | null = null
  homeKey = ""
  // combat
  jinkT = 0
  jinkDir = 1
  lastDamageT = -99
  lastDamageBearing = 0
  lastDamageBy: number | null = null
  dmgWindow: { t: number; a: number }[] = []
  heard: { t: number; bearing: number; dist: string; kind: string }[] = []
  scanBase = 0
  failedTakes = new Map<number, number>()
  badCrates = new Map<number, number>()
  crateHp = new Map<number, { hp: number; t: number }>()
  opts: BrainOpts
  lastCombatT = -99
  label = ""
  draw: any = null

  constructor(hello: any, map: GameMap, opts: BrainOpts = {}) {
    this.opts = opts
    this.name = opts.name ?? "survivor"
    this.map = map
    this.cfg = hello.config
    this.rng = new Rng(hello.seed ?? 1)
    this.me = hello.slot
  }

  // ------------------------------------------------------------------ helpers
  zoneAt(z: any, t: number): { c: P2; r: number } {
    if (t <= z.shrink_start) return { c: [z.center[0], z.center[1]], r: z.radius }
    const f = clamp((t - z.shrink_start) / Math.max(0.001, z.shrink_end - z.shrink_start), 0, 1)
    return {
      c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f],
      r: z.radius + (z.next_radius - z.radius) * f,
    }
  }

  canSee(fromPos: V3, fromAimYaw: number, eye: number, to: V3, toH: number, range = 200, near = 45) {
    const dx = to[0] - fromPos[0], dy = to[1] - fromPos[1]
    const d = hyp(dx, dy)
    if (d > range) return false
    if (d > near) {
      const a = Math.abs(wrap(Math.atan2(dy, dx) - fromAimYaw))
      if (a > Math.PI / 3 + 0.05) return false
    }
    const ez = fromPos[2] + eye
    return this.map.los(fromPos[0], fromPos[1], ez, to[0], to[1], to[2] + toH * 0.5) ||
      this.map.los(fromPos[0], fromPos[1], ez, to[0], to[1], to[2] + toH)
  }

  // ------------------------------------------------------------------ main
  act(obs: any): any {
    const t = obs.t
    this.t = t
    const me = obs.self
    const pos: V3 = me.pos
    const act: any = { tick: obs.tick }
    const scale = 1 + (this.cfg.cubes?.size_per_cube ?? 0.05) * (me.cubes ?? 0)
    const muzzleZ = pos[2] + (me.stats?.muzzle_height ?? 7)
    const eyeZ = pos[2] + (me.stats?.eye_height ?? 8)

    // ---- upgrades
    if (obs.offer && obs.offer.choices?.length) {
      let best = 0, bp = 999
      obs.offer.choices.forEach((c: any, i: number) => {
        const p = UPGRADE_PRIO.indexOf(c.id)
        const pr = p < 0 ? 500 : p
        if (pr < bp) { bp = pr; best = i }
      })
      act.pick = best
    }

    // ---- events
    for (const e of obs.events ?? []) {
      if (e.type === "damaged") {
        if (e.weapon === "npc") { this.npcDmgT = t; this.npcDmgBy = e.by ?? null }
        else if (e.weapon !== "zone") {
          this.lastDamageT = t
          if (e.bearing != null) this.lastDamageBearing = e.bearing
          this.lastDamageBy = e.by ?? null
          if (e.by != null) this.hitBy.set(e.by, t)
          this.dmgWindow.push({ t, a: e.amount })
        }
      } else if (e.type === "take_failed") {
        this.failedTakes.set(e.id, t)
      }
    }
    this.dmgWindow = this.dmgWindow.filter((d) => t - d.t < 3)
    for (const s of obs.sounds ?? []) this.heard.push({ t: t - (s.age ?? 0), bearing: s.bearing, dist: s.dist, kind: s.kind })
    this.heard = this.heard.filter((h) => t - h.t < 6)

    // ---- tracking
    for (const tr of this.tracks.values()) tr.visible = false
    for (const m of obs.mechs ?? []) {
      const store = m.kind === "mech" ? this.tracks : this.npcs
      let tr = store.get(m.id)
      if (!tr) {
        tr = { id: m.id, pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp ?? 1400, maxHp: m.max_hp ?? 1400, weapons: m.weapons ?? [], charging: !!m.charging, cubes: m.cubes ?? 0, seenT: t, firstT: t, visible: true, losT: -99 }
        store.set(m.id, tr)
      }
      tr.pos = m.pos; tr.vel = m.vel; tr.aim = m.aim
      if (m.hp != null) tr.hp = m.hp
      if (m.max_hp != null) tr.maxHp = m.max_hp
      tr.weapons = m.weapons ?? tr.weapons
      tr.charging = !!m.charging
      tr.cubes = m.cubes ?? tr.cubes
      tr.seenT = t
      tr.visible = true
    }
    for (const [id, tr] of this.tracks) if (t - tr.seenT > 12) this.tracks.delete(id)
    for (const [id, tr] of this.npcs) if (t - tr.seenT > 2) this.npcs.delete(id)

    const enemies = [...this.tracks.values()].filter((e) => e.visible)
    for (const e of enemies) {
      const h = 9 * (1 + 0.05 * e.cubes)
      if (this.map.los(pos[0], pos[1], muzzleZ, e.pos[0], e.pos[1], e.pos[2] + h * 0.5) || this.map.los(pos[0], pos[1], eyeZ, e.pos[0], e.pos[1], e.pos[2] + h * 0.85)) e.losT = t
    }

    // ---- zone
    const zone = obs.zone
    const zNow = this.zoneAt(zone, t)
    const zSoon = this.zoneAt(zone, t + 6)
    const nextC: P2 = zone.next_center
    const nextR: number = zone.next_radius
    const myDistNext = hyp(pos[0] - nextC[0], pos[1] - nextC[1])
    const shrinking = t >= zone.shrink_start
    // time until the closing edge reaches me (approx)
    let edgeEta = 999
    for (let dt = 0; dt <= 60; dt += 1) {
      const z = this.zoneAt(zone, t + dt)
      if (hyp(pos[0] - z.c[0], pos[1] - z.c[1]) > z.r - 4) { edgeEta = dt; break }
    }
    const inZoneNow = hyp(pos[0] - zNow.c[0], pos[1] - zNow.c[1]) < zNow.r

    // ---- choose home (a covered spot inside the next circle)
    const key = `${nextC[0].toFixed(0)},${nextC[1].toFixed(0)},${nextR.toFixed(0)}`
    if (key !== this.homeKey || !this.home) {
      this.homeKey = key
      this.home = this.pickHome(pos, nextC, nextR, enemies)
    }
    // re-check home if an enemy is camping near it
    if (this.home && enemies.some((e) => hyp(e.pos[0] - this.home![0], e.pos[1] - this.home![1]) < 40) && t - this.pathT > 2) {
      this.home = this.pickHome(pos, nextC, nextR, enemies)
    }

    // ---- threat assessment
    const myHp = me.hp
    const myMax = me.max_hp
    const hpFrac = myHp / myMax
    const visibleThreats = enemies.filter((e) => t - e.losT < 1.0 || hyp(e.pos[0] - pos[0], e.pos[1] - pos[1]) < 60)
    const recentDmg = this.dmgWindow.reduce((s, d) => s + d.a, 0)
    const underFire = t - this.lastDamageT < 2.5

    // weapons
    const W = me.weapons ?? []
    const gun = W.find((w: any) => w && w.kind === "gun")
    const gunSlot = W.findIndex((w: any) => w && w.kind === "gun")
    const sec = W.findIndex((w: any, i: number) => w && w.kind !== "gun")
    const secW = sec >= 0 ? W[sec] : null

    // ---- target selection
    let target: Track | null = null
    let tScore = -Infinity
    for (const e of enemies) {
      const d = hyp(e.pos[0] - pos[0], e.pos[1] - pos[1])
      const hasLos = t - e.losT < 0.3
      const focus = this.opts.focus ?? true
      let s = -d * 0.02 - e.hp / (focus ? 200 : 400)
      if (hasLos) s += 3
      if (this.lastDamageBy === e.id && underFire) s += 2
      if (this.isAimingAt(e, pos)) s += 1
      if (focus && e.id === this.lastTargetId && t - e.seenT < 1) s += 2.5
      if (d > 260) s -= 5
      if (s > tScore) { tScore = s; target = e }
    }
    this.lastTargetId = target ? target.id : null

    // ---- decide mode
    const alive = obs.alive
    const late = alive <= 4 || nextR <= 70
    let mode: "fight" | "evade" | "travel" = "travel"
    let fightTarget: Track | null = null
    let holdFire = false
    if (target) {
      const d = hyp(target.pos[0] - pos[0], target.pos[1] - pos[1])
      const hasLos = t - target.losT < 0.6
      const tSees = this.canSee(target.pos, target.aim[0], 8, pos, 9 * scale)
      const myPower = myHp * (1 + (secW ? 0.4 : 0)) * (1 + 0.04 * Math.min(10, me.cubes ?? 0))
      const thPower = target.hp * (1 + (target.weapons.length > 1 ? 0.4 : 0)) * (1 + 0.04 * Math.min(10, target.cubes))
      const others = enemies.filter((e) => e !== target && t - e.seenT < 1 && hyp(e.pos[0] - pos[0], e.pos[1] - pos[1]) < 200).length
      const ratio = myPower / Math.max(1, thPower) / (others ? 1.5 : 1)
      const agg = this.opts.aggression ?? 0.2
      const need = 1.3 - (agg - 0.5)
      const favorable = ratio > need || target.hp < 250
      const byTarget = underFire && this.lastDamageBy === target.id
      const provoked = (t - (this.hitBy.get(target.id) ?? -99) < 8) || (target.charging && hasLos && this.isAimingAt(target, pos, 0.08)) || (d < 40 && tSees)
      if (this.opts.hunt) {
        if (d < 260 && (hasLos || t - target.seenT < 5)) { mode = "fight"; fightTarget = target }
      } else if ((this.opts.style ?? "stealth") === "fighter" && !late) {
        if (hasLos && d < 240) {
          fightTarget = target
          if (hpFrac < 0.35 && target.hp > 250 && d > 35) mode = "evade"
          else if (tSees || provoked || favorable || d < 70) mode = "fight"
          else { mode = "evade"; holdFire = true }
        } else if (tSees && d < 200) {
          fightTarget = target
          mode = "evade"
          holdFire = !provoked
        }
      } else if ((this.opts.stealth ?? true) && !late && !provoked) {
        // not engaged: stay quiet. Only finish off a crippled mech that is close.
        if (hasLos && target.hp < 300 && d < 140 && hpFrac > 0.5 && !others) { mode = "fight"; fightTarget = target }
        else if (tSees || (hasLos && d < 120)) { mode = "evade"; fightTarget = target; holdFire = true }
      } else if (late) {
        if (hasLos && d < 240) { mode = "fight"; fightTarget = target }
        else if (favorable && d < 150) { mode = "fight"; fightTarget = target }
        else if (tSees) { mode = "evade"; fightTarget = target }
      } else if (hasLos && d < 240) {
        fightTarget = target
        if (favorable) mode = "fight"
        else if (tSees && d < 55) mode = "fight"
        else if (byTarget && ratio > 0.85 && d < 120) mode = "fight"
        else mode = "evade"
      } else if (tSees && d < 200) {
        fightTarget = target
        mode = favorable ? "fight" : "evade"
      }
    }
    if ((this.opts.chase ?? false) && target && mode !== "fight" && target.hp < 450 && hpFrac > 0.45 && t - target.seenT < 5 && hyp(target.pos[0] - pos[0], target.pos[1] - pos[1]) < 200) {
      mode = "fight"; fightTarget = target; holdFire = false
    }
    if (mode === "evade" && fightTarget && (this.opts.coverCheck ?? false)) {
      // only run if there is cover close by; running in the open just eats laser shots
      this.evadeMove(pos, fightTarget, nextC, nextR, zNow)
      const d = hyp(fightTarget.pos[0] - pos[0], fightTarget.pos[1] - pos[1])
      if (!this.evadeHidden && t - fightTarget.losT < 0.6 && d < 230) mode = "fight"
    }
    if (mode !== "travel") this.lastCombatT = t

    // ---- movement goal
    let goal: P2 | null = this.home
    let goalWhy = "home"
    let urgent = false
    const calm = !target && t - this.lastDamageT > 6 && t - this.lastCombatT > 5
    const zoneSafeFor = (p: P2, margin: number) => {
      // inside the next circle, or inside the current circle with enough time
      return hyp(p[0] - nextC[0], p[1] - nextC[1]) < nextR - margin || (!shrinking && hyp(p[0] - zNow.c[0], p[1] - zNow.c[1]) < zNow.r - margin && zone.shrink_start - t > 20)
    }
    // must head to zone?
    const homeDist = this.home ? hyp(this.home[0] - pos[0], this.home[1] - pos[1]) : 0
    const travelTime = homeDist / (me.stats?.walk_speed ?? 11.7) * 1.4
    if (!inZoneNow || edgeEta < travelTime + 8) urgent = true

    let takeId: number | null = null
    let dropSlot: number | null = null
    if (!urgent && mode !== "fight") {
      // weapon pickups
      let bestP: any = null, bpv = -Infinity
      for (const p of obs.pickups ?? []) {
        if ((this.failedTakes.get(p.id) ?? -99) > t - 3) continue
        const pr = WEAPON_PRIO[p.kind] ?? 0
        const have = W.some((w: any) => w && w.kind === p.kind)
        if (have) continue
        const curSec = secW ? WEAPON_PRIO[secW.kind] ?? 0 : -1
        if (pr <= curSec) continue
        const d = hyp(p.pos[0] - pos[0], p.pos[1] - pos[1])
        const lootR = mode === "evade" ? 25 : (!secW && (this.opts.lootFar ?? true) ? 160 : 90)
        if (d > lootR) continue
        if (p.pos[2] - this.map.surfAt(p.pos[0], p.pos[1]) > 2 && Math.abs(p.pos[2] - pos[2]) > 2) continue // on a roof
        if ((this.map.blocked[this.map.gIdx(p.pos[0], p.pos[1])] & 1) && this.map.wallDistAt(p.pos[0], p.pos[1]) < 1.5) continue
        if (!zoneSafeFor([p.pos[0], p.pos[1]], 5) && d > 20) continue
        const v = pr * 30 - d + (p.id === this.lootId ? 25 : 0)
        if (v > bpv) { bpv = v; bestP = p }
      }
      this.lootId = bestP ? bestP.id : null
      if (bestP) {
        goal = [bestP.pos[0], bestP.pos[1]]
        goalWhy = "loot " + bestP.kind
        const d = hyp(bestP.pos[0] - pos[0], bestP.pos[1] - pos[1])
        if (d < (this.cfg.loot?.pickup_radius ?? 4) - 0.3 && Math.abs(bestP.pos[2] - pos[2]) < 3.8) {
          takeId = bestP.id
          if (secW) dropSlot = sec
        }
      } else {
        // cubes on the ground
        let bc: any = null, bcd = Infinity
        for (const c of obs.cubes ?? []) {
          const d = hyp(c.pos[0] - pos[0], c.pos[1] - pos[1])
          if (Math.abs(c.pos[2] - pos[2]) > 3.5) continue
          if (c.pos[2] - this.map.surfAt(c.pos[0], c.pos[1]) > 2) continue
          if (d < bcd && d < (calm ? 80 : 30) && zoneSafeFor([c.pos[0], c.pos[1]], 3)) { bcd = d; bc = c }
        }
        if (bc) { goal = [bc.pos[0], bc.pos[1]]; goalWhy = "cube" }
        else if (obs.drops?.length && hpFrac > 0.3) {
          // supply drop if close and uncontested
          for (const dr of obs.drops) {
            const d = hyp(dr.pos[0] - pos[0], dr.pos[1] - pos[1])
            if (d > 110 || dr.lands_in > d / 11 + 3) continue
            const contested = [...this.tracks.values()].some((e) => t - e.seenT < 4 && hyp(e.pos[0] - dr.pos[0], e.pos[1] - dr.pos[1]) < 70)
            if (contested && !(late && hpFrac > 0.6)) continue
            if (dr.holder != null && dr.holder !== this.me) continue
            goal = [dr.pos[0], dr.pos[1]]
            goalWhy = "drop"
            break
          }
        }
      }
    }

    // ---- crate / npc farming target (shoot) when calm
    let farmTarget: { pos: V3; vel: V3; id: number; h: number } | null = null
    let npcFlee: Track | null = null
    if (t - this.npcDmgT < 3 && this.npcDmgBy != null && mode === "travel") {
      const n = this.npcs.get(this.npcDmgBy)
      if (n && n.visible) {
        if (hpFrac > 0.35 && gun) farmTarget = { pos: n.pos, vel: n.vel, id: n.id, h: 3.5 }
        else npcFlee = n
      }
    }
    if (!farmTarget && (this.opts.farm ?? true) && calm && !urgent && gun && hpFrac > 0.5 && t < 330) {
      let best: any = null, bd = Infinity
      for (const c of obs.crates ?? []) {
        const d = hyp(c.pos[0] - pos[0], c.pos[1] - pos[1])
        if (d > 110 || (this.badCrates.get(c.id) ?? 0) > 25) continue
        if (!this.map.los(pos[0], pos[1], muzzleZ, c.pos[0], c.pos[1], c.pos[2] + 1.2)) continue
        if (!zoneSafeFor([c.pos[0], c.pos[1]], 5)) continue
        if (d < bd) { bd = d; best = { pos: c.pos, vel: [0, 0, 0], id: c.id, h: 2.4 } }
      }
      if (!best && hpFrac > 0.6 && (me.cubes ?? 0) < 12) {
        for (const n of this.npcs.values()) {
          if (!n.visible) continue
          const d = hyp(n.pos[0] - pos[0], n.pos[1] - pos[1])
          if (d > 85) continue
          if (!this.map.los(pos[0], pos[1], muzzleZ, n.pos[0], n.pos[1], n.pos[2] + 1.75)) continue
          if (d < bd) { bd = d; best = { pos: n.pos, vel: n.vel, id: n.id, h: 3.5 } }
        }
      }
      farmTarget = best
      if (best) {
        const d = hyp(best.pos[0] - pos[0], best.pos[1] - pos[1])
        // track crate progress: give up on crates we can't damage
        if (best.id >= 1000 && best.id < 5000) {
          const rec = this.crateHp.get(best.id)
          const hp = (obs.crates.find((c: any) => c.id === best.id)?.hp) ?? 300
          if (!rec || rec.hp !== hp) this.crateHp.set(best.id, { hp, t })
          else if (t - rec.t > 4) this.badCrates.set(best.id, 99)
        }
        if (goalWhy === "home" && d > 35) { goal = [best.pos[0], best.pos[1]]; goalWhy = "farm" }
      }
    }

    if (this.opts.hunt && mode === "travel" && !urgent && goalWhy === "home") {
      const loud = this.heard.filter((h) => (h.kind === "gun" || h.kind === "laser" || h.kind === "lightning" || h.kind === "mortar") && h.dist !== "far" && t - h.t < 4).sort((a, b) => b.t - a.t)[0]
      if (loud) {
        const r = loud.dist === "near" ? 40 : 110
        const gx = pos[0] + Math.cos(loud.bearing) * r, gy = pos[1] + Math.sin(loud.bearing) * r
        if (zoneSafeFor([gx, gy], 10)) { goal = [gx, gy]; goalWhy = "hunt" }
      }
    }

    // ---- movement vector
    let move: P2 = [0, 0]
    let boost = false
    let jump = false
    this.jetOk = false
    const walk = me.stats?.walk_speed ?? 11.7

    if (npcFlee && mode === "travel") {
      move = this.evadeMove(pos, npcFlee, nextC, nextR, zNow)
    } else if (mode === "evade" && fightTarget) {
      move = this.evadeMove(pos, fightTarget, nextC, nextR, zNow)
      boost = me.energy > 30
    } else if (mode === "fight" && fightTarget) {
      if (t - fightTarget.losT > 1.0) move = this.navMove(pos, [fightTarget.pos[0], fightTarget.pos[1]], [])
      else if (this.opts.tactical) {
        const gunReady = !!gun && (gun.ammo ?? 1) > 0 && (gun.reload ?? 0) <= 0.2
        const secReady = !!secW && secW.kind === "laser" && ((this.opts.precharge ?? false) ? (secW.charge ?? 0) >= (secW.stats?.charge ?? 0.75) - 0.1 : (secW.cooldown ?? 0) < 0.5)
        move = this.tacticalMove(pos, fightTarget, secW?.kind, nextC, nextR, zNow, hpFrac, gunReady || secReady)
      }
      else move = this.fightMove(pos, fightTarget, secW?.kind, nextC, nextR, zNow, hpFrac)
    } else if (goal) {
      const gd = hyp(goal[0] - pos[0], goal[1] - pos[1])
      const arrive = goalWhy === "home" ? 6 : 1.5
      if (gd > arrive) {
        move = this.navMove(pos, goal, enemies)
        if (goalWhy !== "home" && gd < 6) move = [move[0] * Math.max(0.35, gd / 6), move[1] * Math.max(0.35, gd / 6)]
      }
      if (urgent && me.energy > 25) boost = true
      if (!inZoneNow && me.energy > 5) boost = true
    }
    // ---- rooftop hiding: climb onto a large roof inside the next circle and wait there
    let roofCtl = false
    const onRoof = me.grounded && pos[2] > this.map.surfAt(pos[0], pos[1]) + 2.5
    if ((this.opts.roof ?? true) && (mode === "travel" || (onRoof && mode === "evade")) && (goalWhy === "home" || goalWhy === "farm" || onRoof) && !npcFlee) {
      const rk = key
      const roofOk = (r: any) => r && hyp(r.x - nextC[0], r.y - nextC[1]) < nextR - 8 && (this.badRoofs.get(r.id) ?? -99) < t - 60
      if (this.roofKey !== rk || (this.roof && !roofOk(this.roof))) {
        this.roofKey = rk
        if (!roofOk(this.roof)) this.roof = this.pickRoof(pos, nextC, nextR)
      }
      const r = this.roof
      if (r && roofOk(r) && !(urgent && hyp(r.ax - pos[0], r.ay - pos[1]) > 60)) {
        roofCtl = true
        const onIt = onRoof && Math.abs(pos[2] - r.T) < 1.5
        if (onIt) {
          this.climbT = -1
          const d = hyp(r.x - pos[0], r.y - pos[1])
          move = d > 3 ? [(r.x - pos[0]) / d, (r.y - pos[1]) / d] : [0, 0]
          goalWhy = "roof"
        } else {
          const da = hyp(r.ax - pos[0], r.ay - pos[1])
          if (da > 3.5 && this.climbT < 0) {
            move = this.navMove(pos, [r.ax, r.ay], enemies)
            goalWhy = "to-roof"
          } else {
            // at the wall: wait for energy, then jump and jet up while pushing toward the roof point
            const need = Math.min(98, ((r.T - pos[2]) / 10) * 15 * 1.25 + 15)
            const dx = r.x - pos[0], dy = r.y - pos[1], L = hyp(dx, dy) || 1
            if (this.climbT < 0) {
              if (me.energy >= need && me.grounded) { this.climbT = t; jump = true; move = [dx / L, dy / L] }
              else { move = [0, 0]; goalWhy = "charge" }
            } else {
              move = [dx / L, dy / L]
              if (!me.grounded) { boost = pos[2] < r.T + 1.5; this.jetOk = boost }
              else if (pos[2] < r.T - 1.5) { jump = true }
              goalWhy = "climb"
              if (t - this.climbT > 10) { this.badRoofs.set(r.id, t); this.climbT = -1; this.roof = null }
              if (me.grounded && t - this.climbT > 1.5 && pos[2] < r.T - 1.5 && me.energy < 10) this.climbT = -1
            }
          }
        }
      } else if (onRoof) {
        goalWhy = "descend"
      }
    } else this.climbT = -1

    // zone first: never stay in a fight outside (or about to be outside) the zone
    if ((this.opts.zoneFirst ?? true) && (mode === "fight" || mode === "evade") && this.home) {
      const zd = hyp(pos[0] - zSoon.c[0], pos[1] - zSoon.c[1]) - zSoon.r
      if (!inZoneNow || zd > -6 || edgeEta < travelTime + 4) {
        move = this.navMove(pos, this.home, [])
        if (me.grounded && me.energy > 20) boost = true
      }
    }
    // dodge: when a visible enemy has a line on us, keep changing lateral velocity to spoil leading aim
    if ((this.opts.jink ?? true) && fightTarget && t - fightTarget.losT < 0.6 && mode !== "fight") {
      if (t > this.jinkT) {
        this.jinkT = t + 0.3 + this.rng.next() * 0.5
        this.jinkDir = this.rng.next() < 0.5 ? -1 : 1
      }
      const dx = fightTarget.pos[0] - pos[0], dy = fightTarget.pos[1] - pos[1], L = hyp(dx, dy) || 1
      const px = (-dy / L) * this.jinkDir, py = (dx / L) * this.jinkDir
      if (this.map.wallDistAt(pos[0] + px * 4, pos[1] + py * 4) > 3.2) move = [move[0] * 0.7 + px * 0.7, move[1] * 0.7 + py * 0.7]
    }
    // laser threat: an enemy charging a laser at us with line of sight -> duck behind cover if it is close
    if (this.opts.duck ?? true) {
      const threat = enemies.find((e) => e.charging && t - e.losT < 0.4 && this.isAimingAt(e, pos, 0.1) && hyp(e.pos[0] - pos[0], e.pos[1] - pos[1]) < 290)
      if (threat) {
        const spot = this.quickCover(pos, threat)
        if (spot) {
          const dx = spot[0] - pos[0], dy = spot[1] - pos[1], L = hyp(dx, dy) || 1
          move = [dx / L, dy / L]
          if (me.grounded && me.energy > 10) boost = true
          this.label = "duck"
        }
      }
    }
    // zone override: never walk out
    {
      const nxp = pos[0] + move[0] * 3, nyp = pos[1] + move[1] * 3
      if (inZoneNow && hyp(nxp - zSoon.c[0], nyp - zSoon.c[1]) > zSoon.r - 3 && mode !== "travel") {
        const toC = Math.atan2(zSoon.c[1] - pos[1], zSoon.c[0] - pos[0])
        move = [Math.cos(toC) * 0.7 + move[0] * 0.3, Math.sin(toC) * 0.7 + move[1] * 0.3]
      }
    }
    // stuck handling
    const sp = hyp(me.vel[0], me.vel[1])
    if (hyp(move[0], move[1]) > 0.3 && this.climbT < 0) {
      if (t - this.stuckRefT > 1.2) {
        const moved = hyp(pos[0] - this.stuckRef[0], pos[1] - this.stuckRef[1])
        if (moved < 2.5 && t > 1) {
          this.stuckT += 1
          this.unstickUntil = t + 0.8
          if (this.stuckT >= 2) {
            const ml0 = hyp(move[0], move[1]) || 1
            this.badPts.push({ x: pos[0] + (move[0] / ml0) * 3, y: pos[1] + (move[1] / ml0) * 3, t })
            if (this.badPts.length > 30) this.badPts.shift()
          }
          const a = this.rng.next() * TAU
          this.unstickDir = [Math.cos(a), Math.sin(a)]
          this.pathT = -99
        } else this.stuckT = 0
        this.stuckRef = [...pos] as V3
        this.stuckRefT = t
      }
    } else { this.stuckRef = [...pos] as V3; this.stuckRefT = t }
    if (t < this.unstickUntil) {
      move = [move[0] * 0.3 + this.unstickDir[0] * 0.7, move[1] * 0.3 + this.unstickDir[1] * 0.7]
      if (me.grounded && this.stuckT >= 2) jump = true
      if (!me.grounded && me.energy > 10 && this.stuckT >= 2) { boost = true; this.jetOk = true }
    }

    // ---- aiming & firing
    let aimYaw = me.aim[0]
    let aimPitch = 0
    const fire: [boolean, boolean] = [false, false]
    let reload = false
    const myYaw = me.aim[0], myPitch = me.aim[1]
    if (fightTarget && holdFire) {
      // watch it (keeps it in view, front armor toward it) but do not shoot
      const lead = this.leadAim(pos, muzzleZ, fightTarget.pos, fightTarget.vel, 4.5, 252)
      aimYaw = lead[0]; aimPitch = lead[1]
      if (secW?.kind === "laser" && (secW.charge ?? 0) > 0) fire[sec] = true
    } else if (fightTarget && (mode === "fight" || mode === "evade")) {
      const e = fightTarget
      const eh = 9 * (1 + 0.05 * e.cubes)
      const hasLos = t - e.losT < 0.3
      const d3 = hyp(e.pos[0] - pos[0], e.pos[1] - pos[1], e.pos[2] + eh * 0.5 - muzzleZ)
      const d = hyp(e.pos[0] - pos[0], e.pos[1] - pos[1])
      // gun lead
      const gs = gun?.stats?.speed ?? 252
      const lead = this.leadAim(pos, muzzleZ, e.pos, e.vel, eh * 0.5, gs)
      aimYaw = lead[0]; aimPitch = lead[1]
      const err = Math.hypot(wrap(myYaw - aimYaw), myPitch - aimPitch)
      const tol = Math.atan2(Math.max(1.2, 2.2 * (1 + 0.05 * e.cubes)), d3) + 0.004
      let secAim: [number, number] | null = null
      if (secW && sec >= 0) {
        const k = secW.kind
        if (k === "laser") {
          const direct = this.leadAim(pos, muzzleZ, e.pos, e.vel, eh * 0.5, 1e9)
          const rng = secW.stats?.range ?? 280
          if (hasLos && d3 < rng) {
            const charge = secW.charge ?? 0
            const full = secW.stats?.charge ?? 0.75
            const lerr = Math.hypot(wrap(myYaw - direct[0]), myPitch - direct[1])
            const ltol = Math.atan2(1.6 * (1 + 0.05 * e.cubes), d3)
            if (secW.cooldown <= 0.05 || charge > 0) {
              if (charge >= full - 0.05 && lerr < ltol) {
                fire[sec] = false // release
              } else {
                fire[sec] = true
                if (charge > full * 0.6) secAim = direct
              }
            }
          } else if ((secW.charge ?? 0) > 0) {
            const full = secW.stats?.charge ?? 0.75
            if ((secW.charge ?? 0) >= full - 0.05) { if (this.laserFullT < 0) this.laserFullT = t } else this.laserFullT = -1
            // hold the charge for the next peek, but let go before it fires on its own
            fire[sec] = !(this.laserFullT >= 0 && t - this.laserFullT > 1.6)
            if ((this.opts.precharge ?? false)) secAim = this.leadAim(pos, muzzleZ, e.pos, e.vel, eh * 0.5, 1e9)
          } else if ((this.opts.precharge ?? false) && secW.cooldown <= 0.05 && t - e.losT < 3 && d3 < rng) {
            fire[sec] = true // pre-charge behind cover so the peek shot is instant
            this.laserFullT = -1
          }
        } else if (k === "lightning") {
          const rng = (secW.stats?.range ?? 45) * 0.95
          const cone = ((secW.stats?.cone_deg ?? 30) * Math.PI) / 180 / 2
          const yawTo = Math.atan2(e.pos[1] - pos[1], e.pos[0] - pos[0])
          if (hasLos && d < rng && Math.abs(wrap(myYaw - yawTo)) < cone * 0.9 && secW.cooldown <= 0.1 && me.energy > 8) fire[sec] = true
        } else if (k === "mortar") {
          const ms = secW.stats?.speed ?? 72
          const mg = secW.stats?.gravity ?? 22
          const tubeZ = pos[2] + 9.5 * scale
          const sol = this.mortarAim(pos, tubeZ, e.pos, e.vel, ms, mg, !hasLos)
          if (sol && d > 18 && secW.cooldown <= 0.1) {
            const merr = Math.hypot(wrap(myYaw - sol[0]), myPitch - sol[1])
            secAim = sol
            if (merr < 0.03) fire[sec] = true
          }
        }
      }
      if (secAim) { aimYaw = secAim[0]; aimPitch = secAim[1] }
      if (gun && gunSlot >= 0 && hasLos && d3 < (gun.stats?.range ?? 230) * 0.98 && !secAim) {
        if ((gun.ammo ?? 1) > 0 && (gun.reload ?? 0) <= 0 && err < tol) fire[gunSlot] = true
      }
      if (gun && (gun.ammo ?? 1) === 0 && (gun.reload ?? 0) <= 0) reload = true
    } else if (farmTarget && gun) {
      const ft = farmTarget
      const lead = this.leadAim(pos, muzzleZ, ft.pos, ft.vel, ft.h * 0.5, gun.stats?.speed ?? 252)
      aimYaw = lead[0]; aimPitch = lead[1]
      const d3 = hyp(ft.pos[0] - pos[0], ft.pos[1] - pos[1], ft.pos[2] - pos[2])
      const err = Math.hypot(wrap(myYaw - aimYaw), myPitch - aimPitch)
      if (err < Math.atan2(1.0, d3) + 0.004 && (gun.ammo ?? 1) > 0 && d3 < 200) fire[gunSlot] = true
      if (secW?.kind === "lightning" && d3 < 40 && Math.abs(wrap(myYaw - lead[0])) < 0.2 && me.energy > 50) fire[sec] = true
      if ((gun.ammo ?? 1) === 0) reload = true
    } else {
      // no target: look where threats are likely
      aimPitch = 0
      const recentTrack = [...this.tracks.values()].filter((e) => t - e.seenT < 10).sort((a, b) => b.seenT - a.seenT)[0]
      const recentLoud = this.heard.filter((h) => h.kind !== "step" && h.kind !== "crate" && h.kind !== "npc_gun" && t - h.t < 3).sort((a, b) => b.t - a.t)[0]
      if (t - this.lastDamageT < 3) aimYaw = this.lastDamageBearing
      else if (recentTrack && t - recentTrack.seenT < 6) aimYaw = Math.atan2(recentTrack.pos[1] - pos[1], recentTrack.pos[0] - pos[0])
      else if (recentLoud && recentLoud.dist !== "far") aimYaw = recentLoud.bearing
      else if (hyp(move[0], move[1]) > 0.3) {
        aimYaw = Math.atan2(move[1], move[0]) + Math.sin(t * 1.3) * 0.7
      } else {
        // camping: sweep the open directions
        this.scanBase += 0.06
        aimYaw = this.openDir(pos) + Math.sin(this.scanBase) * 1.2
      }
      if (gun && (gun.ammo ?? 12) < (gun.stats?.mag ?? 12) * 0.5 && (gun.reload ?? 0) <= 0 && !target) reload = true
      if (secW?.kind === "laser" && (secW.charge ?? 0) > 0) fire[sec] = true
    }

    // laser charging halves speed; if evading without laser shot, don't charge
    if (mode === "evade" && secW?.kind === "laser" && fire[sec] && (secW.charge ?? 0) === 0 && hyp(fightTarget!.pos[0] - pos[0], fightTarget!.pos[1] - pos[1]) > 150) fire[sec] = false

    act.move = [move[0], move[1]]
    const ml = hyp(move[0], move[1])
    if (ml > 1) act.move = [move[0] / ml, move[1] / ml]
    act.boost = me.grounded ? (boost && ml > 0.2) : (boost && this.jetOk)
    act.jump = jump
    act.aim = [wrap(aimYaw), clamp(aimPitch, -0.69, 1.29)]
    act.fire = fire
    if (reload) act.reload = true
    if (takeId != null) { act.take = takeId; if (dropSlot != null && dropSlot >= 0) act.drop = dropSlot }
    this.label = `${mode} ${goalWhy}${urgent ? " URG" : ""}${fightTarget ? " t" + fightTarget.id : ""}`
    this.lastPos = pos
    return act
  }

  isAimingAt(e: Track, pos: V3, tol = 0.15) {
    const a = Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0])
    return Math.abs(wrap(a - e.aim[0])) < tol
  }

  quickCover(pos: V3, e: Track): P2 | null {
    // nearest point within ~12 m that hides us from e (body center and head)
    const ez = e.pos[2] + 8
    let best: P2 | null = null, bd = Infinity
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU
      for (const r of [4, 7, 10, 13]) {
        const x = pos[0] + Math.cos(a) * r, y = pos[1] + Math.sin(a) * r
        if (this.map.blocked[this.map.gIdx(x, y)] & 1) break
        if (!this.map.clearLine(pos[0], pos[1], x, y)) break
        const z = this.map.surfAt(x, y)
        if (!this.map.los(e.pos[0], e.pos[1], ez, x, y, z + 4.5) && !this.map.los(e.pos[0], e.pos[1], ez, x, y, z + 9)) {
          if (r < bd) { bd = r; best = [x, y] }
          break
        }
      }
    }
    return best
  }

  leadAim(pos: V3, muzzleZ: number, tp: V3, tv: V3, zoff: number, speed: number): [number, number] {
    let tx = tp[0], ty = tp[1], tz = tp[2] + zoff
    const vz = Math.abs(tv[2]) > 0.5 ? tv[2] : 0
    for (let k = 0; k < 4; k++) {
      const d = hyp(tx - pos[0], ty - pos[1], tz - muzzleZ)
      const ft = Math.min(1.5, d / speed)
      tx = tp[0] + tv[0] * ft
      ty = tp[1] + tv[1] * ft
      tz = tp[2] + zoff + vz * ft * 0.5
      const g = this.map.surfAt(tx, ty)
      if (tz - zoff < g - 0.5) tz = g + zoff
    }
    return [Math.atan2(ty - pos[1], tx - pos[0]), Math.atan2(tz - muzzleZ, hyp(tx - pos[0], ty - pos[1]))]
  }

  mortarAim(pos: V3, tubeZ: number, tp: V3, tv: V3, v: number, g: number, high: boolean): [number, number] | null {
    let tx = tp[0], ty = tp[1]
    let sol: [number, number] | null = null
    for (let k = 0; k < 3; k++) {
      const d = hyp(tx - pos[0], ty - pos[1])
      const h = tp[2] + 1 - tubeZ
      const disc = v ** 4 - g * (g * d * d + 2 * h * v * v)
      if (disc < 0) return null
      const th = Math.atan2(v * v + (high ? 1 : -1) * Math.sqrt(disc), g * d)
      const ft = d / (v * Math.cos(th))
      sol = [Math.atan2(ty - pos[1], tx - pos[0]), th]
      tx = tp[0] + tv[0] * ft
      ty = tp[1] + tv[1] * ft
    }
    if (sol && (sol[1] > 1.29 || sol[1] < -0.69)) return null
    return sol
  }

  openDir(pos: V3): number {
    let best = 0, bv = -1
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU
      let L = 0
      for (let r = 5; r <= 120; r += 5) {
        if (this.map.solid(pos[0] + Math.cos(a) * r, pos[1] + Math.sin(a) * r, pos[2] + 6)) break
        L = r
      }
      if (L > bv) { bv = L; best = a }
    }
    return best
  }

  exposure(x: number, y: number, z: number): number {
    // fraction of 16 directions with open sight beyond 60 m at mech-eye height
    let open = 0
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU
      let ok = true
      for (let r = 6; r <= 80; r += 6) {
        if (this.map.solid(x + Math.cos(a) * r, y + Math.sin(a) * r, z + 6)) { ok = false; break }
      }
      if (ok) open++
    }
    return open / 16
  }

  pickHome(pos: V3, c: P2, r: number, enemies: Track[]): P2 {
    const m = this.map
    let best: P2 = [c[0], c[1]], bv = Infinity
    const edge = (this.opts.homeMode ?? "edge") === "edge"
    // anchor: for "edge", the point inside the next circle closest to us (with a margin)
    const margin = Math.max(18, r * 0.3)
    const dc = hyp(pos[0] - c[0], pos[1] - c[1])
    const ar = Math.max(0, Math.min(dc, r - margin))
    const anchor: P2 = dc > 1 ? [c[0] + ((pos[0] - c[0]) / dc) * ar, c[1] + ((pos[1] - c[1]) / dc) * ar] : [c[0], c[1]]
    const N = 50
    for (let k = 0; k < N; k++) {
      let x: number, y: number
      if (edge) {
        const a = this.rng.next() * TAU, rr = Math.sqrt(this.rng.next()) * Math.max(15, Math.min(60, r * 0.4))
        x = anchor[0] + Math.cos(a) * rr; y = anchor[1] + Math.sin(a) * rr
        if (k === 0) { x = anchor[0]; y = anchor[1] }
        if (hyp(x - c[0], y - c[1]) > r - Math.min(margin, r * 0.5) * 0.6) continue
      } else {
        const a = this.rng.next() * TAU
        const rr = Math.sqrt(this.rng.next()) * Math.max(5, r * 0.6)
        x = c[0] + Math.cos(a) * rr; y = c[1] + Math.sin(a) * rr
        if (k === 0) { x = c[0]; y = c[1] }
      }
      const g = m.gIdx(x, y)
      if (m.blocked[g] & 1) continue
      const z = m.surfAt(x, y)
      const wd = m.wallDistAt(x, y)
      const exp = this.exposure(x, y, z)
      const dist = hyp(x - pos[0], y - pos[1])
      const centr = hyp(x - c[0], y - c[1]) / Math.max(1, r)
      let v = exp * 120 + dist * (edge ? 0.6 : 0.25) + (edge ? 0 : centr * 60)
      if (wd > 12) v += 20
      for (const e of enemies) {
        const de = hyp(x - e.pos[0], y - e.pos[1])
        if (de < 120) v += (120 - de) * 0.8
      }
      if (v < bv) { bv = v; best = [x, y] }
    }
    this.pathT = -99
    return best
  }

  pickRoof(pos: V3, c: P2, r: number): any {
    const m = this.map
    const R = r - 12
    if (R < 10) return null
    let best: any = null, bv = Infinity
    const step = Math.max(6, Math.min(10, R / 20))
    for (let y = c[1] - R; y <= c[1] + R; y += step)
      for (let x = c[0] - R; x <= c[0] + R; x += step) {
        if (hyp(x - c[0], y - c[1]) > R) continue
        const k = m.idx(x, y)
        const rin = m.roofIn[k]
        if (rin < 7) continue
        const T = m.pTop[k], g = m.ground[k]
        if (T - g < 5 || T - g > 42) continue
        // approach: shortest outward march to open ground that never crosses roof higher than T
        let ap: any = null
        for (let a = 0; a < 16; a++) {
          const ux = Math.cos((a * Math.PI) / 8), uy = Math.sin((a * Math.PI) / 8)
          let ok = true
          for (let d = 1; d < 90; d += 1) {
            const px = x + ux * d, py = y + uy * d
            const k2 = m.idx(px, py)
            if (m.wall[k2] === 1) { if (m.pTop[k2] > T + 0.4) { ok = false; break } continue }
            // first open cell: walk out until nav-free
            let fx = px, fy = py, found = false
            for (let e = 0; e < 8; e++) {
              const g2 = m.gIdx(fx, fy)
              if (!(m.blocked[g2] & 1)) { found = true; break }
              fx += ux; fy += uy
            }
            if (!found || T - m.surfAt(fx, fy) > 45) { ok = false; break }
            if (!ap || d < ap.d) ap = { d, ax: fx, ay: fy }
            break
          }
          if (!ok) continue
        }
        if (!ap) continue
        const dist = hyp(ap.ax - pos[0], ap.ay - pos[1])
        const v = -Math.min(rin, 20) * 4 + dist * 0.2 + ap.d * 1.5 + Math.abs(T - g - 18) * 0.3
        if (v < bv) { bv = v; best = { id: k, x, y, T, ax: ap.ax, ay: ap.ay, rin } }
      }
    return best
  }

  navMove(pos: V3, goal: P2, enemies: Track[]): P2 {
    const t = this.t
    const m = this.map
    const gchanged = !this.pathGoal || hyp(this.pathGoal[0] - goal[0], this.pathGoal[1] - goal[1]) > 4
    if (gchanged || t - this.pathT > 3 || !this.path) {
      if (this.stuckT < 2 && m.clearLine(pos[0], pos[1], goal[0], goal[1]) && hyp(goal[0] - pos[0], goal[1] - pos[1]) < 60) {
        this.path = [goal]
      } else {
        const es = enemies.filter((e) => t - e.seenT < 5).map((e) => e.pos)
        const ns = [...this.npcs.values()].map((n) => n.pos)
        const bad = this.badPts.filter((b) => t - b.t < 90)
        const cost = es.length || ns.length || bad.length
          ? (g: number) => {
              const p = m.gPos(g)
              let c = 0
              for (const b of bad) if (Math.abs(p[0] - b.x) < 5 && Math.abs(p[1] - b.y) < 5) c += 200
              for (const e of es) {
                const d = hyp(p[0] - e[0], p[1] - e[1])
                if (d < 100) c += (100 - d) * 0.05
              }
              for (const e of ns) {
                const d = hyp(p[0] - e[0], p[1] - e[1])
                if (d < 50) c += (50 - d) * 0.06
              }
              return c
            }
          : undefined
        this.path = m.path(pos[0], pos[1], goal[0], goal[1], 8000, cost) ?? [goal]
      }
      this.pathGoal = [goal[0], goal[1]]
      this.pathT = t
      this.pathI = 0
    }
    const path = this.path!
    // advance index to farthest visible waypoint (within lookahead)
    let i = this.pathI
    while (i < path.length - 1 && hyp(path[i][0] - pos[0], path[i][1] - pos[1]) < 3) i++
    for (let k = Math.min(path.length - 1, i + 12); k > i; k--) {
      if (m.clearLine(pos[0], pos[1], path[k][0], path[k][1])) { i = k; break }
    }
    this.pathI = i
    const wp = path[i]
    const dx = wp[0] - pos[0], dy = wp[1] - pos[1]
    const L = hyp(dx, dy) || 1
    return [dx / L, dy / L]
  }

  fightMove(pos: V3, e: Track, secKind: string | undefined, nextC: P2, nextR: number, zNow: { c: P2; r: number }, hpFrac: number): P2 {
    const t = this.t
    const dx = e.pos[0] - pos[0], dy = e.pos[1] - pos[1]
    const d = hyp(dx, dy) || 1
    const ux = dx / d, uy = dy / d
    // preferred range
    let pref = 110
    if (secKind === "lightning") pref = 25
    else if (secKind === "laser") pref = 120
    else if (secKind === "mortar") pref = 90
    if (e.weapons.includes("lightning") && secKind !== "lightning") pref = Math.max(pref, 80)
    if (t > this.jinkT) {
      this.jinkT = t + 0.3 + this.rng.next() * 0.6
      this.jinkDir = this.rng.next() < 0.5 ? -1 : 1
    }
    let radial = clamp((d - pref) / 40, -1, 1)
    const px = -uy * this.jinkDir, py = ux * this.jinkDir
    let mx = px * 0.85 + ux * radial * 0.7
    let my = py * 0.85 + uy * radial * 0.7
    // avoid walls: if lateral blocked, flip
    const ahead = this.map.wallDistAt(pos[0] + mx * 4, pos[1] + my * 4)
    if (ahead < 3) { this.jinkDir *= -1; mx = -px * 0.85 + ux * radial * 0.7; my = -py * 0.85 + uy * radial * 0.7 }
    return [mx, my]
  }

  tacGoal: P2 | null = null
  tacT = -99
  tacticalMove(pos: V3, e: Track, secKind: string | undefined, nextC: P2, nextR: number, zNow: { c: P2; r: number }, hpFrac: number, ready: boolean): P2 {
    // fight from a spot where only the target can see us; hide while reloading / low
    const t = this.t
    const m = this.map
    let pref = 90
    if (secKind === "lightning") pref = 25
    else if (secKind === "laser") pref = 110
    else if (secKind === "mortar") pref = 80
    if (e.weapons.includes("lightning") && secKind !== "lightning") pref = Math.max(pref, 70)
    const wantShoot = ready && (hpFrac > 0.3 || e.hp < 450)
    const ez = e.pos[2] + 7 * (1 + 0.05 * e.cubes)
    if (!this.tacGoal || t - this.tacT > 0.5 || (this.tacWant !== wantShoot)) {
      this.tacT = t
      this.tacWant = wantShoot
      const others = [...this.tracks.values()].filter((o) => o !== e && t - o.seenT < 5 && hyp(o.pos[0] - pos[0], o.pos[1] - pos[1]) < 230)
      let best: P2 = [pos[0], pos[1]], bv = Infinity
      for (let k = 0; k <= 24; k++) {
        let x = pos[0], y = pos[1], r = 0
        if (k > 0) {
          const a = this.rng.next() * TAU
          r = 3 + this.rng.next() * 12
          x += Math.cos(a) * r; y += Math.sin(a) * r
        }
        if (k > 0) {
          if (m.blocked[m.gIdx(x, y)] & 3) continue
          if (!m.clearLine(pos[0], pos[1], x, y)) continue
        }
        if (hyp(x - zNow.c[0], y - zNow.c[1]) > zNow.r - 4) continue
        const z = m.surfAt(x, y) + 4.5
        const tl = m.los(e.pos[0], e.pos[1], ez, x, y, z)
        let nO = 0
        for (const o of others) if (m.los(o.pos[0], o.pos[1], o.pos[2] + 7, x, y, z)) nO++
        const de = hyp(x - e.pos[0], y - e.pos[1])
        let v = r * 0.4 + Math.abs(de - pref) * 0.2 + nO * 70
        if (wantShoot) v += tl ? 0 : 30
        else v += tl ? 35 : 0
        if (m.wallDistAt(x, y) < 6) v -= 5
        if (hyp(x - nextC[0], y - nextC[1]) > nextR) v += 8
        if (this.tacGoal && hyp(x - this.tacGoal[0], y - this.tacGoal[1]) < 3) v -= 6
        if (v < bv) { bv = v; best = [x, y] }
      }
      this.tacGoal = best
    }
    const g = this.tacGoal!
    const dx = e.pos[0] - pos[0], dy = e.pos[1] - pos[1]
    const d = hyp(dx, dy) || 1
    const ux = dx / d, uy = dy / d
    if (t > this.jinkT) {
      this.jinkT = t + 0.3 + this.rng.next() * 0.6
      this.jinkDir = this.rng.next() < 0.5 ? -1 : 1
    }
    const px = -uy * this.jinkDir, py = ux * this.jinkDir
    const gx = g[0] - pos[0], gy = g[1] - pos[1]
    const gd = hyp(gx, gy)
    let mx: number, my: number
    if (gd > 2.5) { mx = gx / gd + px * 0.4; my = gy / gd + py * 0.4 }
    else { mx = px * 0.8 + gx * 0.3; my = py * 0.8 + gy * 0.3 }
    if (m.wallDistAt(pos[0] + mx * 4, pos[1] + my * 4) < 3 && gd <= 2.5) { this.jinkDir *= -1; mx = -px * 0.8 + gx * 0.3; my = -py * 0.8 + gy * 0.3 }
    return [mx, my]
  }
  tacWant = true
  laserFullT = -1

  evadeMove(pos: V3, e: Track, nextC: P2, nextR: number, zNow: { c: P2; r: number }): P2 {
    // find a nearby point that breaks line of sight from the enemy, inside the zone, away from it
    const t = this.t
    if (!this.evadeGoal || t - this.evadeT > 1.5) {
      this.evadeT = t
      let best: P2 | null = null, bv = Infinity, bestHidden = false
      const ez = e.pos[2] + 8
      for (let k = 0; k < 40; k++) {
        const a = this.rng.next() * TAU
        const r = 10 + this.rng.next() * 45
        const x = pos[0] + Math.cos(a) * r, y = pos[1] + Math.sin(a) * r
        const g = this.map.gIdx(x, y)
        if (this.map.blocked[g] & 1) continue
        const z = this.map.surfAt(x, y)
        const hidden = !this.map.los(e.pos[0], e.pos[1], ez, x, y, z + 6) && !this.map.los(e.pos[0], e.pos[1], ez, x, y, z + 9)
        const de = hyp(x - e.pos[0], y - e.pos[1])
        const dz = hyp(x - zNow.c[0], y - zNow.c[1])
        let v = r * 0.6 - de * 0.3 + (hidden ? 0 : 60)
        if (dz > zNow.r - 5) v += 200
        if (hyp(x - nextC[0], y - nextC[1]) > nextR) v += 15
        if (v < bv) { bv = v; best = [x, y]; bestHidden = hidden && r < 35 }
      }
      this.evadeGoal = best
      this.evadeHidden = bestHidden
    }
    if (this.evadeGoal) return this.navMove(pos, this.evadeGoal, [])
    return [-(e.pos[0] - pos[0]) / 100, -(e.pos[1] - pos[1]) / 100]
  }
  jetOk = false
  npcDmgT = -99
  npcDmgBy: number | null = null
  evadeHidden = true
  lastTargetId: number | null = null
  roof: any = null
  roofKey = ""
  climbT = -1
  badRoofs = new Map<number, number>()
  hitBy = new Map<number, number>()
  badPts: { x: number; y: number; t: number }[] = []
  lootId: number | null = null
  evadeGoal: P2 | null = null
  evadeT = -99
}
