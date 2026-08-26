'use strict';
const fs=require('fs'),vm=require('vm');
const appSrc=fs.readFileSync(__dirname+'/app.js','utf8');
const prodSrc=fs.readFileSync(__dirname+'/productivity.js','utf8');
function extractFunction(src,name){
  const re=new RegExp('function\\s+'+name+'\\s*\\('),m=re.exec(src); if(!m) throw new Error('missing '+name);
  const start=m.index,brace=src.indexOf('{',start); let d=0,q=null,e=false;
  for(let i=brace;i<src.length;i++){const c=src[i];if(q){if(e)e=false;else if(c==='\\')e=true;else if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==='`'){q=c;continue;}if(c==='{')d++;else if(c==='}'&&--d===0)return src.slice(start,i+1);}throw new Error('unterminated '+name);
}
class CL{constructor(){this.s=new Set()}add(...x){x.forEach(v=>this.s.add(v))}remove(...x){x.forEach(v=>this.s.delete(v))}contains(x){return this.s.has(x)}}
class El{constructor(id=''){this.id=id;this.classList=new CL();this.style={};this.dataset={};this.innerHTML='';this.textContent='';this.innerText='';this.disabled=false;this.parentNode={};this.listeners={};}
 setAttribute(k,v){this[k]=v} addEventListener(t,fn){(this.listeners[t]??=[]).push(fn)} removeEventListener(t,fn){this.listeners[t]=(this.listeners[t]||[]).filter(x=>x!==fn)} emit(t){for(const fn of [...(this.listeners[t]||[])])fn({type:t})} remove(){this.removed=true;this.parentNode=null}}
const els={}; const get=id=>els[id]||(els[id]=new El(id));
['mq-boot-screen','mq-boot-status','app-shell','supabase-login-modal','supabase-login-message'].forEach(get);
const ctx={document:{getElementById:get},window:{setTimeout:(fn)=>{fn();return 1}},escapeHtml:v=>String(v??'').replace(/[&<>"']/g,''),console}; vm.createContext(ctx);
for(const n of ['setBootStatus','finishBoot','setAuthButtonBusy','showSupabaseLogin']) vm.runInContext(extractFunction(appSrc,n),ctx);
ctx.setBootStatus('اختبار'); if(get('mq-boot-status').textContent!=='اختبار') throw new Error('boot status');
ctx.showSupabaseLogin('رسالة');
if(!get('app-shell').classList.contains('hidden')) throw new Error('app should hide for auth');
if(get('supabase-login-modal').style.display!=='flex') throw new Error('auth should display');
if(!get('mq-boot-screen').classList.contains('is-done')) throw new Error('boot should finish on auth state');
const b=new El('b'); b.innerHTML='<span>دخول</span><i></i>'; ctx.setAuthButtonBusy(b,true,'جارٍ');
if(!b.disabled||b['aria-busy']!=='true'||!b.innerHTML.includes('fa-spinner')) throw new Error('busy on');
ctx.setAuthButtonBusy(b,false); if(b.disabled||b['aria-busy']!=='false'||!b.innerHTML.includes('دخول')) throw new Error('busy restore');

// Lazy-library loader: a failed script must be removed so a second call can retry.
class Script extends El{constructor(){super();this.src='';}}
const scripts=[]; const head={appendChild(s){scripts.push(s);s.parentNode=head;return s}};
const prodCtx={state:{libraryPromises:new Map()},document:{scripts,head,createElement:()=>new Script()},window:{setTimeout:(fn)=>setTimeout(fn,1000),clearTimeout},PRODUCTIVITY_VERSION:'final',Error,Promise,console,clearTimeout};
vm.createContext(prodCtx); vm.runInContext(extractFunction(prodSrc,'loadScriptOnce'),prodCtx);
(async()=>{
 let ready=false; const p1=prodCtx.loadScriptOnce('https://cdn.example/x.js',()=>ready); const s1=scripts[0]; s1.emit('error');
 let failed=false; try{await p1}catch(_){failed=true} if(!failed||!s1.removed) throw new Error('failed script not cleaned');
 const p2=prodCtx.loadScriptOnce('https://cdn.example/x.js',()=>ready); const s2=scripts[scripts.length-1]; if(s2===s1) throw new Error('retry did not create script'); ready=true; s2.emit('load'); await p2;
 if(s2.dataset.mqLoadState!=='loaded') throw new Error('loader did not mark loaded');
 console.log('FINAL_HARDENING_SMOKE PASS — boot/auth busy + retryable bounded lazy loader');
})().catch(e=>{console.error(e);process.exit(1)});
