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
    if (o.assignedStaffId) accrued[o.assignedStaffId] = (accrued[o.assignedStaffId] || 0) + (o.techPayout != null ? o.techPayout : calcPayout(o, pay.technician));
    if (o.assignedMillerId) accrued[o.assignedMillerId] = (accrued[o.assignedMillerId] || 0) + (o.millerPayout != null ? o.millerPayout : calcPayout(o, pay.miller));
  });
  return { outstanding, activeOrders: active, ordersTotal: count, accrued };
}

module.exports = { summary };
