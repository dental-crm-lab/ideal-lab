'use strict';
const store = require('./store');

const DEFAULT_CONFIG = {
  labName: 'IDEAL',
  stages: ['Новый', 'Дизайн (CAD)', 'Фрезеровка / Печать', 'Спекание / Обработка', 'Готово', 'Выдан'],
  deadlineTiers: [
    { maxUnits: 7, days: 4 },
    { maxUnits: 14, days: 6 },
    { maxUnits: 24, days: 8 },
    { maxUnits: 9999, days: 10 }
  ],
  urgentDays: 2,
  urgentMultiplier: 1.4,
  techSharePercent: 30
};

const DEFAULT_PRICE_LIST = [
  { id: '1.1', category: 'Коронки', name: 'Цельнофрезерованная анатомическая коронка ZrO2', price: 6000, unit: 'tooth' },
  { id: '1.2', category: 'Коронки', name: 'Коронка ZrO2 на винтовой фиксации', price: 6000, unit: 'tooth', addon: 1500, addonLabel: 'Титановое основание с винтом' },
  { id: '1.3', category: 'Коронки', name: 'Коронка ZrO2-PRETTAU (редуцирование + e.max)', price: 8000, unit: 'tooth' },
  { id: '1.4', category: 'Коронки', name: 'Коронка ZrO2-PRETTAU на винтовой фиксации (+e.max)', price: 8000, unit: 'tooth', addon: 1500, addonLabel: 'Титановое основание с винтом' },
  { id: '1.5', category: 'Коронки', name: 'Цельнофрезерованная коронка PMMA-Multi', price: 1200, unit: 'tooth' },
  { id: '1.6', category: 'Коронки', name: 'Коронка PMMA-Multi на винтовой фиксации', price: 1200, unit: 'tooth', addon: 1500, addonLabel: 'Титановое основание с винтом' },
  { id: '2.1', category: 'Виниры', name: 'Винир E.max STANDART', price: 9000, unit: 'tooth' },
  { id: '2.2', category: 'Виниры', name: 'Винир E.max Premium на рефракторе', price: 12000, unit: 'tooth' },
  { id: '3.1', category: 'Вкладки', name: 'Вкладка окклюзионная e.max (OnLay)', price: 6500, unit: 'tooth' },
  { id: '3.2', category: 'Вкладки', name: 'Вкладка культевая ZrO2 (InLay)', price: 6000, unit: 'tooth' },
  { id: '4.1', category: 'Индивидуальные абатменты', name: 'Инд. абатмент цельноциркониевый', price: 4500, unit: 'tooth' },
  { id: '4.2', category: 'Индивидуальные абатменты', name: 'Инд. абатмент цельнофрезерованный Premill', price: 5500, unit: 'tooth' },
  { id: '5.1', category: 'Балочные конструкции', name: 'Балка Титан на 4-х имплантах', price: 50000, unit: 'case' },
  { id: '5.2', category: 'Балочные конструкции', name: 'Балка Титан на 5-6-ти имплантах', price: 55000, unit: 'case' },
  { id: '5.3', category: 'Балочные конструкции', name: 'Балка селективное спекание на 4-х имплантах', price: 25000, unit: 'case' },
  { id: '5.4', category: 'Балочные конструкции', name: 'Балка селективное спекание на 5-6 имплантах', price: 30000, unit: 'case' },
  { id: '5.5', category: 'Балочные конструкции', name: 'Супраструктура на балочную конструкцию', price: 80000, unit: 'case' },
  { id: '6.1', category: 'Хирургические шаблоны (3D-печать)', name: 'Хирургический шаблон без втулок', price: 5000, unit: 'case' },
  { id: '6.2', category: 'Хирургические шаблоны (3D-печать)', name: 'Доп. отверстие под имплант', price: 1000, unit: 'case' },
  { id: '7.1', category: '3D печать', name: 'Диагностические модели ВНЧС', price: 3000, unit: 'case' },
  { id: '7.2', category: '3D печать', name: 'WaxUp (моделировка + печать), 1 челюсть', price: 5000, unit: 'case' },
  { id: '8.1', category: 'Прочее', name: 'Восковой базис с прикусными шаблонами', price: 200, unit: 'case' },
  { id: '8.2', category: 'Прочее', name: 'Диагностическая модель из гипса III класса', price: 300, unit: 'case' },
  { id: '8.3', category: 'Прочее', name: 'Титановое основание Multi-Unit Аналог Geo', price: 2500, unit: 'tooth' },
  { id: '8.4', category: 'Прочее', name: 'Титановое основание Аналог Geo', price: 1500, unit: 'tooth' },
  { id: '8.5', category: 'Прочее', name: 'Искусственная десна Aidite (1 зуб)', price: 500, unit: 'tooth' }
];

