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

/* Run this ONCE in the editor after enabling Google sign-in, to grant the
   "connect to an external service" permission (used to verify Google logins). */
function authorize() {
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
  getDb_();
  Logger.log('Authorized — Google sign-in is ready.');
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

/* ---------- Google sign-in, allow-list & sessions ---------- */

var OWNER = 'cole@go-mobius-digital.com';                                       // always allowed + admin
var GOOGLE_CLIENT_ID = '1084707732685-tu8ra68po4vs4rhbt71rkpej72g4pg28.apps.googleusercontent.com';
var SESSION_TTL = 30 * 24 * 60 * 60 * 1000;                                     // 30 days

function usersList_() { return getGlobal_('users') || []; }
function isAllowed_(email) { email = String(email || '').toLowerCase(); return email === OWNER || usersList_().indexOf(email) >= 0; }

function verifyGoogle_(idToken) {
  if (!idToken) throw 'Missing sign-in token';
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw 'Sign-in verification failed';
  var info = JSON.parse(res.getContentText());
  if (info.aud !== GOOGLE_CLIENT_ID) throw 'Sign-in was issued for a different app';
  if (String(info.email_verified) !== 'true') throw 'Your Google email is not verified';
  if (Number(info.exp) * 1000 < Date.now()) throw 'Sign-in expired — try again';
  return String(info.email).toLowerCase();
}

function sessions_() { return getGlobal_('sessions') || {}; }
function newSession_(email) {
  var s = sessions_(), now = Date.now();
  Object.keys(s).forEach(function (t) { if (!s[t] || !s[t].ts || now - s[t].ts > SESSION_TTL) delete s[t]; });
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  s[token] = { email: email, ts: now };
  setGlobal_('sessions', s);
  return token;
}
function sessionEmail_(token) {
  if (!token) return null;
  var e = sessions_()[token];
  if (!e || Date.now() - e.ts > SESSION_TTL) return null;
  return e.email;
}
function authEmail_(req) {                     // valid, allow-listed email from a session token, else null
  var e = sessionEmail_(req.auth);
  return (e && isAllowed_(e)) ? e : null;
}

function googleAuth_(req) {
  var email = verifyGoogle_(req.idToken);
  if (!isAllowed_(email)) throw 'Access denied for ' + email + '. Ask the Q4 Playbook owner to add your email.';
  return { token: newSession_(email), email: email, isAdmin: email === OWNER };
}
function addUser_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 1) throw 'Enter a valid email address';
  var u = usersList_();
  if (u.indexOf(email) < 0) { u.push(email); setGlobal_('users', u); }
  return { users: u };
}
function removeUser_(email) {
  email = String(email || '').trim().toLowerCase();
  setGlobal_('users', usersList_().filter(function (x) { return x !== email; }));
  return { users: usersList_() };
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
    case 'googleAuth': return googleAuth_(req);
  }
  // Team actions: allow a valid Google session OR the passcode (emergency fallback).
  var email = authEmail_(req);
  var byPass = String(req.pass) === pass_();
  if (!email && !byPass) throw 'Not authorized — sign in again';
  var admin = (email === OWNER) || byPass;                 // passcode = owner-level access
  switch (req.action) {
    case 'adminLoad': return adminLoad_(email, admin);
    case 'saveState': return saveState_(req.brand, req.state);
    case 'saveGlobal': return saveGlobal_(req);
    case 'addBrand': return addBrand_(req.name);
    case 'archiveBrand': return archiveBrand_(req.name);
    case 'listUsers': if (!admin) throw 'Owner only'; return { users: usersList_() };
    case 'addUser': if (!admin) throw 'Owner only'; return addUser_(req.email);
    case 'removeUser': if (!admin) throw 'Owner only'; return removeUser_(req.email);
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

function adminLoad_(email, admin) {
  const bs = brands_().filter(function (b) { return !b.archived; });
  const sm = stateMap_();
  const states = {};
  bs.forEach(function (b) { states[b.name] = sm[b.name] && sm[b.name].json ? JSON.parse(sm[b.name].json) : null; });
  return {
    brands: bs.map(function (b) { return { name: b.name, token: b.token }; }),
    states: states,
    slots: getGlobal_('slots') || {},
    bf: getGlobal_('bf') || '',
    defaults: getGlobal_('defaults') || {},
    email: email || '',
    isAdmin: !!admin,
    users: admin ? usersList_() : []
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
