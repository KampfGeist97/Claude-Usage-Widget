const { invoke } = window.__TAURI__.core;
const authView = document.querySelector('#authView');
const usageView = document.querySelector('#usageView');
const settings = document.querySelector('#settings');
const limitsEl = document.querySelector('#limits');
const creditsEl = document.querySelector('#credits');
const statusEl = document.querySelector('#status');
const authMessage = document.querySelector('#authMessage');
const refreshInterval = document.querySelector('#refreshInterval');
let refreshTimer = null;
let lastSnapshot = null;

function show(which){
  [authView,usageView,settings].forEach(x=>x.classList.add('hidden'));
  which.classList.remove('hidden');
}
function humanReset(sec){
  if(sec==null)return 'kein Reset angegeben';
  if(sec<=0)return 'Reset fällig';
  const d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60);
  return d?`in ${d}T ${h}h`:h?`in ${h}h ${m}m`:`in ${m}m`;
}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render(snapshot){
  lastSnapshot=snapshot;
  limitsEl.innerHTML='';
  if(!snapshot.limits?.length){limitsEl.innerHTML='<div class="error">Anthropic hat aktuell keine Limits in einem bekannten Format geliefert.</div>';}
  for(const item of snapshot.limits||[]){
    const used=Math.max(0,Math.min(100,Number(item.percent_used)||0));
    const cls=used>=90?'bad':used>=75?'warn':'';
    const card=document.createElement('div'); card.className='limit';
    card.innerHTML=`<div class="limit-head"><span class="limit-name">${esc(item.label)}</span><span class="limit-pct">${used.toFixed(0)} % genutzt</span></div><div class="bar"><div class="fill ${cls}" style="width:${used}%"></div></div><div class="meta"><span>${(100-used).toFixed(0)} % frei</span><span>Reset ${esc(humanReset(item.reset_in_seconds))}</span></div>`;
    limitsEl.appendChild(card);
  }
  const c=snapshot.credits;
  if(c?.enabled){
    const fmt=new Intl.NumberFormat('de-DE',{style:'currency',currency:c.currency||'USD'});
    creditsEl.innerHTML=`<h3>Extra Usage / Credits</h3><div class="value">${c.used!=null?fmt.format(c.used):'–'}</div><div class="meta"><span>${c.limit!=null?'Limit '+fmt.format(c.limit):c.balance!=null?'Guthaben '+fmt.format(c.balance):''}</span><span>${c.percent!=null?Number(c.percent).toFixed(0)+' %':''}</span></div>`;
    creditsEl.classList.remove('hidden');
  }else creditsEl.classList.add('hidden');
  statusEl.textContent='Aktualisiert '+new Date(snapshot.fetched_at).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
async function refresh(){
  statusEl.textContent='Aktualisiere …';
  try{ const s=await invoke('get_usage'); render(s); show(usageView); }
  catch(e){
    const msg=String(e);
    if(msg.includes('AUTH_REQUIRED')) return checkAuth();
    limitsEl.innerHTML=`<div class="error">${esc(msg)}</div>`; show(usageView); statusEl.textContent='Fehler';
  }
}
async function checkAuth(){
  try{
    const a=await invoke('auth_status');
    if(a.connected){authMessage.textContent=''; await refresh(); return;}
    show(authView);
    authMessage.textContent=a.oauth_error|| (a.oauth_pending?'Browser-Anmeldung läuft …':'');
  }catch(e){show(authView);authMessage.textContent=String(e);}
}
function setTimer(){
  if(refreshTimer)clearInterval(refreshTimer);
  const seconds=Number(localStorage.getItem('refreshSeconds')||60);
  refreshInterval.value=String(seconds);
  refreshTimer=setInterval(()=>refresh(),Math.max(60,seconds)*1000);
}

document.querySelector('#refreshBtn').onclick=refresh;
document.querySelector('#hideBtn').onclick=()=>invoke('hide_window');
document.querySelector('#loginBtn').onclick=async()=>{authMessage.textContent='Browser wird geöffnet …';try{await invoke('start_oauth');authMessage.textContent='Anmeldung im Browser abschließen …';}catch(e){authMessage.textContent=String(e);}};
document.querySelector('#menuBtn').onclick=async()=>{show(settings);try{document.querySelector('#autostart').checked=await invoke('get_autostart');}catch{}};
document.querySelector('#settingsBack').onclick=()=>show(usageView);
document.querySelector('#autostart').onchange=async e=>{try{await invoke('set_autostart',{enabled:e.target.checked});}catch(err){e.target.checked=!e.target.checked;alert(String(err));}};
refreshInterval.onchange=e=>{localStorage.setItem('refreshSeconds',e.target.value);setTimer();};
document.querySelector('#logoutBtn').onclick=async()=>{await invoke('disconnect');lastSnapshot=null;checkAuth();};
document.querySelector('#quitBtn').onclick=()=>invoke('quit_app');

window.__TAURI__.event.listen('auth-changed',()=>checkAuth());
window.__TAURI__.event.listen('manual-refresh',()=>refresh());
setTimer(); checkAuth();
