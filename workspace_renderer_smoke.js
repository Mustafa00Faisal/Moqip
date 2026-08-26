const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.js','utf8');
function extract(name){
  const marker = `function ${name}(`;
  const i = src.indexOf(marker); if(i<0) throw new Error(`missing ${name}`);
  const brace = src.indexOf('{',i); let depth=0, quote=null, esc=false, templateDepth=0;
  for(let p=brace;p<src.length;p++){
    const c=src[p], prev=src[p-1];
    if(quote){
      if(esc){esc=false;continue;} if(c==='\\'){esc=true;continue;}
      if(quote==='`' && c==='`'){quote=null;continue;}
      if(quote!=='`' && c===quote){quote=null;continue;}
      continue;
    }
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
    if(c==='{') depth++; else if(c==='}'){depth--; if(depth===0) return src.slice(i,p+1);}
  }
  throw new Error(`unterminated ${name}`);
}
const elements = new Map();
function el(id){ if(!elements.has(id)) elements.set(id,{id,innerHTML:'',textContent:'',innerText:'',value:'',className:'',classList:{add(){},remove(){},toggle(){}}}); return elements.get(id); }
global.document = { getElementById: el };
global.escapeHtml = s => String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':'&quot;',"'":'&#39;'}[m]));
global.jsArg = v => JSON.stringify(v);
global.formatShortDate = v => `S:${v}`;
global.formatDate = v => `D:${v}`;
global.numFormat = new Intl.NumberFormat('en-US');
global.getPaidAmount = tx => tx.payments.reduce((a,p)=>a+Number(p.amount||0),0);
global.getRemainingAmount = tx => Math.max(0, Number(tx.fee||0)-getPaidAmount(tx));
global.getNextFollowUp = tx => tx.followUps.filter(f=>!f.done).sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt))[0] || null;
for(const n of ['getTransactionTimeline','renderTxStations','renderTxWorkspaceSections']) eval(extract(n));
const tx={id:'abc',fee:100000,stations:[{id:'s1',name:'الحسابات',user:'موظف',date:10},{id:'s2',name:'التدقيق',user:'',date:20}],notes:[{id:'n1',text:'ملاحظة <آمنة>',date:30}],payments:[{id:'p1',amount:25000,method:'نقدي',date:40}],followUps:[{id:'f1',title:'مراجعة',dueAt:'2020-01-01T10:00:00',done:false,createdAt:50}],activity:[{id:'a1',date:60,type:'note',text:'حدث'}],lastUpdate:70};
renderTxStations(tx); renderTxWorkspaceSections(tx);
function assert(cond,msg){if(!cond) throw new Error(msg)}
assert(el('det-stations').innerHTML.includes('mq-case-route-step is-current'),'current route missing');
assert(!el('det-stations').innerHTML.includes('v6-route-'),'legacy route leaked');
assert(el('det-notes-list').innerHTML.includes('mq-case-note-card'),'new note card missing');
assert(el('det-notes-list').innerHTML.includes('&lt;آمنة&gt;'),'note escaping broken');
assert(el('det-followups-list').innerHTML.includes('mq-case-follow-card'),'new follow card missing');
assert(el('det-followups-list').innerHTML.includes('is-overdue'),'overdue followup state missing');
assert(el('det-payments-list').innerHTML.includes('25,000'),'payment rendering wrong');
assert(el('det-timeline-list').innerHTML.includes('mq-case-timeline-item'),'timeline component missing');
assert(el('det-stations-count').textContent===2,'station count wrong');
assert(el('det-notes-count').textContent===1,'note count wrong');
assert(el('det-followups-count').textContent===1,'followup count wrong');
assert(el('det-payments-count').textContent===1,'payment count wrong');
assert(el('det-paid').textContent.includes('25,000'),'paid summary wrong');
assert(el('det-remaining').textContent.includes('75,000'),'remaining summary wrong');
const combined=[...elements.values()].map(x=>x.innerHTML).join('\n');
assert(!/bg-white dark:bg-darkcard|v6-workspace-|v6-panel-list|text-\[10px\]/.test(combined),'legacy generated markup leaked');
console.log('WORKSPACE_RENDERER_SMOKE PASS');
