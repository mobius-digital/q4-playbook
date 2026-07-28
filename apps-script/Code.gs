/**
 * Q4 Playbook — backend API (Google Apps Script + Google Sheets)
 * Mobius Digital
 *
 * SETUP (one time):
 *   1. script.google.com → New project → paste this whole file → save.
 *   2. Run the `setup` function once (▶ button). Authorize when asked.
 *   3. Open View → Logs. Copy the TEAM PASSCODE and the Sheet URL it prints.
 *   4. Deploy → New deployment → type: Web app
 *        Execute as: Me
 *        Who has access: Anyone
 *      → copy the Web app URL and paste it into API_URL in index.html.
 *
 * DATA: one spreadsheet ("Q4 Playbook DB"), auto-created, with three tabs:
 *   Brands: name | token | archived     (token = the client link key)
 *   State:  brand | json | updatedAt    (one row per brand, full plan as JSON)
 *   Global: key | json                  (shared check-in slots, BF date)
 *
 * Brand removal is a SOFT DELETE (archived=TRUE). Re-adding the same brand
 * name restores it with all of its history and the same client link.
 *
 * To change the team passcode later:
 *   Project Settings → Script properties → edit ADMIN_PASS.
 */

const DB_NAME = 'Q4 Playbook DB';

/* ---------- setup & plumbing ---------- */

function setup() {
  getDb_();
  const props = PropertiesService.getScriptProperties();
  Logger.log('DB ready: ' + SpreadsheetApp.openById(props.getProperty('DB_ID')).getUrl());
  Logger.log('TEAM PASSCODE: ' + pass_());
  Logger.log('Now deploy as a Web app (Execute as Me, access: Anyone) and paste the URL into index.html.');
}

function getDb_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('DB_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) { ss = SpreadsheetApp.create(DB_NAME); props.setProperty('DB_ID', ss.getId()); }
  ensure_(ss, 'Brands', ['name', 'token', 'archived']);
  ensure_(ss, 'State', ['brand', 'json', 'updatedAt']);
  ensure_(ss, 'Global', ['key', 'json']);
  return ss;
}

function ensure_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); }
  return sh;
}

