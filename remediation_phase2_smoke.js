'use strict';

const fs = require('fs');
const vm = require('vm');

const appSource = fs.readFileSync(__dirname + '/app.js', 'utf8');
const htmlSource = fs.readFileSync(__dirname + '/index.html', 'utf8');
const productivitySource = fs.readFileSync(__dirname + '/productivity.js', 'utf8');
const productivityCss = fs.readFileSync(__dirname + '/productivity.css', 'utf8');
const workerSource = fs.readFileSync(__dirname + '/service-worker.js', 'utf8');
const sqlSource = fs.readFileSync(__dirname + '/SUPABASE_SECURITY_SETUP.sql', 'utf8');

function extractFunction(source, name) {
    const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
    if (!match) throw new Error('Missing function: ' + name);
    const start = match.index;
    const openParen = source.indexOf('(', start);
    let parenDepth = 0;
    let quote = null;
    let escaped = false;
    let brace = -1;
    for (let i = openParen; i < source.length; i++) {
        const char = source[i];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char.charCodeAt(0) === 96) { quote = char; continue; }
        if (char === '(') parenDepth++;
        else if (char === ')') parenDepth--;
        else if (char === '{' && parenDepth === 0) { brace = i; break; }
    }
    let depth = 0;
    quote = null;
    escaped = false;
    for (let i = brace; i < source.length; i++) {
        const char = source[i];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char.charCodeAt(0) === 96) { quote = char; continue; }
        if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('Unterminated function: ' + name);
}

function createContext(values = {}) {
    const ctx = {
        console,
        Date,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Map,
        Set,
        JSON,
        Intl,
        Blob,
        Promise,
        setTimeout,
        clearTimeout,
        ...values
    };
    vm.createContext(ctx);
    return ctx;
}

