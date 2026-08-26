'use strict';
const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync(__dirname+'/app.js','utf8');
function extractFunction(name){
 const m=new RegExp('function\\s+'+name+'\\s*\\(').exec(src); if(!m) throw new Error('missing '+name);
 const start=m.index, brace=src.indexOf('{',start); let d=0,q=null,e=false;
 for(let i=brace;i<src.length;i++){const c=src[i];if(q){if(e)e=false;else if(c==='\\')e=true;else if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==='`'){q=c;continue;}if(c==='{')d++;else if(c==='}'&&--d===0)return src.slice(start,i+1);} throw new Error('unterminated');
}
class CL{contains(){return false}}
class Style{constructor(){this.m={}}setProperty(k,v){this.m[k]=v}}
class El{constructor(id){this.id=id;this.textContent='';this.innerHTML='';this.style=new Style()}getContext(){return {canvas:this}}}
const els={}; const get=id=>els[id]||(els[id]=new El(id));
['analytics-completed-sum','analytics-avg-fee','analytics-total-count','analytics-avg-duration','analytics-completion-rate','analytics-paid-total','analytics-remaining-total','analytics-fee-total','analytics-active-count','analytics-stalled-count','analytics-completed-count','analytics-collection-rate','analytics-completion-ring','analytics-collection-bar','deptPerformanceChart','statusDistributionChart','paymentsTrendChart','analytics-top-clients'].forEach(get);
const document={getElementById:get,documentElement:{classList:new CL()}};
const DAY=86400000,base=Date.now()-10*DAY;
const db={companies:[{id:'c1',name:'شركة ألف'},{id:'c2',name:'شركة باء'}],transactions:[
 {id:'a',status:'active',companyId:'c1',dept:'مسجل الشركات',fee:100,paid:40,createdAt:base,lastUpdate:base+DAY,payments:[]},
 {id:'s',status:'stalled',companyId:'c2',dept:'الضريبة',fee:200,paid:50,createdAt:base,lastUpdate:base+DAY,payments:[]},
 {id:'c1',status:'completed',companyId:'c1',dept:'مسجل الشركات',fee:300,paid:300,createdAt:base,lastUpdate:base+2*DAY,completedAt:base+2*DAY,payments:[{amount:300,date:Date.now()}]},
 {id:'c2',status:'completed',companyId:'c2',dept:'الضريبة',fee:400,paid:100,createdAt:base,lastUpdate:base+4*DAY,completedAt:base+4*DAY,payments:[{amount:100,date:Date.now()}]},
]};
const chartConfigs=[];
class Chart{constructor(ctx,cfg){this.ctx=ctx;this.cfg=cfg;chartConfigs.push(cfg)}destroy(){}}
const ctx={document,db,Chart,console,Math,String,Number,Date,Intl,
 getPaidAmount:t=>t.paid,getRemainingAmount:t=>Math.max(0,t.fee-t.paid),
 getCompanyById:id=>db.companies.find(x=>String(x.id)===String(id)),
 numFormat:new Intl.NumberFormat('en-US'),
 escapeHtml:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
};
vm.createContext(ctx); vm.runInContext('let deptChartInstance=null,statusChartInstance=null,paymentsTrendChartInstance=null;',ctx); vm.runInContext(extractFunction('renderAnalyticsData'),ctx);
ctx.renderAnalyticsData();
const assert=(c,m)=>{if(!c)throw new Error(m)};
assert(els['analytics-fee-total'].textContent==='1,000 د.ع','fee total');
assert(els['analytics-paid-total'].textContent==='490 د.ع','paid total');
assert(els['analytics-remaining-total'].textContent==='510 د.ع','remaining total');
assert(els['analytics-completion-rate'].textContent==='50%','completion');
assert(els['analytics-collection-rate'].textContent==='49%','collection');
assert(els['analytics-active-count'].textContent==='1'&&els['analytics-stalled-count'].textContent==='1'&&els['analytics-completed-count'].textContent==='2','workload counts');
assert(els['analytics-avg-duration'].textContent==='3 يوم','avg duration');
assert(els['analytics-avg-fee'].textContent==='250 د.ع','avg fee');
assert(els['analytics-completed-sum'].textContent==='700 د.ع','completed sum');
assert(els['analytics-completion-ring'].style.m['--mq-progress']==='180deg','completion ring');
assert(els['analytics-collection-bar'].style.width==='49%','collection bar');
assert(chartConfigs.length===3,'three charts');
assert(chartConfigs[0].data.datasets[0].backgroundColor.includes('#f47a1f'),'dept identity color');
assert(chartConfigs[1].data.datasets[0].backgroundColor[0]==='#f47a1f','status identity color');
assert(chartConfigs[2].data.datasets[0].borderColor==='#f47a1f','trend identity color');
assert(els['analytics-top-clients'].innerHTML.includes('mq-analytics-rank-row'),'new ranking renderer');
assert(!els['analytics-top-clients'].innerHTML.includes('v6-ranking'),'legacy ranking leaked');
console.log('ANALYTICS_SMOKE PASS',JSON.stringify({fee:1000,paid:490,remaining:510,completion:50,collection:49,charts:chartConfigs.length}));
