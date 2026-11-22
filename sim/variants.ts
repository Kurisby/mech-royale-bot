import { Brain } from "../brain.ts"
import type { GameMap } from "../map.ts"
export function make(kind: string, h: any, m: GameMap): any {
  if (kind === "hunter") return new Brain(h, m, { aggression: 0.9 })
  if (kind === "main") return new Brain(h, m, {})
  if (kind === "nofarm") return new Brain(h, m, { farm: false })
  throw new Error("unknown variant " + kind)
}
