import { Brain } from "../brain.ts"
import { Brain as BrainV1 } from "./brain_v1.ts"
import type { GameMap } from "../map.ts"
export function make(kind: string, h: any, m: GameMap): any {
  if (kind === "hunter") return new BrainV1(h, m, { aggression: 0.9 })
  if (kind === "v1") return new BrainV1(h, m, {})
  if (kind === "main") return new Brain(h, m, {})
  if (kind === "agg") return new Brain(h, m, { aggression: 0.9 })
  if (kind === "timid") return new Brain(h, m, { aggression: 0.2 })
  if (kind === "nofarm") return new Brain(h, m, { farm: false })
  if (kind.startsWith("agg:")) return new Brain(h, m, { aggression: +kind.slice(4) })
  throw new Error("unknown variant " + kind)
}
