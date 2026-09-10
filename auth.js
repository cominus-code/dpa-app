// ---------------------------------------------------------------------
// DPA – auth layer (Supabase). Loads before app.js/rules.js and blocks
// the existing UI behind a full-screen gate until the visitor is signed
// in with a real account. Talks to Supabase directly (auth + Postgres via
// RLS); the two admin-only account actions go through Edge Functions
// (admin-create-user, admin-reset-password) since they need the service
// role key, which never reaches this client code.
// ---------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://eofzfjzwvcqphsrgfnhw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ATqeI5AqKQ13OKK8lZzhdg_iQ5aO2oe';
const EMAIL_DOMAIN = 'dpa-test.internal';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentProfile = null;
export function getProfile() { return currentProfile; }

// -----------------------------------------------------------------
// Gate markup — injected once, styled to match the existing header
// (dark plum / purple, same tokens as style.css).
// -----------------------------------------------------------------
const gate = document.createElement('div');
gate.id = 'authgate';
gate.innerHTML = `
  <div class="authcard">
    <div class="authbrand"><span class="brandmark">◒</span><span>DPA<small>Projektplan</small></span></div>
    <div id="authbody"></div>
  </div>`;
document.body.appendChild(gate);
const authbody = () => document.getElementById('authbody');

function showGate() { gate.style.display = 'flex'; }
function hideGate() { gate.style.display = 'none'; }

