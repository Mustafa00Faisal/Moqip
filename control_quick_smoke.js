'use strict';
const fs=require('fs'), vm=require('vm');
const appSrc=fs.readFileSync(__dirname+'/app.js','utf8');
const prodSrc=fs.readFileSync(__dirname+'/productivity.js','utf8');
function extractFunction(src,name){
  const re=new RegExp('function\\s+'+name+'\\s*\\('), m=re.exec(src); if(!m) throw new Error('missing '+name);
  const start=m.index, brace=src.indexOf('{',start); let d=0,q=null,e=false;
  for(let i=brace;i<src.length;i++){const c=src[i];if(q){if(e)e=false;else if(c==='\\')e=true;else if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==='`'){q=c;continue;}if(c==='{')d++;else if(c==='}'&&--d===0)return src.slice(start,i+1);}throw new Error('unterminated '+name);
}
class CL{constructor(){this.s=new Set()}add(...xs){xs.forEach(x=>this.s.add(x))}remove(...xs){xs.forEach(x=>this.s.delete(x))}toggle(x,f){if(f===undefined){if(this.s.has(x)){this.s.delete(x);return false}this.s.add(x);return true}if(f)this.s.add(x);else this.s.delete(x);return f}contains(x){return this.s.has(x)}}
class El{constructor(id=''){this.id=id;this.textContent='';this.innerText='';this.innerHTML='';this.value='';this.className='';this.classList=new CL();this.style={};this.clicked=false;}focus(){}click(){this.clicked=true}}
const els={}; const get=id=>els[id]||(els[id]=new El(id));
['settings-entity-search','settings-lawyers-count','settings-companies-count','settings-lawyers-visible','settings-companies-visible','settings-lawyers-list','settings-companies-list','health-tx-count','health-vault-count','health-storage-size','health-status','health-details','health-breakdown','mqQuickActions','mqQuickPicker','mq-quick-picker-search','mq-quick-picker-kicker','mqQuickPickerTitle','mq-quick-picker-subtitle','mq-quick-picker-icon','mq-quick-picker-count','mq-quick-picker-list','vault-company-select','vault-file-upload'].forEach(get);
els['mq-quick-picker-icon'].querySelector=()=>({className:''});
const panelEls=['profile','entities','data','system'].map(x=>{const e=new El();e.dataset={settingsPanel:x};return e});
const tabEls=['profile','entities','data','system'].map(x=>{const e=new El();e.dataset={settingsTab:x};return e});
const document={getElementById:get,querySelectorAll(sel){if(sel==='[data-settings-panel]')return panelEls;if(sel==='[data-settings-tab]')return tabEls;return []},querySelector(sel){if(sel==='#mq-quick-picker-icon i')return get('mq-quick-picker-icon').querySelector();return null}};
const db={
 lawyers:[{id:'l1',name:'رؤى عبدالله'},{id:'l2',name:'سارة خالد'}],
 companies:[{id:'c1',name:'شركة ألف',lawyerId:'l1'},{id:'c2',name:'شركة باء',lawyerId:'l2'}],
 transactions:[
  {id:'t1',lawyerId:'l1',companyId:'c1',type:'تصديق',dept:'مسجل الشركات',status:'active',fee:100,lastUpdate:200,stations:[],notes:[],payments:[{id:'p1',amount:25,status:'posted',receiptRef:'MQP-P1'}],followUps:[{id:'f1',done:false}]},
  {id:'t2',lawyerId:'l2',companyId:'c2',type:'حجز نطاق',dept:'هيئة الإعلام',status:'stalled',fee:100,lastUpdate:300,stations:[],notes:[],payments:[],followUps:[]},
  {id:'t3',lawyerId:'l1',companyId:'c1',type:'منجز',dept:'مسجل الشركات',status:'completed',fee:100,completedAt:100,lastUpdate:100,stations:[],notes:[],payments:[],followUps:[]}
 ],
 vault:[{id:'v1',companyId:'c1',data:'data:image/jpeg;base64,A'}]
};
let toast=null, switched=null, opened=null, actionStarted=null, vaultRendered=0, archiveMode=null;
const ctx={document,db,console,Blob,String,Math,Date,setTimeout:(fn)=>fn(),clearTimeout:()=>{},
 escapeHtml:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),escapeAttr:s=>String(s??'').replace(/"/g,'&quot;'),jsArg:x=>JSON.stringify(String(x)),
 lawyerName:id=>db.lawyers.find(x=>String(x.id)===String(id))?.name||'',companyName:id=>db.companies.find(x=>String(x.id)===String(id))?.name||'',
 getCompanyById:id=>db.companies.find(x=>String(x.id)===String(id)),getLawyerById:id=>db.lawyers.find(x=>String(x.id)===String(id)),getPendingFollowUps:t=>(t.followUps||[]).filter(x=>!x.done),rebuildEntityIndexes:()=>{},showToast:(m,t)=>toast={m,t}
 ,getAllStoredTransactions:()=>[...(db.transactions||[]),...(db.trash?.transactions||[])]
};
vm.createContext(ctx);
for(const n of ['renderSettingsEntities','clearSettingsEntitySearch','setSettingsPanel','runDatabaseHealthCheck']) vm.runInContext(extractFunction(appSrc,n),ctx);
const assert=(c,m)=>{if(!c)throw new Error(m)};
ctx.renderSettingsEntities();
assert(els['settings-lawyers-count'].textContent===2,'lawyer total');assert(els['settings-companies-count'].textContent===2,'company total');
assert((els['settings-lawyers-list'].innerHTML.match(/mq-directory-card/g)||[]).length===2,'new lawyer cards');assert((els['settings-companies-list'].innerHTML.match(/mq-directory-card/g)||[]).length===2,'new company cards');
assert(!/v6-entity|v6-control/.test(els['settings-lawyers-list'].innerHTML+els['settings-companies-list'].innerHTML),'legacy directory leaked');
els['settings-entity-search'].value='ألف';ctx.renderSettingsEntities();assert(els['settings-companies-visible'].textContent===1,'company search');
els['settings-entity-search'].value='رؤى';ctx.renderSettingsEntities();assert(els['settings-lawyers-visible'].textContent===1,'lawyer search');
ctx.setSettingsPanel('entities');assert(panelEls[1].classList.contains('active')&&!panelEls[0].classList.contains('active'),'panel switch');assert(tabEls[1].classList.contains('active'),'tab switch');
const health=ctx.runDatabaseHealthCheck(false);assert(health.issues.length===0,'healthy fixture issues');assert(els['health-status'].className==='is-good','health class');assert(els['health-breakdown'].innerHTML.includes('mq-data-snapshot-item'),'new snapshot renderer');assert(!/bg-slate|v6-health/.test(els['health-breakdown'].innerHTML),'legacy health leaked');
db.transactions.push({id:'bad',lawyerId:'l1',companyId:'missing',status:'active',stations:[],notes:[],payments:[],followUps:[]});ctx.runDatabaseHealthCheck(false);assert(els['health-status'].className==='is-warning','bad health status');assert(els['health-details'].innerHTML.includes('mq-health-message is-warning'),'health warning presentation');db.transactions.pop();