function load(ctx, names) {
    names.forEach(name => vm.runInContext(extractFunction(appSource, name), ctx));
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

function baseDb() {
    return {
        schemaVersion: 6,
        governanceVersion: 1,
        paymentLedgerVersion: 2,
        settings: { name: '', address: '', theme: 'light', signature: null },
        lawyers: [{ id: 'l1', name: 'المحامي' }],
        companies: [{ id: 'c1', lawyerId: 'l1', name: 'الشركة' }],
        transactions: [],
        vault: [],
        trash: { transactions: [] },
        auditLog: []
    };
}

function auditContext(db, saveResult = true) {
    let id = 0;
    return createContext({
        db,
        cloudSyncOwnerId: 'owner-1',
        makeId: () => `generated-${++id}`,
        getDeviceId: () => 'device-1',
        saveData: () => saveResult,
        showToast: () => {},
        customAlert: () => {},
        closeModal: () => {},
        openModal: () => {},
        renderGovernancePanel: () => {},
        renderSettingsEntities: () => {},
        renderTxWorkspaceSections: () => {},
        renderV6Dashboard: () => {},
        openTxDetails: () => {},
        numFormat: new Intl.NumberFormat('en-US')
    });
}

test('governance and payment migration is stable and lossless', () => {
    let generated = 0;
    const ctx = createContext({
        SCHEMA_VERSION: 6,
        crypto: { randomUUID: () => `uuid-${++generated}` },
        rebuildEntityIndexes: () => {}
    });
    load(ctx, ['createEmptyDb', 'makeId', 'buildPaymentReceiptRef', 'normalizeDb', 'getPaidAmount']);
    const source = baseDb();
    source.transactions.push({
        id: 'tx1', companyId: 'c1', lawyerId: 'l1', type: 'معاملة', status: 'active', fee: 100,
        createdAt: 10, lastUpdate: 20, stations: [], notes: [], followUps: [], activity: [],
        payments: [
            { id: 'posted-1', amount: 60, date: 11 },
            { id: 'reversed-1', amount: 30, date: 12, status: 'reversed', reversedAt: 13, reversalReason: 'خطأ إدخال' }
        ]
    });
    source.trash.transactions.push({
        id: 'tx-deleted', companyId: 'c1', lawyerId: 'l1', type: 'قديم', status: 'completed', fee: 50,
        createdAt: 1, lastUpdate: 2, completedAt: 2, deletedAt: 3,
        stations: [], notes: [], payments: [], followUps: [], activity: []
    });
    source.auditLog.push({ id: 'audit-old', date: 22, action: 'legacy.action' });

    const first = ctx.normalizeDb(source);
    const second = ctx.normalizeDb(first);
    assert(first.governanceVersion === 1 && first.paymentLedgerVersion === 2, 'governance versions must migrate');
    assert(first.trash.transactions.length === 1 && first.trash.transactions[0].deletedAt === 3, 'trash record must survive migration');
    assert(first.auditLog[0].actorId === 'local' && first.auditLog[0].deviceId === 'unknown', 'legacy audit entries need safe identity defaults');
    assert(first.transactions[0].payments[0].status === 'posted', 'legacy payment should become posted');
    assert(first.transactions[0].payments[1].status === 'reversed', 'reversal status must survive');
    assert(ctx.getPaidAmount(first.transactions[0]) === 60, 'reversed payment must not count as paid');
    assert(first.transactions[0].payments[0].receiptRef === second.transactions[0].payments[0].receiptRef, 'receipt reference must remain stable across normalization');
    assert(ctx.buildPaymentReceiptRef('دفعة-١') === ctx.buildPaymentReceiptRef('دفعة-١'), 'Unicode legacy payment reference must be deterministic');
    assert(ctx.buildPaymentReceiptRef('دفعة-١') !== ctx.buildPaymentReceiptRef('دفعة-٢'), 'different Unicode legacy payment ids need different references');
});

test('audit entry is committed with a save and rolled back with a failed save', () => {
    const committedDb = baseDb();
    const committed = auditContext(committedDb, true);
    load(committed, ['appendAudit', 'saveDataWithAudit']);
    assert(committed.saveDataWithAudit('transaction.test', 'transaction', 'tx1', 'اختبار', { value: 1 }) === true, 'audited save should report success');
    assert(committedDb.auditLog.length === 1 && committedDb.auditLog[0].deviceId === 'device-1', 'successful mutation must retain its audit entry');

    const failedDb = baseDb();
    const failed = auditContext(failedDb, false);
    load(failed, ['appendAudit', 'saveDataWithAudit']);
    assert(failed.saveDataWithAudit('transaction.test', 'transaction', 'tx1', 'اختبار') === false, 'failed save should report failure');
    assert(failedDb.auditLog.length === 0, 'failed mutation must not leave a false audit entry');
});

test('soft deletion and restoration preserve the entire transaction', () => {
    const db = baseDb();
    db.transactions.push({
        id: 'tx1', companyId: 'c1', lawyerId: 'l1', type: 'تصديق', status: 'active', fee: 100,
        createdAt: 1, lastUpdate: 2, stations: [], notes: [{ id: 'n1', text: 'مهم', date: 2 }],
        payments: [{ id: 'p1', amount: 25, status: 'posted', receiptRef: 'MQP-P1', date: 2 }],
        followUps: [], activity: []
    });
    const ctx = auditContext(db, true);
    Object.assign(ctx, {
        currentTxId: 'tx1',
        getTransaction: id => db.transactions.find(tx => String(tx.id) === String(id)),
        customConfirm: (_title, _message, action) => action()
    });
    load(ctx, ['appendAudit', 'saveDataWithAudit', 'reqDeleteTx', 'restoreDeletedTransaction']);
    ctx.reqDeleteTx();
    assert(db.transactions.length === 0 && db.trash.transactions.length === 1, 'delete must move instead of destroy');
    assert(db.trash.transactions[0].payments[0].receiptRef === 'MQP-P1', 'soft deletion must preserve payment evidence');
    assert(db.auditLog.at(-1).action === 'transaction.deleted', 'soft deletion must be audited');
    ctx.restoreDeletedTransaction('tx1');
    assert(db.transactions.length === 1 && db.trash.transactions.length === 0, 'restore must return the record');
    assert(db.transactions[0].notes[0].text === 'مهم' && db.transactions[0].payments[0].amount === 25, 'restore must preserve nested records');
    assert(!('deletedAt' in db.transactions[0]) && db.auditLog.at(-1).action === 'transaction.restored', 'restore must remove trash metadata and add audit');
});

test('completed transaction can reopen once with history and audit intact', () => {
    const db = baseDb();
    const tx = { id: 'tx1', type: 'منجزة', status: 'completed', completedAt: 100, lastUpdate: 100, activity: [] };
    db.transactions.push(tx);
    const ctx = auditContext(db, true);
    Object.assign(ctx, {
        currentTxId: 'tx1',
        getTransaction: () => tx,
        customConfirm: (_title, _message, action) => action()
    });
    load(ctx, ['addActivity', 'appendAudit', 'saveDataWithAudit', 'reqReopenTx']);
    ctx.reqReopenTx();
    assert(tx.status === 'active' && tx.completedAt === null, 'reopen must return transaction to active state');
    assert(tx.activity.filter(item => item.type === 'reopened').length === 1, 'reopen history must be recorded once');
    assert(db.auditLog.at(-1).details.previousCompletedAt === 100, 'audit must preserve the prior completion date');
});

test('payment reversal excludes value, keeps evidence, and rolls back on save failure', () => {
    const successDb = baseDb();
    const payment = { id: 'p1', amount: 40, method: 'نقدي', status: 'posted', receiptRef: 'MQP-STABLE', date: 10, reversedAt: null, reversalReason: '' };
    const tx = { id: 'tx1', type: 'مالية', fee: 100, legacyPaidAmount: 0, payments: [payment], activity: [], lastUpdate: 10 };
    successDb.transactions.push(tx);
    const success = auditContext(successDb, true);
    Object.assign(success, {
        pendingPaymentReversal: { txId: 'tx1', paymentId: 'p1' },
        getTransaction: () => tx,
        document: { getElementById: id => id === 'reverse-payment-reason' ? { value: 'قيد مكرر' } : null }
    });
    load(success, ['addActivity', 'appendAudit', 'saveDataWithAudit', 'getPaidAmount', 'confirmPaymentReversal']);
    assert(success.getPaidAmount(tx) === 40, 'posted payment should initially count');
    success.confirmPaymentReversal();
    assert(success.getPaidAmount(tx) === 0, 'reversed payment must be excluded');
    assert(payment.receiptRef === 'MQP-STABLE' && payment.status === 'reversed', 'reversal must retain the original payment and receipt reference');
    assert(successDb.auditLog.at(-1).action === 'payment.reversed', 'reversal must be audited');

    const failedDb = baseDb();
    const failedPayment = { id: 'p2', amount: 30, status: 'posted', receiptRef: 'MQP-P2', date: 10, reversedAt: null, reversalReason: '' };
    const failedTx = { id: 'tx2', type: 'مالية', fee: 100, payments: [failedPayment], activity: [], lastUpdate: 10 };
    failedDb.transactions.push(failedTx);
    const failed = auditContext(failedDb, false);
    Object.assign(failed, {
        pendingPaymentReversal: { txId: 'tx2', paymentId: 'p2' },
        getTransaction: () => failedTx,
        document: { getElementById: id => id === 'reverse-payment-reason' ? { value: 'اختبار فشل' } : null }
    });
    load(failed, ['addActivity', 'appendAudit', 'saveDataWithAudit', 'confirmPaymentReversal']);
    failed.confirmPaymentReversal();
    assert(failedPayment.status === 'posted' && failedPayment.reversedAt === null, 'failed reversal must restore payment state');
    assert(failedTx.activity.length === 0 && failedDb.auditLog.length === 0, 'failed reversal must restore history and audit state');
});

test('cloud update uses owner, id, and expected revision as compare-and-swap filters', async () => {
    const filters = [];
    let payload = null;
    let response = { data: { revision: 8, updated_at: '2026-08-26T00:00:00Z' }, error: null };
    const builder = {
        update(value) { payload = value; return this; },
        eq(column, value) { filters.push([column, value]); return this; },
        select() { return this; },
        maybeSingle() { return Promise.resolve(response); }
    };
    const remote = { data: { remote: true }, revision: 9, updated_at: '2026-08-26T01:00:00Z' };
    const ctx = createContext({
        cloudRevision: 7,
        cloudRecordExists: true,
        supabaseClient: { from: table => { assert(table === 'app_data', 'wrong cloud table'); return builder; } },
        withCloudTimeout: promise => Promise.resolve(promise),
        fetchCloudRecord: async () => remote
    });
    load(ctx, ['writeCloudSnapshot']);
    const saved = await ctx.writeCloudSnapshot({ id: 'owner-1' }, { local: true });
    assert(saved.saved === true && payload.revision === 8, 'next revision must be written');
    assert(filters.some(([key, value]) => key === 'owner_id' && value === 'owner-1'), 'owner filter missing');
    assert(filters.some(([key, value]) => key === 'id' && value === 1), 'snapshot id filter missing');
    assert(filters.some(([key, value]) => key === 'revision' && value === 7), 'expected revision filter missing');

    response = { data: null, error: null };
    filters.length = 0;
    const conflict = await ctx.writeCloudSnapshot({ id: 'owner-1' }, { local: 'second' });
    assert(conflict.conflict === true && conflict.remote.revision === 9, 'zero updated rows must become an explicit conflict');
});

test('initial concurrent insert is converted to a conflict instead of overwrite', async () => {
    const builder = {
        insert() { return this; },
        select() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } }); }
    };
    const ctx = createContext({
        cloudRevision: 0,
        cloudRecordExists: false,
        supabaseClient: { from: () => builder },
        withCloudTimeout: promise => Promise.resolve(promise),
        fetchCloudRecord: async () => ({ data: { won: 'remote' }, revision: 1 })
    });
    load(ctx, ['writeCloudSnapshot']);
    const result = await ctx.writeCloudSnapshot({ id: 'owner-1' }, { won: 'local' });
    assert(result.conflict === true && result.remote.data.won === 'remote', 'duplicate initial insert must preserve both choices');
});

