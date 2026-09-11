'use strict';
import { getProfile } from './auth.js';
import * as DB from './db.js';

const $ = s => document.querySelector(s), R = DPARules;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dot = (s = 'unknown') => `<span class="dot ${s}" aria-hidden="true"></span>`;
const statuses = { green: 'Uppfyllt', yellow: 'Bevaka', red: 'Kräver åtgärd', unknown: 'Behov ej bedömt', missing: 'Saknar koppling', na: 'Inte aktuellt' };
const statusHTML = s => `<span class="status">${dot(s)}${statuses[s] || 'Ej bedömt'}</span>`;
const cols = [['startup', 'Uppstartsmöte', 'FB-nummer'], ['fn1', 'Fastighetsnät 1', 'FB-nummer'], ['fn2', 'Fastighetsnät 2', 'FB-nummer'], ['fiber', 'Trade / Colt', 'Ordernummer'], ['cs', 'CS-nummer', 'Kommunikation'], ['object', 'Skapat objekt', 'Ja / Nej']];

// ---------------------------------------------------------------------
// State — now a client-side cache of the database, not the source of
// truth. refreshState() re-fetches everything; every mutation goes
// through db.js first, then re-fetches on success (simple and correct,
// rather than juggling two sources of truth for a 3-person test app).
// ---------------------------------------------------------------------
let state = { today: new Date().toISOString().slice(0, 10), projects: [] };
let view = 'projects', search = '', filter = 'all', owner = null, openProjects = new Set(), openStages = new Set(), tabs = {};
let unlinkedCache = null;

const currentUserName = () => getProfile()?.full_name || '';
const project = id => state.projects.find(p => p.id === id);
const customerNames = p => [...new Set([...p.deliveries.map(l => l.customer).filter(Boolean), ...p.customers.map(c => c.name)])];
const allOwners = () => [...new Set(state.projects.map(p => p.owner))].sort();

function aggregate(ss) { return ss.includes('red') ? 'red' : ss.includes('yellow') ? 'yellow' : ss.some(s => ['unknown', 'missing'].includes(s)) ? 'unknown' : ss.length && ss.some(s => s === 'green') ? 'green' : 'unknown'; }
function pointStatus(c) { if (c.status === 'na') return 'na'; if (['missing', 'unknown', 'red'].includes(c.status)) return c.status; if (c.status !== 'green' && c.date && c.date < state.today) return 'red'; return c.status; }
function followStatus(l) { if (l.closed) return 'green'; const d = R.due(l); return d < state.today ? 'red' : d <= R.days(state.today, 7) ? 'yellow' : 'unknown'; }
function stageStatus(s) { return aggregate(Object.values(s.points).map(pointStatus)); }
function deliveryStatus(l) { if (l.closed) return 'green'; const ss = [...Object.values(l.points).map(pointStatus), ...l.stages.map(stageStatus)]; if (R.due(l) < state.today || l.deliveryDate < state.today || l.reportDate && l.reportDate < state.today) ss.push('red'); return aggregate(ss); }
function projectStatus(p) { return aggregate(p.deliveries.map(deliveryStatus)); }

function toast(t) { $('#toast').textContent = t; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 4500); }
function btn(action, text, p = '', l = '', extra = '') { return `<button type="button" data-action="${action}" data-p="${p}" data-l="${l}" ${extra}>${text}</button>`; }
function field(label, name, value = '', type = 'text', required = false) { return `<label>${label}<input type="${type}" name="${name}" value="${esc(value)}" ${required ? 'required' : ''}></label>`; }
function dialog(title, body, submit, fn) {
  const el = $('#modal');
  el.innerHTML = `<form><button type="button" class="close" data-close="modal" aria-label="Stäng">×</button><h2 id="modal-title">${esc(title)}</h2>${body}<p class="error" id="form-error" role="alert"></p><div class="actions"><button type="button" data-close="modal">${submit ? 'Avbryt' : 'Stäng'}</button>${submit ? `<button type="submit" class="primary" id="dialog-submit">${submit}</button>` : ''}</div></form>`;
  el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const btnEl = $('#dialog-submit');
    if (btnEl) { btnEl.disabled = true; }
    const result = await fn?.(new FormData(e.target));
    if (btnEl) { btnEl.disabled = false; }
    if (result !== false) el.close();
  };
  if (!el.open) el.showModal();
}
function fail(t) { $('#form-error').textContent = t; return false; }
function panel(title, body) { $('#drawer').innerHTML = `<button class="close" data-close="drawer" aria-label="Stäng sidopanel">×</button><h2 id="drawer-title">${esc(title)}</h2>${body}`; if (!$('#drawer').open) $('#drawer').showModal(); }
function pageHead(title, sub, actions = '') { return `<div class="pagehead"><div><h1>${title}</h1><p>${sub}</p></div>${actions}</div>`; }

// Runs a write, refreshes state on success, and turns thrown DbErrors
// into the dialog's inline error message instead of a silent failure.
async function runWrite(promise, { thenRender = true } = {}) {
  try {
    await promise;
    await refreshState({ silent: true });
    if (thenRender) render();
    return true;
  } catch (e) {
    if (e.kind === 'conflict') {
      toast(e.message + ' Sidan uppdateras med senaste versionen.');
      await refreshState({ silent: true });
      render();
      return fail(e.message + ' Din ändring sparades inte — försök igen med de nya uppgifterna.');
    }
    return fail(e.message || 'Något gick fel.');
  }
}

