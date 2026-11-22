import { GameMap } from "../map.ts"
import { Sim, loadConfig, type Factory } from "./sim.ts"
import { Rusher } from "./opponents.ts"
import * as V from "./variants.ts"
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")))
const s = +(args.seed ?? 1)
const map = new GameMap("/home/user/mechbot/arena")
const cfg = loadConfig()
const facs: Factory[] = []
const slot = args.slot != null ? +args.slot : s % 16
let brain: any
for (let i = 0; i < 16; i++) {
  if (i === slot) facs.push((h, m) => { brain = V.make(args.mine ?? "main", h, m); brain.name = "MINE"; return brain })
  else if (i % 2 === 0) facs.push((h, m) => new Rusher(h, m))
  else facs.push((h, m) => { const b: any = V.make("hunter", h, m); b.name = "opp"; return b })
}
const sim = new Sim(map, cfg, s * 1000 + 17, facs)
const me = sim.mechs[slot]
while (sim.t < 480 && sim.mechs.filter((m) => m.alive).length > 1 && me.alive) {
  sim.step()
  if (sim.tick % 20 === 0) {
    const z = sim.zoneNow()
    console.log(`t=${sim.t.toFixed(0)} pos=${me.pos.map((v) => v.toFixed(0))} hp=${me.hp.toFixed(0)} en=${me.energy.toFixed(0)} w=${me.weapons.map((w) => w?.kind)} c=${me.cubes} ${brain.label} zd=${(Math.hypot(me.pos[0]-z.c[0], me.pos[1]-z.c[1]) - z.r).toFixed(0)} home=${brain.home?.map((v:number)=>v.toFixed(0))} alive=${sim.mechs.filter(m=>m.alive).length}`)
  }
}
console.log("dead", !me.alive, (me as any).lastW, sim.t)
