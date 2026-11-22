# mech-royale-bot

Bot for the Builders Buildathon "Mech Royale" track (protocol `mechfight/1`), written in TypeScript and run with Bun.

- `bot.ts`: entrypoint (stdin/stdout loop via the kit wrapper `mechfight.ts`)
- `map.ts`: map model built from `/arena` (walkable grid, walls, line of sight, A* pathfinding)
- `brain.ts`: decision making (zone and cover, looting, cube farming, fight or evade, leading aim)
- `arena/`: bundled copy of the map, used only if `/arena` can't be read
- `sim/`: a rough local simulator used for testing (not part of the image)

Submit this repository's URL on the Mech Royale track page. The Dockerfile is at the top level.