// ---------------------------------------------------------------------
// Load / refresh
// ---------------------------------------------------------------------
async function refreshState({ silent } = {}) {
  if (!silent) setLoading(true);
  try {
    state = await DB.loadState();
    if (!owner || !allOwners().includes(owner)) owner = currentUserName();
  } catch (e) {
    toast('Kunde inte hämta data: ' + e.message);
  } finally {
    if (!silent) setLoading(false);
  }
}
function setLoading(v) {
  const el = $('#app');
  if (v) el.innerHTML = '<div class="empty">Laddar…</div>';
}

// ---------------------------------------------------------------------
// Rendering — unchanged from the original design/behaviour, just reads
// from the (now database-backed) state.
// ---------------------------------------------------------------------
function render() {
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  if (['projects', 'all'].includes(view)) renderProjects();
  else if (view === 'followups' || view === 'reminders') renderTasks();
  else if (view === 'unlinked') renderUnlinked();
  else renderTeam();
}

function renderProjects() {
  const mine = state.projects.filter(p => view === 'all' || owner === 'all' || p.owner === owner);
  const counts = s => mine.filter(p => projectStatus(p) === s).length;
  $('#app').innerHTML = pageHead('Projektöversikt', 'Projekt, leveranser och etapper i en samlad vy.', btn('new', '＋ Skapa nytt projekt', '', '', 'class="primary"')) +
    `<div class="stats">${[['red', counts('red'), 'Projekt kräver åtgärd', 'Minst en avvikelse'], ['yellow', counts('yellow'), 'Projekt att bevaka', 'Följ nästa steg'], ['green', counts('green'), 'Projekt uppfyllda', 'Kontrollpunkter klara'], ['all', mine.length, 'Totalt antal projekt', `${mine.reduce((n, p) => n + p.deliveries.length, 0)} leveranser · ${mine.reduce((n, p) => n + p.deliveries.reduce((v, l) => v + l.stages.length, 0), 0)} etapper`]].map(([s, n, t, h]) => `<button class="stat" data-filter="${s}">${dot(s)}<div><strong>${n}</strong><span>${t}</span><small>${h}</small></div></button>`).join('')}</div>` +
    `<div class="toolbar"><input id="search" aria-label="Sök projekt, kund eller order" placeholder="Sök projekt, kund, RO eller GA1…" value="${esc(search)}"><select id="status-filter" aria-label="Filtrera status"><option value="all">Alla statusar</option><option value="red">Kräver åtgärd</option><option value="yellow">Bevaka</option><option value="green">Uppfyllt</option><option value="unknown">Behov ej bedömt</option></select><select id="owner-filter" aria-label="Projektledare"><option value="all">Alla projektledare</option>${allOwners().map(o => `<option ${o === owner ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select><button class="reset" data-action="reset-filter">Återställ filter</button></div><div id="projects-result"></div>`;
  $('#status-filter').value = filter;
  $('#owner-filter').value = view === 'all' ? 'all' : owner;
  $('#search').oninput = e => { search = e.target.value; drawProjects(); };
  $('#status-filter').onchange = e => { filter = e.target.value; drawProjects(); };
  $('#owner-filter').onchange = e => { owner = e.target.value; view = 'projects'; render(); };
  drawProjects();
}
function drawProjects() {
  const list = state.projects.filter(p => view === 'all' || owner === 'all' || p.owner === owner).filter(p => JSON.stringify(p).toLowerCase().includes(search.toLowerCase())).filter(p => filter === 'all' || projectStatus(p) === filter);
  $('#projects-result').innerHTML = `<div class="tablewrap"><table class="projecttable"><thead><tr><th>Projekt</th><th>Projektnummer</th><th>Kund</th><th>Projektledare</th><th>Leveranser</th><th>Etapper</th><th>Önskat sista datum</th><th>Faktiskt datum</th><th>Påminnelse</th><th>Status</th></tr></thead><tbody>${list.map(p => `<tr class="projectrow ${openProjects.has(p.id) ? 'open' : ''}"><td>${btn('expand', `<span>${openProjects.has(p.id) ? '⌄' : '›'}</span>${esc(p.name)}`, p.id, '', `class="projectname" aria-expanded="${openProjects.has(p.id)}"`)}</td><td>${p.number}</td><td>${esc(customerNames(p).join(', ') || 'Ej kopplad')}</td><td>${esc(p.owner)}</td><td>${p.deliveries.length}</td><td>${p.deliveries.reduce((n, l) => n + l.stages.length, 0)}</td><td>${p.desired || '–'}</td><td>${p.actual || '–'}</td><td class="${p.reminder && p.reminder <= state.today ? 'overdue' : ''}">${p.reminder || '–'}</td><td>${statusHTML(projectStatus(p))}</td></tr>${openProjects.has(p.id) ? `<tr><td colspan="10" class="expandcell">${projectDetail(p)}</td></tr>` : ''}`).join('') || '<tr><td colspan="10" class="empty">Inga projekt matchar ditt urval.</td></tr>'}</tbody></table></div><div class="legend"><strong>Statusförklaring:</strong><span>${dot('green')}Uppfyllt</span><span>${dot('yellow')}Bevaka</span><span>${dot('red')}Kräver åtgärd</span><span>${dot('na')}Inte aktuellt</span><span>${dot('unknown')}Saknar koppling / ej bedömt</span></div>`;
}
function projectDetail(p) {
  const tab = tabs[p.id] || 'deliveries';
  return `<div class="projectdetail"><div class="detailhead"><div class="actions"><h2>${esc(p.name)}</h2>${statusHTML(projectStatus(p))}</div><div class="actions">${btn('edit-project', '✎ Redigera projekt', p.id)}${btn('takeover', 'Ta över projekt', p.id, '', p.owner === currentUserName() ? 'disabled' : '')}${btn('delete-project', '🗑 Ta bort projekt', p.id)}</div></div><section class="info"><h3>Projektinformation</h3><div class="infofields">${[['Projektnummer', p.number], ['Kundbolag', customerNames(p).join(', ') || 'Ej kopplat'], ['Projektledare', p.owner], ['Önskat sista leveransdatum', p.desired || '–'], ['Faktiskt datum', p.actual || '–'], ['Påminnelsedatum', p.reminder || '–']].map(([k, v]) => `<div><small>${k}</small>${esc(v)}</div>`).join('')}</div><div class="notehead"><strong>Projektanteckning</strong>${btn('note', '✎ Redigera', p.id)}</div><div class="notetext">${esc(p.note || 'Ingen projektanteckning ännu.')}</div><div class="notemeta">${p.noteAt ? 'Senast uppdaterad: ' + esc(p.noteAt) : 'Intern anteckning'}</div></section><div class="tabline"><div class="tabs">${[['deliveries', `Leveranser (${p.deliveries.length})`], ['customers', 'Kundbolag'], ['history', `Historik`]].map(([key, name]) => btn('tab', name, p.id, '', `data-tab="${key}" class="${tab === key ? 'active' : ''}"`)).join('')}${btn('report', 'Kunduppdatering', p.id)}</div>${btn('link-delivery', '＋ Lägg till leverans', p.id)}</div>${tab === 'history' ? `<div id="history-slot-${p.id}"><p class="muted">Laddar historik…</p></div>` : tab === 'customers' ? `<div class="section">${customerNames(p).map(name => `<p><strong>${esc(name)}</strong><br><small>${esc(p.deliveries.find(l => l.customer === name)?.org || p.customers.find(c => c.name === name)?.org || 'Org.nr saknas')}</small></p>`).join('') || '<p>Inga kundbolag kopplade.</p>'}${btn('add-customer', '＋ Lägg till kundbolag', p.id)}</div>` : deliveryTable(p)}</div>`;
}
function loadHistoryIfNeeded(p) {
  const slot = document.getElementById(`history-slot-${p.id}`);
  if (!slot) return;
  DB.fetchHistory(p).then(events => {
    const slot2 = document.getElementById(`history-slot-${p.id}`);
    if (!slot2) return;
    slot2.innerHTML = events.map(h => `<div class="historyitem"><strong>${esc(actionLabel(h.action))}</strong><small>${new Date(h.occurred_at).toLocaleString('sv-SE')} · ${esc(h.actor?.full_name || 'Systemet')}</small>${h.note ? `<p>${esc(h.note)}</p>` : ''}</div>`).join('') || '<p class="muted">Inga ändringar ännu.</p>';
  }).catch(() => { slot.innerHTML = '<p class="muted">Kunde inte hämta historik.</p>'; });
}
function actionLabel(a) {
  return {
    insert: 'Skapad', update: 'Uppdaterad', delete: 'Borttagen', closed: 'Klarskriven', reopened: 'Återöppnad',
    followup_completed: 'Kunduppföljning genomförd', followup_override_set: 'Uppföljningsdatum justerat manuellt',
    ownership_transferred: 'Ägarbyte', note_updated: 'Anteckning ändrad', unlinked_from_project: 'Kopplades bort från projekt',
    linked_to_project: 'Kopplades till projekt', deleted: 'Projekt borttaget', restored: 'Projekt återställt',
  }[a] || a;
}
function cell(p, l, key, s = null) {
  const inherited = s && ['startup', 'fiber'].includes(key);
  const c = inherited ? l.points[key] : (s ? s.points[key] : l.points[key]);
  if (!c) return '–';
  const status = pointStatus(c);
  return `<button class="cellbutton" data-action="point" data-p="${p.id}" data-l="${l.id}" data-key="${key}" ${s ? `data-stage="${s.id}"` : ''}>${dot(status)}${esc(c.ref || statuses[status] || 'Saknar koppling')}<small>${inherited ? 'Gemensamt på leveransen' : c.date || statuses[status]}</small></button>`;
}
function deliveryTable(p) {
  return `<div class="tablewrap"><table class="deliverytable"><thead><tr><th>Leveransnamn</th><th>Status</th><th>Leveransorder<br><small>RO / GA1</small></th>${cols.map(([, label, sub]) => `<th>${label}<br><small>${sub}</small></th>`).join('')}<th>Leveransdatum<br><small>Från order</small></th><th>Slutrapportering<br><small>Planerat datum</small></th><th>Kunduppföljning<br><small>Nästa datum</small></th><th>Klarskriv leveransen</th><th></th><th>Etapper</th></tr></thead><tbody>${p.deliveries.map(l => `<tr><td>${btn('stages', `${openStages.has(l.id) ? '⌄' : '›'} ${esc(l.name)}`, p.id, l.id, `class="projectname" aria-expanded="${openStages.has(l.id)}"`)}</td><td>${statusHTML(deliveryStatus(l))}${l.stages.length ? `<small class="submeta">${l.stages.filter(s => stageStatus(s) === 'green').length} av ${l.stages.length} etapper klara</small>` : ''}</td><td>${btn('delivery', esc(l.order), p.id, l.id, 'class="textbutton"')}</td>${cols.map(([k]) => `<td>${cell(p, l, k)}</td>`).join('')}<td>${btn('delivery', l.deliveryDate || 'Datum saknas', p.id, l.id, 'class="datebutton"')}</td><td>${btn('reportdate', l.reportDate || '＋ Ange datum', p.id, l.id, 'class="datebutton"')}${l.reportDate && l.reportDate < state.today && !l.closed ? '<small class="submeta overdue">Planerat datum passerat</small>' : ''}</td><td>${btn('followup', l.closed ? `${dot('green')} Avslutad` : `${dot(followStatus(l))} ${R.due(l)}${R.due(l) <= state.today ? '<small class="submeta overdue">Uppföljning behövs nu</small>' : ''}`, p.id, l.id, 'class="datebutton"')}</td><td>${l.closed ? `${dot('green')} ${l.closed}` : btn('close-delivery', 'Klarskriv', p.id, l.id)}</td><td>${btn('unlink-delivery', 'Koppla bort', p.id, l.id, 'class="textbutton"')}</td><td>${btn('stages', String(l.stages.length) + ' ⌄', p.id, l.id)}</td></tr>${openStages.has(l.id) ? `<tr><td colspan="15" class="stagecell"><table class="stagetable"><thead><tr><th>Etappnamn</th><th>Status</th>${cols.map(([, name]) => `<th>${name}</th>`).join('')}</tr></thead><tbody>${l.stages.map(s => `<tr><td>${esc(s.name)}</td><td>${statusHTML(stageStatus(s))}</td>${cols.map(([k]) => `<td>${cell(p, l, k, s)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="8" class="empty">Leveransen har ännu inga etapper.</td></tr>'}</tbody></table>${btn('stage', '＋ Lägg till etapp', p.id, l.id, 'class="textbutton"')}</td></tr>` : ''}`).join('') || '<tr><td colspan="15" class="empty">Koppla en leverans via RO- eller GA1-nummer för att komma igång.</td></tr>'}</tbody></table></div><p class="scrollhint">Bläddra i sidled för datum och uppföljning. Klicka på en kontrollpunkt för underlag och kopplingar.</p>`;
}
function renderTasks() {
  const follow = view === 'followups';
  const rows = state.projects.flatMap(p => follow ? p.deliveries.filter(l => !l.closed).map(l => ({ p, l, date: R.due(l) })) : p.reminder ? [{ p, date: p.reminder }] : []).sort((a, b) => a.date.localeCompare(b.date));
  $('#app').innerHTML = pageHead(follow ? 'Kunduppföljning' : 'Påminnelser', `${rows.filter(r => r.date <= state.today).length} att hantera idag · ${state.today}`) + `<div class="tablewrap"><table class="tasktable"><thead><tr><th>Datum</th><th>Projekt</th>${follow ? '<th>Leverans</th><th>Leveransdatum</th>' : '<th>Projektanteckning</th>'}<th></th></tr></thead><tbody>${rows.map(({ p, l, date }) => `<tr><td class="${date <= state.today ? 'overdue' : ''}">${dot(date < state.today ? 'red' : date === state.today ? 'yellow' : 'unknown')} ${date}</td><td>${btn('open-project', esc(p.name), p.id, '', 'class="textbutton"')}</td>${follow ? `<td>${esc(l.name)}</td><td>${l.deliveryDate}</td><td>${btn('followup', 'Hantera uppföljning', p.id, l.id)}</td>` : `<td>${esc(p.note)}</td><td>${btn('edit-project', 'Ändra påminnelse', p.id)}</td>`}</tr>`).join('') || '<tr><td colspan="5" class="empty">Inga aktuella uppföljningar.</td></tr>'}</tbody></table></div>`;
}
async function renderUnlinked() {
  $('#app').innerHTML = pageHead('Ej kopplade ordrar', 'Leveranser utan projekt just nu — koppla en för att hämta dess kund och kontrollpunkter.') + '<div id="unlinked-slot"><p class="muted">Laddar…</p></div>';
  try {
    unlinkedCache = await DB.fetchUnlinkedDeliveries();
  } catch (e) { $('#unlinked-slot').innerHTML = `<p class="muted">Kunde inte hämta: ${esc(e.message)}</p>`; return; }
  $('#unlinked-slot').innerHTML = `<div class="tablewrap"><table class="tasktable"><thead><tr><th>Leveransorder</th><th>Leverans</th><th>Kund</th><th>Leveransdatum</th><th>Kända kontrollpunkter</th><th></th></tr></thead><tbody>${unlinkedCache.map(o => `<tr><td>${esc(o.order)}</td><td>${esc(o.name)}</td><td>${esc(o.customer || '–')}</td><td>${o.deliveryDate || '–'}</td><td>${o.knownCheckpoints}</td><td>${btn('choose-project', 'Koppla till projekt', '', '', `data-order="${o.id}"`)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Inga okopplade leveranser just nu.</td></tr>'}</tbody></table></div>`;
}
function renderTeam() {
  $('#app').innerHTML = pageHead('Teamöversikt', 'Projekt och avvikelser per projektledare.') + `<div class="tablewrap"><table><thead><tr><th>Projektledare</th><th>Projekt</th><th>Leveranser</th><th>Kräver åtgärd</th><th></th></tr></thead><tbody>${allOwners().map(o => { const ps = state.projects.filter(p => p.owner === o); return `<tr><td>${esc(o)}</td><td>${ps.length}</td><td>${ps.reduce((n, p) => n + p.deliveries.length, 0)}</td><td>${ps.filter(p => projectStatus(p) === 'red').length}</td><td>${btn('owner', 'Visa projekt', '', '', `data-owner="${esc(o)}"`)}</td></tr>`; }).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------------
// Mutations — each performs the write via db.js, then refreshes state.
// ---------------------------------------------------------------------
function newProject() {
  dialog('Skapa nytt projekt', field('Projektnamn', 'name', '', 'text', true) + '<p class="muted">Du blir projektledare automatiskt. Kundbolag följer med när du kopplar leveranser.</p>', 'Skapa projekt', async f => {
    const name = f.get('name').trim();
    if (!name) return fail('Ange ett projektnamn.');
    return runWrite(DB.createProject({ name }).then(row => { openProjects.add(row.id); view = 'projects'; owner = currentUserName(); search = ''; filter = 'all'; }), { thenRender: true }).then(ok => { if (ok) toast('Projektet är skapat. Koppla din första leverans.'); return ok; });
  });
}
function editProject(p) {
  dialog('Redigera projekt', field('Projektnamn', 'name', p.name, 'text', true) + `<div class="formgrid">${field('Kundens önskade sista leveransdatum', 'desired', p.desired, 'date')}${field('Faktiskt datum', 'actual', p.actual, 'date')}${field('Påminnelsedatum', 'reminder', p.reminder, 'date')}<label>Orsak vid försening<select name="reason"><option value="">Välj orsak</option>${['Kund / tillträde', 'Fiberleverans', 'Entreprenör', 'Internt beroende', 'Annat'].map(s => `<option ${p.reason === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div><label class="check"><input name="confirmed" type="checkbox">Jag har stämt av önskat datum med kunden och verifierat att det är rimligt.</label>${p.originalDesired ? `<p class="muted">Ursprungligt önskat datum: ${p.originalDesired}. Det behålls vid ändring för uppföljning.</p>` : ''}`, 'Spara', async f => {
    const desired = f.get('desired'), actual = f.get('actual'), name = f.get('name').trim();
    if (!name) return fail('Ange ett projektnamn.');
    if (desired && desired !== p.desired && !f.get('confirmed')) return fail('Bekräfta kunddialogen innan du ändrar önskat datum.');
    if (actual > state.today) return fail('Faktiskt datum kan inte ligga i framtiden.');
    if (actual && (p.originalDesired || desired) && actual > (p.originalDesired || desired) && !f.get('reason')) return fail('Välj orsakskod eftersom utfallet är senare än ursprungligt önskat datum.');
    if (actual && p.deliveries.some(l => !l.closed)) return fail('Klarskriv projektets leveranser innan du registrerar projektets faktiska slutdatum.');
    const patch = { name, desired, actual, reminder: f.get('reminder'), reason: f.get('reason') };
    if (!p.originalDesired && desired) patch.originalDesired = desired;
    return runWrite(DB.updateProject(p.id, patch, p.updatedAt));
  });
}
function editNote(p) {
  dialog('Projektanteckning', `<label>Levande intern anteckning<textarea name="note" rows="6" maxlength="4000">${esc(p.note)}</textarea></label><small>Anteckningen följer inte med kundunderlaget. Tidigare text sparas i historiken.</small>`, 'Spara anteckning', async f => {
    if (p.note === f.get('note')) return;
    return runWrite(DB.updateProject(p.id, { note: f.get('note') }, p.updatedAt));
  });
}
function linkDeliveryDialog(p, presetId = '') {
  dialog('Koppla leverans', `<label>Välj bland okopplade leveranser<select name="order" id="order-pick" required><option value="">Välj en leveransorder</option>${(unlinkedCache || []).map(o => `<option value="${o.id}" ${o.id === presetId ? 'selected' : ''}>${esc(o.order)} · ${esc(o.name)} · ${esc(o.customer || '')}</option>`).join('')}</select></label>${field('Leveransnamn (valfritt, annars order-namnet)', 'name')}<div id="order-result" class="notice" aria-live="polite">${unlinkedCache?.length ? 'Välj en leverans i listan.' : 'Inga okopplade leveranser just nu — se "Ej kopplade ordrar".'}</div>`, 'Bekräfta koppling', async f => {
    const orderId = f.get('order');
    if (!orderId) return fail('Välj en leverans.');
    return runWrite(DB.linkDelivery(orderId, p.id, f.get('name').trim() || null), { thenRender: true }).then(ok => {
      if (ok) { openProjects.add(p.id); tabs[p.id] = 'deliveries'; toast('Leveransen är kopplad. Första kunduppföljningen är planerad.'); }
      return ok;
    });
  });
  const select = $('#modal [name="order"]');
  const update = () => {
    const o = (unlinkedCache || []).find(x => x.id === select.value);
    $('#order-result').innerHTML = o ? `${dot('green')} <strong>${esc(o.order)}</strong><br>Kund: ${esc(o.customer || '–')}<br>Leveransdatum: ${o.deliveryDate || '–'}<br>${o.knownCheckpoints} kända kontrollpunkter följer med.` : 'Välj en leverans i listan.';
  };
  select.onchange = update;
  if (presetId) update();
}
function pointPanel(p, l, key, s) {
  const inherited = s && ['startup', 'fiber'].includes(key), target = inherited ? l : s || l, c = target.points[key], label = cols.find(x => x[0] === key)[1];
  panel(label, `<p class="muted">${esc(p.name)} / ${esc(l.name)}${s ? ' / ' + esc(s.name) : ''}</p>${statusHTML(pointStatus(c))}<dl><dt>Referens</dt><dd>${esc(c.ref || 'Ingen koppling')}</dd><dt>Status</dt><dd>${esc(statuses[pointStatus(c)])}</dd><dt>Datum från källa</dt><dd>${c.date || 'Saknas'}</dd><dt>Källa</dt><dd>${c.manual ? 'Manuellt ställningstagande i DPA' : (c.source || 'Källsystem') + ' · demodata'}</dd><dt>Senaste hämtning</dt><dd>${l.sourceAt}</dd></dl><div class="notice">${esc(c.detail || (c.status === 'red' ? 'Kontrollera behov och kopplat uppdrag innan nästa steg.' : c.status === 'missing' ? 'Sök fram uppdragets referens för att hämta dess underlag.' : 'Granska underlaget och följ upp vid behov.'))}${inherited ? '<br>Gemensamt på leveransen. En ändring gäller alla etapper.' : ''}</div><h3>Koppling och behov</h3><form id="point-form">${key === 'object' ? `<label>Skapat objekt<select name="choice"><option value="source">Behåll hämtad uppgift</option><option value="Ja">Ja – bekräftat av projektledaren</option><option value="Nej">Nej</option><option value="unknown">Behov ej bedömt</option><option value="na">Inte aktuellt</option></select></label>` : `${field('Referens', 'ref', c.ref)}<label>Behov<select name="choice"><option value="source">Behåll referens / källuppgift</option><option value="missing">Saknar koppling</option><option value="unknown">Behov ej bedömt</option><option value="na">Inte aktuellt</option></select></label>`}${field('Notering / skäl vid undantag', 'reason', c.manual ? c.detail : '')}<p class="error" id="point-error" role="alert"></p><button class="primary">Spara koppling</button></form><button disabled>Öppna i DELTA — inte anslutet</button>`);
  $('#point-form').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), choice = f.get('choice'), reason = f.get('reason').trim();
    if (choice === 'na' && !reason) { $('#point-error').textContent = 'Ange varför kontrollpunkten inte är aktuell.'; return; }
    let patch;
    if (key === 'object') {
      patch = choice === 'source' ? (reason ? { detail: reason } : null) : { ref: ['Ja', 'Nej'].includes(choice) ? choice : '', status: choice === 'Ja' ? 'green' : choice === 'Nej' ? 'red' : choice, date: '', detail: reason, manual: true };
    } else if (choice !== 'source') {
      patch = { ref: '', status: ['na', 'unknown'].includes(choice) ? choice : 'missing', date: '', detail: reason, manual: true };
    } else {
      patch = { ref: f.get('ref'), detail: reason || c.detail };
    }
    if (!patch) { $('#drawer').close(); return; }
    const ok = await runWrite(DB.updateCheckpoint({ deliveryId: inherited || !s ? l.id : null, stageId: s && !inherited ? s.id : null, type: key, patch }), { thenRender: true });
    if (ok) { $('#drawer').close(); toast('Kopplingen är sparad.'); }
  };
}
function deliveryPanel(p, l) {
  panel(l.name, `<p class="muted">${esc(p.name)} · ${esc(l.order)}</p>${statusHTML(deliveryStatus(l))}<dl><dt>Kund</dt><dd>${esc(l.customer)}</dd><dt>Organisationsnummer</dt><dd>${esc(l.org)}</dd><dt>Leveransdatum</dt><dd>${l.deliveryDate}</dd><dt>Slutrapportering</dt><dd>${l.reportDate || 'Ej planerad'}</dd><dt>Faktiskt klarskriven</dt><dd>${l.closed || 'Inte klarskriven'}</dd><dt>Källa</dt><dd>RO / GA1 · demoregister</dd><dt>Senaste hämtning</dt><dd>${l.sourceAt}</dd></dl><h3>Kontrollpunkter</h3>${cols.map(([k, n]) => `<div class="historyitem"><strong>${n}</strong><br>${statusHTML(pointStatus(l.points[k]))} · ${esc(l.points[k].ref || 'Ingen referens')}</div>`).join('')}<div class="actions">${btn('stage', '＋ Lägg till etapp', p.id, l.id)}${btn('sync-date', 'Prova ändrat källdatum', p.id, l.id)}</div><div class="notice">Demonstration: ett ändrat källdatum räknar om framtida kunduppföljning. Förfallen uppföljning ligger kvar. Ingen verklig order ändras — det här skriver bara till testdatabasen.</div><button disabled>Öppna i DELTA — inte anslutet</button>`);
}
function followupPanel(p, l) {
  if (l.closed) { panel('Kunduppföljning', `<p>Leveransen klarskrevs ${l.closed}. Inga nya uppföljningar planeras.</p>${followHistory(l)}`); return; }
  panel('Kunduppföljning', `<p class="muted">${esc(p.name)} / ${esc(l.name)}</p><div class="section"><h3>Nästa uppföljning</h3><h2 class="${R.due(l) <= state.today ? 'overdue' : ''}">${R.due(l)}</h2><p>${R.due(l) <= state.today ? 'Uppföljning behövs nu.' : 'Planerad uppföljning.'}</p><small>Leveransdatum: ${l.deliveryDate}</small></div><form id="follow-form">${field('Genomförd datum', 'date', state.today, 'date', true)}<label>Notering (valfritt)<textarea name="note" placeholder="Vad kom ni överens om med kunden?"></textarea></label><p id="follow-error" class="error" role="alert"></p><button class="primary">Markera uppföljning genomförd</button></form><div class="notice">Efter genomförandet planeras nästa datum automatiskt. En förfallen uppföljning ligger kvar tills den hanteras.</div>${btn('adjust-follow', 'Justera nästa datum', p.id, l.id)}<h3 style="margin-top:25px">Genomförda uppföljningar</h3>${followHistory(l)}`);
  $('#follow-form').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), date = f.get('date'), last = l.followHistory.at(-1)?.date;
    if (date > state.today || date < l.created || (last && date <= last)) { $('#follow-error').textContent = 'Datum måste ligga mellan skapandet och idag, och efter föregående uppföljning.'; return; }
    const ok = await runWrite(DB.completeFollowup(l.id, date, f.get('note')), { thenRender: true });
    if (ok) { toast('Uppföljningen sparad. Nästa datum är ' + R.due(project(p.id).deliveries.find(d => d.id === l.id)) + '.'); followupPanel(project(p.id), project(p.id).deliveries.find(d => d.id === l.id)); }
  };
}
function followHistory(l) { return [...l.followHistory].reverse().map(h => `<div class="historyitem"><strong>${h.date}</strong> · ${esc(h.by)}<p>${esc(h.note || 'Genomförd kunduppföljning.')}</p></div>`).join('') || '<p class="muted">Ingen genomförd uppföljning registrerad.</p>'; }
function addStage(p, l) {
  dialog('Lägg till etapp', field('Etappnamn', 'name', '', 'text', true) + '<div class="notice">Uppstartsmöte och inkommande fiber delas med leveransen. Fastighetsnät, CS-ärende och objekt kan kopplas separat via etappens kontrollpunkter.</div>', 'Skapa etapp', async f => {
    const name = f.get('name').trim();
    if (!name) return fail('Ange ett etappnamn.');
    return runWrite(DB.addStage(l.id, name), { thenRender: true }).then(ok => { if (ok) openStages.add(l.id); return ok; });
  });
}
function report(p) {
  dialog('Kunduppdatering', `<label>Mottagare<input id="recipient" placeholder="Namn / kundbolag"></label><h3>Leveranser som ska ingå</h3>${p.deliveries.map(l => `<label class="check"><input type="checkbox" data-report="${l.id}" checked>${esc(l.name)} · ${esc(l.customer)}</label>`).join('')}<label>Text till kunden<textarea id="customer-text" placeholder="Vad händer härnäst? Behöver kunden göra något?"></textarea></label><div id="report-preview" class="customerpreview"></div><div class="actions"><button type="button" id="copy-report">Kopiera text</button><button type="button" id="print-report">Skriv ut / spara PDF</button></div><p class="muted">Förhandsgranska innan du delar. Interna anteckningar ingår inte. Ingen information skickas automatiskt.</p>`, '', null);
  const update = () => {
    const selected = [...document.querySelectorAll('[data-report]:checked')].map(x => x.dataset.report), list = p.deliveries.filter(l => selected.includes(l.id));
    $('#report-preview').innerHTML = `<small>LEVERANSUPPDATERING · DEMOUNDERLAG · ${state.today}</small><h2>${esc(p.name)}</h2><p>Till: ${esc($('#recipient').value || 'vald mottagare')}</p>${list.map(l => `<h3>${esc(l.name)}</h3><p>${esc(l.customer)}<br>Planerad leverans: ${l.deliveryDate}.<br>${l.closed ? 'Klarskriven: ' + l.closed : deliveryStatus(l) === 'red' ? 'En avvikelse behöver följas upp. Bekräfta påverkan på tidplanen.' : 'Leveransen följs upp enligt plan.'}${l.reportDate ? '<br>Planerad slutrapportering: ' + l.reportDate : ''}</p>${l.stages.length ? '<p>Etapper: ' + l.stages.map(s => esc(s.name)).join(', ') + '.</p>' : ''}`).join('') || '<p>Välj minst en leverans.</p>'}<p style="white-space:pre-wrap">${esc($('#customer-text').value)}</p><small>Datum och status är demouppgifter. Verifiera underlaget innan det används.</small>`;
    $('#copy-report').disabled = $('#print-report').disabled = !list.length;
  };
  document.querySelectorAll('[data-report]').forEach(x => x.onchange = update);
  $('#recipient').oninput = update; $('#customer-text').oninput = update;
  $('#copy-report').onclick = () => navigator.clipboard.writeText($('#report-preview').innerText).then(() => toast('Kundunderlaget kopierat.')).catch(() => toast('Markera och kopiera texten i förhandsgranskningen.'));
  $('#print-report').onclick = () => window.print();
  update();
}

// ---------------------------------------------------------------------
// Click dispatcher
// ---------------------------------------------------------------------
document.addEventListener('click', async e => {
  const close = e.target.closest('[data-close]');
  if (close) { $('#' + close.dataset.close).close(); return; }
  const nav = e.target.closest('[data-view]');
  if (nav) { view = nav.dataset.view; render(); return; }
  const filt = e.target.closest('[data-filter]');
  if (filt) { filter = filt.dataset.filter; render(); return; }
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const a = b.dataset.action, p = project(b.dataset.p), l = p?.deliveries.find(l => l.id === b.dataset.l), s = l?.stages.find(s => s.id === b.dataset.stage);

  if (a === 'new') newProject();
  if (a === 'reset-filter') { search = ''; filter = 'all'; owner = currentUserName(); render(); }
  if (a === 'expand') { openProjects.has(p.id) ? openProjects.delete(p.id) : openProjects.add(p.id); drawProjects(); }
  if (a === 'stages') { openStages.has(l.id) ? openStages.delete(l.id) : openStages.add(l.id); drawProjects(); }
  if (a === 'tab') { tabs[p.id] = b.dataset.tab; drawProjects(); if (b.dataset.tab === 'history') loadHistoryIfNeeded(p); }
  if (a === 'edit-project') editProject(p);
  if (a === 'note') editNote(p);
  if (a === 'link-delivery') { if (unlinkedCache === null) unlinkedCache = await DB.fetchUnlinkedDeliveries(); linkDeliveryDialog(p); }
  if (a === 'point') pointPanel(p, l, b.dataset.key, s);
  if (a === 'delivery') deliveryPanel(p, l);
  if (a === 'followup') followupPanel(p, l);
  if (a === 'stage') addStage(p, l);
  if (a === 'report') report(p);
  if (a === 'open-project') { $('#modal').close(); $('#drawer').close(); view = 'all'; search = ''; filter = 'all'; openProjects.add(p.id); render(); }
  if (a === 'owner') { view = 'projects'; owner = b.dataset.owner; render(); }
  if (a === 'choose-project') {
    dialog('Välj projekt', `<label>Projekt<select name="p">${state.projects.map(pr => `<option value="${pr.id}">${esc(pr.name)}</option>`).join('')}</select></label>`, 'Fortsätt', f => {
      const target = project(f.get('p'));
      if (!target) return fail('Skapa ett projekt först.');
      $('#modal').close();
      linkDeliveryDialog(target, b.dataset.order);
      return false;
    });
  }
  if (a === 'add-customer') dialog('Lägg till kundbolag', field('Företagsnamn', 'name', '', 'text', true) + field('Organisationsnummer', 'org', '', 'text', true) + '<small>Demodata. Organisationsnumret verifieras inte mot bolagsregister.</small>', 'Lägg till', async f => {
    if (!f.get('name').trim() || !f.get('org').trim()) return fail('Fyll i företagsnamn och organisationsnummer.');
    return runWrite(DB.addCustomer(p.id, { name: f.get('name').trim(), org: f.get('org').trim() }));
  });
  if (a === 'takeover') dialog('Ta över projekt', `<p>${esc(p.name)} flyttas från ${esc(p.owner)} till ${esc(currentUserName())}. Källsystemens ansvar ändras inte.</p>`, 'Ta över', () => runWrite(DB.takeOverProject(p.id)));
  if (a === 'delete-project') dialog('Ta bort projekt', `<div class="notice">Projektet döljs och räknas som borttaget. Leveranser raderas inte — de hamnar bland de okopplade ordrarna. En administratör kan återställa projektet senare.</div><p><strong>${esc(p.name)}</strong> (${p.number})</p>`, 'Ta bort projekt', async () => {
    const ok = await runWrite(DB.deleteProjectRemote(p.id));
    if (ok) { openProjects.delete(p.id); toast('Projektet är borttaget.'); }
    return ok;
  });
  if (a === 'unlink-delivery') dialog('Koppla bort leverans', `<p><strong>${esc(l.name)}</strong> (${esc(l.order)}) kopplas bort från ${esc(p.name)} och hamnar bland de okopplade ordrarna. Kontrollpunkter och historik följer med leveransen.</p>`, 'Koppla bort', () => runWrite(DB.unlinkDelivery(l.id)).then(ok => { if (ok) toast('Leveransen är bortkopplad.'); return ok; }));
  if (a === 'reportdate') dialog('Planera slutrapportering', field('Slutrapporteringsdatum (valfritt)', 'date', l.reportDate, 'date') + '<p class="muted">Detta är ett planeringsdatum. Det verkliga klarskrivningsdatumet sparas när du klarskriver leveransen.</p>', 'Spara', f => runWrite(DB.updateDeliveryField(l.id, { reportDate: f.get('date') }, l.updatedAt)));
  if (a === 'adjust-follow') dialog('Justera nästa kunduppföljning', field('Nästa datum', 'date', R.due(l), 'date', true) + field('Skäl till justering', 'reason', '', 'text', true) + '<small>Ett manuellt datum gäller till nästa genomförda uppföljning eller ändrat källdatum. Avvikelse från tvåveckorsregeln sparas i historiken.</small>', 'Spara', async f => {
    if (!f.get('reason').trim()) return fail('Ange skäl till justeringen.');
    return runWrite(DB.setFollowOverride(l.id, f.get('date'), f.get('reason')));
  });
  if (a === 'close-delivery') dialog('Klarskriv leveransen', `<p><strong>${esc(l.name)}</strong> · ${esc(l.order)}</p>${deliveryStatus(l) !== 'green' ? '<div class="notice">Det finns öppna eller obekräftade kontrollpunkter. Bekräfta att leveransen ändå är färdig innan du klarskriver.</div>' : ''}<label class="check"><input name="confirmed" type="checkbox" required>Jag har verifierat att leveransen är färdig och kan klarskrivas i DPA.</label><label>Notering<textarea name="note" ${deliveryStatus(l) !== 'green' ? 'required' : ''}></textarea></label><p>Faktiskt klarskrivningsdatum: <strong>${state.today}</strong>. Framtida kunduppföljning stoppas. Ingen order klarskrivs i källsystemet.</p>`, 'Klarskriv leveransen', async f => {
    if (!f.get('confirmed')) return fail('Bekräfta att leveransen är färdig.');
    if (deliveryStatus(l) !== 'green' && !f.get('note').trim()) return fail('Beskriv varför leveransen kan klarskrivas trots öppna kontrollpunkter.');
    return runWrite(DB.closeDelivery(l.id, f.get('note'))).then(ok => { if (ok) toast('Leveransen är klarskriven. Kunduppföljningen har avslutats.'); return ok; });
  });
  if (a === 'sync-date') dialog('Prova ändrat datum från ordern', field('Nytt leveransdatum i demokällan', 'date', l.deliveryDate, 'date', true) + '<div class="notice">Simulerar nästa hämtning från RO / GA1 — skriver till testdatabasen så att kunduppföljningen räknas om, precis som en riktig integration skulle göra.</div>', 'Simulera hämtning', f => runWrite(DB.updateDeliveryField(l.id, { deliveryDate: f.get('date') }, l.updatedAt)).then(ok => { if (ok) deliveryPanel(project(p.id), project(p.id).deliveries.find(d => d.id === l.id)); return ok; }));
});

// ---------------------------------------------------------------------
// Boot — wait for auth.js to finish signing the user in, then load,
// render, and subscribe to realtime changes from other testers.
// ---------------------------------------------------------------------
let unsubscribeRealtime = null;
async function boot() {
  await refreshState();
  owner = currentUserName();
  render();
  if (!unsubscribeRealtime) unsubscribeRealtime = DB.subscribeRealtime(async () => { await refreshState({ silent: true }); render(); });
}
document.addEventListener('dpa:authenticated', boot);
document.addEventListener('dpa:refresh', async () => { await refreshState({ silent: true }); render(); });
