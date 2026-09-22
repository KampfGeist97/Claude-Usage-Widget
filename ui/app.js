'use strict';

const api = window.claudeWidget;
const authView = document.querySelector('#authView');
const usageView = document.querySelector('#usageView');
const settingsView = document.querySelector('#settings');
const limitsEl = document.querySelector('#limits');
const creditsEl = document.querySelector('#credits');
const statusEl = document.querySelector('#status');
const authMessage = document.querySelector('#authMessage');
const refreshInterval = document.querySelector('#refreshInterval');
const rememberPosition = document.querySelector('#rememberPosition');
const hideOnFocusLoss = document.querySelector('#hideOnFocusLoss');
let currentView = null;

function show(which) {
  [authView, usageView, settingsView].forEach(x => x.classList.add('hidden'));
  which.classList.remove('hidden');
  currentView = which;
}

function humanReset(sec) {
  if (sec == null) return 'kein Reset angegeben';
  if (sec <= 0) return 'Reset fällig';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `in ${d}T ${h}h` : h ? `in ${h}h ${m}m` : `in ${m}m`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(snapshot) {
  limitsEl.innerHTML = '';
  if (!snapshot?.limits?.length) {
    limitsEl.innerHTML = '<div class="error">Claude hat aktuell keine Limits in einem bekannten Format geliefert.</div>';
  }
  for (const item of snapshot?.limits || []) {
    const used = Math.max(0, Math.min(100, Number(item.percent_used) || 0));
    const cls = used >= 90 ? 'bad' : used >= 75 ? 'warn' : '';
    const card = document.createElement('div');
    card.className = 'limit';
    card.innerHTML = `<div class="limit-head"><span class="limit-name">${esc(item.label)}</span><span class="limit-pct">${used.toFixed(0)} % genutzt</span></div><div class="bar"><div class="fill ${cls}" style="width:${used}%"></div></div><div class="meta"><span>${(100 - used).toFixed(0)} % frei</span><span>Reset ${esc(humanReset(item.reset_in_seconds))}</span></div>`;
    limitsEl.appendChild(card);
  }

  const c = snapshot?.credits;
  if (c?.enabled) {
    let fmt;
    try { fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: c.currency || 'USD' }); }
    catch { fmt = { format: v => `${v} ${c.currency || ''}`.trim() }; }
    creditsEl.innerHTML = `<h3>Extra Usage / Credits</h3><div class="value">${c.used != null ? fmt.format(c.used) : '–'}</div><div class="meta"><span>${c.limit != null ? 'Limit ' + fmt.format(c.limit) : c.balance != null ? 'Guthaben ' + fmt.format(c.balance) : ''}</span><span>${c.percent != null ? Number(c.percent).toFixed(0) + ' %' : ''}</span></div>`;
    creditsEl.classList.remove('hidden');
  } else {
    creditsEl.classList.add('hidden');
  }

  const fetched = snapshot?.fetched_at ? new Date(snapshot.fetched_at) : new Date();
  statusEl.textContent = 'Live · ' + fetched.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  show(usageView);
}

function renderError(error) {
  limitsEl.innerHTML = `<div class="error">${esc(error?.message || error || 'Unbekannter Fehler')}</div>`;
  creditsEl.classList.add('hidden');
  statusEl.textContent = 'Fehler';
  show(usageView);
}

async function refresh() {
  statusEl.textContent = 'Aktualisiere …';
  try {
    const snapshot = await api.refreshUsage();
    render(snapshot);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/AUTH_REQUIRED|401|unauthorized|login|sign.?in/i.test(msg)) return checkAuth();
    renderError(msg);
  }
}

async function checkAuth() {
  show(authView);
  authMessage.textContent = 'Claude-WebSession wird geprüft …';
  try {
    const status = await api.getStatus();
    if (status.connected) {
      authMessage.textContent = '';
      const snapshot = await api.getUsage();
      render(snapshot);
      return;
    }
    authMessage.textContent = status.error || 'Noch nicht mit Claude verbunden.';
  } catch (e) {
    authMessage.textContent = String(e?.message || e);
  }
}

async function loadSettings() {
  const s = await api.getSettings();
  rememberPosition.checked = Boolean(s.rememberPosition);
  hideOnFocusLoss.checked = Boolean(s.hideOnFocusLoss);
  refreshInterval.value = String(s.refreshSeconds || 60);
  try { document.querySelector('#autostart').checked = await api.getAutostart(); } catch {}
}

document.querySelector('#refreshBtn').onclick = refresh;
document.querySelector('#hideBtn').onclick = () => api.hide();
document.querySelector('#loginBtn').onclick = async () => {
  authMessage.textContent = 'Claude-Anmeldung wird geöffnet …';
  await api.login();
  authMessage.textContent = 'Anmeldung im Claude-Fenster abschließen. Danach aktualisiert sich das Widget automatisch.';
};
document.querySelector('#reloginBtn').onclick = () => api.login();
document.querySelector('#menuBtn').onclick = async () => { await loadSettings(); show(settingsView); };
document.querySelector('#settingsBack').onclick = () => show(usageView);
document.querySelector('#autostart').onchange = async e => {
  try { e.target.checked = await api.setAutostart(e.target.checked); }
  catch (err) { e.target.checked = !e.target.checked; alert(String(err)); }
};
rememberPosition.onchange = async e => api.updateSettings({ rememberPosition: e.target.checked });
hideOnFocusLoss.onchange = async e => api.updateSettings({ hideOnFocusLoss: e.target.checked });
refreshInterval.onchange = async e => api.updateSettings({ refreshSeconds: Number(e.target.value) });
document.querySelector('#logoutBtn').onclick = async () => {
  await api.logout();
  await checkAuth();
};
document.querySelector('#quitBtn').onclick = () => api.quit();

api.onUsageUpdated(payload => {
  if (payload?.ok && payload.snapshot) render(payload.snapshot);
  else if (payload?.error && currentView !== settingsView) renderError(payload.error);
});
api.onSessionChanged(payload => {
  if (payload?.connected) {
    authMessage.textContent = '';
    void api.getUsage().then(render).catch(() => {});
  } else if (currentView !== settingsView) {
    show(authView);
    authMessage.textContent = payload?.error || 'Claude-Anmeldung erforderlich.';
  }
});

void checkAuth();
