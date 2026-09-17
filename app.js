'use strict';
import { getProfile } from './auth.js';
import * as DB from './db.js';

const $ = s => document.querySelector(s), R = DPARules;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dot = (s = 'unknown') => `<span class="dot ${s}" aria-hidden="true"></span>`;
const statuses = { green: 'Uppfyllt', yellow: 'Bevaka', red: 'Kräver åtgärd', unknown: 'Behov ej bedömt', missing: 'Saknar koppling', na: 'Inte aktuellt' };
const statusHTML = s => `<span class="status">${dot(s)}${statuses[s] || 'Ej bedömt'}</span>`;
const cols = [['startup', 'Uppstartsmöte', 'FB-nummer'], ['fn1', 'Fastighetsnät 1', 'FB-nummer'], ['fn2', 'Fastighetsnät 2', 'FB-nummer'], ['fiber', 'Trade / Colt', 'Ordernummer'], ['cs', 'CS-nummer', 'Kommunikation'], ['object', 'Skapat objekt', 'Ja / Nej'], ['wbs', 'WBS-nummer', 'WBS-kod']];
const OPTIONAL_COLS = [...cols.map(c => c[0]), 'order', 'deliveryDate', 'reportDate', 'followup']; // 'name' and 'status' are always shown

// ---------------------------------------------------------------------
// State — now a client-side cache of the database, not the source of
// truth. refreshState() re-fetches everything; every mutation goes
// through db.js first, then re-fetches on success (simple and correct,
// rather than juggling two sources of truth for a 3-person test app).
// ---------------------------------------------------------------------
let state = { today: new Date().toISOString().slice(0, 10), projects: [], tags: [] };
let view = 'projects', search = '', filter = 'all', owner = null, openProjects = new Set(), openStages = new Set(), tabs = {}, deliveryTabs = {};
let unlinkedCache = null;
let notifications = [];
let viewPrefs = { columns: { project: {}, leveranslage: {}, datum: {} }, column_order: [], filters: {}, sort: {} };
// (reportSelection removed — the tidsplansbilaga is generated per project, not via a cross-project selection.)

const currentUserName = () => getProfile()?.full_name || '';
const currentProfileId = () => getProfile()?.id || '';
const currentProfileIsAdmin = () => getProfile()?.role === 'admin';
const project = id => state.projects.find(p => p.id === id);
const customerNames = p => [...new Set([...p.deliveries.map(l => l.customer).filter(Boolean), ...p.customers.map(c => c.name)])];
const allOwners = () => [...new Set(state.projects.map(p => p.owner))].sort();

function aggregate(ss) { return ss.includes('red') ? 'red' : ss.includes('yellow') ? 'yellow' : ss.some(s => ['unknown', 'missing'].includes(s)) ? 'unknown' : ss.length && ss.some(s => s === 'green') ? 'green' : 'unknown'; }
function pointStatus(c) { if (c.status === 'na') return 'na'; if (['missing', 'unknown', 'red'].includes(c.status)) return c.status; if (c.status !== 'green' && c.date && c.date < state.today) return 'red'; return c.status; }
function followStatus(l) { if (l.closed) return 'green'; const d = R.due(l); return d < state.today ? 'red' : d <= R.days(state.today, 7) ? 'yellow' : 'unknown'; }
function stageStatus(s) { return aggregate(Object.values(s.points).map(pointStatus)); }
function deliveryStatus(l) { if (l.closed) return 'green'; const ss = [...Object.values(l.points).map(pointStatus), ...l.stages.map(stageStatus)]; if (R.due(l) < state.today || l.deliveryDate < state.today || l.reportDate && l.reportDate < state.today) ss.push('red'); return aggregate(ss); }
function projectStatus(p) { return aggregate(p.deliveries.map(deliveryStatus)); }
const isArchived = p => !!p.actual;
function colVisible(key) { return viewPrefs.columns.leveranslage?.[key] !== false; } // default visible unless explicitly hidden
function colVisible2(context, key, def) { const v = viewPrefs.columns[context]?.[key]; return v === undefined ? def : v; }

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
  else if (view === 'archive') renderArchive();
  else if (view === 'trash') renderTrash();
  else renderTeam();
}

