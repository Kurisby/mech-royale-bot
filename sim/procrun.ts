// Run the real bot process (stdio) inside the simulator for one match, to catch protocol/runtime errors.
import { GameMap } from "../map.ts"
import { Sim, loadConfig } from "./sim.ts"
import * as V from "./variants.ts"
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")))
const map = new GameMap("/home/user/mechbot/arena"); const cfg = loadConfig()
const seed = +(args.seed ?? 1), slot = +(args.slot ?? 0)
const proc = Bun.spawn(["bun", args.bot ?? "/home/user/mechbot/bot.ts"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
let last: any = {}, waiting: ((v: any) => void) | null = null, buf = ""
;(async () => {
  const dec = new TextDecoder()
  for await (const chunk of proc.stdout as any) {
    buf += dec.decode(chunk)
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      const msg = JSON.parse(line)
      if (msg.type === "ready") { console.error("ready", msg.name) }
      else last = msg
      if (waiting) { const w = waiting; waiting = null; w(msg) }
    }
  }
})()
const send = (o: any) => { proc.stdin.write(JSON.stringify(o) + "\n"); proc.stdin.flush() }
const wait = () => new Promise((res) => { waiting = res; setTimeout(() => { if (waiting === res) { waiting = null; res(null) } }, 300) })
let helloSent: any = null
const ctrl = { name: "MINE", act(obs: any) { send(obs); const a = { ...last }; delete a.tick; return a } }
const facs = Array.from({ length: 16 }, (_, i) => i === slot ? (h: any) => { helloSent = { ...h, map: { dir: "/home/user/mechbot/arena", files: [] } }; return ctrl } : (h: any, m: any) => V.make("pro", h, m))
const sim = new Sim(map, cfg, seed * 1000 + 17, facs)
send(helloSent); await wait()
const me = sim.mechs[slot]
let timeouts = 0, n = 0
while (sim.t < 480 && me.alive && sim.mechs.filter((m) => m.alive).length > 1) {
  const decide = sim.tick % 2 === 0
  sim.step()
  if (decide) { n++; const r = await wait(); if (!r) timeouts++ }
  if (sim.tick % 400 === 0) console.error(`t=${sim.t.toFixed(0)} hp=${me.hp.toFixed(0)} pos=${me.pos.map(v=>v.toFixed(0))} w=${me.weapons.map(w=>w?.kind)} label=${last.debug?.label}`)
}
send({ type: "end", place: 1, kills: 0 })
console.error("done t", sim.t.toFixed(1), "alive", me.alive, "cause", (me as any).lastW, "decisions", n, "timeouts", timeouts)
process.exit(0)
