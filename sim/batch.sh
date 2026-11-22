#!/bin/bash
# usage: batch.sh N_PER_WORKER extra-args...
N=$1; shift
for w in 0 1 2 3; do
  bun sim/run.ts n=$N seed=$((w*1000+1)) "$@" > /tmp/claude-0/b$w.json 2>/tmp/claude-0/b$w.log &
done
wait
cat /tmp/claude-0/b?.json | bun -e '
const lines=require("fs").readFileSync(0,"utf8").trim().split("\n");const all=lines.flatMap(l=>JSON.parse(l));
const g={};for(const r of all){(g[r.name]??=[]).push(r)}
for(const [k,v] of Object.entries(g)){const pts=v.map(r=>16-r.place);const m=pts.reduce((a,b)=>a+b,0)/v.length;const sd=Math.sqrt(pts.reduce((a,b)=>a+(b-m)**2,0)/v.length)/Math.sqrt(v.length);
console.log(k.padEnd(8),"n",v.length,"pts",m.toFixed(2),"±",sd.toFixed(2),"deathT",(v.reduce((a,r)=>a+r.deathT,0)/v.length).toFixed(0),"kills",(v.reduce((a,r)=>a+r.kills,0)/v.length).toFixed(2),"cubes",(v.reduce((a,r)=>a+r.cubes,0)/v.length).toFixed(1));const c={};for(const r of v)c[r.cause]=(c[r.cause]??0)+1;console.log("   causes",JSON.stringify(c))}'
