// PROBE BUILD: walk to the middle of the next safe circle, stand still, never shoot.
import { run, type Hello } from "./mechfight.ts"
import { GameMap } from "./map.ts"
import { ZoneBot } from "./zonebot.ts"
const MAP_FALLBACK = new URL("./arena", import.meta.url).pathname
run((hello: Hello) => {
  let map: GameMap
  try { map = new GameMap(hello.map.dir) } catch { map = new GameMap(MAP_FALLBACK) }
  const b = new ZoneBot(hello, map)
  return { name: "kurisby-probe", act: (obs) => b.act(obs) }
})
