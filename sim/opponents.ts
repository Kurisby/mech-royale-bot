// Opponent bots for the local simulator.
import type { GameMap } from "../map.ts"
const hyp = Math.hypot

// "Rusher": heads for the zone, grabs a weapon, chases and shoots the nearest visible mech with lead.
export class Rusher {
  name = "rusher"
  map: GameMap
  path: any = null; pathT = -9; pi = 0; goal: any = null
  constructor(hello: any, map: GameMap) { this.map = map }
  act(obs: any) {
    const me = obs.self, p = me.pos
    const a: any = { tick: obs.tick }
    if (obs.offer) a.pick = 0
    const enemies = obs.mechs.filter((m: any) => m.kind === "mech").sort((x: any, y: any) => hyp(x.pos[0] - p[0], x.pos[1] - p[1]) - hyp(y.pos[0] - p[0], y.pos[1] - p[1]))
    let goal = obs.zone.next_center
    const pk = obs.pickups.filter((q: any) => !me.weapons.some((w: any) => w && w.kind === q.kind)).sort((x: any, y: any) => hyp(x.pos[0] - p[0], x.pos[1] - p[1]) - hyp(y.pos[0] - p[0], y.pos[1] - p[1]))[0]
    if (pk && me.weapons[1] == null && hyp(pk.pos[0] - p[0], pk.pos[1] - p[1]) < 80) { goal = pk.pos; if (hyp(pk.pos[0] - p[0], pk.pos[1] - p[1]) < 3.5) a.take = pk.id }
    const e = enemies[0]
    if (e && hyp(e.pos[0] - p[0], e.pos[1] - p[1]) > 40) goal = e.pos
    // nav
    if (!this.goal || hyp(this.goal[0] - goal[0], this.goal[1] - goal[1]) > 10 || obs.t - this.pathT > 3) {
      this.path = this.map.path(p[0], p[1], goal[0], goal[1], 20000) ?? [goal]; this.pathT = obs.t; this.pi = 0; this.goal = goal
    }
    while (this.pi < this.path.length - 1 && hyp(this.path[this.pi][0] - p[0], this.path[this.pi][1] - p[1]) < 4) this.pi++
    for (let k = Math.min(this.path.length - 1, this.pi + 8); k > this.pi; k--) if (this.map.clearLine(p[0], p[1], this.path[k][0], this.path[k][1])) { this.pi = k; break }
    const wp = this.path[this.pi]
    const dx = wp[0] - p[0], dy = wp[1] - p[1], L = hyp(dx, dy) || 1
    a.move = L > 2 ? [dx / L, dy / L] : [0, 0]
    a.boost = !me.in_zone
    a.aim = [Math.atan2(dy, dx), 0]
    a.fire = [false, false]
    if (e) {
      const mz = p[2] + 7
      const d = hyp(e.pos[0] - p[0], e.pos[1] - p[1], e.pos[2] + 4.5 - mz)
      const ft = d / 252
      const tx = e.pos[0] + e.vel[0] * ft, ty = e.pos[1] + e.vel[1] * ft, tz = e.pos[2] + 4.5
      a.aim = [Math.atan2(ty - p[1], tx - p[0]), Math.atan2(tz - mz, hyp(tx - p[0], ty - p[1]))]
      const sec = me.weapons[1]
      let f1 = false
      if (sec) {
        if (sec.kind === "lightning") f1 = d < 43
        else if (sec.kind === "laser") f1 = (sec.charge ?? 0) < 0.75 && d < 270
        else if (sec.kind === "mortar") { const th = 0.5 * Math.asin(Math.min(1, d * 22 / 72 / 72)); a.aim[1] = th; f1 = d > 20 && d < 230 }
      }
      a.fire = [d < 225 && !(sec?.kind === "mortar"), f1]
      if (sec?.kind === "mortar" && d < 20) a.fire = [true, false]
      if (Math.random() < 0.3) a.move = [a.move[0] * 0.5 - dy / L * 0.8, a.move[1] * 0.5 + dx / L * 0.8]
    }
    return a
  }
}
