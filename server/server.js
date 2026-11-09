'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const store = require('./store');
const { seedIfNeeded } = require('./seed');
const { migrateStageAssignees } = require('./migrate');
const superadmin = require('./superadmin');
const push = require('./push');
const auth = require('./auth');
const finance = require('./finance');

seedIfNeeded();
auth.migratePins();
migrateStageAssignees();

const app = express();
app.set('trust proxy', 1); // Railway/прокси: корректный req.ip для ограничения перебора PIN
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(superadmin.requestLogger);

// ---- file uploads (scan files etc.) ----
const UPLOAD_DIR = path.join(store.DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
storage: multer.diskStorage({
destination: (req, file, cb) => cb(null, UPLOAD_DIR),
filename: (req, file, cb) => {
const safe = (file.originalname || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
cb(null, randomUUID() + '__' + safe);
}
}),
limits: { fileSize: 200 * 1024 * 1024 } // 200MB ceiling (scans are typically 30-100MB)
});

app.post('/api/upload', auth.authenticate, upload.single('file'), (req, res) => {
if (!req.file) return res.status(400).json({ error: 'no_file' });
res.json({
url: '/uploads/' + encodeURIComponent(req.file.filename),
name: req.file.originalname,
size: req.file.size
});
});
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d' }));

// ---- superadmin panel (см. superadmin.js): отдельный логин по
// SUPERADMIN_LOGIN/SUPERADMIN_PASSWORD, не связан с обычным входом ----
app.use('/superadmin', superadmin.router);

// ---- аутентификация (см. auth.js) ----
function clientIp(req) { return req.ip || (req.socket && req.socket.remoteAddress) || 'x'; }

// Список активных сотрудников для экрана выбора имени (без PIN и прочих полей).
app.get('/api/public/staff-list', (req, res) => {
  const rows = store.listCollection('staff')
    .filter((r) => r.data.active !== false)
    .map((r) => ({ id: r.id, name: r.data.name, role: r.data.role }));
  res.json(rows);
});

app.post('/api/auth/staff', (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const pin = String((req.body && req.body.pin) || '');
  const key = clientIp(req) + '|' + id;
  const wait = auth.lockedFor(key);
  if (wait > 0) return res.status(429).json({ error: 'locked', retryInSec: Math.ceil(wait / 1000) });
  const d = store.getDoc('staff/' + id);
  if (!d || d.active === false || !auth.checkPin(pin, d.pinHash)) {
    auth.noteFail(key);
    return res.status(401).json({ error: 'bad_pin' });
  }
  auth.clearFails(key);
  res.json({ token: auth.issueStaffToken(id, d), staff: auth.publicStaff(id, d) });
});

// Врач: вход по номеру телефона (без PIN — как и раньше) и саморегистрация.
const normPhone = (v) => String(v || '').replace(/[^\d+]/g, '');
app.post('/api/auth/doctor', (req, res) => {
  const key = 'doc|' + clientIp(req);
  if (auth.lockedFor(key) > 0) return res.status(429).json({ error: 'locked' });
  const phone = normPhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'no_phone' });
  const d = store.getDoc('doctors/' + phone);
  if (!d) { auth.noteFail(key); return res.json({ exists: false }); }
  res.json({ exists: true, token: auth.issueDoctorToken(phone), doctor: Object.assign({ id: phone }, d) });
});
app.post('/api/auth/register-doctor', (req, res) => {
  const b = req.body || {};
  const phone = normPhone(b.phone);
  const name = String(b.name || '').trim().slice(0, 120);
  const clinic = String(b.clinic || '').trim().slice(0, 120);
  if (!phone || !name) return res.status(400).json({ error: 'bad_request' });
  let d = store.getDoc('doctors/' + phone);
  if (!d) {
    d = { name, clinic, phone, demo: false, createdAt: new Date().toISOString() };
    store.setDoc('doctors/' + phone, d);
  } // если уже есть — существующую запись не перезаписываем
  res.json({ token: auth.issueDoctorToken(phone), doctor: Object.assign({ id: phone }, d) });
});
app.get('/api/auth/me', auth.authenticate, (req, res) => {
  const u = req.user;
  if (u.type === 'staff') return res.json({ type: 'staff', staff: auth.publicStaff(u.id, u.doc) });
  res.json({ type: 'doctor', doctor: Object.assign({ id: u.id }, u.doc) });
});

// ---- защищённый API коллекций/документов ----
function broadcast(evt) { io.emit('change', evt); }
store.events.on('change', broadcast);

io.use((socket, next) => {
  const u = auth.userFromToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('unauthorized'));
  next();
});

