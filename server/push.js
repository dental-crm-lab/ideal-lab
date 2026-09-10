// Web Push notifications: new order / due soon / overdue.
// Self-provisions a VAPID keypair into the store (settings/vapid) so no
// manual Railway env-var setup is required. Recipients are configurable
// per role via settings/config.notifyRoles (see DEFAULT_CONFIG.notifyRoles
// in public/index.html for the client-side default/fallback shape).
'use strict';
const webpush = require('web-push');
const store = require('./store');

const DEFAULT_NOTIFY_ROLES = {
  newOrder: ['owner', 'admin'],
  dueSoon: ['owner'],
  overdue: ['owner']
};

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return;
  let doc = store.getDoc('settings/vapid');
  if (!doc || !doc.publicKey || !doc.privateKey) {
    const keys = webpush.generateVAPIDKeys();
    doc = { publicKey: keys.publicKey, privateKey: keys.privateKey };
    store.setDoc('settings/vapid', doc);
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:ideal-lab@example.com';
  webpush.setVapidDetails(subject, doc.publicKey, doc.privateKey);
  vapidReady = true;
}

function getPublicKey() {
  ensureVapid();
  const doc = store.getDoc('settings/vapid');
  return doc && doc.publicKey;
}

function notifyRolesFor(kind) {
  const cfgDoc = store.getDoc('settings/config') || {};
  const nr = cfgDoc.notifyRoles || {};
  const roles = nr[kind];
  if (Array.isArray(roles)) return roles;
  return DEFAULT_NOTIFY_ROLES[kind] || [];
}

function staffIdsForRoles(roles) {
  if (!roles || !roles.length) return [];
  return store.listCollection('staff')
    .filter(r => r.data.active !== false && roles.indexOf(r.data.role) > -1)
    .map(r => r.id);
}

function subscriptionsForStaffIds(staffIds) {
  if (!staffIds || !staffIds.length) return [];
  return store.listCollection('pushSubscriptions')
    .filter(r => staffIds.indexOf(r.data.staffId) > -1);
}

async function sendToStaffIds(staffIds, payload) {
  ensureVapid();
  const subs = subscriptionsForStaffIds(staffIds);
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (rec) => {
    try {
      await webpush.sendNotification(rec.data.subscription, body);
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        store.deleteDoc('pushSubscriptions/' + rec.id);
      } else {
        console.error('push send failed', code, err && err.message);
      }
    }
  }));
}

async function notifyNewOrder(order) {
  try {
    const roles = notifyRolesFor('newOrder');
    const staffIds = staffIdsForRoles(roles);
    if (!staffIds.length) return;
    const material = order.material === 'zro2' ? 'ZrO2' : order.material === 'pmma' ? 'PMMA' : '';
    await sendToStaffIds(staffIds, {
      title: 'Новый заказ',
      body: (order.patientName || 'Пациент') + (material ? ' · ' + material : '') + (order.dueDate ? ' · срок ' + order.dueDate : ''),
      tag: 'order-new',
      url: '/'
    });
  } catch (e) { console.error('notifyNewOrder failed', e); }
}

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function checkDeadlines() {
  try {
    const cfgDoc = store.getDoc('settings/config') || {};
    const stages = cfgDoc.stages || [];
    const lastStage = stages[stages.length - 1]; // "Выдан" — order is done, skip
    const today = todayIso();
    const tomorrow = addDaysIso(today, 1);

    const dueSoonRoles = notifyRolesFor('dueSoon');
    const overdueRoles = notifyRolesFor('overdue');
    const dueSoonStaffIds = staffIdsForRoles(dueSoonRoles);
    const overdueStaffIds = staffIdsForRoles(overdueRoles);
    if (!dueSoonStaffIds.length && !overdueStaffIds.length) return;

    const orders = store.listCollection('orders');
    for (const rec of orders) {
      const o = rec.data;
      if (!o.dueDate || o.stage === lastStage) continue;
      const flags = o.notifyFlags || {};
      let patch = null;

      if (o.dueDate < today) {
        if (flags.overdueSentDate !== today && overdueStaffIds.length) {
          await sendToStaffIds(overdueStaffIds, {
            title: 'Заказ просрочен',
            body: (o.patientName || 'Пациент') + ' · срок был ' + o.dueDate,
            tag: 'order-overdue-' + rec.id,
            url: '/'
          });
          patch = Object.assign({}, flags, { overdueSentDate: today });
        }
      } else if ((o.dueDate === today || o.dueDate === tomorrow)) {
        if (flags.dueSoonSentDate !== today && dueSoonStaffIds.length) {
          await sendToStaffIds(dueSoonStaffIds, {
            title: o.dueDate === today ? 'Срок сдачи сегодня' : 'Срок сдачи завтра',
            body: (o.patientName || 'Пациент') + ' · ' + o.dueDate,
            tag: 'order-duesoon-' + rec.id,
            url: '/'
          });
          patch = Object.assign({}, flags, { dueSoonSentDate: today });
        }
      }

      if (patch) store.updateDoc('orders/' + rec.id, { notifyFlags: patch });
    }
  } catch (e) { console.error('checkDeadlines failed', e); }
}

module.exports = { ensureVapid, getPublicKey, notifyNewOrder, checkDeadlines, staffIdsForRoles, notifyRolesFor };
