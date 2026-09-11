// ---------------------------------------------------------------------
// DPA – data layer. Fetches from Supabase and reshapes into exactly the
// `state.projects` structure app.js already renders (same field names:
// id, number, name, owner, customers, desired, originalDesired, actual,
// reason, reminder, note, noteAt, history, deliveries[{id, name, order,
// customer, org, created, deliveryDate, reportDate, closed, followOverride,
// followHistory, points, stages, sourceAt}]). This means the rendering
// functions in app.js do not need to change — only how state is loaded
// and how mutations are written back.
// ---------------------------------------------------------------------
import { supabase, getProfile } from './auth.js';

const CHECKPOINT_KEYS = ['startup', 'fn1', 'fn2', 'fiber', 'cs', 'object'];
const SOURCE_LABEL = { startup: 'DELTA / källsystem', fn1: 'DELTA / källsystem', fn2: 'DELTA / källsystem', fiber: 'Trade / Colt', cs: 'TeliaNow', object: 'DELTA / källsystem' };

function emptyPoints() {
  const o = {};
  CHECKPOINT_KEYS.forEach(k => { o[k] = { ref: '', status: 'unknown', date: '', detail: '', manual: false }; });
  return o;
}
function mapCheckpointRow(row) {
  return { ref: row.reference || '', status: row.status, date: row.status_date || '', detail: row.detail || '', manual: row.manual || false, source: SOURCE_LABEL[row.checkpoint_type] };
}
function nameFor(profilesById, id) {
  const p = profilesById[id];
  return p ? p.full_name : 'Okänd';
}

// -----------------------------------------------------------------
// Full-state load. One round trip per table, joined client-side —
// simplest to reason about correctly for a dataset this size.
// -----------------------------------------------------------------
export async function loadState() {
  const [{ data: profiles }, { data: projects }, { data: customers }, { data: deliveries }, { data: stages }, { data: checkpoints }, { data: followups }] = await Promise.all([
    supabase.from('profiles').select('id,username,full_name,role'),
    supabase.from('projects').select('*').is('deleted_at', null).order('created_at'),
    supabase.from('project_customers').select('*'),
    supabase.from('deliveries').select('*').not('project_id', 'is', null).order('created_at'),
    supabase.from('stages').select('*').order('created_at'),
    supabase.from('checkpoints').select('*'),
    supabase.from('follow_up_events').select('*').order('completed_date'),
  ]);

  const profilesById = Object.fromEntries((profiles || []).map(p => [p.id, p]));
  const stagesByDelivery = groupBy(stages || [], 'delivery_id');
  const checkpointsByDelivery = groupBy((checkpoints || []).filter(c => c.delivery_id), 'delivery_id');
  const checkpointsByStage = groupBy((checkpoints || []).filter(c => c.stage_id), 'stage_id');
  const customersByProject = groupBy(customers || [], 'project_id');
  const deliveriesByProject = groupBy(deliveries || [], 'project_id');
  const followupsByDelivery = groupBy(followups || [], 'delivery_id');

  function pointsFor(cpRows) {
    const pts = emptyPoints();
    cpRows.forEach(row => { pts[row.checkpoint_type] = mapCheckpointRow(row); });
    return pts;
  }

  const mappedProjects = (projects || []).map(pr => ({
    id: pr.id,
    number: pr.number,
    name: pr.name,
    ownerId: pr.owner_id,
    owner: nameFor(profilesById, pr.owner_id),
    customers: (customersByProject[pr.id] || []).map(c => ({ id: c.id, name: c.name, org: c.org_number })),
    desired: pr.desired_date || '',
    originalDesired: pr.original_desired_date || '',
    actual: pr.actual_date || '',
    reason: pr.reason_code || '',
    reminder: pr.reminder_date || '',
    note: pr.note || '',
    noteAt: pr.note_updated_at ? new Date(pr.note_updated_at).toLocaleString('sv-SE') : '',
    updatedAt: pr.updated_at,
    history: [], // filled lazily via fetchHistory() when the history tab is opened
    deliveries: (deliveriesByProject[pr.id] || []).map(d => ({
      id: d.id,
      name: d.name,
      order: `${d.order_type}-${d.order_id}`,
      orderType: d.order_type,
      orderId: d.order_id,
      customer: d.customer_name || '',
      org: d.org_number || '',
      created: d.created_date,
      deliveryDate: d.delivery_date || '',
      reportDate: d.report_date || '',
      closed: d.closed_date || '',
      followOverride: d.follow_override || '',
      followOverrideReason: d.follow_override_reason || '',
      followHistory: (followupsByDelivery[d.id] || []).map(f => ({ date: f.completed_date, note: f.note, by: nameFor(profilesById, f.completed_by) })),
      points: pointsFor(checkpointsByDelivery[d.id] || []),
      stages: (stagesByDelivery[d.id] || []).map(s => ({
        id: s.id, name: s.name,
        points: pointsFor(checkpointsByStage[s.id] || []),
      })),
      sourceAt: d.source_synced_at ? new Date(d.source_synced_at).toLocaleString('sv-SE') : 'Aldrig hämtad',
      updatedAt: d.updated_at,
    })),
  }));

  return { today: new Date().toISOString().slice(0, 10), projects: mappedProjects };
}