// Evaluate only audited quick-action section, with mocked window routing.
const qStart=prodSrc.indexOf('    const QUICK_ACTION_META =');
const qEnd=prodSrc.indexOf('    /* -------------------------------------------------------------------------\n       05. PWA install',qStart);
if(qStart<0||qEnd<0)throw new Error('quick section markers');
ctx.window=ctx;
ctx.navigator={onLine:true};
ctx.state={quickAction:null,quickPickerSource:[],quickPickerTimer:null};
ctx.updateProductivitySheetLock=()=>{};
ctx.closeDailyWorkspace=()=>{};
ctx.switchTab=x=>{switched=x};ctx.getTransaction=id=>db.transactions.find(t=>String(t.id)===String(id));ctx.openTxDetails=id=>{opened=id};ctx.startTxAction=a=>{actionStarted=a};ctx.toggleArchiveTab=m=>{archiveMode=m};ctx.updateVaultDropdown=()=>{};ctx.updateCustomSelectText=()=>{};ctx.renderVault=()=>{vaultRendered++};
vm.runInContext(prodSrc.slice(qStart,qEnd),ctx);
ctx.openQuickActions();assert(els['mqQuickActions'].classList.contains('active'),'launch open');ctx.closeQuickActions();assert(!els['mqQuickActions'].classList.contains('active'),'launch close');
ctx.beginQuickAction('newTx');assert(switched==='newTx','newTx route');
ctx.beginQuickAction('payment');assert(ctx.state.quickAction==='payment','quick state');assert(els['mqQuickPicker'].classList.contains('active'),'picker open');assert(ctx.state.quickPickerSource.length===2,'completed excluded for payment');assert(els['mq-quick-picker-list'].innerHTML.includes('mq-launch-case'),'new picker row');assert(!/mq-action-picker/.test(els['mq-quick-picker-list'].innerHTML),'old picker row leaked');
// newest stalled item should be first
assert(els['mq-quick-picker-list'].innerHTML.indexOf('حجز نطاق')<els['mq-quick-picker-list'].innerHTML.indexOf('تصديق'),'picker sort');
ctx.chooseQuickTransaction('t1');assert(opened==='t1'&&actionStarted==='payment','payment route');
ctx.beginQuickAction('document');assert(ctx.state.quickPickerSource.length===3,'document includes completed');ctx.chooseQuickTransaction('t1');assert(switched==='archive'&&archiveMode==='vault','document archive route');assert(els['vault-company-select'].value==='c1'&&vaultRendered>0&&els['vault-file-upload'].clicked,'document upload route');
console.log('CONTROL_QUICK_SMOKE PASS',JSON.stringify({directory:'new',health:'new',quick:'launchpad',routes:'preserved'}));