function pass_() {
  const p = PropertiesService.getScriptProperties();
  let v = p.getProperty('ADMIN_PASS');
  if (!v) { v = 'mobius-' + Utilities.getUuid().slice(0, 6); p.setProperty('ADMIN_PASS', v); }
  return v;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- HTTP entry points ---------- */

function doGet() { return json_({ ok: true, service: 'q4-playbook' }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const req = JSON.parse((e.postData && e.postData.contents) || '{}');
    return json_(Object.assign({ ok: true }, route_(req)));
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function route_(req) {
  switch (req.action) {
    case 'clientLoad': return clientLoad_(req);
    case 'clientSave': return clientSave_(req);
  }
  if (String(req.pass) !== pass_()) throw 'Bad passcode';
  switch (req.action) {
    case 'adminLoad': return adminLoad_();
    case 'saveState': return saveState_(req.brand, req.state);
    case 'saveGlobal': return saveGlobal_(req);
    case 'addBrand': return addBrand_(req.name);
    case 'archiveBrand': return archiveBrand_(req.name);
  }
  throw 'Unknown action: ' + req.action;
}

/* ---------- data access ---------- */

function brands_() {
  const v = getDb_().getSheetByName('Brands').getDataRange().getValues();
  return v.slice(1).map(function (r, i) {
    return { row: i + 2, name: String(r[0]), token: String(r[1]), archived: r[2] === true || r[2] === 'TRUE' };
  }).filter(function (b) { return b.name; });
}

function findBrand_(name) {
  return brands_().find(function (b) { return b.name === name; }) || null;
}

function checkClient_(req) {
  const b = findBrand_(String(req.brand || ''));
  if (!b || b.archived || String(req.key) !== b.token) throw 'Invalid link';
  return b;
}

function stateMap_() {
  const v = getDb_().getSheetByName('State').getDataRange().getValues();
  const m = {};
  v.slice(1).forEach(function (r, i) { if (r[0]) m[String(r[0])] = { row: i + 2, json: r[1] }; });
  return m;
}

function getGlobal_(key) {
  const v = getDb_().getSheetByName('Global').getDataRange().getValues();
  for (let i = 1; i < v.length; i++) if (String(v[i][0]) === key) return v[i][1] ? JSON.parse(v[i][1]) : null;
  return null;
}

function setGlobal_(key, obj) {
  const sh = getDb_().getSheetByName('Global');
  const v = sh.getDataRange().getValues();
  const s = JSON.stringify(obj);
  for (let i = 1; i < v.length; i++) if (String(v[i][0]) === key) { sh.getRange(i + 1, 2).setValue(s); return; }
  sh.appendRow([key, s]);
}

/* ---------- actions ---------- */

function adminLoad_() {
  const bs = brands_().filter(function (b) { return !b.archived; });
  const sm = stateMap_();
  const states = {};
  bs.forEach(function (b) { states[b.name] = sm[b.name] && sm[b.name].json ? JSON.parse(sm[b.name].json) : null; });
  return {
    brands: bs.map(function (b) { return { name: b.name, token: b.token }; }),
    states: states,
    slots: getGlobal_('slots') || {},
    bf: getGlobal_('bf') || '',
    defaults: getGlobal_('defaults') || {}
  };
}

function clientLoad_(req) {
  const b = checkClient_(req);
  const sm = stateMap_();
  return {
    state: sm[b.name] && sm[b.name].json ? JSON.parse(sm[b.name].json) : null,
    slots: getGlobal_('slots') || {},
    bf: getGlobal_('bf') || '',
    defaults: getGlobal_('defaults') || {}
  };
}

function saveState_(brand, state) {
  if (!brand) throw 'Brand required';
  const sh = getDb_().getSheetByName('State');
  const sm = stateMap_();
  const s = JSON.stringify(state || {});
  const t = new Date();
  if (sm[brand]) sh.getRange(sm[brand].row, 2, 1, 2).setValues([[s, t]]);
  else sh.appendRow([brand, s, t]);
  return {};
}

/* Clients can only write questionnaire answers and per-item comment notes. */
function clientSave_(req) {
  const b = checkClient_(req);
  const sm = stateMap_();
  const cur = (sm[b.name] && sm[b.name].json ? JSON.parse(sm[b.name].json) : null) || {};
  cur.answers = Object.assign(cur.answers || {}, req.answers || {});
  cur.items = cur.items || {};
  const notes = req.notes || {};
  Object.keys(notes).forEach(function (k) {
    cur.items[k] = Object.assign({ status: 'not', owner: '', note: '' }, cur.items[k] || {}, { note: String(notes[k]) });
  });
  return saveState_(b.name, cur);
}

function saveGlobal_(req) {
  if (req.slots) setGlobal_('slots', req.slots);
  if (req.bf !== undefined && req.bf !== null) setGlobal_('bf', String(req.bf));
  if (req.defaults) setGlobal_('defaults', req.defaults);
  return {};
}

function addBrand_(name) {
  name = String(name || '').trim();
  if (!name) throw 'Name required';
  const ex = findBrand_(name);
  const sh = getDb_().getSheetByName('Brands');
  if (ex) {
    if (ex.archived) { sh.getRange(ex.row, 3).setValue(false); return { token: ex.token, restored: true }; }
    throw 'Brand already exists';
  }
  const token = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  sh.appendRow([name, token, false]);
  return { token: token };
}

function archiveBrand_(name) {
  const b = findBrand_(String(name || ''));
  if (!b) throw 'Brand not found';
  getDb_().getSheetByName('Brands').getRange(b.row, 3).setValue(true);
  return {};
}
