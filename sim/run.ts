import { GameMap } from "../map.ts"
import { Brain } from "../brain.ts"
import { Sim, loadConfig, type Factory } from "./sim.ts"
import { Rusher, House } from "./opponents.ts"
import * as V from "./variants.ts"

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")))
const n = +(args.n ?? 4), seed0 = +(args.seed ?? 1)
const mine = args.mine ?? "main"
const field = args.field ?? "mixed"
const map = new GameMap("/home/user/mechbot/arena")
const cfg = loadConfig()
const res: any[] = []
for (let s = seed0; s < seed0 + n; s++) {
  const facs: Factory[] = []
  const mySlots = new Set<number>()
  // 2 copies of our bot per match at random-ish slots for more samples
  mySlots.add(s % 16); if (field !== "house" && field !== "ffa") mySlots.add((s * 7 + 3) % 16)
  for (let i = 0; i < 16; i++) {
    if (mySlots.has(i)) facs.push((h, m) => { const b: any = V.make(mine, h, m); b.name = "MINE"; return b })
    else if (field === "house" || field === "ffa") { const tierOf = (k: number) => (k < 4 ? 0 : k < 8 ? 1 : k < 12 ? 2 : 3); const k = [...Array(i).keys()].filter((q) => !mySlots.has(q)).length; facs.push((h, m) => new House(V.make(args.hb ?? "pro", h, m), tierOf(k))) }
    else if (field === "rusher" || (field === "mixed" && i % 2 === 0) || (field === "promix" && i % 3 === 0)) facs.push((h, m) => new Rusher(h, m))
    else facs.push((h, m) => { const b: any = V.make(args.opp ?? (field === "pro" || field === "promix" ? "pro" : field === "hunter" ? "hunter" : field), h, m); b.name = "opp"; return b })
  }
  const t0 = performance.now()
  Sim.armHouse = args.arm === "1"
  const sim = new Sim(map, cfg, s * 1000 + 17, facs)
  if (field === "house") { sim.house = true; if (args.every) sim.houseEvery = +args.every; if (args.late) sim.houseLate = +args.late; if (args.ret) sim.retaliateS = +args.ret; if (args.kdiv) sim.kdiv = +args.kdiv; if (args.omni) sim.omniHouse = args.omni === "1"; if (args.canopy) sim.canopy = args.canopy === "1" }
  if (args.hpx) for (const m of sim.mechs) if (m.ctrl.name === "MINE") { (m as any).stats.hp *= +args.hpx; m.hp *= +args.hpx }
  if (args.dmgx) for (const m of sim.mechs) if (m.ctrl.name === "MINE") (m as any).stats.armor = 1 - 1 / +args.dmgx
  const r = sim.run()
  const ms = performance.now() - t0
  for (const x of r) res.push({ seed: s, ...x })
  const mineR = r.filter((x) => x.name === "MINE")
  console.error(`seed ${s} ${ms.toFixed(0)}ms t=${sim.t.toFixed(0)} mine places ${mineR.map((x) => x.place + "(" + x.cause + "," + x.deathT.toFixed(0) + "s,k" + x.kills + ",c" + x.cubes + ")").join(" ")}`)
}
console.error("timing max", Sim.maxMs.toFixed(1), "slow", Sim.slow, "of", Sim.calls)
console.log(JSON.stringify(res))
