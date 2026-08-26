const fs=require('fs');
const vm=require('vm');
const src=fs.readFileSync(__dirname + '/app.js','utf8');
const start=src.indexOf('function renderTxList(containerId, txs, emptyMsg)');
const end=src.indexOf('// ==========================================\n        // 7. منطق خزنة المستندات',start);
if(start<0||end<0) throw new Error('renderTxList not found');
const fnSrc=src.slice(start,end).trim();
const box={innerHTML:''};
const context={
  document:{getElementById:(id)=>id==='active-list'?box:null},
  companyName:(id)=>id==='c1'?'شركة ألف':'شركة باء',
  lawyerName:(id)=>id==='l1'?'محامي أول':'محامي ثان',
  getPaidAmount:(tx)=>tx.paid,
  getRemainingAmount:(tx)=>Math.max(0,tx.fee-tx.paid),
  getNextFollowUp:(tx)=>tx.next||null,
  formatShortDate:(v)=>new Date(v).toISOString().slice(0,10),
  escapeHtml:(v)=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
  escapeAttr:(v)=>String(v??''),
  jsArg:(v)=>JSON.stringify(String(v)),
  numFormat:new Intl.NumberFormat('en-US'),
  Date,
  Math
};
vm.createContext(context);
vm.runInContext(fnSrc,context);
const rows=[
  {id:'older',companyId:'c1',lawyerId:'l1',type:'قديمة',dept:'مسجل',status:'active',priority:'normal',lastUpdate:100,fee:1000,paid:200,stations:[],next:null},
  {id:'newer',companyId:'c2',lawyerId:'l2',type:'جديدة',dept:'ضريبة',status:'stalled',priority:'urgent',lastUpdate:200,fee:2000,paid:500,stations:[{name:'الضريبة'}],next:{dueAt:'2020-01-01T00:00:00Z',done:false}}
];
const before=rows.map(x=>x.id).join(',');
context.renderTxList('active-list',rows,'فارغ');
const after=rows.map(x=>x.id).join(',');
function assert(cond,msg){if(!cond)throw new Error(msg)}
assert(before===after,'renderer mutated source array');
assert(box.innerHTML.includes('mq-case-card'),'new card class missing');
assert(!box.innerHTML.includes('v6-transaction-card'),'legacy card leaked');
assert(box.innerHTML.indexOf('جديدة')<box.innerHTML.indexOf('قديمة'),'sorting by lastUpdate failed');
assert(box.innerHTML.includes('25%'),'collection percent incorrect');
assert(box.innerHTML.includes('متابعة متأخرة'),'overdue follow-up state missing');
assert(box.innerHTML.includes('openTxDetails'), 'open handler missing');
box.innerHTML='';
context.renderTxList('active-list',[],'لا توجد معاملات');
assert(box.innerHTML.includes('mq-cases-empty'),'new empty state missing');
assert(box.innerHTML.includes('تأسيس معاملة'),'empty-state action missing');
console.log('TRANSACTION_RENDERER_SMOKE PASS');
