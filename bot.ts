import { run, draw, type Hello } from "./mechfight.ts"
import { GameMap } from "./map.ts"
import { Brain } from "./brain.ts"

const MAP_FALLBACK = new URL("./arena", import.meta.url).pathname

run((hello: Hello) => {
  let map: GameMap
  try {
    map = new GameMap(hello.map.dir)
  } catch (e) {
    process.stderr.write(`map load from ${hello.map.dir} failed (${e}); using bundled copy\n`)
    map = new GameMap(MAP_FALLBACK)
  }
  const brain = new Brain(hello, map, { name: "survivor" })
  return {
    name: "kurisby-survivor",
    act(obs) {
      const a = brain.act(obs)
      if (brain.label) draw.label(brain.label)
      return a
    },
  }
})
