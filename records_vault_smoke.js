'use strict';
const fs=require('fs'); const vm=require('vm');
const src=fs.readFileSync(__dirname+'/app.js','utf8');
function extractFunction(name){
  const re=new RegExp('function\\s+'+name+'\\s*\\('); const m=re.exec(src); if(!m) throw new Error('missing '+name);
  const start=m.index, brace=src.indexOf('{',start); let depth=0,quote=null,esc=false;
  for(let i=brace;i<src.length;i++){const c=src[i]; if(quote){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===quote)quote=null;continue;} if(c==='"'||c==="'"||c==='`'){quote=c;continue;} if(c==='{')depth++; else if(c==='}'&&--depth===0)return src.slice(start,i+1);} throw new Error('unterminated '+name);
}
class CL{constructor(){this.s=new Set()}add(x){this.s.add(x)}remove(x){this.s.delete(x)}toggle(x,f){if(f)this.s.add(x);else this.s.delete(x);return f}contains(x){return this.s.has(x)}}
class El{constructor(){this.textContent='';this.innerText='';this.innerHTML='';this.value='';this.classList=new CL();this.style={display:''}}}
const els={}; const get=id=>els[id]||(els[id]=new El());
['archive-search','records-completed-count','records-doc-count','records-company-count','archive-results-caption','archive-list','vault-company-select','btn-vault-upload','vault-gallery','vault-company-summary','vault-doc-caption','vault-doc-count','archive-tx-content','archive-vault-content','tab-arch-tx','tab-arch-vault'].forEach(get);
const document={getElementById:get};
const db={
  companies:[{id:'c1',name:'شركة ألف'},{id:'c2',name:'شركة باء'}],
  lawyers:[{id:'l1',name:'رؤى عبدالله'},{id:'l2',name:'سارة خالد'}],
  transactions:[
    {id:'t1',status:'completed',companyId:'c1',lawyerId:'l1',type:'تصديق',fee:100,paid:100,lastUpdate:300},
    {id:'t2',status:'completed',companyId:'c2',lawyerId:'l2',type:'حجز نطاق',fee:200,paid:50,lastUpdate:500},
    {id:'t3',status:'active',companyId:'c1',lawyerId:'l1',type:'تأييد',fee:90,paid:10,lastUpdate:600}
  ],
  vault:[{id:'v1',companyId:'c1',date:700,data:'data:image/jpeg;base64,AAA'},{id:'v2',companyId:'c1',date:650,data:'data:image/jpeg;base64,BBB'}]
};
const ctx={document,db,console,Math,String,Intl,
 companyName:id=>db.companies.find(x=>String(x.id)===String(id))?.name||'', lawyerName:id=>db.lawyers.find(x=>String(x.id)===String(id))?.name||'',
 getCompanyById:id=>db.companies.find(x=>String(x.id)===String(id)),
 getPaidAmount:t=>t.paid, getRemainingAmount:t=>Math.max(0,t.fee-t.paid),
 numFormat:new Intl.NumberFormat('en-US'), formatShortDate:v=>'D'+v,
 escapeHtml:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])), escapeAttr:v=>String(v??'').replace(/"/g,'&quot;'), jsArg:v=>JSON.stringify(String(v)),
 updateVaultDropdown:()=>{},
};
vm.createContext(ctx);
for(const n of ['renderArchive','renderVault','toggleArchiveTab']) vm.runInContext(extractFunction(n),ctx);
const assert=(c,m)=>{if(!c)throw new Error(m)};
ctx.renderArchive();
assert(els['records-completed-count'].textContent===2,'completed count');
assert(els['records-doc-count'].textContent===2,'doc count');
assert(els['records-company-count'].textContent===2,'company count');
assert(els['archive-list'].innerHTML.includes('mq-archive-entry'),'new archive card missing');
assert(els['archive-list'].innerHTML.indexOf('حجز نطاق')<els['archive-list'].innerHTML.indexOf('تصديق'),'archive sort newest first');
assert(!/v6-record|v6-empty/.test(els['archive-list'].innerHTML),'legacy archive presentation leaked');
els['archive-search'].value='ألف'; ctx.renderArchive();
assert((els['archive-list'].innerHTML.match(/class=\"mq-archive-entry /g)||[]).length===1,'archive search');
els['archive-search'].value='غير موجود'; ctx.renderArchive(); assert(els['archive-list'].innerHTML.includes('mq-records-empty'),'archive empty state');
els['vault-company-select'].value=''; ctx.renderVault(); assert(els['btn-vault-upload'].classList.contains('hidden'),'upload must hide without company'); assert(els['vault-gallery'].innerHTML.includes('mq-records-empty'),'vault no-company empty');
els['vault-company-select'].value='c1'; ctx.renderVault(); assert(!els['btn-vault-upload'].classList.contains('hidden'),'upload must show'); assert(els['vault-doc-count'].textContent===2,'vault count'); assert((els['vault-gallery'].innerHTML.match(/class=\"mq-vault-file /g)||[]).length===2,'vault files'); assert(!/v6-vault/.test(els['vault-gallery'].innerHTML),'legacy vault presentation leaked');
ctx.toggleArchiveTab('vault'); assert(els['tab-arch-vault'].classList.contains('active') && !els['tab-arch-tx'].classList.contains('active'),'vault tab state'); assert(els['archive-vault-content'].style.display==='block' && els['archive-tx-content'].style.display==='none','vault panel state');
console.log('RECORDS_VAULT_SMOKE PASS',JSON.stringify({completed:2,docs:2,search:1,vaultCompany:'c1'}));
