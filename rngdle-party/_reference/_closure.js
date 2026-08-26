const fs=require("fs");
const src=fs.readFileSync("421374ec80474347.js","utf8");
function balanced(bo){ let d=0; for(let j=bo;j<src.length;j++){const c=src[j];if(c==="{")d++;else if(c==="}"){d--;if(d===0)return src.slice(bo+1,j);}} return null; }
function extractModule(id){
  // find ",<id>,e=>{"
  let idx=src.indexOf(","+id+",e=>{");
  if(idx<0) idx=src.indexOf("["+id+",e=>{");
  if(idx<0){ const m=new RegExp("[,\\[]"+id+",e=>\\{").exec(src); if(!m) return null; idx=m.index; }
  const bo=src.indexOf("{", idx+(""+id).length);
  return balanced(bo);
}
const closure={}; const queue=[10163];
while(queue.length){
  const id=queue.shift(); if(id in closure) continue;
  const body=extractModule(id);
  if(body==null){ console.error("MISSING",id); continue; }
  closure[id]=body;
  for(const m of body.matchAll(/e\.i\((\d+)\)/g)){ const dep=+m[1]; if(!(dep in closure)) queue.push(dep); }
}
console.log("closure module ids:", Object.keys(closure));
const totalLen=Object.values(closure).reduce((a,b)=>a+b.length,0);
console.log("total body chars:", totalLen);
fs.writeFileSync("_closure.json", JSON.stringify(closure));
