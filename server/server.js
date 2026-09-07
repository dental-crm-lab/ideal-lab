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

seedIfNeeded();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));

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

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  res.json({
    url: '/uploads/' + encodeURIComponent(req.file.filename),
    name: req.file.originalname,
    size: req.file.size
  });
});
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d' }));

// ---- generic collection/document API ----
function broadcast(evt) { io.emit('change', evt); }
store.events.on('change', broadcast);

app.get('/api/collection/:coll', (req, res) => {
  const opts = {};
  if (req.query.orderBy) opts.orderBy = req.query.orderBy;
  if (req.query.dir) opts.dir = req.query.dir;
  if (req.query.limit) opts.limit = parseInt(req.query.limit, 10);
  res.json(store.listCollection(req.params.coll, opts));
});

app.get('/api/doc/:coll/:id', (req, res) => {
  const data = store.getDoc(req.params.coll + '/' + req.params.id);
  if (data === undefined) return res.json({ exists: false });
  res.json({ exists: true, data });
});

app.post('/api/doc/:coll', (req, res) => {
  const id = store.addDoc(req.params.coll, req.body || {});
  res.json({ id });
});

app.put('/api/doc/:coll/:id', (req, res) => {
  store.setDoc(req.params.coll + '/' + req.params.id, req.body || {});
  res.json({ ok: true });
});

app.patch('/api/doc/:coll/:id', (req, res) => {
  const data = store.updateDoc(req.params.coll + '/' + req.params.id, req.body || {});
  res.json({ ok: true, data });
});

app.delete('/api/doc/:coll/:id', (req, res) => {
  store.deleteDoc(req.params.coll + '/' + req.params.id);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- static frontend ----
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('IDEAL Lab server listening on port ' + PORT);
  console.log('Data dir: ' + store.DATA_DIR);
});
