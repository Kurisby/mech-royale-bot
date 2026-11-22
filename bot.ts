import { run, draw, type Hello } from "./mechfight.ts"
import { GameMap } from "./map.ts"
import { Brain } from "./brain.ts"

// which play style this build uses (see brain.ts BrainOpts)
const PROFILES: Record<string, any> = {
  survivor: {},
  fighter: { stealth: false, style: "x", roof: false, aggression: 1.0, chase: true },
  squad: { style: "squad", roof: false, farmHard: true, huntGap: 80 },
  prowler: { style: "squad", roof: false, farmHard: true, huntGap: 80, rearBonus: 250, stillPassive: true, prowl: true },
  dodger: { style: "squad", roof: false, farmHard: true, huntGap: 80, rearBonus: 250, stillPassive: true, prowl: true, evadeHp: 0.6, precharge: true, fightBoost: true },
}
const PROFILE = "dodger"
const MAP_FALLBACK = new URL("./arena", import.meta.url).pathname

run((hello: Hello) => {
  let map: GameMap
  try {
    map = new GameMap(hello.map.dir)
  } catch (e) {
    process.stderr.write(`map load from ${hello.map.dir} failed (${e}); using bundled copy\n`)
    map = new GameMap(MAP_FALLBACK)
  }
  // warm up the JIT so the first real decisions stay fast
  try {
    for (let k = 0; k < 6; k++) map.path(-300 + k * 100, -200, 300 - k * 80, 250, 25000)
    for (let k = 0; k < 2000; k++) map.los(-100, -100, 5, 100 + k * 0.01, 120, 6)
  } catch {}
  const brain = new Brain(hello, map, { name: PROFILE, ...PROFILES[PROFILE] })
  return {
    name: "kurisby-" + PROFILE,
    act(obs) {
      const a = brain.act(obs)
      if (brain.label) draw.label(brain.label)
      return a
    },
  }
})
