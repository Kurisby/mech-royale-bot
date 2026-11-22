// CALIBRATION BUILD: stands still and never shoots. Used once to measure the score of doing nothing.
import { run } from "./mechfight.ts"
run(() => ({ name: "kurisby-calibrate", act: () => ({}) }))