test('conflict decisions are audited before the selected snapshot is written', async () => {
    const db = baseDb();
    db.auditLog = [];
    let flushed = 0;
    const ctx = auditContext(db, true);
    Object.assign(ctx, {
        cloudConflict: {
            ownerId: 'owner-1', expectedRevision: 3,
            remote: { data: { ...baseDb(), settings: { ...baseDb().settings, name: 'السحابة' } }, revision: 4 }
        },
        cloudSyncQueued: false,
        normalizeDb: value => JSON.parse(JSON.stringify(value)),
        setCloudRecordState: () => {},
        storeLocalSnapshot: () => true,
        markCloudPending: () => true,
        applyCurrentSettingsToUI: () => {},
        renderAll: () => {},
        flushCloudSave: async () => { flushed++; return true; }
    });
    load(ctx, ['appendAudit', 'resolveCloudConflict']);
    const result = await ctx.resolveCloudConflict('remote');
    assert(result === true && flushed === 1, 'remote decision should write the audited selected snapshot');
    assert(ctx.db.settings.name === 'السحابة', 'remote choice must replace local data');
    assert(ctx.db.auditLog.at(-1).action === 'cloud.conflict_resolved_remote', 'remote conflict choice must be audited');
});

test('health check detects duplicate entities, payments, and inconsistent reversal evidence', () => {
    const db = baseDb();
    db.lawyers.push({ id: 'l1', name: 'مكرر' });
    db.transactions.push({
        id: 'tx1', companyId: 'c1', lawyerId: 'l1', status: 'active', completedAt: 55, fee: 100,
        stations: [], notes: [], followUps: [],
        payments: [
            { id: 'p1', amount: 10, status: 'posted', receiptRef: 'MQP-P1' },
            { id: 'p1', amount: 20, status: 'reversed', receiptRef: '', reversedAt: null, reversalReason: '' }
        ]
    });
    const elements = new Map();
    const getElement = id => {
        if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', className: '' });
        return elements.get(id);
    };
    const ctx = createContext({
        db,
        document: { getElementById: getElement },
        rebuildEntityIndexes: () => {},
        getLawyerById: id => db.lawyers.find(item => String(item.id) === String(id)) || null,
        getCompanyById: id => db.companies.find(item => String(item.id) === String(id)) || null,
        escapeHtml: value => String(value),
        showToast: () => {}
    });
    load(ctx, ['runDatabaseHealthCheck']);
    const result = ctx.runDatabaseHealthCheck(false);
    assert(result.issues.some(issue => issue.includes('معرف عميل مكرر')), 'duplicate lawyer should be detected');
    assert(result.issues.some(issue => issue.includes('معرف دفعة مكرر')), 'duplicate payment should be detected');
    assert(result.issues.some(issue => issue.includes('بلا مرجع سند ثابت')), 'missing receipt evidence should be detected');
    assert(result.issues.some(issue => issue.includes('تاريخ إنجاز غير متسق')), 'active transaction with completedAt should be detected');
});

