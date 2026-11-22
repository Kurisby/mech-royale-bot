// Probe bot: walk to the next safe circle, stand still near its middle, never shoot, never loot.
import { GameMap, type P2 } from "./map.ts"
export class ZoneBot {
  map: GameMap
  path: P2[] | null = null
  pathT = -99
  goal: P2 | null = null
  pi = 0
  constructor(hello: any, map: GameMap) { this.map = map }
  act(obs: any) {
    const me = obs.self, p = me.pos, t = obs.t
    const z = obs.zone
    const a: any = { tick: obs.tick, fire: [false, false] }
    if (obs.offer) a.pick = 0
    const c: P2 = [z.next_center[0], z.next_center[1]]
    const goal = c
    const d = Math.hypot(goal[0] - p[0], goal[1] - p[1])
    const settle = Math.max(4, z.next_radius * 0.25)
    if (d > settle) {
      if (!this.goal || Math.hypot(this.goal[0] - goal[0], this.goal[1] - goal[1]) > 3 || t - this.pathT > 4) {
        this.path = this.map.path(p[0], p[1], goal[0], goal[1], 12000) ?? [goal]
        this.goal = goal; this.pathT = t; this.pi = 0
      }
      const path = this.path!
      while (this.pi < path.length - 1 && Math.hypot(path[this.pi][0] - p[0], path[this.pi][1] - p[1]) < 3) this.pi++
      for (let k = Math.min(path.length - 1, this.pi + 10); k > this.pi; k--) if (this.map.clearLine(p[0], p[1], path[k][0], path[k][1])) { this.pi = k; break }
      const wp = path[this.pi]
      const dx = wp[0] - p[0], dy = wp[1] - p[1], L = Math.hypot(dx, dy) || 1
      a.move = [dx / L, dy / L]
      a.boost = !me.in_zone && me.energy > 5
      a.aim = [Math.atan2(dy, dx), 0]
    } else {
      a.move = [0, 0]
      a.aim = [me.aim[0] + 0.25, 0]
    }
    return a
  }
}
