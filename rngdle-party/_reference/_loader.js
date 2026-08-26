const fs=require("fs");
const src=fs.readFileSync("421374ec80474347.js","utf8");

// Extract module body by id: pattern ,<ID>,e=>{ ... balanced ... }
function extractModule(id){
  const marker=","+id+",e=>{";
  let idx=src.indexOf(marker);
  if(idx<0){ // maybe at start or different spacing
    const re=new RegExp("[,\\[]"+id+",e=>\\{");
    const m=re.exec(src); if(!m) return null; idx=m.index+ (m[0].length - (id.length+ ",e=>{".length) ) -0;
    idx=src.indexOf(id+",e=>{", m.index); idx=src.indexOf("{", idx);
    return balanced(idx);
  }
  const bo=src.indexOf("{", idx);
  return balanced(bo);
}
function balanced(bo){
  let d=0; for(let j=bo;j<src.length;j++){const c=src[j];if(c==="{")d++;else if(c==="}"){d--;if(d===0)return src.slice(bo+1,j);}}
  return null;
}

const registry={}; // id -> module exports (lazy)
const bodies={};
function getBody(id){ if(!(id in bodies)) bodies[id]=extractModule(id); return bodies[id]; }
function requireMod(id){
  if(registry[id]) return registry[id].exports;
  const body=getBody(id);
  if(body==null) throw new Error("no body for module "+id);
  const exportsObj={};
  const e={
    s(a){ let k=0; while(k<a.length){ const name=a[k], nxt=a[k+1];
        if(typeof nxt==="function"){ Object.defineProperty(exportsObj,name,{get:nxt,enumerable:true,configurable:true}); k+=2; }
        else if(typeof nxt==="number"){ exportsObj[name]=a[k+2]; k+=3; }
        else { exportsObj[name]=nxt; k+=2; } } },
    i(depId){ return requireMod(depId); }
  };
  registry[id]={exports:exportsObj};
  new Function("e",body)(e);
  return exportsObj;
}

// Load scoring module 10163
const scoring=requireMod(10163);
console.log("scoring exports:", Object.keys(scoring));
const defs=requireMod(67711);
console.log("badge-defs exports:", Object.keys(defs), "count", defs.BADGE_DEFINITIONS?.length);
const scored=requireMod(10584);
console.log("scored exports:", Object.keys(scored), "SCORED_BADGES", scored.SCORED_BADGES?.length, "PCTkeys", scored.SCORE_PERCENTILES?Object.keys(scored.SCORE_PERCENTILES).length:0);

// Test composeRollResult on 644959 (should reproduce the observed roll)
const r=scoring.composeRollResult(644959);
console.log("\ncomposeRollResult(644959): totalScore=",r.totalScore,"badges=",r.badges.length);
console.log("percentile(3335 vs actual):", scoring.getPercentileForScore(r.totalScore));
console.log("top badges:", r.badges.slice(0,6).map(b=>b.id+":"+(b.score??"?")));
module.exports={scoring,defs,scored,requireMod};
