// Simple file-backed document store: mimics the minimal Firestore-like
// interface the frontend needs (collection/doc, get/set/update/delete/add,
// list with orderBy+limit). Not built for heavy concurrency — fine for a
// small lab's order volume.
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let mem = {};
if (fs.existsSync(DB_FILE)) {
  try { mem = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('Failed to parse db.json, starting fresh:', e.message); mem = {}; }
}

const events = new EventEmitter();
events.setMaxListeners(0);

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(mem), (err) => {
      if (err) { console.error('db save failed', err); return; }
      fs.rename(tmp, DB_FILE, (err2) => { if (err2) console.error('db rename failed', err2); });
    });
  }, 150);
}

function splitPath(p) {
  return p.split('/').filter(Boolean);
}
function collOf(id) { return id.split('/').slice(0, -1).join('/'); }

function getDoc(docPath) {
  const d = mem[docPath];
  return d ? JSON.parse(JSON.stringify(d)) : undefined;
}
function setDoc(docPath, data) {
  mem[docPath] = JSON.parse(JSON.stringify(data));
  scheduleSave();
  events.emit('change', { collection: collOf(docPath), id: docPath.split('/').pop(), path: docPath });
}
function updateDoc(docPath, patch) {
  const existing = mem[docPath] || {};
  mem[docPath] = Object.assign({}, existing, JSON.parse(JSON.stringify(patch)));
  scheduleSave();
  events.emit('change', { collection: collOf(docPath), id: docPath.split('/').pop(), path: docPath });
  return mem[docPath];
}
function deleteDoc(docPath) {
  delete mem[docPath];
  scheduleSave();
  events.emit('change', { collection: collOf(docPath), id: docPath.split('/').pop(), path: docPath });
}
function addDoc(collPath, data) {
  const id = randomUUID();
  const docPath = collPath + '/' + id;
  setDoc(docPath, data);
  return id;
}
function listCollection(collPath, opts) {
  opts = opts || {};
  const prefix = collPath + '/';
  const out = [];
  for (const key of Object.keys(mem)) {
    if (key.indexOf(prefix) !== 0) continue;
    const rest = key.slice(prefix.length);
    if (rest.indexOf('/') !== -1) continue; // only direct children
    out.push({ id: rest, data: JSON.parse(JSON.stringify(mem[key])) });
  }
  if (opts.orderBy) {
    const f = opts.orderBy, dir = opts.dir === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      const av = a.data[f], bv = b.data[f];
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * dir;
    });
  } else {
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  if (opts.limit) return out.slice(0, opts.limit);
  return out;
}

module.exports = { getDoc, setDoc, updateDoc, deleteDoc, addDoc, listCollection, events, DATA_DIR };
