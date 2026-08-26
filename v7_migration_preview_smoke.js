'use strict';

const { createMigrationPreview, validateMigrationPreview } = require('./v7/migration-preview.js');

const snapshot = {
    schemaVersion: 6,
    settings: {
        name: 'مكتب الاختبار',
        address: 'بغداد',
        theme: 'dark',
        signature: 'data:image/png;base64,QUJDRA=='
    },
    lawyers: [{ id: 'l1', name: 'محامي أول' }],
    companies: [{ id: 'c1', lawyerId: 'l1', name: 'شركة أولى' }],
    transactions: [{
        id: 't1', companyId: 'c1', lawyerId: 'l1', type: 'تصديق', dept: 'مسجل الشركات',
        status: 'active', priority: 'high', fee: 1000, legacyPaidAmount: 25,
        createdAt: 1000, lastUpdate: 9000,
        stations: [{ id: 's1', name: 'الاستعلامات', user: 'موظف', date: 2000 }],
        notes: [{ id: 'n1', text: 'ملاحظة', date: 3000 }],
        followUps: [{ id: 'f1', title: 'مراجعة', dueAt: '2026-08-27T09:00:00Z', done: false, createdAt: 4000 }],
        payments: [
            { id: 'p1', amount: 100, status: 'posted', receiptRef: 'MQP-P1', date: 5000 },
            { id: 'p2', amount: 50, status: 'reversed', receiptRef: 'MQP-P2', date: 6000, reversedAt: 7000, reversalReason: 'قيد خاطئ' }
        ],
        activity: [{ id: 'a1', type: 'note', sourceId: 'n1', text: 'تمت إضافة ملاحظة', date: 3000 }]
    }],
    trash: { transactions: [{
        id: 't2', companyId: 'c1', lawyerId: 'l1', type: 'محذوفة', dept: 'الضريبة',
        status: 'stalled', priority: 'normal', fee: 200,
        createdAt: 1000, lastUpdate: 8000, deletedAt: 8500, deletedBy: 'local', deletionReason: 'حذف يدوي',
        stations: [], notes: [], followUps: [], payments: [], activity: []
    }] },
    vault: [{ id: 'd1', companyId: 'c1', name: 'وثيقة.png', date: 5000, data: 'data:image/png;base64,QUJDRA==' }],
    auditLog: [{ id: 'audit1', action: 'transaction.created', entityType: 'transaction', entityId: 't1', summary: 'إنشاء', actorId: 'local', deviceId: 'phone', details: {}, date: 1000 }]
};

const before = JSON.stringify(snapshot);
const plan = createMigrationPreview(snapshot, {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222'
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(JSON.stringify(snapshot) === before, 'preview mutated the source snapshot');
assert(plan.format === 'MOAQIB_V7_MIGRATION_PREVIEW' && plan.model_version === 1, 'wrong plan identity');
assert(plan.validation.valid, JSON.stringify(plan.validation.issues));
assert(plan.rows.transactions.length === 2, 'active and deleted transactions must both migrate');
assert(plan.rows.transactions.find(row => row.id === 't2').deleted_at, 'soft-deleted transaction lost deletion evidence');
assert(plan.rows.payments.length === 2, 'payments were not flattened');
assert(plan.rows.payments.find(row => row.id === 'p2').status === 'reversed', 'reversal status lost');
assert(plan.rows.payments.find(row => row.id === 'p2').reversal_reason === 'قيد خاطئ', 'reversal reason lost');
assert(plan.rows.documents.length === 1 && plan.payloads.documents.length === 1, 'document metadata/payload split failed');
assert(plan.rows.documents[0].size_bytes === 4, 'document payload size estimate wrong');
assert(plan.payloads.signature?.size_bytes === 4, 'signature payload not preserved');
assert(plan.rows.audit_events[0].actor_id === null && plan.rows.audit_events[0].actor_label === 'local', 'legacy actor evidence lost');

const broken = JSON.parse(JSON.stringify(plan));
broken.rows.companies[0].lawyer_id = 'missing';
broken.rows.transactions.push({ ...broken.rows.transactions[0] });
const brokenValidation = validateMigrationPreview(broken);
assert(!brokenValidation.valid, 'broken migration plan was accepted');
assert(brokenValidation.issues.some(issue => issue.code === 'COMPANY_LAWYER_ORPHAN'), 'orphan was not detected');
assert(brokenValidation.issues.some(issue => issue.code === 'ID_DUPLICATE'), 'duplicate was not detected');

console.log('V7_MIGRATION_PREVIEW_SMOKE PASS', JSON.stringify({
    valid: plan.validation.valid,
    transactions: plan.rows.transactions.length,
    payments: plan.rows.payments.length,
    documents: plan.rows.documents.length,
    auditEvents: plan.rows.audit_events.length
}));