function groupBy(rows, key) {
  const out = {};
  rows.forEach(r => { (out[r[key]] ||= []).push(r); });
  return out;
}

// -----------------------------------------------------------------
// Realtime: any change to the core tables triggers a debounced
// full refetch + re-render, so every signed-in tester sees changes
// from colleagues without reloading.
// -----------------------------------------------------------------
export function subscribeRealtime(onChange) {
  let t = null;
  const debounced = () => { clearTimeout(t); t = setTimeout(onChange, 400); };
  const channel = supabase.channel('dpa-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stages' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'checkpoints' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'project_customers' }, debounced)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'follow_up_events' }, debounced)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// -----------------------------------------------------------------
// Errors thrown by write helpers carry a `.kind` so app.js can show
// the right message ('conflict' | 'duplicate' | 'permission' | 'error').
// -----------------------------------------------------------------
class DbError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

export async function createProject({ name }) {
  const { data, error } = await supabase.from('projects').insert({ name, owner_id: getProfile().id }).select().single();
  if (error) throw new DbError(error.message, 'error');
  return data;
}

// Concurrency-safe update: the WHERE clause only matches if the row is
// still at the version we last loaded. If nothing matches, someone else
// changed it first — refetch and tell the user, never silently overwrite.
export async function updateProject(id, patch, expectedUpdatedAt) {
  const dbPatch = {};
  if ('name' in patch) dbPatch.name = patch.name;
  if ('desired' in patch) dbPatch.desired_date = patch.desired || null;
  if ('originalDesired' in patch) dbPatch.original_desired_date = patch.originalDesired || null;
  if ('actual' in patch) dbPatch.actual_date = patch.actual || null;
  if ('reason' in patch) dbPatch.reason_code = patch.reason || null;
  if ('reminder' in patch) dbPatch.reminder_date = patch.reminder || null;
  if ('note' in patch) dbPatch.note = patch.note;
  const { data, error } = await supabase.from('projects').update(dbPatch).eq('id', id).eq('updated_at', expectedUpdatedAt).select();
  if (error) throw new DbError(error.message, 'error');
  if (!data || data.length === 0) throw new DbError('Projektet har ändrats av någon annan sedan du öppnade det.', 'conflict');
  return data[0];
}

export async function takeOverProject(id) {
  const { data, error } = await supabase.rpc('take_over_project', { p_project_id: id });
  if (error) throw new DbError(error.message, 'error');
  return data;
}
export async function deleteProjectRemote(id, note) {
  const { error } = await supabase.rpc('delete_project', { p_project_id: id, p_note: note || '' });
  if (error) throw new DbError(error.message, 'error');
}
export async function restoreProjectRemote(id) {
  const { error } = await supabase.rpc('restore_project', { p_project_id: id });
  if (error) throw new DbError(error.message, 'error');
}
export async function fetchDeletedProjects() {
  const { data, error } = await supabase.from('projects').select('id,number,name,deleted_at,deleted_by,profiles:deleted_by(full_name)').not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
  if (error) throw new DbError(error.message, 'error');
  return data || [];
}

export async function addCustomer(projectId, { name, org }) {
  const { error } = await supabase.from('project_customers').insert({ project_id: projectId, name, org_number: org });
  if (error) throw new DbError(error.message, 'error');
}