function collOk(req, res) {
  if (auth.COLLECTIONS.indexOf(req.params.coll) === -1) { res.status(404).json({ error: 'unknown_collection' }); return false; }
  return true;
}
app.use('/api/collection', auth.authenticate);
app.use('/api/doc', auth.authenticate);

app.get('/api/collection/:coll', (req, res) => {
  if (!collOk(req, res)) return;
  const coll = req.params.coll, u = req.user;
  if (!auth.collectionReadable(u, coll)) return res.status(403).json({ error: 'forbidden' });
  const opts = {};
  if (req.query.orderBy) opts.orderBy = req.query.orderBy;
  if (req.query.dir) opts.dir = req.query.dir;
  if (req.query.limit) opts.limit = parseInt(req.query.limit, 10);
  let rows = store.listCollection(coll, Object.assign({}, opts, { limit: 0 }));
  if (u.type === 'doctor') rows = rows.filter((r) => auth.canReadDoc(u, coll, r.id, r.data));
  if (opts.limit) rows = rows.slice(0, opts.limit);
  res.json(rows.map((r) => ({ id: r.id, data: auth.sanitizeOut(coll, r.id, r.data) })));
});

app.get('/api/doc/:coll/:id', (req, res) => {
  if (!collOk(req, res)) return;
  const coll = req.params.coll, id = req.params.id;
  const data = store.getDoc(coll + '/' + id);
  if (!auth.canReadDoc(req.user, coll, id, data)) {
    return res.status(403).json({ error: 'forbidden' }); // не раскрываем, существует ли документ
  }
  if (data === undefined) return res.json({ exists: false });
  res.json({ exists: true, data: auth.sanitizeOut(coll, id, data) });
});

function guardWrite(req, res, method, id) {
  if (!collOk(req, res)) return null;
  const coll = req.params.coll;
  const existing = id ? store.getDoc(coll + '/' + id) : undefined;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const why = auth.checkWrite(req.user, method, coll, id, body, existing);
  if (why) { res.status(why === 'unknown_collection' ? 404 : 403).json({ error: why }); return null; }
  if (coll === 'staff') {
    const bad = auth.prepareStaffBody(method, body, existing);
    if (bad) { res.status(400).json({ error: bad }); return null; }
  }
  return { coll, existing, body };
}

app.post('/api/doc/:coll', (req, res) => {
  const g = guardWrite(req, res, 'POST', null);
  if (!g) return;
  const id = store.addDoc(g.coll, g.body);
  res.json({ id });
  if (g.coll === 'orders') {
    push.notifyNewOrder(Object.assign({}, g.body, { id }));
  }
});

app.put('/api/doc/:coll/:id', (req, res) => {
  const g = guardWrite(req, res, 'PUT', req.params.id);
  if (!g) return;
  store.setDoc(g.coll + '/' + req.params.id, g.body);
  res.json({ ok: true });
});

app.patch('/api/doc/:coll/:id', (req, res) => {
  const g = guardWrite(req, res, 'PATCH', req.params.id);
  if (!g) return;
  const data = store.updateDoc(g.coll + '/' + req.params.id, g.body);
  res.json({ ok: true, data: auth.sanitizeOut(g.coll, req.params.id, data) });
});

app.delete('/api/doc/:coll/:id', (req, res) => {
  const g = guardWrite(req, res, 'DELETE', req.params.id);
  if (!g) return;
  store.deleteDoc(g.coll + '/' + req.params.id);
  if (g.coll === 'orders') {
    // платежи удалённого заказа не должны оставаться «висящими» в финансах
    store.listCollection('payments')
      .filter((r) => r.data.orderId === req.params.id)
      .forEach((r) => store.deleteDoc('payments/' + r.id));
  }
  res.json({ ok: true });
});

// сводка по всем заказам (дебиторка, начисления) — только для ролей с доступом к деньгам
app.get('/api/finance/summary', auth.authenticate, (req, res) => {
  if (!auth.hasMoney(req.user)) return res.status(403).json({ error: 'forbidden' });
  res.json(finance.summary());
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- web push (new order / due soon / overdue notifications) ----
app.get('/api/push/public-key', (req, res) => {
res.json({ publicKey: push.getPublicKey() });
});
push.ensureVapid();
push.checkDeadlines();
setInterval(() => push.checkDeadlines(), 30 * 60 * 1000);

// ---- static frontend ----
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));
app.get('*', (req, res, next) => {
if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
console.log('IDEAL Lab server listening on port ' + PORT);
console.log('Data dir: ' + store.DATA_DIR);
});