// -----------------------------------------------------------------
// Login form
// -----------------------------------------------------------------
function renderLogin(message) {
  authbody().innerHTML = `
    <h1>Logga in</h1>
    <p class="muted">Använd det användarnamn och lösenord du fått av din administratör.</p>
    ${message ? `<div class="autherror">${message}</div>` : ''}
    <label>Användarnamn<input id="li-username" autocomplete="username" autofocus></label>
    <label>Lösenord<input id="li-password" type="password" autocomplete="current-password"></label>
    <button class="primary" id="li-submit" style="width:100%">Logga in</button>
  `;
  const submit = async () => {
    const username = document.getElementById('li-username').value.trim().toLowerCase();
    const password = document.getElementById('li-password').value;
    if (!username || !password) return renderLogin('Ange användarnamn och lösenord.');
    const btn = document.getElementById('li-submit');
    btn.disabled = true; btn.textContent = 'Loggar in...';
    const { error } = await supabase.auth.signInWithPassword({ email: `${username}@${EMAIL_DOMAIN}`, password });
    if (error) { renderLogin('Fel användarnamn eller lösenord.'); return; }
    await afterSignIn();
  };
  document.getElementById('li-submit').onclick = submit;
  authbody().querySelectorAll('input').forEach(inp => inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
}

// -----------------------------------------------------------------
// Forced password change (first login, or after an admin reset)
// -----------------------------------------------------------------
function renderChangePassword(opts) {
  const forced = !!(opts && opts.forced);
  authbody().innerHTML = `
    <h1>${forced ? 'Byt lösenord för att fortsätta' : 'Byt lösenord'}</h1>
    <p class="muted">${forced ? 'Det här är ett tillfälligt lösenord. Välj ett eget innan du fortsätter.' : 'Välj ett nytt lösenord för ditt konto.'}</p>
    <div id="cp-error" class="autherror" style="display:none"></div>
    <label>Nytt lösenord (minst 8 tecken)<input id="cp-new" type="password" autocomplete="new-password"></label>
    <label>Upprepa nytt lösenord<input id="cp-repeat" type="password" autocomplete="new-password"></label>
    <button class="primary" id="cp-submit" style="width:100%">Spara nytt lösenord</button>
    ${forced ? '' : '<button class="textbutton" id="cp-cancel" style="width:100%;margin-top:6px">Avbryt</button>'}
  `;
  if (!forced) document.getElementById('cp-cancel').onclick = () => finishBoot();
  document.getElementById('cp-submit').onclick = async () => {
    const a = document.getElementById('cp-new').value;
    const b = document.getElementById('cp-repeat').value;
    const err = document.getElementById('cp-error');
    if (a.length < 8) { err.textContent = 'Minst 8 tecken.'; err.style.display = 'block'; return; }
    if (a !== b) { err.textContent = 'Lösenorden matchar inte.'; err.style.display = 'block'; return; }
    const btn = document.getElementById('cp-submit');
    btn.disabled = true; btn.textContent = 'Sparar...';
    const { error } = await supabase.auth.updateUser({ password: a });
    if (error) { err.textContent = error.message; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Spara nytt lösenord'; return; }
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('profiles').update({ must_change_password: false }).eq('id', user.id);
    currentProfile.must_change_password = false;
    finishBoot();
  };
}

// -----------------------------------------------------------------
// Admin panel — list, create, reset. Rendered inside the existing
// #modal <dialog> so it reuses the app's own modal chrome/styling.
// -----------------------------------------------------------------
async function callFn(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Fel (${res.status})`);
  return data;
}

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint32Array(14))).map(n => chars[n % chars.length]).join('');
}

async function openAdminPanel() {
  const modal = document.getElementById('modal');
  const { data: users } = await supabase.from('profiles').select('id,username,full_name,role,must_change_password,created_at').order('created_at');
  modal.innerHTML = `
    <form method="dialog"><h2 id="modal-title">Administrera användare</h2>
    <p class="muted">Konton skapas direkt här — ingen e-postinbjudan. Lösenordet visas en gång; ge det till personen själv.</p>
    <table class="admintable"><thead><tr><th>Användarnamn</th><th>Namn</th><th>Roll</th><th>Status</th><th></th></tr></thead>
    <tbody>${users.map(u => `
      <tr>
        <td>${u.username}</td><td>${u.full_name}</td><td>${u.role === 'admin' ? 'Admin' : 'LPL'}</td>
        <td>${u.must_change_password ? '<span class="pill pill-yellow">Måste byta lösenord</span>' : '<span class="pill pill-green">Aktivt</span>'}</td>
        <td><button type="button" class="textbutton" data-reset="${u.id}" data-uname="${u.username}">Återställ lösenord</button></td>
      </tr>`).join('')}
    </tbody></table>
    <hr>
    <h3>Skapa ny användare</h3>
    <div id="cu-error" class="autherror" style="display:none"></div>
    <label>Användarnamn<input id="cu-username" placeholder="t.ex. kollega1"></label>
    <label>Namn<input id="cu-fullname" placeholder="t.ex. Anna Andersson"></label>
    <label>Roll<select id="cu-role"><option value="lpl">Leveransprojektledare</option><option value="admin">Admin</option></select></label>
    <label>Tillfälligt lösenord<span style="display:flex;gap:6px"><input id="cu-password" value="${randomPassword()}"><button type="button" class="textbutton" id="cu-regen">↻</button></span></label>
    <div class="pagehead" style="margin-top:14px"><span></span><span style="display:flex;gap:8px">
      <button type="button" id="cu-cancel">Stäng</button>
      <button type="button" class="primary" id="cu-submit">Skapa användare</button>
    </span></div>
    </form>`;
  modal.showModal();
  document.getElementById('cu-cancel').onclick = () => modal.close();
  document.getElementById('cu-regen').onclick = () => { document.getElementById('cu-password').value = randomPassword(); };
  document.querySelectorAll('[data-reset]').forEach(btn => btn.onclick = async () => {
    const pw = randomPassword();
    if (!confirm(`Sätt nytt tillfälligt lösenord för "${btn.dataset.uname}"?\n\nNytt lösenord: ${pw}\n\nDetta visas bara nu — kopiera det innan du fortsätter.`)) return;
    try { await callFn('admin-reset-password', { user_id: btn.dataset.reset, password: pw }); alert(`Nytt lösenord för ${btn.dataset.uname}:\n${pw}\n\n(Personen måste byta det vid nästa inloggning.)`); }
    catch (e) { alert('Kunde inte återställa: ' + e.message); }
  });
  document.getElementById('cu-submit').onclick = async () => {
    const err = document.getElementById('cu-error');
    err.style.display = 'none';
    const username = document.getElementById('cu-username').value.trim().toLowerCase();
    const full_name = document.getElementById('cu-fullname').value.trim();
    const role = document.getElementById('cu-role').value;
    const password = document.getElementById('cu-password').value;
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) { err.textContent = 'Ogiltigt användarnamn (3–24 tecken: a-z, 0-9, . _ -).'; err.style.display = 'block'; return; }
    if (!full_name) { err.textContent = 'Ange ett namn.'; err.style.display = 'block'; return; }
    try {
      await callFn('admin-create-user', { username, full_name, role, password });
      alert(`Konto skapat!\n\nAnvändarnamn: ${username}\nLösenord: ${password}\n\nGe uppgifterna till personen direkt — de visas inte igen. Personen måste byta lösenord vid första inloggning.`);
      modal.close();
      openAdminPanel();
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  };
}

// -----------------------------------------------------------------
// Boot sequence
// -----------------------------------------------------------------
async function afterSignIn() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return renderLogin();
  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (error || !profile) return renderLogin('Kunde inte hämta din profil. Kontakta en administratör.');
  currentProfile = profile;
  if (profile.must_change_password) { renderChangePassword({ forced: true }); return; }
  finishBoot();
}

function finishBoot() {
  hideGate();
  injectUserChrome();
}

function injectUserChrome() {
  const identity = document.querySelector('.identity');
  if (identity) {
    const initials = (currentProfile.full_name || currentProfile.username).split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    identity.innerHTML = `
      <b>${initials}</b>
      <span>${currentProfile.full_name}<small>${currentProfile.role === 'admin' ? 'Administratör' : 'Leveransprojektledare'}</small></span>
      <button type="button" class="textbutton" id="chrome-changepw">Byt lösenord</button>
      <button type="button" class="textbutton" id="chrome-logout">Logga ut</button>
    `;
    document.getElementById('chrome-changepw').onclick = () => { showGate(); renderChangePassword({ forced: false }); };
    document.getElementById('chrome-logout').onclick = async () => { await supabase.auth.signOut(); location.reload(); };
  }
  const nav = document.querySelector('nav[aria-label="Huvudnavigation"]');
  if (nav && currentProfile.role === 'admin' && !document.getElementById('nav-admin')) {
    const b = document.createElement('button');
    b.id = 'nav-admin'; b.textContent = 'Administrera';
    b.onclick = () => openAdminPanel();
    nav.appendChild(b);
  }
}

(async function boot() {
  showGate();
  authbody().innerHTML = '<p class="muted">Laddar...</p>';
  const { data: { session } } = await supabase.auth.getSession();
  if (session) { await afterSignIn(); } else { renderLogin(); }
})();