test('schema upgrade errors are distinguished from connectivity failures', () => {
    const ctx = createContext();
    load(ctx, ['isCloudSchemaUpgradeError']);
    assert(ctx.isCloudSchemaUpgradeError({ code: 'PGRST204', message: "Could not find the 'revision' column" }), 'missing revision should require migration');
    assert(ctx.isCloudSchemaUpgradeError({ code: '42703', message: 'column revision does not exist' }), 'Postgres missing column should require migration');
    assert(!ctx.isCloudSchemaUpgradeError({ code: '42501', message: 'permission denied' }), 'RLS rejection is not a schema upgrade');
});

test('UI, dependency, cache, and SQL release contracts are present', () => {
    for (const id of ['btn-reopen-transaction', 'reversePaymentModal', 'cloudConflictModal', 'trash-list', 'audit-list']) {
        assert(htmlSource.includes(`id="${id}"`), `missing phase-two UI id: ${id}`);
    }
    assert(htmlSource.includes('@supabase/supabase-js@2.112.3'), 'Supabase dependency must be pinned');
    assert(productivitySource.includes('chart.js@4.4.7/dist/chart.umd.min.js'), 'Chart dependency must be pinned');
    assert(!/Capacitor|Firebase|MOAQIB_NATIVE_PUSH|nativePushBridge/.test(productivitySource + fs.readFileSync(__dirname + '/push-config.js', 'utf8')), 'release must remain Web/PWA only');
    assert(workerSource.includes("moaqib-v7-foundation-01"), 'V7 service worker cache version must advance');
    assert(productivitySource.includes("status === 'conflict'"), 'sync UI must expose conflict status');
    assert(productivityCss.includes('.mq-sync-banner.has-conflict'), 'conflict banner needs a distinct visual state');
    assert(sqlSource.includes('revision bigint not null default 0'), 'SQL migration must add revision');
    assert(sqlSource.includes('check (revision >= 0)'), 'SQL migration must constrain revisions');
    assert(sqlSource.includes('check (id = 1)'), 'SQL migration must enforce one snapshot id');
    assert(sqlSource.includes("notify pgrst, 'reload schema'"), 'SQL migration must refresh PostgREST schema cache');
    assert(sqlSource.includes('new.revision <> old.revision + 1'), 'SQL must block outdated clients that skip revision increments');
});

