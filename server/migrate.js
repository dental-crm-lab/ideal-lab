// Одноразовая миграция: старые назначения (assignedStaffId / assignedMillerId) -> этапы.
//   assignedStaffId  -> assignedModelingId И assignedPaintingId
//   assignedMillerId -> assignedMillingId
// Старые поля не удаляются. Ручные суммы переносятся: techPayout делится поровну на modelingPayout/paintingPayout,
// millerPayout -> millingPayout; без ручной суммы начисление считается по ставке (stageRates).
// Затрагиваются только заказы, у которых ещё нет ни одного нового назначения. Выполняется один раз
// (маркер settings/migrations), перед изменениями делает копию db.json рядом с ним.
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');

const MARKER_KEY = 'stageAssignees';

function migrateStageAssignees() {
  const marks = store.getDoc('settings/migrations') || {};
  if (marks[MARKER_KEY]) return;

  const todo = store.listCollection('orders').filter((r) => {
    const o = r.data;
    const hasNew = o.assignedModelingId || o.assignedPaintingId || o.assignedMillingId;
    return !hasNew && (o.assignedStaffId || o.assignedMillerId);
  });

  const changes = [];
  if (todo.length) {
    // без резервной копии не трогаем данные
    const src = path.join(store.DATA_DIR, 'db.json');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dst = src + '.bak-pre-stage-migration-auto-' + stamp;
    try {
      fs.copyFileSync(src, dst);
    } catch (e) {
      console.error('Migration stageAssignees SKIPPED: could not back up db.json (' + e.message + ')');
      return;
    }
    console.log('Migration stageAssignees: backup written to ' + dst);
    todo.forEach((r) => {
      const o = r.data;
      const patch = {
        assignedModelingId: o.assignedStaffId || null,
        assignedPaintingId: o.assignedStaffId || null,
        assignedMillingId: o.assignedMillerId || null
      };
      // ручные суммы сохраняем: техник -> поровну на моделирование и покраску (итог тот же),
      // фрезеровщик -> фрезеровка. Переносим только если есть кому платить.
      if (o.assignedStaffId && o.techPayout != null && !isNaN(Number(o.techPayout))) {
        const half = Math.floor(Number(o.techPayout) / 2);
        patch.modelingPayout = half;
        patch.paintingPayout = Number(o.techPayout) - half;
      }
      if (o.assignedMillerId && o.millerPayout != null && !isNaN(Number(o.millerPayout))) {
        patch.millingPayout = Number(o.millerPayout);
      }
      store.updateDoc('orders/' + r.id, patch);
      changes.push({ id: r.id, code: o.code, was: { assignedStaffId: o.assignedStaffId || null, assignedMillerId: o.assignedMillerId || null }, now: patch });
    });
  }

  marks[MARKER_KEY] = { at: new Date().toISOString(), migrated: changes.length, orders: changes };
  store.setDoc('settings/migrations', marks);
  console.log('Migration stageAssignees: migrated ' + changes.length + ' order(s)');
}

module.exports = { migrateStageAssignees };
