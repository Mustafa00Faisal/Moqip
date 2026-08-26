'use strict';
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(__dirname + '/app.js','utf8');

function extractFunction(name){
  const re = new RegExp('function\\s+'+name+'\\s*\\(');
  const m = re.exec(src); if(!m) throw new Error('missing function '+name);
  const start=m.index; const brace=src.indexOf('{',start); let depth=0, quote=null, esc=false;
  for(let i=brace;i<src.length;i++){
    const c=src[i];
    if(quote){ if(esc) esc=false; else if(c==='\\') esc=true; else if(c===quote) quote=null; continue; }
    if(c==='"'||c==="'"||c==='`'){ quote=c; continue; }
    if(c==='{') depth++; else if(c==='}' && --depth===0) return src.slice(start,i+1);
  }
  throw new Error('unterminated '+name);
}

class ClassList{
  constructor(){this.s=new Set()}
  add(...x){x.forEach(v=>this.s.add(v))}
  remove(...x){x.forEach(v=>this.s.delete(v))}
  contains(x){return this.s.has(x)}
  toggle(x,force){ if(force===undefined){if(this.s.has(x)){this.s.delete(x);return false;} this.s.add(x);return true;} if(force)this.s.add(x); else this.s.delete(x); return force; }
}
class El{
  constructor(id=''){this.id=id;this._value='';this.textContent='';this.innerText='';this._html='';this.options=[];this.selectedIndex=0;this.style={};this.classList=new ClassList();}
  set value(v){this._value=String(v); const i=this.options.findIndex(o=>String(o.value)===this._value); if(i>=0)this.selectedIndex=i;}
  get value(){return this._value;}
  set innerHTML(v){
    this._html=String(v);
    if(this.id==='new-tx-company'){
      this.options=[];
      const re=/<option value="([^"]*)">([\s\S]*?)<\/option>/g; let m;
      while((m=re.exec(this._html))) this.options.push({value:m[1],text:m[2].replace(/<[^>]+>/g,'')});
      this.selectedIndex=0; this._value=this.options[0]?.value||'';
    }
  }
  get innerHTML(){return this._html}
}
const els={}; const get=id=>els[id]||(els[id]=new El(id));
['new-tx-lawyer','new-tx-company','new-tx-type','new-tx-fee','new-tx-preview-lawyer','new-tx-preview-company','new-tx-preview-dept','new-tx-preview-type','new-tx-preview-fee','new-tx-preview-progress','new-tx-preview-progress-bar','new-tx-preview-ready','text-new-tx-lawyer','text-new-tx-company'].forEach(get);
els['new-tx-lawyer'].options=[{value:'',text:'اختر'},{value:'1',text:'رؤى'},{value:'2',text:'سارة'}];
els['new-tx-lawyer'].selectedIndex=1; els['new-tx-lawyer'].value='1';
els['text-new-tx-lawyer'].classList.add('is-placeholder'); els['text-new-tx-company'].classList.add('is-placeholder');
let dept={value:'دائرة مسجل الشركات'};
const document={
  getElementById:get,
  querySelector(sel){if(sel==='input[name="new-tx-dept"]:checked') return dept; return null;}
};
const db={lawyers:[{id:1,name:'رؤى'},{id:2,name:'سارة'}],companies:[{id:11,name:'شركة ألف',lawyerId:1},{id:12,name:'شركة باء',lawyerId:2}],transactions:[]};
let saved=0, switched=null, toast=null, alertMsg=null;
const context={
  document, db, console,
  numFormat:new Intl.NumberFormat('en-US'),
  escapeHtml:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  getCompanyById:id=>db.companies.find(x=>String(x.id)===String(id)),
  getLawyerById:id=>db.lawyers.find(x=>String(x.id)===String(id)),
  makeId:()=> 'tx-test-1',
  addActivity:(tx,type,label)=>tx.activity.push({type,label,at:123}),
  saveData:()=>{saved++;return true},
  saveDataWithAudit:()=>{saved++;return true},
  switchTab:x=>switched=x,
  showToast:(m,t)=>toast={m,t},
  customAlert:(a,b,c)=>{alertMsg={a,b,c};},
};
vm.createContext(context);
for(const name of ['updateCustomSelectText','updateCompanyDropdown','refreshNewTxPreview','createNewTransaction']) vm.runInContext(extractFunction(name),context);
function assert(cond,msg){if(!cond) throw new Error(msg)}

// 1. Lawyer selection filters company choices.
context.updateCompanyDropdown();
assert(els['new-tx-company'].options.length===2,'company dropdown should contain blank + matching company');
assert(els['new-tx-company'].options[1].value==='11','wrong company after lawyer filter');
assert(!els['new-tx-company'].options.some(o=>o.value==='12'),'company from another lawyer leaked into dropdown');

// 2. Complete the form and verify live dossier.
els['new-tx-company'].value='11'; els['new-tx-company'].selectedIndex=1;
els['new-tx-type'].value='تجديد سجل تجاري'; els['new-tx-fee'].value='25000';
context.refreshNewTxPreview();
assert(els['new-tx-preview-progress'].textContent==='100%','readiness should be 100%');
assert(els['new-tx-preview-progress-bar'].style.width==='100%','progress bar should be full');
assert(els['new-tx-preview-ready'].classList.contains('is-ready'),'ready state class missing');
assert(els['new-tx-preview-lawyer'].textContent==='رؤى','lawyer preview mismatch');
assert(els['new-tx-preview-company'].textContent==='شركة ألف','company preview mismatch');
assert(els['new-tx-preview-fee'].innerHTML.includes('25,000'),'fee preview mismatch');

// 3. Create exact transaction structure and verify Core defaults.
context.createNewTransaction();
assert(db.transactions.length===1,'transaction not created');
const tx=db.transactions[0];
assert(tx.id==='tx-test-1','id mismatch');
assert(tx.companyId===11 && tx.lawyerId===1,'entity links mismatch');
assert(tx.type==='تجديد سجل تجاري' && tx.dept==='دائرة مسجل الشركات','transaction identity mismatch');
assert(tx.fee===25000 && tx.paidAmount===0,'financial defaults mismatch');
assert(tx.status==='active' && tx.priority==='normal','status defaults mismatch');
assert(Array.isArray(tx.stations)&&Array.isArray(tx.notes)&&Array.isArray(tx.payments)&&Array.isArray(tx.followUps)&&Array.isArray(tx.activity),'collection defaults missing');
assert(tx.activity.length===1 && tx.activity[0].type==='created','creation timeline entry missing');
assert(saved===1 && switched==='active','save/navigation path mismatch');
assert(toast && toast.t==='success','success feedback missing');

// 4. UI reset introduced in REBUILD 05 must not mutate Core data.
assert(els['new-tx-lawyer'].value==='' && els['new-tx-company'].value==='' && els['new-tx-type'].value==='' && els['new-tx-fee'].value==='','creation form did not reset');
assert(els['new-tx-preview-progress'].textContent==='0%','live dossier did not reset');
assert(els['text-new-tx-lawyer'].innerText==='اختر جهة التعامل','lawyer visible label did not reset');
assert(els['text-new-tx-company'].innerText==='اختر المحامي أولاً','company visible label did not reset');

// 5. Missing required fields are still blocked by Core validation.
context.createNewTransaction();
assert(db.transactions.length===1,'invalid empty transaction was created');
assert(alertMsg && alertMsg.a==='بيانات ناقصة','missing-field validation did not trigger');

console.log('CREATION_FLOW_SMOKE PASS', JSON.stringify({transactions:db.transactions.length, filteredCompany:'11', readiness:'100%', reset:'0%'}));
