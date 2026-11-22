import { Brain } from "../brain.ts"
import { Brain as BrainV1 } from "./brain_v1.ts"
import { Brain as BrainPro } from "./brain_pro.ts"
import type { GameMap } from "../map.ts"
export function make(kind: string, h: any, m: GameMap): any {
  if (kind === "hunter") return new BrainV1(h, m, { aggression: 0.9 })
  if (kind === "v1") return new BrainV1(h, m, {})
  if (kind === "pro") return new BrainPro(h, m, { aggression: 1.0, hunt: true, lootFar: true, coverCheck: true })
  if (kind === "noduck") return new Brain(h, m, { duck: false })
  if (kind === "center") return new Brain(h, m, { homeMode: "center" })
  if (kind === "edgenofarm") return new Brain(h, m, { farm: false })
  if (kind === "loud") return new Brain(h, m, { stealth: false })
  if (kind === "nocover") return new Brain(h, m, { coverCheck: false })
  if (kind === "noloot") return new Brain(h, m, { lootFar: false })
  if (kind === "base2") return new Brain(h, m, { coverCheck: false, lootFar: false })
  if (kind === "main") return new Brain(h, m, {})
  if (kind === "agg") return new Brain(h, m, { aggression: 0.9 })
  if (kind === "timid") return new Brain(h, m, { aggression: 0.2 })
  if (kind === "nofarm") return new Brain(h, m, { farm: false })
  if (kind.startsWith("agg:")) return new Brain(h, m, { aggression: +kind.slice(4) })
  throw new Error("unknown variant " + kind)
}