function renderProjects() {
  const mine = state.projects.filter(p => !isArchived(p)).filter(p => view === 'all' || p.owner === owner);
  $('#app').innerHTML = `<div class="pagehead2"><div><h1>Projektöversikt</h1><p>En samlad vy över dina projekt, leveranser och etapper.</p></div>${btn('new', '＋ Nytt projekt', '', '', 'class="primary"')}</div>` +
    `<div class="tabbar">${btn('switch-tab', 'Mina projekt', '', '', `data-target="projects" class="${view === 'projects' ? 'active' : ''}"`)}${btn('switch-tab', 'Alla projekt', '', '', `data-target="all" class="${view === 'all' ? 'active' : ''}"`)}</div>` +
    `<div class="pillbar"><input id="search" aria-label="Sök projekt, kund eller order" placeholder="Sök projekt, kund, RO eller GA1…" value="${esc(search)}">` +
    [['all', 'Alla'], ['red', 'Avvikelser'], ['yellow', 'Bevaka'], ['green', 'Uppfyllt'], ['unknown', 'Ej bedömt']].map(([s, label]) => btn('set-filter', `${label} ${mine.filter(p => s === 'all' || projectStatus(p) === s).length}`, '', '', `data-status="${s}" class="pill ${filter === s ? 'active' : ''}"`)).join('') +
    `${btn('customize', '⚙ Kolumner', '', '', 'id="btn-customize" class="colbtn"')}</div>` +
    `<div id="projects-result"></div>`;
  $('#search').oninput = e => { search = e.target.value; drawProjects(); };
  $('#btn-customize').onclick = e => openColumnPicker(e.currentTarget, 'project');
  drawProjects();
}
function drawProjects() {
  const list = state.projects.filter(p => !isArchived(p)).filter(p => view === 'all' || p.owner === owner).filter(p => JSON.stringify(p).toLowerCase().includes(search.toLowerCase())).filter(p => filter === 'all' || projectStatus(p) === filter);
  const showOwnerCol = view === 'all' && colVisible2('project', 'owner', true);
  const cols2 = [
    ['customer', 'Kund', true], ...(showOwnerCol ? [['owner', 'Projektledare', true]] : []),
    ['deliveries', 'Leveranser', true], ['desired', 'Önskat sista datum', true], ['reminder', 'Påminnelse', true],
  ].filter(([k]) => k === 'deliveries' ? colVisible2('project', k, true) : colVisible2('project', k, true));
  $('#projects-result').innerHTML = `<div class="tablewrap"><table class="cleantable"><thead><tr><th></th><th>Projekt</th>${cols2.map(([, l]) => `<th>${l}</th>`).join('')}<th>Status</th></tr></thead><tbody>${list.map(p => `<tr><td>${btn('expand', `<span class="chev">${openProjects.has(p.id) ? '⌄' : '›'}</span>`, p.id, '', `class="projcell-name" aria-expanded="${openProjects.has(p.id)}" style="display:inline-flex"`)}</td><td>${btn('expand', `${esc(p.name)}${p.tagName ? `<span class="tagchip">${esc(p.tagName)}</span>` : ''}`, p.id, '', 'class="projcell-name"')}<div class="projcell-sub">${p.number}</div></td>${cols2.map(([k]) => `<td>${deliveryColValue(p, k)}</td>`).join('')}<td>${statusInline(projectStatus(p))}</td></tr>${openProjects.has(p.id) ? `<tr class="subrow"><td colspan="${2 + cols2.length + 1}">${projectDetail(p)}</td></tr>` : ''}`).join('') || `<tr><td colspan="${2 + cols2.length + 1}" class="empty">Inga projekt matchar ditt urval.</td></tr>`}</tbody></table></div><div class="legend2">${legendItems()}</div>`;
}
function deliveryColValue(p, key) {
  if (key === 'customer') return esc(customerNames(p).join(', ') || 'Ej kopplad');
  if (key === 'owner') return esc(p.owner);
  if (key === 'deliveries') return p.deliveries.length;
  if (key === 'desired') return p.desired || '–';
  if (key === 'reminder') return `<span class="${p.reminder && p.reminder <= state.today ? 'overdue' : ''}">${p.reminder || '–'}</span>`;
  return '';
}
function statusInline(s) {
  const map = { red: ['sw-red', 'Avvikelse'], yellow: ['sw-yellow', 'Bevaka'], green: ['sw-green', 'Uppfyllt'], unknown: ['sw-gray', 'Ej bedömt'], na: ['sw-gray', 'Ej aktuellt'] };
  const [cls, label] = map[s] || map.unknown;
  return `<span class="statusdot-inline"><span class="sw ${cls}"></span>${label}</span>`;
}
function legendItems() {
  return `<span><span class="sw sw-green" style="display:inline-block"></span>Grönt: uppfyllt</span><span><span class="sw sw-yellow" style="display:inline-block"></span>Gult: bevaka</span><span><span class="sw sw-red" style="display:inline-block"></span>Rött: avvikelse</span><span><span class="sw-ring"></span>Ej aktuellt</span>`;
}
function projectDetail(p) {
  const tab = tabs[p.id] || 'deliveries';
  return `<div class="projectdetail"><div class="detailhead"><div class="actions"><h2>${esc(p.name)}${p.tagName ? `<span class="tagchip">${esc(p.tagName)}</span>` : ''}</h2>${statusHTML(projectStatus(p))}</div><div class="actions">${btn('edit-project', '✎ Redigera projekt', p.id)}${btn('takeover', 'Ta över projekt', p.id, '', p.owner === currentUserName() ? 'disabled' : '')}${btn('delete-project', '🗑 Flytta till papperskorg', p.id)}</div></div>` +
    `<div class="notebar2"><span class="lbl">Anteckning</span><span class="txt">${esc(p.note || 'Ingen projektanteckning ännu.')}</span>${btn('note', '✎', p.id)}</div>` +
    `<div class="tabline"><div class="tabs">${[['deliveries', `Leveranser (${p.deliveries.length})`], ['customers', 'Kundbolag'], ['history', `Historik`]].map(([key, name]) => btn('tab', name, p.id, '', `data-tab="${key}" class="${tab === key ? 'active' : ''}"`)).join('')}${btn('report', 'Kunduppdatering', p.id)}${btn('timeline-report', '＋ Skapa tidsplansbilaga', p.id, '', 'class="primary"')}</div></div>` +
    `${tab === 'history' ? `<div id="history-slot-${p.id}"><p class="muted">Laddar historik…</p></div>` : tab === 'customers' ? `<div class="section">${customerNames(p).map(name => `<p><strong>${esc(name)}</strong><br><small>${esc(p.deliveries.find(l => l.customer === name)?.org || p.customers.find(c => c.name === name)?.org || 'Org.nr saknas')}</small></p>`).join('') || '<p>Inga kundbolag kopplade.</p>'}${btn('add-customer', '＋ Lägg till kundbolag', p.id)}</div>` : deliveryTable(p)}`;
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
  const dtab = deliveryTabs[p.id] || 'leveranslage';
  const head = `<div class="deliveryhead"><div class="tabs2">${['leveranslage', 'datum'].map(t => `<span data-action="dtab" data-p="${p.id}" data-l="" data-dtab="${t}" class="${dtab === t ? 'active' : ''}">${t === 'leveranslage' ? 'Leveransläge' : 'Datum och uppföljning'}</span>`).join('')}</div><div class="actions2">${btn('link-delivery', '＋ Koppla leverans', p.id)}${btn('customize-delivery', '⚙ Kolumner', p.id, '', `data-ctx="${dtab}"`)}</div></div>`;
  if (!p.deliveries.length) return head + `<div class="empty">Koppla en leverans via RO- eller GA1-nummer för att komma igång.</div>`;
  if (dtab === 'leveranslage') {
    const visibleCols = cols.filter(([k]) => colVisible2('leveranslage', k, true));
    return head + `<table class="subtable"><thead><tr><th>Leverans / order</th><th>Status</th>${visibleCols.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead><tbody>${p.deliveries.map(l => `<tr><td>${btn('delivery', esc(l.name), p.id, l.id, 'class="textbutton" style="display:block;text-align:left;font-weight:500"')}<div style="font-size:10px;color:var(--muted)">${esc(l.order)}</div></td><td>${statusInline(deliveryStatus(l))}</td>${visibleCols.map(([k]) => `<td>${cell(p, l, k)}</td>`).join('')}<td>${btn('stages', openStages.has(l.id) ? 'Dölj etapper' : `Etapper (${l.stages.length})`, p.id, l.id, 'class="textbutton"')}</td></tr>${openStages.has(l.id) ? l.stages.map(s => `<tr class="stagesub"><td><i class="treeicon">↳</i>${esc(s.name)}</td><td>${statusInline(stageStatus(s))}</td>${visibleCols.map(([k]) => `<td>${cell(p, l, k, s)}</td>`).join('')}<td>${btn('edit-stage', '✎', p.id, l.id, `data-stage="${s.id}"`)}</td></tr>`).join('') + `<tr class="stagesub"><td colspan="${3 + visibleCols.length}">${btn('stage', '＋ Lägg till etapp', p.id, l.id, 'class="textbutton"')}</td></tr>` : ''}`).join('')}</tbody></table>`;
  }
  return head + `<table class="subtable"><thead><tr><th>Leverans / order</th><th>Status</th><th>Leveransdatum</th><th>Slutrapportering</th><th>Kunduppföljning</th><th>Klarskriv</th><th></th></tr></thead><tbody>${p.deliveries.map(l => `<tr><td>${esc(l.name)}<div style="font-size:10px;color:var(--muted)">${esc(l.order)}</div></td><td>${statusInline(deliveryStatus(l))}</td><td>${btn('delivery', l.deliveryDate || 'Datum saknas', p.id, l.id, 'class="textbutton"')}</td><td>${btn('reportdate', l.reportDate || '＋ Ange datum', p.id, l.id, 'class="textbutton"')}${l.reportDate && l.reportDate < state.today && !l.closed ? '<div class="overdue" style="font-size:10px">Planerat datum passerat</div>' : ''}</td><td>${btn('followup', l.closed ? 'Avslutad' : `${R.due(l)}${R.due(l) <= state.today ? ' · behövs nu' : ''}`, p.id, l.id, 'class="textbutton"')}</td><td>${l.closed ? `✓ ${l.closed}` : btn('close-delivery', 'Klarskriv', p.id, l.id)}</td><td>${btn('unlink-delivery', 'Koppla bort', p.id, l.id, 'class="textbutton"')}</td></tr>${openStages.has(l.id) ? l.stages.map(s => `<tr class="stagesub"><td><i class="treeicon">↳</i>${esc(s.name)}</td><td>${statusInline(stageStatus(s))}</td><td>${btn('edit-stage', s.deliveryDate || 'Datum saknas', p.id, l.id, `data-stage="${s.id}" class="textbutton"`)}</td><td colspan="4" style="color:var(--muted)">Gemensamt med leveransen</td></tr>`).join('') : ''}`).join('')}</tbody></table>`;
}
const COLUMN_DEFS = {
  project: [['customer', 'Kund'], ['owner', 'Projektledare (endast Alla projekt)'], ['deliveries', 'Leveranser'], ['desired', 'Önskat sista datum'], ['reminder', 'Påminnelse']],
  leveranslage: cols.map(([k, label]) => [k, label]),
  datum: [['order', 'Leveransorder'], ['deliveryDate', 'Leveransdatum'], ['reportDate', 'Slutrapportering'], ['followup', 'Kunduppföljning']],
};
function openColumnPicker(anchor, context) {
  document.querySelectorAll('.colpicker').forEach(el => el.remove());
  const el = document.createElement('div');
  el.className = 'colpicker';
  const defs = COLUMN_DEFS[context];
  el.innerHTML = `<strong style="font-size:11px;text-transform:uppercase;color:var(--muted)">Anpassa kolumner</strong><hr>${defs.map(([k, label]) => `<label><input type="checkbox" data-colkey="${k}" ${colVisible2(context, k, true) ? 'checked' : ''}>${esc(label)}</label>`).join('')}<hr><small class="muted">${context === 'project' ? 'Projekt visas alltid.' : 'Leverans och Status visas alltid.'} Sparas automatiskt.</small>`;
  const r = anchor.getBoundingClientRect();
  el.style.top = (r.bottom + window.scrollY + 4) + 'px';
  el.style.left = (r.left + window.scrollX) + 'px';
  document.body.appendChild(el);
  el.querySelectorAll('[data-colkey]').forEach(cb => cb.onchange = () => {
    viewPrefs.columns[context] = viewPrefs.columns[context] || {};
    viewPrefs.columns[context][cb.dataset.colkey] = cb.checked;
    saveViewPrefsSoon();
    drawProjects();
  });
  setTimeout(() => document.addEventListener('click', function h(e) { if (!el.contains(e.target) && e.target !== anchor) { el.remove(); document.removeEventListener('click', h); } }), 0);
}
let viewPrefsTimer = null;
function saveViewPrefsSoon() {
  clearTimeout(viewPrefsTimer);
  viewPrefsTimer = setTimeout(() => {
    DB.saveViewPreferences({ columns: viewPrefs.columns, column_order: [], filters: { status: filter }, sort: {} }).catch(() => {});
  }, 500);
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
function renderArchive() {
  const list = state.projects.filter(isArchived).filter(p => view === 'all' || owner === 'all' || p.owner === owner);
  $('#app').innerHTML = pageHead('Arkiv', 'Slutrapporterade projekt (faktiskt datum satt) — ur den aktiva listan men sökbara med full historik.') + `<div class="tablewrap"><table class="projecttable"><thead><tr><th>Projekt</th><th>Projektnummer</th><th>Kund</th><th>Projektledare</th><th>Faktiskt datum</th><th>Status vid arkivering</th><th></th></tr></thead><tbody>${list.map(p => `<tr class="projectrow ${openProjects.has(p.id) ? 'open' : ''}"><td>${btn('expand', `<span>${openProjects.has(p.id) ? '⌄' : '›'}</span>${esc(p.name)}${p.tagName ? `<span class="tagchip">${esc(p.tagName)}</span>` : ''}`, p.id, '', `class="projectname" aria-expanded="${openProjects.has(p.id)}"`)}</td><td>${p.number}</td><td>${esc(customerNames(p).join(', ') || 'Ej kopplad')}</td><td>${esc(p.owner)}</td><td>${p.actual}</td><td>${statusHTML(projectStatus(p))}</td><td>${btn('reactivate', '↺ Återaktivera', p.id)}</td></tr>${openProjects.has(p.id) ? `<tr><td colspan="7" class="expandcell">${projectDetail(p)}</td></tr>` : ''}`).join('') || '<tr><td colspan="7" class="empty">Inga arkiverade projekt ännu.</td></tr>'}</tbody></table></div>`;
}
async function renderTrash() {
  $('#app').innerHTML = pageHead('Papperskorg', 'Projekt du (eller, om du är admin, någon) tagit bort. Leveranser förloras aldrig — de hamnar i den okopplade poolen direkt vid borttagning.') + '<div id="trash-slot"><p class="muted">Laddar…</p></div>';
  let list;
  try { list = await DB.fetchTrash(); } catch (e) { $('#trash-slot').innerHTML = `<p class="muted">Kunde inte hämta: ${esc(e.message)}</p>`; return; }
  const mine = currentProfileIsAdmin() ? list : list.filter(p => p.owner_id === currentProfileId());
  $('#trash-slot').innerHTML = `<div class="tablewrap"><table class="tasktable"><thead><tr><th>Projektnummer</th><th>Namn</th><th>Ägare</th><th>Borttaget</th><th>Av</th><th></th></tr></thead><tbody>${mine.map(p => `<tr><td>${p.number}</td><td>${esc(p.name)}</td><td>${esc(p.ownerName)}</td><td>${new Date(p.deleted_at).toLocaleString('sv-SE')}</td><td>${esc(p.deletedByName)}</td><td>${btn('restore-trash', 'Återställ', p.id)}${btn('purge-trash', 'Radera permanent', p.id, '', 'class="textbutton"')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Papperskorgen är tom.</td></tr>'}</tbody></table></div>`;
}
function renderTeam() {
  $('#app').innerHTML = pageHead('Teamöversikt', 'Projekt och avvikelser per projektledare.') + `<div class="tablewrap"><table><thead><tr><th>Projektledare</th><th>Projekt</th><th>Leveranser</th><th>Kräver åtgärd</th><th></th></tr></thead><tbody>${allOwners().map(o => { const ps = state.projects.filter(p => p.owner === o && !isArchived(p)); return `<tr><td>${esc(o)}</td><td>${ps.length}</td><td>${ps.reduce((n, p) => n + p.deliveries.length, 0)}</td><td>${ps.filter(p => projectStatus(p) === 'red').length}</td><td>${btn('owner', 'Visa projekt', '', '', `data-owner="${esc(o)}"`)}</td></tr>`; }).join('')}</tbody></table></div>`;
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
  const tagOptions = `<option value="">Ingen märkning</option>${state.tags.map(t => `<option value="${t.id}" ${p.tagId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;
  dialog('Redigera projekt', field('Projektnamn', 'name', p.name, 'text', true) + `<label>Märkning (samlingsprojekt, valfritt)<select name="tagId">${tagOptions}</select></label><div class="formgrid">${field('Kundens önskade sista leveransdatum', 'desired', p.desired, 'date')}${field('Faktiskt datum', 'actual', p.actual, 'date')}${field('Påminnelsedatum', 'reminder', p.reminder, 'date')}<label>Orsak vid försening<select name="reason"><option value="">Välj orsak</option>${['Kund / tillträde', 'Fiberleverans', 'Entreprenör', 'Internt beroende', 'Annat'].map(s => `<option ${p.reason === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div><label class="check"><input name="confirmed" type="checkbox">Jag har stämt av önskat datum med kunden och verifierat att det är rimligt.</label>${p.originalDesired ? `<p class="muted">Ursprungligt önskat datum: ${p.originalDesired}. Det behålls vid ändring för uppföljning.</p>` : ''}${p.actual ? '<div class="notice">Projektet är arkiverat (faktiskt datum satt). Rensa fältet för att flytta tillbaka det till den aktiva listan.</div>' : ''}`, 'Spara', async f => {
    const desired = f.get('desired'), actual = f.get('actual'), name = f.get('name').trim();
    if (!name) return fail('Ange ett projektnamn.');
    if (desired && desired !== p.desired && !f.get('confirmed')) return fail('Bekräfta kunddialogen innan du ändrar önskat datum.');
    if (actual > state.today) return fail('Faktiskt datum kan inte ligga i framtiden.');
    if (actual && (p.originalDesired || desired) && actual > (p.originalDesired || desired) && !f.get('reason')) return fail('Välj orsakskod eftersom utfallet är senare än ursprungligt önskat datum.');
    if (actual && p.deliveries.some(l => !l.closed)) return fail('Klarskriv projektets leveranser innan du registrerar projektets faktiska slutdatum.');
    const patch = { name, desired, actual, reminder: f.get('reminder'), reason: f.get('reason'), tagId: f.get('tagId') };
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
  dialog('Lägg till etapp', field('Etappnamn', 'name', '', 'text', true) + field('Eget leveransdatum (valfritt)', 'deliveryDate', '', 'date') + '<div class="notice">Uppstartsmöte och inkommande fiber delas med leveransen. Fastighetsnät, CS-ärende, objekt och WBS kan kopplas separat via etappens kontrollpunkter.</div>', 'Skapa etapp', async f => {
    const name = f.get('name').trim();
    if (!name) return fail('Ange ett etappnamn.');
    return runWrite(DB.addStage(l.id, name, f.get('deliveryDate')), { thenRender: true }).then(ok => { if (ok) openStages.add(l.id); return ok; });
  });
}
function editStage(p, l, s) {
  dialog('Redigera etapp', field('Etappnamn', 'name', s.name, 'text', true) + field('Eget leveransdatum (valfritt)', 'deliveryDate', s.deliveryDate, 'date'), 'Spara', async f => {
    const name = f.get('name').trim();
    if (!name) return fail('Ange ett etappnamn.');
    return runWrite(DB.updateStage(s.id, { name, deliveryDate: f.get('deliveryDate') }, s.updatedAt));
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
  $('#print-report').onclick = () => {
    // Route through #report-modal (a plain overlay, not a <dialog>) — printing
    // content inside an open native <dialog> is unreliable in Chromium and
    // produces a blank page, as found while testing the tidsplansbilaga.
    const rm = $('#report-modal');
    rm.innerHTML = `<div class="reportwrap"><div class="reporttoolbar"><button type="button" data-close="report-modal">← Tillbaka</button><button type="button" id="report-print2" class="primary">Skriv ut / Spara som PDF</button></div><div class="tlsection">${$('#report-preview').innerHTML}</div></div>`;
    rm.hidden = false;
    $('#report-print2').onclick = () => window.print();
  };
  update();
}

// ---------------------------------------------------------------------
// Click dispatcher
// ---------------------------------------------------------------------
document.addEventListener('click', async e => {
  const close = e.target.closest('[data-close]');
  if (close) { const el = $('#' + close.dataset.close); if (el.close) el.close(); else el.hidden = true; return; }
  const nav = e.target.closest('[data-view]');
  if (nav) { view = nav.dataset.view; render(); return; }
  const filt = e.target.closest('[data-filter]');
  if (filt) { filter = filt.dataset.filter; render(); return; }
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const a = b.dataset.action, p = project(b.dataset.p), l = p?.deliveries.find(l => l.id === b.dataset.l), s = l?.stages.find(s => s.id === b.dataset.stage);

  if (a === 'new') newProject();
  if (a === 'reset-filter') { search = ''; filter = 'all'; owner = currentUserName(); render(); }
  if (a === 'switch-tab') { view = b.dataset.target; render(); }
  if (a === 'set-filter') { filter = b.dataset.status; saveViewPrefsSoon(); drawProjects(); }
  if (a === 'expand') { openProjects.has(p.id) ? openProjects.delete(p.id) : openProjects.add(p.id); drawProjects(); }
  if (a === 'stages') { openStages.has(l.id) ? openStages.delete(l.id) : openStages.add(l.id); drawProjects(); }
  if (a === 'dtab') { deliveryTabs[p.id] = b.dataset.dtab; drawProjects(); }
  if (a === 'customize-delivery') openColumnPicker(b, b.dataset.ctx);
  if (a === 'edit-stage') editStage(p, l, s);
  if (a === 'tab') { tabs[p.id] = b.dataset.tab; drawProjects(); if (b.dataset.tab === 'history') loadHistoryIfNeeded(p); }
  if (a === 'edit-project') editProject(p);
  if (a === 'note') editNote(p);
  if (a === 'link-delivery') { if (unlinkedCache === null) unlinkedCache = await DB.fetchUnlinkedDeliveries(); linkDeliveryDialog(p); }
  if (a === 'point') pointPanel(p, l, b.dataset.key, s);
  if (a === 'delivery') deliveryPanel(p, l);
  if (a === 'followup') followupPanel(p, l);
  if (a === 'stage') addStage(p, l);
  if (a === 'report') report(p);
  if (a === 'timeline-report') openTimelineWizard(p);
  if (a === 'open-project') { $('#modal').close(); $('#drawer').close(); view = 'all'; search = ''; filter = 'all'; openProjects.add(p.id); render(); }
  if (a === 'owner') { view = 'all'; search = b.dataset.owner; render(); }
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
  if (a === 'delete-project') dialog('Flytta till papperskorg', `<div class="notice">Projektet flyttas till din papperskorg. Leveranser raderas inte — de hamnar bland de okopplade ordrarna. Du kan själv återställa eller permanent radera det senare från "Papperskorg" i menyn.</div><p><strong>${esc(p.name)}</strong> (${p.number})</p>`, 'Flytta till papperskorg', async () => {
    const ok = await runWrite(DB.deleteProjectRemote(p.id));
    if (ok) { openProjects.delete(p.id); toast('Projektet ligger nu i papperskorgen.'); }
    return ok;
  });
  if (a === 'reactivate') dialog('Återaktivera projekt', `<p><strong>${esc(p.name)}</strong> flyttas tillbaka till den aktiva listan. Faktiskt datum rensas.</p>`, 'Återaktivera', () => runWrite(DB.updateProject(p.id, { actual: '', reason: '' }, p.updatedAt)).then(ok => { if (ok) toast('Projektet är aktivt igen.'); return ok; }));
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

  if (a === 'restore-trash') dialog('Återställ projekt', '<p>Projektet flyttas tillbaka till din aktiva lista.</p>', 'Återställ', () => DB.restoreProjectRemote(b.dataset.p).then(async () => { toast('Projektet är återställt.'); await refreshState({ silent: true }); render(); return true; }).catch(e => fail(e.message)));
  if (a === 'purge-trash') dialog('Radera permanent', '<div class="notice"><strong>Detta går inte att ångra.</strong> Projektet och dess historik tas bort helt. Leveranser som redan ligger i den okopplade poolen påverkas inte.</div>', 'Radera permanent', () => DB.purgeProjectRemote(b.dataset.p).then(async () => { toast('Projektet är permanent raderat.'); await renderTrash(); return true; }).catch(e => fail(e.message)));

});

document.addEventListener('click', e => {
  const bell = e.target.closest('#notif-bell');
  if (bell) { toggleNotifPanel(); return; }
  if (!e.target.closest('.notifpanel')) document.querySelectorAll('.notifpanel').forEach(el => el.remove());
});

// ---------------------------------------------------------------------
// Notifications (delivery date changes) — flagged in-app, per project owner.
// ---------------------------------------------------------------------
function renderNotifBell() {
  const el = $('#notif-bell');
  if (!el) return;
  const unread = notifications.filter(n => !n.read_at).length;
  el.innerHTML = `<span class="bellicon" aria-label="Aviseringar">🔔</span>${unread ? `<span class="bellcount">${unread}</span>` : ''}`;
}
function toggleNotifPanel() {
  const existing = document.querySelector('.notifpanel');
  if (existing) { existing.remove(); return; }
  const unreadIds = notifications.filter(n => !n.read_at).map(n => n.id);
  const el = document.createElement('div');
  el.className = 'notifpanel';
  el.innerHTML = `<div class="notifhead"><span>Aviseringar</span>${unreadIds.length ? '<button type="button" id="notif-markall" class="textbutton">Markera alla lästa</button>' : ''}</div>${notifications.map(n => `<div class="notifitem ${n.read_at ? '' : 'unread'}">${esc(n.message)}<small>${new Date(n.created_at).toLocaleString('sv-SE')}</small></div>`).join('') || '<div class="notifempty">Inga aviseringar ännu.</div>'}`;
  document.body.appendChild(el);
  if (unreadIds.length) $('#notif-markall').onclick = async () => {
    await DB.markAllNotificationsRead(unreadIds);
    notifications.forEach(n => n.read_at = n.read_at || new Date().toISOString());
    renderNotifBell();
    el.remove();
  };
}
async function refreshNotifications() {
  try { notifications = await DB.fetchNotifications(); renderNotifBell(); } catch (e) { /* non-critical */ }
}

// ---------------------------------------------------------------------
// Presentationsrapport (PDF via print) — Gantt built from plain divs so
// it renders identically in the print/PDF output.
// ---------------------------------------------------------------------
// =======================================================================
// Tidsplansbilaga — customer-facing timeline appendix, generated per
// project. Built strictly from real stored fields (see chat: no source
// links, dates, or dependencies are invented). Two honest limitations,
// stated once here rather than hidden:
//  - Moments (checkpoints) only ever have a single date, never a period,
//    so a moment is always shown as a milestone, never a bar.
//  - "Slutförd leverans" has no separate "customer received it" field;
//    per the agreed decision it shows the planned delivery date plus,
//    once klarskriven, "Bekräftat internt [datum]" — never implied to
//    be a verified customer-received date.
// =======================================================================
const MOMENT_LABELS = { fn1: 'Fastighetsnät 1', fn2: 'Fastighetsnät 2', cs: 'Kommunikation (CS)', object: 'Skapat objekt' };

function momentEntry(point, label) {
  if (!point) return null;
  if (point.status === 'na') return { label, state: 'na' };
  if (point.status === 'green' && point.date) return { label, state: 'done', date: point.date };
  if (point.date) return { label, state: 'open', date: point.date };
  return { label, state: 'missing' };
}
function deliverySharedMoments(l) { return [momentEntry(l.points.startup, 'Uppstartsmöte'), momentEntry(l.points.fiber, 'Inkommande fiber')].filter(Boolean); }
function ownMoments(pointsObj) { return ['fn1', 'fn2', 'cs', 'object'].map(k => momentEntry(pointsObj[k], MOMENT_LABELS[k])).filter(Boolean); }
function firstCompletedDate(pointsObj, keys) { const ds = keys.map(k => pointsObj[k]).filter(p => p.status === 'green' && p.date).map(p => p.date); return ds.length ? ds.sort()[0] : null; }
function deliveryBar(l) {
  const start = firstCompletedDate(l.points, ['startup', 'fn1', 'fn2', 'fiber', 'cs', 'object']);
  if (start && l.deliveryDate && start < l.deliveryDate) return { type: 'period', start, end: l.deliveryDate };
  if (l.deliveryDate) return { type: 'milestone', date: l.deliveryDate };
  return { type: 'none' };
}
function stageBar(s) {
  const start = firstCompletedDate(s.points, ['fn1', 'fn2', 'cs', 'object']);
  if (start && s.deliveryDate && start < s.deliveryDate) return { type: 'period', start, end: s.deliveryDate };
  if (s.deliveryDate) return { type: 'milestone', date: s.deliveryDate };
  return { type: 'none' };
}
function fmtSv(d) { return d ? new Date(d + 'T00:00:00').toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

function dateRangeFor(p) {
  const all = [];
  p.deliveries.forEach(l => { const b = deliveryBar(l); if (b.type === 'period') all.push(b.start, b.end); if (b.type === 'milestone') all.push(b.date); l.stages.forEach(s => { const sb = stageBar(s); if (sb.type === 'period') all.push(sb.start, sb.end); if (sb.type === 'milestone') all.push(sb.date); }); });
  const valid = all.filter(Boolean).sort();
  if (!valid.length) return null;
  const start = new Date(valid[0] + 'T00:00:00'); start.setDate(1);
  const endRaw = new Date(valid.at(-1) + 'T00:00:00');
  const end = new Date(endRaw.getFullYear(), endRaw.getMonth() + 1, 0);
  return { start, end };
}
function monthTicks(range) {
  const ticks = []; let d = new Date(range.start), first = true;
  while (d <= range.end) {
    ticks.push({ pct: ((d - range.start) / (range.end - range.start)) * 100, label: d.toLocaleDateString('sv-SE', { month: 'short' }) + (d.getMonth() === 0 || first ? ' \'' + String(d.getFullYear()).slice(2) : '') });
    first = false; d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  return ticks;
}
function pctOf(dateStr, range) { return Math.min(100, Math.max(0, ((new Date(dateStr + 'T00:00:00') - range.start) / (range.end - range.start)) * 100)); }
function todayPct(range) { const t = new Date(); return t >= range.start && t <= range.end ? ((t - range.start) / (range.end - range.start)) * 100 : null; }

function ganttRow(labelHTML, bar, range, flagComment) {
  let mark = '';
  if (bar.type === 'period') mark = `<span class="gbar" style="left:${pctOf(bar.start, range)}%;width:${Math.max(1.5, pctOf(bar.end, range) - pctOf(bar.start, range))}%"></span><span class="gmilestone" style="left:${pctOf(bar.end, range)}%" title="${fmtSv(bar.end)}"></span>`;
  else if (bar.type === 'milestone') mark = `<span class="gmilestone" style="left:${pctOf(bar.date, range)}%" title="${fmtSv(bar.date)}"></span>`;
  const dateText = bar.type === 'none' ? '<span class="gnodate">Datum saknas</span>' : bar.type === 'milestone' ? `<span class="gdatetext">${fmtSv(bar.date)}</span>` : `<span class="gdatetext">${fmtSv(bar.end)}</span>`;
  return `<div class="grow2"><span class="glabel2">${labelHTML}</span><div class="gtrack2">${mark}</div>${dateText}</div>${flagComment ? `<div class="gflag">⚠ ${esc(flagComment)}</div>` : ''}`;
}
function momentRowHTML(entry) {
  if (!entry) return '';
  const cls = { na: 'muted', done: 'done', open: 'open', missing: 'muted' }[entry.state];
  const text = entry.state === 'na' ? 'Ej aktuellt' : entry.state === 'done' ? `Klart · ${fmtSv(entry.date)}` : entry.state === 'open' ? `Datum behöver bekräftas · ${fmtSv(entry.date)}` : 'Datum saknas';
  return `<div class="momentrow"><span class="momentlabel">${esc(entry.label)}</span><span class="momentstate ${cls}">${text}</span></div>`;
}
function completionRowHTML(label, plannedDate, closedDate) {
  const text = (plannedDate ? `Planerat: ${fmtSv(plannedDate)}` : 'Datum saknas') + (closedDate ? ` · Bekräftat internt: ${fmtSv(closedDate)}` : '');
  return `<div class="momentrow"><span class="momentlabel">${label}</span><span class="momentstate ${closedDate ? 'done' : 'open'}">${text}</span></div>`;
}

function openTimelineWizard(p) {
  dialog('Skapa tidsplansbilaga', `<p class="muted">${esc(p.name)} · samtliga ${p.deliveries.length} leveranser ingår, oavsett variant.</p><label>Variant<select name="variant"><option value="overview">Övergripande</option><option value="detailed">Detaljerad</option><option value="both" selected>Båda</option></select></label><label class="check"><input type="checkbox" name="showStages" checked>Visa etapper i den övergripande Gantt-delen (när de finns)</label><label class="check"><input type="checkbox" name="showRefs">Ta med referenser och WBS i den detaljerade tabellen</label>`, 'Fortsätt till granskning', f => {
    openTimelineReview(p, { variant: f.get('variant'), showStages: !!f.get('showStages'), showRefs: !!f.get('showRefs') });
    return false;
  });
}
function hasOpenCheckpointIssue(l) {
  const keys = ['startup', 'fn1', 'fn2', 'fiber', 'cs', 'object'];
  return keys.some(k => ['red', 'missing'].includes(l.points[k].status)) || l.stages.some(s => keys.filter(k => k !== 'startup' && k !== 'fiber').some(k => ['red', 'missing'].includes(s.points[k]?.status)));
}
function openTimelineReview(p, opts) {
  const flaggable = p.deliveries.filter(l => !l.closed && hasOpenCheckpointIssue(l));
  dialog('Granska kundpåverkan innan export', `<p class="muted">${flaggable.length ? 'Dessa leveranser har öppna avvikelser internt. Lägg bara till en kundkommentar om det faktiskt påverkar kunden — annars visas leveransen neutralt utan varning.' : 'Inga öppna interna avvikelser att granska.'}</p>${flaggable.map(l => `<div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:10px"><strong>${esc(l.name)}</strong> · ${esc(l.order)}<label class="check" style="margin-top:6px"><input type="checkbox" data-flag="${l.id}">Flagga som kundpåverkan i bilagan</label><textarea data-comment="${l.id}" placeholder="Kort, kundanpassad förklaring (visas bara om flaggad)"></textarea></div>`).join('')}<label>Sammanfattande kommentar (valfri, visas i bilagan)<textarea name="summary"></textarea></label><label class="check"><input type="checkbox" name="saveNote">Spara sammanfattande kommentar även som projektanteckning</label>`, 'Generera bilaga', async f => {
    const flags = {};
    flaggable.forEach(l => { const cb = document.querySelector(`[data-flag="${l.id}"]`), ta = document.querySelector(`[data-comment="${l.id}"]`); if (cb?.checked && ta?.value.trim()) flags[l.id] = ta.value.trim(); });
    const summary = f.get('summary').trim();
    if (f.get('saveNote') && summary) await runWrite(DB.updateProject(p.id, { note: (p.note ? p.note + '\n\n' : '') + summary }, p.updatedAt), { thenRender: false });
    renderTimelineReport(p, { ...opts, flags, summary });
    return false;
  });
}

function renderOverviewSection(p, opts, range) {
  const done = p.deliveries.filter(l => l.closed).length;
  const plannedDates = p.deliveries.map(l => l.deliveryDate).filter(Boolean);
  const lastPlanned = plannedDates.length === p.deliveries.length ? plannedDates.sort().at(-1) : null;
  return `<section class="tlsection"><div class="tlhead"><div><h1>Tidsplan – ${esc(p.name)}</h1><div class="tlsub">Övergripande</div></div><div class="tlmeta"><div>Kund: ${esc(customerNames(p).join(', ') || '–')}</div><div>${p.number} · Genererad ${new Date().toLocaleString('sv-SE')}</div></div></div>
  <div class="tlsummary"><div><i class="ico">▤</i><span><strong>${p.deliveries.length}</strong> leveranser</span></div><div><i class="ico">✓</i><span><strong>${done}</strong> färdigställda</span></div><div><i class="ico">▦</i><span>Kundens önskade sista datum <strong>${p.desired ? fmtSv(p.desired) : 'ej angivet'}</strong></span></div><div><i class="ico">▦</i><span>${lastPlanned ? 'Aktuell plan, sista leverans <strong>' + fmtSv(lastPlanned) + '</strong>' : 'Aktuell plan: ej fullständig — inte alla leveranser har datum'}</span></div></div>
  <div class="tlgantt">${range ? `<div class="gscale2">${monthTicks(range).map(t => `<span style="left:${t.pct}%">${t.label}</span>`).join('')}</div>${todayPct(range) !== null ? `<div class="gtoday" style="left:${todayPct(range)}%"><span>Idag</span></div>` : ''}` : '<p class="muted">Inga daterade leveranser att placera på en tidsaxel ännu.</p>'}
  ${p.deliveries.map(l => range ? ganttRow(esc(l.name), deliveryBar(l), range, opts.flags[l.id]) + (opts.showStages ? l.stages.map(s => ganttRow('&nbsp;&nbsp;↳ ' + esc(s.name), stageBar(s), range)).join('') : '') : `<div class="grow2"><span class="glabel2">${esc(l.name)}</span><span class="gnodate">Datum saknas</span></div>`).join('')}
  </div>
  ${opts.summary || Object.keys(opts.flags).length ? `<div class="tlchanges"><strong>Kundrelevanta kommentarer</strong>${opts.summary ? `<p>${esc(opts.summary)}</p>` : ''}${Object.entries(opts.flags).map(([lid, c]) => { const l = p.deliveries.find(x => x.id === lid); return `<p>⚠ <strong>${esc(l?.name || '')}:</strong> ${esc(c)}</p>`; }).join('')}</div>` : ''}
  <div class="tllegend">${legendItems()}<span>◆ Milstolpe</span><span>▬ Planerad period</span></div>
  <div class="tlfooter">Genererad ${new Date().toLocaleString('sv-SE')}. Underlaget speglar status vid genereringstillfället — inte en levande uppdatering. Datum utan bekräftelse redovisas som prognos.</div>
  </section>`;
}
function renderDetailedSection(p, opts, range) {
  const rows = p.deliveries.map(l => {
    const shared = deliverySharedMoments(l), own = ownMoments(l.points);
    const stagesHTML = l.stages.map(s => `<div class="tlstage"><div class="tlstagename">↳ ${esc(s.name)}</div>${ownMoments(s.points).map(momentRowHTML).join('')}${completionRowHTML('Slutförd etapp', s.deliveryDate, Object.values(s.points).filter(k => k).every(pt => pt.status === 'green' || pt.status === 'na') ? (s.deliveryDate || null) : null)}</div>`).join('');
    return `<div class="tldelivery">
      <div class="tldeliveryhead"><strong>${esc(l.name)}</strong><span class="muted">${esc(l.order)}${opts.showRefs ? ` · ${esc(l.customer)}` : ''}</span></div>
      ${range ? ganttRow('', deliveryBar(l), range, opts.flags[l.id]) : ''}
      ${shared.map(momentRowHTML).join('')}
      ${!l.stages.length ? own.map(momentRowHTML).join('') : ''}
      ${!l.stages.length ? completionRowHTML('Slutförd leverans', l.deliveryDate, l.closed) : ''}
      ${stagesHTML}
      ${l.stages.length ? completionRowHTML('Slutförd leverans (hela)', l.deliveryDate, l.closed) : ''}
    </div>`;
  }).join('');
  const showWbs = opts.showRefs && p.deliveries.some(l => l.points.wbs.ref);
  return `<section class="tlsection"><div class="tlhead"><div><h1>Tidsplan – ${esc(p.name)}</h1><div class="tlsub">Detaljerad</div></div><div class="tlmeta"><div>Kund: ${esc(customerNames(p).join(', ') || '–')}</div><div>${p.number} · Genererad ${new Date().toLocaleString('sv-SE')}</div></div></div>
  <div class="tlgantt">${range ? `<div class="gscale2">${monthTicks(range).map(t => `<span style="left:${t.pct}%">${t.label}</span>`).join('')}</div>${todayPct(range) !== null ? `<div class="gtoday" style="left:${todayPct(range)}%"><span>Idag</span></div>` : ''}` : ''}
  ${rows}
  </div>
  ${opts.showRefs ? `<table class="reporttable"><thead><tr><th>Leverans</th><th>Planerat datum</th><th>Faktiskt / bekräftat</th>${showWbs ? '<th>WBS</th>' : ''}<th>Kommentar</th></tr></thead><tbody>${p.deliveries.map(l => `<tr><td>${esc(l.name)}</td><td>${l.deliveryDate ? fmtSv(l.deliveryDate) : 'Datum saknas'}</td><td>${l.closed ? fmtSv(l.closed) : '–'}</td>${showWbs ? `<td>${esc(l.points.wbs.ref || '–')}</td>` : ''}<td>${esc(opts.flags[l.id] || '')}</td></tr>`).join('')}</tbody></table>` : ''}
  <div class="tllegend">${legendItems()}</div>
  <div class="tlfooter">Genererad ${new Date().toLocaleString('sv-SE')}. Underlaget speglar status vid genereringstillfället. Interna referenser och anteckningar ingår inte.</div>
  </section>`;
}
function renderTimelineReport(p, opts) {
  const range = dateRangeFor(p);
  const modal = $('#report-modal');
  let body = '';
  if (opts.variant === 'overview' || opts.variant === 'both') body += renderOverviewSection(p, opts, range);
  if (opts.variant === 'both') body += '<div class="tlpagebreak"></div>';
  if (opts.variant === 'detailed' || opts.variant === 'both') body += renderDetailedSection(p, opts, range);
  modal.innerHTML = `<div class="reportwrap"><div class="reporttoolbar"><button type="button" data-close="report-modal">← Tillbaka</button><button type="button" id="report-print" class="primary">Skriv ut / Spara som PDF</button></div>${body}</div>`;
  modal.hidden = false;
  $('#report-print').onclick = () => window.print();
}

// ---------------------------------------------------------------------
// Boot — wait for auth.js to finish signing the user in, then load,
// render, and subscribe to realtime changes from other testers.
// ---------------------------------------------------------------------
let unsubscribeRealtime = null, unsubscribeNotify = null;
async function boot() {
  await refreshState();
  owner = currentUserName();
  try {
    viewPrefs = await DB.fetchViewPreferences();
    if (viewPrefs.filters?.status) filter = viewPrefs.filters.status;
  } catch (e) { /* defaults are fine */ }
  await refreshNotifications();
  render();
  if (!unsubscribeRealtime) unsubscribeRealtime = DB.subscribeRealtime(async () => { await refreshState({ silent: true }); render(); });
  if (!unsubscribeNotify) unsubscribeNotify = DB.subscribeNotifications(() => refreshNotifications());
}
document.addEventListener('dpa:authenticated', boot);
document.addEventListener('dpa:refresh', async () => { await refreshState({ silent: true }); render(); });
