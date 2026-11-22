// Static map model: terrain, prisms, walkable surface, walls, line of sight, A* pathfinding.
import { readFileSync } from "node:fs"

export type P2 = [number, number]

export class GameMap {
  minX: number
  minY: number
  nx: number
  ny: number
  ground: Float32Array // terrain height at 1 m vertices
  pBase: Float32Array // lowest prism base covering the cell (Infinity if none)
  pTop: Float32Array // highest prism top covering the cell (-Infinity if none)
  surf: Float32Array // ground-level walking surface
  wall: Uint8Array // 1 = vertical obstacle for a ground-level mech
  wallDist: Float32Array // distance (m) to nearest hard wall cell
  cliffDist: Float32Array
  roofIn: Float32Array
  // nav grid (2 m)
  G = 2
  gnx: number
  gny: number
  blocked: Uint8Array
  gsurf: Float32Array
  treeDense: Uint8Array // 1 where a tree crown is (vision only)

  constructor(dir: string) {
    const world = JSON.parse(readFileSync(dir + "/v2/world.json", "utf8"))
    const t = world.terrain
    this.minX = t.minX
    this.minY = t.minY
    this.nx = t.nx
    this.ny = t.ny
    const n = this.nx * this.ny
    const buf = readFileSync(dir + "/v2/terrain.i16")
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, n)
    this.ground = new Float32Array(n)
    for (let k = 0; k < n; k++) this.ground[k] = i16[k] * (t.scale ?? 0.01)
    this.pBase = new Float32Array(n).fill(Infinity)
    this.pTop = new Float32Array(n).fill(-Infinity)
    this.surf = new Float32Array(this.ground)
    this.wall = new Uint8Array(n)
    const deck = new Float32Array(n).fill(-Infinity)
    for (const p of world.prisms) {
      const ring: number[] = p.ring
      const holes: number[][] = p.holes ?? []
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (let k = 0; k < ring.length; k += 2) {
        x0 = Math.min(x0, ring[k]); x1 = Math.max(x1, ring[k])
        y0 = Math.min(y0, ring[k + 1]); y1 = Math.max(y1, ring[k + 1])
      }
      const i0 = Math.max(0, Math.floor(x0 - this.minX)), i1 = Math.min(this.nx - 1, Math.ceil(x1 - this.minX))
      const j0 = Math.max(0, Math.floor(y0 - this.minY)), j1 = Math.min(this.ny - 1, Math.ceil(y1 - this.minY))
      for (let j = j0; j <= j1; j++) {
        const y = this.minY + j
        for (let i = i0; i <= i1; i++) {
          const x = this.minX + i
          if (!pip(ring, x, y)) continue
          let inHole = false
          for (const h of holes) if (h.length >= 6 && pip(h, x, y)) { inHole = true; break }
          if (inHole) continue
          const k = j * this.nx + i
          if (p.base < this.pBase[k]) this.pBase[k] = p.base
          if (p.top > this.pTop[k]) this.pTop[k] = p.top
          const g = this.ground[k]
          if (p.top <= g + 1.2) { this.surf[k] = Math.max(this.surf[k], p.top); continue }
          if (p.base >= g + 9.2) continue // overhead, walk under
          if (p.kind === "bridge" && p.top - p.base < 4) { deck[k] = Math.max(deck[k], p.top); continue }
          this.wall[k] = 1
        }
      }
    }
    for (let k = 0; k < n; k++) if (deck[k] > -Infinity && !this.wall[k]) this.surf[k] = Math.max(this.surf[k], deck[k])
    // cliffs: steeper than walkable over 1 m or 2 m -> treat as wall (both sides)
    {
      const nx = this.nx
      const cliff = new Uint8Array(n)
      for (let j = 2; j < this.ny - 2; j++)
        for (let i = 2; i < this.nx - 2; i++) {
          const k = j * nx + i
          const s0 = this.surf[k]
          for (const [di, dj, lim] of [[1, 0, 1.25], [0, 1, 1.25], [1, 1, 1.7], [1, -1, 1.7], [2, 0, 2.3], [0, 2, 2.3]] as const) {
            const k2 = (j + dj) * nx + (i + di)
            const dz = this.surf[k2] - s0
            if (dz > lim) cliff[k] = 1
            else if (-dz > lim) cliff[k2] = 1
          }
        }
      for (let k = 0; k < n; k++) if (cliff[k] && !this.wall[k]) this.wall[k] = 2
    }
    // map edge walls
    for (let i = 0; i < this.nx; i++) { this.wall[i] = 1; this.wall[(this.ny - 1) * this.nx + i] = 1 }
    for (let j = 0; j < this.ny; j++) { this.wall[j * this.nx] = 1; this.wall[j * this.nx + this.nx - 1] = 1 }
    const nx = this.nx, ny = this.ny
    const dt = (pred: (k: number) => boolean) => {
      const d = new Float32Array(n)
      const D = Math.SQRT2
      for (let k = 0; k < n; k++) d[k] = pred(k) ? 0 : 1e9
      for (let j = 1; j < ny; j++)
        for (let i = 1; i < nx - 1; i++) {
          const k = j * nx + i
          d[k] = Math.min(d[k], d[k - 1] + 1, d[k - nx] + 1, d[k - nx - 1] + D, d[k - nx + 1] + D)
        }
      for (let j = ny - 2; j >= 0; j--)
        for (let i = nx - 2; i >= 1; i--) {
          const k = j * nx + i
          d[k] = Math.min(d[k], d[k + 1] + 1, d[k + nx] + 1, d[k + nx + 1] + D, d[k + nx - 1] + D)
        }
      return d
    }
    const d = dt((k) => this.wall[k] === 1)
    const dc = dt((k) => this.wall[k] === 2)
    this.wallDist = d
    // flat-roof interior distance: distance to the nearest edge of a building roof section
    this.roofIn = dt((k) => {
      if (this.wall[k] !== 1 || !(this.pTop[k] - this.ground[k] >= 4) || this.pBase[k] > this.ground[k] + 1.5) return true
      const T = this.pTop[k]
      const i = k % nx, j = (k / nx) | 0
      if (i < 1 || j < 1 || i >= nx - 1 || j >= ny - 1) return true
      for (const k2 of [k - 1, k + 1, k - nx, k + nx]) if (this.wall[k2] !== 1 || Math.abs(this.pTop[k2] - T) > 1.0) return true
      return false
    })
    this.cliffDist = dc
    // nav grid: bit 1 = hard wall nearby, bit 2 = cliff nearby (passable downhill)
    this.gnx = Math.floor(nx / this.G)
    this.gny = Math.floor(ny / this.G)
    const gn = this.gnx * this.gny
    this.blocked = new Uint8Array(gn)
    this.gsurf = new Float32Array(gn)
    for (let gj = 0; gj < this.gny; gj++)
      for (let gi = 0; gi < this.gnx; gi++) {
        const k = gj * this.G * nx + gi * this.G
        this.gsurf[gj * this.gnx + gi] = this.surf[k]
        this.blocked[gj * this.gnx + gi] = (d[k] < 3.0 ? 1 : 0) | (dc[k] < 2.0 ? 2 : 0)
      }
    // trees (dense crowns) for vision heuristics
    this.treeDense = new Uint8Array(n)
    const tf: string[] = world.trees.fields
    const td: number[] = world.trees.data
    const F = tf.length
    const ix = tf.indexOf("crownX") >= 0 ? tf.indexOf("crownX") : tf.indexOf("x")
    const iy = tf.indexOf("crownY") >= 0 ? tf.indexOf("crownY") : tf.indexOf("y")
    const ir = tf.indexOf("crownR")
    for (let q = 0; q + F <= td.length; q += F) {
      const cx = td[q + ix], cy = td[q + iy], r = td[q + ir] * 0.8
      for (let y = Math.floor(cy - r); y <= cy + r; y++)
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue
          const i = x - this.minX, j = y - this.minY
          if (i >= 0 && j >= 0 && i < nx && j < ny) this.treeDense[(j | 0) * nx + (i | 0)] = 1
        }
    }
  }

  idx(x: number, y: number) {
    let i = Math.round(x - this.minX), j = Math.round(y - this.minY)
    if (i < 0) i = 0; else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0; else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }
  groundAt(x: number, y: number) { return this.ground[this.idx(x, y)] }
  surfAt(x: number, y: number) { return this.surf[this.idx(x, y)] }
  wallDistAt(x: number, y: number) { return this.wallDist[this.idx(x, y)] }

  /** true if point (x,y,z) is inside solid geometry */
  solid(x: number, y: number, z: number) {
    const k = this.idx(x, y)
    if (z < this.ground[k] - 0.2) return true
    return z >= this.pBase[k] && z <= this.pTop[k]
  }

  /** line of sight between two 3D points (buildings + terrain; trees ignored unless vision=true) */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 1.5) {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.hypot(dx, dy)
    const n = Math.max(1, Math.ceil(L / step))
    for (let s = 1; s < n; s++) {
      const f = s / n
      if (this.solid(ax + dx * f, ay + dy * f, az + dz * f)) return false
    }
    return true
  }

  // ---- nav grid helpers
  gIdx(x: number, y: number) {
    let gi = Math.round((x - this.minX) / this.G), gj = Math.round((y - this.minY) / this.G)
    if (gi < 0) gi = 0; else if (gi >= this.gnx) gi = this.gnx - 1
    if (gj < 0) gj = 0; else if (gj >= this.gny) gj = this.gny - 1
    return gj * this.gnx + gi
  }
  gPos(g: number): P2 {
    return [this.minX + (g % this.gnx) * this.G, this.minY + Math.floor(g / this.gnx) * this.G]
  }
  /** nearest unblocked nav cell to (x,y) within radius r cells */
  nearestFree(x: number, y: number, r = 12): number {
    const g0 = this.gIdx(x, y)
    if (!(this.blocked[g0] & 1)) return g0
    const gi0 = g0 % this.gnx, gj0 = Math.floor(g0 / this.gnx)
    let best = -1, bd = Infinity
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const gi = gi0 + di, gj = gj0 + dj
        if (gi < 0 || gj < 0 || gi >= this.gnx || gj >= this.gny) continue
        const g = gj * this.gnx + gi
        if (this.blocked[g] & 1) continue
        const dd = di * di + dj * dj
        if (dd < bd) { bd = dd; best = g }
      }
    return best
  }

  private gScore?: Float32Array
  private came?: Int32Array
  private stamp?: Uint32Array
  private closed?: Uint32Array
  private curStamp = 0

  /** A* from (sx,sy) to goal (gx,gy). Returns list of world waypoints or null. extraCost(g) adds per-cell cost. */
  path(sx: number, sy: number, gx: number, gy: number, maxNodes = 60000, extraCost?: (g: number) => number): P2[] | null {
    const gn = this.gnx * this.gny
    if (!this.gScore) {
      this.gScore = new Float32Array(gn)
      this.came = new Int32Array(gn)
      this.stamp = new Uint32Array(gn)
      this.closed = new Uint32Array(gn)
    }
    const gS = this.gScore!, came = this.came!, stamp = this.stamp!, closed = this.closed!
    const st = ++this.curStamp
    const s = this.nearestFree(sx, sy, 6)
    const goal = this.nearestFree(gx, gy, 15)
    if (s < 0 || goal < 0) return null
    const W = this.gnx
    const gi1 = goal % W, gj1 = Math.floor(goal / W)
    const h = (g: number) => {
      const dx = Math.abs((g % W) - gi1), dy = Math.abs(Math.floor(g / W) - gj1)
      return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * this.G
    }
    const heap = new MinHeap()
    gS[s] = 0; stamp[s] = st; came[s] = -1
    heap.push(s, h(s))
    let found = false, nodes = 0, bestG = s, bestH = h(s)
    const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    while (heap.size) {
      const c = heap.pop()
      if (closed[c] === st) continue
      closed[c] = st
      if (c === goal) { found = true; break }
      const hc = h(c)
      if (hc < bestH) { bestH = hc; bestG = c }
      if (++nodes > maxNodes) break
      const ci = c % W, cj = Math.floor(c / W)
      const cs = this.gsurf[c]
      for (let d = 0; d < 8; d++) {
        const ni = ci + DI[d], nj = cj + DJ[d]
        if (ni < 0 || nj < 0 || ni >= W || nj >= this.gny) continue
        const nb = nj * W + ni
        const bn = this.blocked[nb]
        if ((bn & 1) || closed[nb] === st) continue
        if ((bn & 2) && this.gsurf[nb] > cs + 0.3) continue
        if (d >= 4 && ((this.blocked[cj * W + ni] & 1) || (this.blocked[nj * W + ci] & 1))) continue
        if (this.gsurf[nb] - cs > 1.6) continue
        let cost = (d < 4 ? 1 : Math.SQRT2) * this.G
        if (extraCost) cost += extraCost(nb)
        const ng = gS[c] + cost
        if (stamp[nb] !== st || ng < gS[nb]) {
          stamp[nb] = st; gS[nb] = ng; came[nb] = c
          heap.push(nb, ng + h(nb))
        }
      }
    }
    const end = found ? goal : bestG
    const out: P2[] = []
    for (let c = end; c >= 0; c = came[c]) { out.push(this.gPos(c)); if (c === s) break }
    out.reverse()
    return out
  }

  /** straight walkable segment check on the nav grid */
  clearLine(ax: number, ay: number, bx: number, by: number) {
    const L = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(L / 1.0))
    let prev = this.surfAt(ax, ay)
    for (let s = 1; s <= n; s++) {
      const f = s / n
      const x = ax + (bx - ax) * f, y = ay + (by - ay) * f
      if (this.wallDistAt(x, y) < 2.8) return false
      const sv = this.surfAt(x, y)
      if (sv - prev > 1.2) return false
      prev = sv
    }
    return true
  }
}

function pip(ring: number[], x: number, y: number) {
  let inside = false
  const n = ring.length
  for (let a = 0, b = n - 2; a < n; b = a, a += 2) {
    const xa = ring[a], ya = ring[a + 1], xb = ring[b], yb = ring[b + 1]
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside
  }
  return inside
}

export class MinHeap {
  ids: number[] = []
  ks: number[] = []
  get size() { return this.ids.length }
  push(id: number, k: number) {
    const ids = this.ids, ks = this.ks
    let i = ids.length
    ids.push(id); ks.push(k)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (ks[p] <= k) break
      ids[i] = ids[p]; ks[i] = ks[p]; i = p
    }
    ids[i] = id; ks[i] = k
  }
  pop(): number {
    const ids = this.ids, ks = this.ks
    const top = ids[0]
    const lid = ids.pop()!, lk = ks.pop()!
    const n = ids.length
    if (n > 0) {
      let i = 0
      while (true) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && ks[c + 1] < ks[c]) c++
        if (ks[c] >= lk) break
        ids[i] = ids[c]; ks[i] = ks[c]; i = c
      }
      ids[i] = lid; ks[i] = lk
    }
    return top
  }
}
