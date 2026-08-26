'use strict';
const fs=require('fs'); const vm=require('vm');
const src=fs.readFileSync(__dirname+'/app.js','utf8');
function extractFunction(name){
  const re=new RegExp('function\\s+'+name+'\\s*\\('); const m=re.exec(src); if(!m) throw new Error('missing '+name);
  const start=m.index, brace=src.indexOf('{',start); let depth=0,quote=null,esc=false;
  for(let i=brace;i<src.length;i++){const c=src[i]; if(quote){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===quote)quote=null;continue;} if(c==='"'||c==="'"||c==='`'){quote=c;continue;} if(c==='{')depth++; else if(c==='}'&&--depth===0)return src.slice(start,i+1);} throw new Error('unterminated '+name);
}
class CL{constructor(){this.s=new Set()}toggle(x,f){if(f)this.s.add(x);else this.s.delete(x);return f}contains(x){return this.s.has(x)}}
class Style{constructor(){this.m={}}setProperty(k,v){this.m[k]=v}}
class El{constructor(){this.textContent='';this.innerText='';this.innerHTML='';this.value='';this.classList=new CL();this.style=new Style()}focus(){}}
const els={}; const get=id=>els[id]||(els[id]=new El());
['acc-total-dues','accounting-search','accounting-group-count','accounting-list','acc-advanced-fees','acc-advanced-paid','acc-advanced-remaining','acc-advanced-unpaid-count','acc-collection-rate','acc-collection-ring'].forEach(get);
const modeBtns=['all','open','settled'].map(mode=>({dataset:{accountingMode:mode},classList:new CL()}));
const document={getElementById:get,querySelectorAll:(s)=>s==='[data-accounting-mode]'?modeBtns:[]};
const db={
 lawyers:[{id:'l1',name:'رؤى عبدالله'},{id:'l2',name:'سارة خالد'},{id:'l3',name:'أحمد كامل'}],
 companies:[{id:'c1',name:'ألف',lawyerId:'l1'},{id:'c2',name:'باء',lawyerId:'l2'},{id:'c3',name:'جيم',lawyerId:'l3'}],
 transactions:[
  {id:'a1',status:'active',lawyerId:'l1',companyId:'c1',fee:100,paid:40},
  {id:'c1',status:'completed',lawyerId:'l1',companyId:'c1',fee:200,paid:200},
  {id:'s1',status:'stalled',lawyerId:'l1',companyId:'c1',fee:300,paid:50},
  {id:'a2',status:'active',lawyerId:'l2',companyId:'c2',fee:400,paid:100},
  {id:'c2',status:'completed',lawyerId:'l3',companyId:'c3',fee:150,paid:150},
 ]
};
const ctx={document,db,console,Math,String,Intl,
 getCompanyById:id=>db.companies.find(x=>String(x.id)===String(id)),
 getLawyerById:id=>db.lawyers.find(x=>String(x.id)===String(id)),
 getPaidAmount:t=>t.paid,
 getRemainingAmount:t=>Math.max(0,t.fee-t.paid),
 numFormat:new Intl.NumberFormat('en-US'),
 escapeHtml:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 jsArg:v=>JSON.stringify(String(v)),
};
vm.createContext(ctx);
vm.runInContext("let accountingViewMode='all';",ctx);
vm.runInContext("const ACCOUNTING_STATUSES=new Set(['active','stalled','completed']);",ctx);
for(const n of ['renderAdvancedAccounting','renderAccounting','setAccountingViewMode','clearAccountingSearch']) vm.runInContext(extractFunction(n),ctx);
const assert=(c,m)=>{if(!c)throw new Error(m)};
ctx.renderAccounting();
assert(els['acc-total-dues'].innerText==='610','lawyer ledger total must match the full portfolio scope');
assert(String(els['accounting-group-count'].textContent)==='3','all ledger groups should be 3');
assert(els['accounting-list'].innerHTML.includes('mq-ledger-account'),'new ledger card missing');
assert(!els['accounting-list'].innerHTML.includes('v6-ledger-'),'legacy ledger leaked');
assert(els['accounting-list'].innerHTML.indexOf('رؤى عبدالله')<els['accounting-list'].innerHTML.indexOf('سارة خالد'),'open balances not sorted descending');
assert(els['accounting-list'].innerHTML.includes('مسدد'),'settled state missing');
assert(els['acc-advanced-fees'].textContent==='1,150 د.ع','portfolio fees wrong');
assert(els['acc-advanced-paid'].textContent==='540 د.ع','portfolio paid wrong');
assert(els['acc-advanced-remaining'].textContent==='610 د.ع','portfolio remaining wrong');
assert(els['acc-advanced-unpaid-count'].textContent==='3','unpaid count wrong');
assert(els['acc-collection-rate'].textContent==='47%','collection rate wrong');
assert(els['acc-collection-ring'].style.m['--mq-rate']==='169.20000000000002deg','ring rate wrong');
ctx.setAccountingViewMode('settled');
assert(String(els['accounting-group-count'].textContent)==='1','settled filter wrong');
assert(els['accounting-list'].innerHTML.includes('أحمد كامل'),'settled account missing');
ctx.setAccountingViewMode('open');
assert(String(els['accounting-group-count'].textContent)==='2','open filter wrong');
els['accounting-search'].value='سارة'; ctx.renderAccounting();
assert(String(els['accounting-group-count'].textContent)==='1' && els['accounting-list'].innerHTML.includes('سارة خالد'),'search filter wrong');
els['accounting-search'].value='لايوجد'; ctx.renderAccounting();
assert(els['accounting-list'].innerHTML.includes('mq-finance-empty'),'new finance empty state missing');
console.log('FINANCE_SMOKE PASS',JSON.stringify({ledgerDue:610,portfolioRemaining:610,collectionRate:47,scope:'ledger and portfolio active+stalled+completed'}));