function addDays(iso, n) {
  const d = iso ? new Date(iso + 'T00:00:00') : new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function seedIfNeeded() {
  if (!store.getDoc('settings/config')) {
    store.setDoc('settings/config', DEFAULT_CONFIG);
  }
  if (!store.getDoc('settings/priceList')) {
    store.setDoc('settings/priceList', { items: DEFAULT_PRICE_LIST });
  }
  const staffRows = store.listCollection('staff');
  if (staffRows.length === 0) {
    store.setDoc('staff/admin-emil', { name: 'Эмиль', role: 'admin', pin: '1234', phone: '', active: true, demo: false, createdAt: new Date().toISOString() });
    store.setDoc('staff/demo-tech-1', { name: 'Техник — Бекболот', role: 'technician', pin: '1111', phone: '', active: true, demo: true, createdAt: new Date().toISOString() });
    store.setDoc('staff/demo-tech-2', { name: 'Техник — Айгерим', role: 'technician', pin: '1112', phone: '', active: true, demo: true, createdAt: new Date().toISOString() });
    store.setDoc('staff/demo-mill-1', { name: 'Фрезеровщик — Марат', role: 'miller', pin: '2222', phone: '', active: true, demo: true, createdAt: new Date().toISOString() });

    store.setDoc('doctors/demo-doc-1', { name: 'Айгуль Токтосунова', clinic: 'DentStudio', phone: 'demo-doc-1', demo: true, createdAt: new Date().toISOString() });
    store.setDoc('doctors/demo-doc-2', { name: 'Нурбек Асанов', clinic: 'Smile Clinic', phone: 'demo-doc-2', demo: true, createdAt: new Date().toISOString() });

    function item(id) { return DEFAULT_PRICE_LIST.find((p) => p.id === id); }
    const demoOrders = [
      { codeSuffix: 'A1', patientName: 'Пациент А. (демо)', doctorName: 'Айгуль Токтосунова', clinicName: 'DentStudio', doctorPhone: 'demo-doc-1',
        items: [{ lineId: 'l1', itemId: '1.1', name: item('1.1').name, unit: 'tooth', teeth: [16, 17], addon: false, unitPrice: 6000, addonPrice: 0, lineTotal: 12000 }],
        urgent: false, subtotal: 12000, total: 12000, unitsTotal: 2, stageIdx: 0, assignedStaffId: null, daysAgo: 0, paidNow: 0 },
      { codeSuffix: 'A2', patientName: 'Пациент Б. (демо)', doctorName: 'Нурбек Асанов', clinicName: 'Smile Clinic', doctorPhone: 'demo-doc-2',
        items: [{ lineId: 'l2', itemId: '1.3', name: item('1.3').name, unit: 'tooth', teeth: [24, 25, 26], addon: false, unitPrice: 8000, addonPrice: 0, lineTotal: 24000 }],
        urgent: true, subtotal: 24000, total: 33600, unitsTotal: 3, stageIdx: 1, assignedStaffId: 'demo-tech-1', daysAgo: 1, paidNow: 15000 },
      { codeSuffix: 'A3', patientName: 'Пациент В. (демо)', doctorName: 'Айгуль Токтосунова', clinicName: 'DentStudio', doctorPhone: 'demo-doc-1',
        items: [{ lineId: 'l3', itemId: '2.1', name: item('2.1').name, unit: 'tooth', teeth: [11, 12, 21, 22], addon: false, unitPrice: 9000, addonPrice: 0, lineTotal: 36000 }],
        urgent: false, subtotal: 36000, total: 36000, unitsTotal: 4, stageIdx: 2, assignedStaffId: 'demo-tech-2', daysAgo: 3, paidNow: 36000 },
      { codeSuffix: 'A4', patientName: 'Пациент Г. (демо)', doctorName: 'Нурбек Асанов', clinicName: 'Smile Clinic', doctorPhone: 'demo-doc-2',
        items: [{ lineId: 'l4', itemId: '1.2', name: item('1.2').name, unit: 'tooth', teeth: [36], addon: true, unitPrice: 6000, addonPrice: 1500, lineTotal: 7500 }],
        urgent: false, subtotal: 7500, total: 7500, unitsTotal: 1, stageIdx: 4, assignedStaffId: 'demo-tech-1', daysAgo: 6, paidNow: 7500 }
    ];
    const today = new Date();
    demoOrders.forEach((o) => {
      const created = new Date(today.getTime() - o.daysAgo * 86400000).toISOString();
      const due = addDays(created.slice(0, 10), o.urgent ? 2 : 4);
      const id = store.addDoc('orders', {
        code: 'IDEAL-DEMO-' + o.codeSuffix, createdAt: created, createdBy: { type: 'staff', name: 'Эмиль' },
        doctorPhone: o.doctorPhone, doctorName: o.doctorName, clinicName: o.clinicName, patientName: o.patientName,
        items: o.items, urgent: o.urgent, subtotal: o.subtotal, total: o.total, unitsTotal: o.unitsTotal,
        dueDate: due, stage: DEFAULT_CONFIG.stages[o.stageIdx], assignedStaffId: o.assignedStaffId, assignedMillerId: null,
        techPayout: null, links: [], notes: '', statusHistory: [{ stage: DEFAULT_CONFIG.stages[o.stageIdx], at: created }], demo: true
      });
      if (o.paidNow > 0) {
        store.addDoc('payments', { orderId: id, amount: o.paidNow, method: 'Перевод', date: created.slice(0, 10), note: '', demo: true, createdAt: created });
      }
    });
    store.addDoc('expenses', { date: new Date().toISOString().slice(0, 10), category: 'Логистика (выездной скан)', amount: 800, staffId: null, orderId: null, note: 'Выезд в клинику Smile Clinic (демо)', demo: true, createdAt: new Date().toISOString() });
  }
}

module.exports = { seedIfNeeded, DEFAULT_CONFIG, DEFAULT_PRICE_LIST };
