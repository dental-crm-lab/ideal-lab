// Серверный подсчёт финансовых сводок по ВСЕМ заказам (клиент держит в памяти
// только последние 500, поэтому дебиторку/начисления считаем здесь).
'use strict';
const store = require('./store');

const DEFAULT_PAYOUTS = {
  technician: { mode: 'percent', percent: 30, fixedZr: 0, fixedPmma: 0 },
  miller: { mode: 'percent', percent: 0, fixedZr: 0, fixedPmma: 0 }
};
const DEFAULT_STAGES = ['Новый', 'Дизайн (CAD)', 'Фрезеровка / Печать', 'Спекание / Обработка', 'Готово', 'Выдан'];

function payoutsFrom(cfg) {
  if (!cfg.payouts) {
    return {
      technician: Object.assign({}, DEFAULT_PAYOUTS.technician, cfg.techSharePercent != null ? { percent: cfg.techSharePercent } : {}),
      miller: Object.assign({}, DEFAULT_PAYOUTS.miller)
    };
  }
  return {
    technician: Object.assign({}, DEFAULT_PAYOUTS.technician, cfg.payouts.technician),
    miller: Object.assign({}, DEFAULT_PAYOUTS.miller, cfg.payouts.miller)
  };
}
function calcPayout(o, p) {
  if (!p) return 0;
  if (p.mode === 'fixed') {
    if (o.material === 'ZR') return p.fixedZr || 0;
    if (o.material === 'PMMA') return p.fixedPmma || 0;
    return 0;
  }
  return Math.round((o.total || 0) * (p.percent || 0) / 100);
}

// Ставка за зуб по этапам (настраивается в Настройках), одинакова для всех материалов.
const DEFAULT_RATES = { modeling: 500, painting: 500, milling: 1000 };
const STAGE_WORKS = [
  { key: 'modeling', idField: 'assignedModelingId', payField: 'modelingPayout' },
  { key: 'painting', idField: 'assignedPaintingId', payField: 'paintingPayout' },
  { key: 'milling', idField: 'assignedMillingId', payField: 'millingPayout' }
];
function unitsOf(o) {
  if (o.unitsTotal != null) return Number(o.unitsTotal) || 0;
  return (o.items || []).reduce((a, li) => a + (li.unit === 'tooth' ? (li.teeth || []).length : (li.qty || 0)), 0);
}
// Начисления по заказу: [{staffId, amount}]. Если назначен хоть один этап — новая схема
// (зубы × ставка, либо ручное значение); иначе прежняя схема для старых заказов.
function orderAccruals(o, cfg, pay) {
  const rates = Object.assign({}, DEFAULT_RATES, cfg.stageRates);
  const out = [];
  if (STAGE_WORKS.some((w) => o[w.idField])) {
    STAGE_WORKS.forEach((w) => {
      if (!o[w.idField]) return;
      out.push({ staffId: o[w.idField], amount: o[w.payField] != null ? Number(o[w.payField]) || 0 : unitsOf(o) * (Number(rates[w.key]) || 0) });
    });
  } else {
    if (o.assignedStaffId) out.push({ staffId: o.assignedStaffId, amount: o.techPayout != null ? o.techPayout : calcPayout(o, pay.technician) });
    if (o.assignedMillerId) out.push({ staffId: o.assignedMillerId, amount: o.millerPayout != null ? o.millerPayout : calcPayout(o, pay.miller) });
  }
  return out;
}

function summary() {
  const cfg = store.getDoc('settings/config') || {};
  const stages = cfg.stages && cfg.stages.length ? cfg.stages : DEFAULT_STAGES;
  const lastStage = stages[stages.length - 1];
  const pay = payoutsFrom(cfg);
  const paidBy = {};
  store.listCollection('payments').forEach((r) => {
    paidBy[r.data.orderId] = (paidBy[r.data.orderId] || 0) + (r.data.amount || 0);
  });
  let outstanding = 0, active = 0, count = 0;
  const accrued = {};
  store.listCollection('orders').forEach((r) => {
    const o = r.data;
    count++;
    outstanding += Math.max(0, (o.total || 0) - (paidBy[r.id] || 0));
    if (o.stage !== lastStage) active++;
    orderAccruals(o, cfg, pay).forEach((a) => { accrued[a.staffId] = (accrued[a.staffId] || 0) + a.amount; });
  });
  return { outstanding, activeOrders: active, ordersTotal: count, accrued };
}

module.exports = { summary, orderAccruals };