test('critical mutations route through the append-only operational audit helper', () => {
    const requiredActions = [
        'transaction.created', 'transaction.completed', 'transaction.reopened', 'transaction.deleted', 'transaction.restored',
        'transaction.station_added', 'transaction.status_changed', 'transaction.note_added', 'transaction.followup_added',
        'transaction.followup_completed', 'transaction.priority_changed', 'payment.created', 'payment.reversed',
        'lawyer.created', 'lawyer.deleted', 'company.created', 'company.deleted', 'vault.created', 'vault.deleted', 'data.imported'
    ];
    for (const action of requiredActions) assert(appSource.includes(`'${action}'`), `missing audited action: ${action}`);
    assert(appSource.includes("if (payment.status === 'reversed') return showToast('لا يمكن إصدار سند قبض لدفعة معكوسة'"), 'reversed payment receipt must be blocked');
    assert(appSource.includes('String(receiptPayment.receiptRef'), 'receipt PDF must use the stable recorded reference');
    assert(appSource.includes('const snapshot = normalizeDb(JSON.parse(JSON.stringify(db)))') && appSource.includes('data: snapshot'), 'backup checksum and data must use the same frozen snapshot');
});

(async () => {
    const failures = [];
    for (const item of tests) {
        try {
            await item.run();
            console.log('PASS', item.name);
        } catch (error) {
            failures.push({ name: item.name, error: error.message });
            console.error('FAIL', item.name, '-', error.message);
        }
    }
    if (failures.length) {
        console.error('REMEDIATION_PHASE2_SMOKE FAILED', JSON.stringify(failures, null, 2));
        process.exitCode = 1;
        return;
    }
    console.log('REMEDIATION_PHASE2_SMOKE PASS', JSON.stringify({ tests: tests.length }));
})();