// Linking now means: take an existing delivery row from the unlinked
// pool (fetchUnlinkedDeliveries) and assign it to a project — never an
// arbitrary typed-in id, since only known orders exist until real
// integrations are connected. This reuses whatever checkpoints the row
// already has rather than re-creating it.
export async function linkDelivery(deliveryId, projectId, newName) {
  const { error } = await supabase.rpc('link_delivery', { p_delivery_id: deliveryId, p_project_id: projectId });
  if (error) {
    if (error.message?.includes('duplicate')) throw new DbError('Den här leveransen är redan kopplad till ett projekt.', 'duplicate');
    throw new DbError(error.message, 'error');
  }
  if (newName) await supabase.from('deliveries').update({ name: newName }).eq('id', deliveryId);
}
export async function unlinkDelivery(deliveryId, note) {
  const { error } = await supabase.rpc('unlink_delivery', { p_delivery_id: deliveryId, p_note: note || '' });
  if (error) throw new DbError(error.message, 'error');
}

export async function updateDeliveryField(id, patch, expectedUpdatedAt) {
  const dbPatch = {};
  if ('reportDate' in patch) dbPatch.report_date = patch.reportDate || null;
  if ('deliveryDate' in patch) dbPatch.delivery_date = patch.deliveryDate || null;
  if ('deliveryDate' in patch) dbPatch.source_synced_at = new Date().toISOString();
  const { data, error } = await supabase.from('deliveries').update(dbPatch).eq('id', id).eq('updated_at', expectedUpdatedAt).select();
  if (error) throw new DbError(error.message, 'error');
  if (!data || data.length === 0) throw new DbError('Leveransen har ändrats av någon annan sedan du öppnade den.', 'conflict');
  return data[0];
}

export async function closeDelivery(id, note) {
  const { error } = await supabase.rpc('close_delivery', { p_delivery_id: id, p_note: note || '' });
  if (error) throw new DbError(error.message, 'error');
}
export async function completeFollowup(id, date, note) {
  const { error } = await supabase.rpc('complete_followup', { p_delivery_id: id, p_completed_date: date, p_note: note || '' });
  if (error) throw new DbError(error.message, 'error');
}
export async function setFollowOverride(id, date, reason) {
  const { error } = await supabase.rpc('set_followup_override', { p_delivery_id: id, p_date: date, p_reason: reason });
  if (error) throw new DbError(error.message, 'error');
}

export async function addStage(deliveryId, name) {
  const { data, error } = await supabase.from('stages').insert({ delivery_id: deliveryId, name }).select().single();
  if (error) throw new DbError(error.message, 'error');
  const rows = ['fn1', 'fn2', 'cs', 'object'].map(type => ({ stage_id: data.id, checkpoint_type: type, status: 'unknown' }));
  await supabase.from('checkpoints').insert(rows);
  return data;
}

// Checkpoint update: either targets a delivery-level or stage-level row
// directly (they're pre-created for every delivery/stage), so this is a
// plain update keyed by (owner_id, checkpoint_type) rather than an upsert.
export async function updateCheckpoint({ deliveryId, stageId, type, patch }) {
  const dbPatch = {};
  if ('ref' in patch) dbPatch.reference = patch.ref;
  if ('status' in patch) dbPatch.status = patch.status;
  if ('date' in patch) dbPatch.status_date = patch.date || null;
  if ('detail' in patch) dbPatch.detail = patch.detail;
  if ('manual' in patch) dbPatch.manual = patch.manual;
  let q = supabase.from('checkpoints').update(dbPatch).eq('checkpoint_type', type);
  q = stageId ? q.eq('stage_id', stageId) : q.eq('delivery_id', deliveryId);
  const { error } = await q;
  if (error) throw new DbError(error.message, 'error');
}

export async function fetchHistory(project) {
  const deliveryIds = project.deliveries.map(d => d.id);
  const { data, error } = await supabase.from('audit_events')
    .select('*, actor:actor_id(full_name)')
    .eq('entity_type', 'project').eq('entity_id', project.id)
    .order('occurred_at', { ascending: false });
  const deliveryEvents = deliveryIds.length
    ? (await supabase.from('audit_events').select('*, actor:actor_id(full_name)').eq('entity_type', 'delivery').in('entity_id', deliveryIds).order('occurred_at', { ascending: false })).data || []
    : [];
  if (error) throw new DbError(error.message, 'error');
  return [...(data || []), ...deliveryEvents].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

export async function fetchUnlinkedDeliveries() {
  const { data, error } = await supabase.from('deliveries').select('*, checkpoints(*)').is('project_id', null).order('created_at', { ascending: false });
  if (error) throw new DbError(error.message, 'error');
  return (data || []).map(d => ({
    id: d.id, order: `${d.order_type}-${d.order_id}`, name: d.name, customer: d.customer_name, org: d.org_number,
    deliveryDate: d.delivery_date, knownCheckpoints: (d.checkpoints || []).filter(c => c.reference).length,
  }));
}
