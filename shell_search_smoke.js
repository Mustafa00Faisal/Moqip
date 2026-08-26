'use strict';
const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync(__dirname+'/app.js','utf8');
function extractFunction(name){
 const re=new RegExp('function\\s+'+name+'\\s*\\('),m=re.exec(src); if(!m) throw new Error('missing '+name);
 const start=m.index,brace=src.indexOf('{',start); let d=0,q=null,e=false;
 for(let i=brace;i<src.length;i++){const c=src[i];if(q){if(e)e=false;else if(c==='\\')e=true;else if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==='`'){q=c;continue;}if(c==='{')d++;else if(c==='}'&&--d===0)return src.slice(start,i+1);}throw new Error('unterminated '+name);
}
class CL{constructor(init=[]){this.s=new Set(init)}add(...x){x.forEach(v=>this.s.add(v))}remove(...x){x.forEach(v=>this.s.delete(v))}toggle(x,f){if(f===undefined){if(this.s.has(x)){this.s.delete(x);return false}this.s.add(x);return true}f?this.s.add(x):this.s.delete(x);return f}contains(x){return this.s.has(x)}}
class El{constructor(id=''){this.id=id;this.value='';this.textContent='';this.innerText='';this.innerHTML='';this.style={display:''};this.className='';this.classList=new CL();this.dataset={};this.children=[];}appendChild(x){this.children.push(x);return x}append(...xs){this.children.push(...xs)}remove(){}focus(){this.focused=true}setAttribute(){} }
const els={}; const get=id=>els[id]||(els[id]=new El(id));
['supabase-login-modal','auth-title','auth-subtitle','auth-icon','auth-icon-bg','login-action-group','register-action-group','supabase-login-message','moreMenuModal','uiAlertTitle','uiAlertMsg','uiAlertIcon','uiAlert','toast-container','global-search-query','global-search-status','global-search-priority','global-search-payment','global-search-company','global-search-lawyer','global-search-dept','global-search-date-from','global-search-date-to','global-search-count','global-search-results'].forEach(get);
const body=new El('body');
const document={
 getElementById:get, body,
 createElement:(tag)=>new El(tag),
 querySelectorAll:()=>[]
};
const db={transactions:[
 {id:'1',type:'تأييد ضريبة',companyId:'c1',lawyerId:'l1',dept:'مسجل الشركات',status:'active',priority:'normal',fee:10000,paid:4000,createdAt:1000,lastUpdate:3000,stations:[],notes:[{text:'مراجعة اليوم'}],followUps:[],activity:[]},
 {id:'2',type:'حجز نطاق',companyId:'c2',lawyerId:'l2',dept:'الاتصالات',status:'stalled',priority:'high',fee:20000,paid:0,createdAt:2000,lastUpdate:4000,stations:[],notes:[],followUps:[],activity:[]}
]};
const companies={c1:'شركة أرض البيطرة',c2:'شركة سنام'}, lawyers={l1:'رؤى عبدالله',l2:'سارة خالد'};
const ctx={document,db,console,String,Number,Math,Date,Intl,setTimeout:()=>0,clearTimeout:()=>{},
 rebuildEntityIndexes:()=>{}, companyName:id=>companies[id]||'',lawyerName:id=>lawyers[id]||'',
 getNextFollowUp:()=>null,getPaidAmount:t=>t.paid,getRemainingAmount:t=>Math.max(0,t.fee-t.paid),
 numFormat:new Intl.NumberFormat('en-US'),escapeHtml:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 jsArg:v=>JSON.stringify(String(v)),formatShortDate:()=> '25 آب'
};
vm.createContext(ctx);
vm.runInContext("const GLOBAL_SEARCH_TEXT_FIELDS=['global-search-query','global-search-dept','global-search-date-from','global-search-date-to']; const GLOBAL_SEARCH_SELECT_FIELDS=['global-search-status','global-search-priority','global-search-payment','global-search-company','global-search-lawyer']; let globalSearchTimer=null;",ctx);
for(const n of ['toggleAuthMode','showToast','customAlert','openMoreMenu','closeMoreMenu','renderGlobalSearchResultCard','renderGlobalSearchResults']) vm.runInContext(extractFunction(n),ctx);
const assert=(x,m)=>{if(!x)throw new Error(m)};
ctx.toggleAuthMode('register');
assert(get('supabase-login-modal').dataset.authMode==='register','auth mode dataset');
assert(get('auth-title').textContent==='إنشاء حساب جديد','register title');
assert(get('auth-icon-bg').className==='mq-auth-symbol is-register','register symbol');
assert(!get('auth-icon-bg').className.includes('gradient'),'legacy auth tailwind leaked');
ctx.toggleAuthMode('login');
assert(get('auth-icon-bg').className==='mq-auth-symbol is-login','login symbol');
ctx.openMoreMenu(); assert(get('moreMenuModal').classList.contains('active'),'more open'); assert(body.classList.contains('mq-overlay-open'),'body lock');
ctx.closeMoreMenu(); assert(!get('moreMenuModal').classList.contains('active'),'more close'); assert(!body.classList.contains('mq-overlay-open'),'body unlock');
ctx.showToast('نجح الحفظ','success');
assert(get('toast-container').children.length===1,'toast appended');
assert(get('toast-container').children[0].className==='mq-toast is-success','new toast class');
ctx.customAlert('خطأ','رسالة','error'); assert(get('uiAlertIcon').className==='mq-dialog-symbol is-error','new alert icon'); assert(get('uiAlert').classList.contains('active'),'alert activated');
ctx.renderGlobalSearchResults();
assert(get('global-search-count').textContent==='2 نتيجة','search count all');
assert(get('global-search-results').innerHTML.includes('mq-search-result'),'new result class missing');
assert(!get('global-search-results').innerHTML.includes('v6-global'),'legacy result leaked');
get('global-search-query').value='حجز'; ctx.renderGlobalSearchResults();
assert(get('global-search-count').textContent==='1 نتيجة' && get('global-search-results').innerHTML.includes('حجز نطاق'),'query filter');
get('global-search-query').value=''; get('global-search-status').value='active'; ctx.renderGlobalSearchResults();
assert(get('global-search-count').textContent==='1 نتيجة' && get('global-search-results').innerHTML.includes('تأييد ضريبة'),'status filter');
get('global-search-status').value='completed'; ctx.renderGlobalSearchResults();
assert(get('global-search-count').textContent==='0 نتيجة' && get('global-search-results').innerHTML.includes('mq-empty-state'),'empty state');
console.log('SHELL_SEARCH_SMOKE PASS — auth/more/toast/dialog/search renderer and filters');
