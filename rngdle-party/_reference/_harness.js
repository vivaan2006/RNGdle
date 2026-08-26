const fs=require("fs");
const helperBody=fs.readFileSync("_helper_body.js","utf8");
const helpers={};
const hE={ s(a){for(let k=0;k<a.length;k+=2)Object.defineProperty(helpers,a[k],{get:a[k+1],enumerable:true,configurable:true});} };
new Function("e",helperBody)(hE);
const helpersObj={}; for(const k of Object.keys(helpers)) helpersObj[k]=helpers[k];
const badgeUtils={ createBadgeId:(x)=>x, Family:new Proxy({},{get:(_,p)=>String(p)}) };

function makeE(exportsObj){
  return {
    s(a){
      let k=0;
      while(k<a.length){
        const name=a[k];
        const nxt=a[k+1];
        if(typeof nxt==="function"){ Object.defineProperty(exportsObj,name,{get:nxt,enumerable:true,configurable:true}); k+=2; }
        else if(typeof nxt==="number"){ exportsObj[name]=a[k+2]; k+=3; }
        else { exportsObj[name]=nxt; k+=2; }
      }
    },
    i(id){ if(id===47558) return helpersObj; if(id===82713) return badgeUtils; throw new Error("unknown import "+id); }
  };
}
const exportsObj={};
new Function("e",fs.readFileSync("_badge_body.js","utf8"))(makeE(exportsObj));
console.log("exports:", Object.keys(exportsObj).map(k=>{const v=exportsObj[k];return k+"("+(Array.isArray(v)?("arr"+v.length):typeof v)+")";}).join(", "));
let arr=null,arrName=null;
for(const k of Object.keys(exportsObj)){ const v=exportsObj[k]; if(Array.isArray(v)&&v.length>50&&v[0]&&v[0].check){arr=v;arrName=k;} }
console.log("BADGE ARRAY:", arrName, "len", arr&&arr.length);
if(arr){ console.log("sample:", JSON.stringify({id:arr[0].id,label:arr[0].label,check:typeof arr[0].check, gc:typeof arr[0].getContributors})); fs.writeFileSync("_arr_ok.txt","1"); }

// ---- VALIDATION against tests.match / tests.reject ----
let pass=0, fail=0, failures=[];
for(const b of arr){
  const digits = n => String(n);
  for(const m of (b.tests?.match||[])){ let ok; try{ok=!!b.check(m,digits(m));}catch(e){ok="ERR:"+e.message;} if(ok!==true){fail++; failures.push([b.id,"match",m,ok]);} else pass++; }
  for(const r of (b.tests?.reject||[])){ let ok; try{ok=!!b.check(r,digits(r));}catch(e){ok="ERR:"+e.message;} if(ok!==false){fail++; failures.push([b.id,"reject",r,ok]);} else pass++; }
}
console.log("\nVALIDATION (check(n,String(n))): pass="+pass+" fail="+fail);
console.log(JSON.stringify(failures.slice(0,30),null,0));
