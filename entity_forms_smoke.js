'use strict';
const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync(__dirname+'/app.js','utf8');
function extract(name){const m=new RegExp('function\\s+'+name+'\\s*\\(').exec(src);if(!m)throw Error('missing '+name);const b=src.indexOf('{',m.index);let d=0,q=null,e=false;for(let i=b;i<src.length;i++){const c=src[i];if(q){if(e)e=false;else if(c==='\\')e=true;else if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==='`'){q=c;continue;}if(c==='{')d++;else if(c==='}'&&--d===0)return src.slice(m.index,i+1);}throw Error('bad '+name)}
class E{constructor(v=''){this.value=v}}
const els={'in-lawyer-name':new E('أحمد علي'),'in-comp-name':new E('شركة الاختبار'),'in-comp-lawyer':new E('101')};
const document={getElementById:id=>els[id]||(els[id]=new E())};
const db={lawyers:[{id:101,name:'محام موجود'}],companies:[],transactions:[],vault:[]};
let rebuilt=0,closed=[],saved=0,toasts=[],idCounter=0;
const ctx={document,db,Date:{now:()=>20260825},console,makeId:()=>`entity-${++idCounter}`,rebuildEntityIndexes:()=>rebuilt++,closeModal:id=>closed.push(id),saveData:()=>{saved++;return true},saveDataWithAudit:()=>{saved++;return true},showToast:(m,t)=>toasts.push([m,t]),getLawyerById:id=>db.lawyers.find(x=>String(x.id)===String(id))};
vm.createContext(ctx); for(const n of ['saveLawyer','saveCompany'])vm.runInContext(extract(n),ctx);
function a(c,m){if(!c)throw Error(m)}
ctx.saveLawyer();a(db.lawyers.length===2,'lawyer not saved');a(db.lawyers[1].name==='أحمد علي','lawyer name mismatch');a(els['in-lawyer-name'].value==='','lawyer form not cleared');a(closed.includes('addLawyerModal'),'lawyer modal not closed');
ctx.saveCompany();a(db.companies.length===1,'company not saved');a(db.companies[0].name==='شركة الاختبار','company name mismatch');a(db.companies[0].lawyerId==='101','company relation mismatch');a(els['in-comp-name'].value===''&&els['in-comp-lawyer'].value==='','company form not cleared');a(closed.includes('addCompanyModal'),'company modal not closed');a(saved===2&&rebuilt===2,'save/index path mismatch');
console.log('ENTITY_FORMS_SMOKE PASS',JSON.stringify({lawyers:db.lawyers.length,companies:db.companies.length,saves:saved}));
