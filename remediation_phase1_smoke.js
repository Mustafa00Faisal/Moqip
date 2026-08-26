'use strict';

const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(__dirname + '/app.js', 'utf8');

function extractFunction(name) {
    const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
    if (!match) throw new Error('Missing function: ' + name);
    const start = match.index;
    const openParen = source.indexOf('(', start);
    let parenDepth = 0;
    let signatureQuote = null;
    let signatureEscaped = false;
    let brace = -1;
    for (let i = openParen; i < source.length; i++) {
        const char = source[i];
        if (signatureQuote) {
            if (signatureEscaped) signatureEscaped = false;
            else if (char === '\\') signatureEscaped = true;
            else if (char === signatureQuote) signatureQuote = null;
            continue;
        }
        if (char === '"' || char === "'" || char.charCodeAt(0) === 96) {
            signatureQuote = char;
            continue;
        }
        if (char === '(') parenDepth++;
        else if (char === ')') parenDepth--;
        else if (char === '{' && parenDepth === 0) {
            brace = i;
            break;
        }
    }
    if (brace < 0) throw new Error('Missing function body: ' + name);
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = brace; i < source.length; i++) {
        const char = source[i];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char.charCodeAt(0) === 96) {
            quote = char;
            continue;
        }
        if (char === '{') depth++;
        if (char === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('Unterminated function: ' + name);
}

function context(values = {}) {
    const ctx = {
        console,
        Date,
        Math,
        Number,
        String,
        Array,
        Object,
        Map,
        Set,
        JSON,
        Intl,
        setTimeout,
        clearTimeout,
        ...values
    };
    vm.createContext(ctx);
    return ctx;
}

function load(ctx, names) {
    names.forEach(name => vm.runInContext(extractFunction(name), ctx));
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const tests = [];
function test(name, run) {
    tests.push({ name, run });
}

test('normalizeDb canonicalizes every identifier and completion date', () => {
    const ctx = context({
        SCHEMA_VERSION: 6,
        crypto: { randomUUID: () => 'generated-id' },
        rebuildEntityIndexes: () => {}
    });
    load(ctx, ['createEmptyDb', 'makeId', 'buildPaymentReceiptRef', 'normalizeDb']);
    const normalized = ctx.normalizeDb({
        lawyers: [{ id: 10, name: 'محام' }],
        companies: [{ id: 'company-uuid', lawyerId: 10, name: 'شركة' }],
        transactions: [{
            id: 20,
            companyId: 'company-uuid',
            lawyerId: 10,
            status: 'completed',
            fee: 100,
            createdAt: 1000,
            lastUpdate: 5000,
            stations: [{ id: 30, name: 'محطة', date: 2000 }],
            notes: ['ملاحظة قديمة'],
            payments: [{ id: 40, amount: 50, date: 3000 }],
            followUps: [{ id: 50, title: 'متابعة', dueAt: '2026-08-27T08:00:00.000Z' }],
            activity: [{ id: 60, type: 'completed', text: 'تم الإنجاز', date: 4000 }]
        }],
        vault: [{ id: 70, companyId: 'company-uuid', data: 'data:image/jpeg;base64,AAA', date: 3000 }]
    });
    assert(normalized.lawyers[0].id === '10', 'lawyer id must be a string');
    assert(normalized.companies[0].lawyerId === '10', 'company lawyerId must be a string');
    assert(normalized.transactions[0].id === '20', 'transaction id must be a string');
    assert(normalized.transactions[0].stations[0].id === '30', 'station id must be a string');
    assert(normalized.transactions[0].notes[0].id, 'legacy string note must become a record');
    assert(normalized.transactions[0].payments[0].id === '40', 'payment id must be a string');
    assert(normalized.transactions[0].followUps[0].id === '50', 'follow-up id must be a string');
    assert(normalized.transactions[0].activity[0].id === '60', 'activity id must be a string');
    assert(normalized.transactions[0].completedAt === 4000, 'completedAt should migrate from completion activity');
    assert(normalized.vault[0].id === '70', 'vault id must be a string');
    assert(normalized.vault[0].companyId === 'company-uuid', 'vault companyId must stay intact');
});

test('numeric vault IDs open and delete through string UI arguments', () => {
    const db = { vault: [{ id: 1700000000001, companyId: 'company-uuid', data: 'DATA' }] };
    let opened = null;
    let saveCalls = 0;
    let renderCalls = 0;
    const ctx = context({
        db,
        openLightbox: value => { opened = value; },
        customConfirm: (_title, _message, action) => action(),
        saveData: () => { saveCalls++; return true; },
        saveDataWithAudit: () => { saveCalls++; return true; },
        renderVault: () => { renderCalls++; }
    });
    load(ctx, ['openVaultLightbox', 'reqDeleteVaultItem']);
    ctx.openVaultLightbox('1700000000001');
    assert(opened === 'DATA', 'string UI argument must open a numeric legacy vault item');
    ctx.reqDeleteVaultItem('1700000000001');
    assert(db.vault.length === 0, 'string UI argument must delete a numeric legacy vault item');
    assert(saveCalls === 1 && renderCalls === 1, 'vault deletion must save and rerender once');
});

test('numeric legacy follow-up IDs toggle', () => {
    const tx = { id: 'tx-1', lastUpdate: 1, followUps: [{ id: 1700000000000, title: 'متابعة', done: false }], activity: [] };
    const ctx = context({
        tx,
        getTransaction: () => tx,
        makeId: () => 'activity-id',
        saveData: () => true,
        saveDataWithAudit: () => true,
        renderTxWorkspaceSections: () => {},
        renderV6Dashboard: () => {}
    });
    load(ctx, ['addActivity', 'toggleFollowUp']);
    ctx.toggleFollowUp('tx-1', '1700000000000');
    assert(tx.followUps[0].done === true, 'numeric legacy follow-up must toggle from a string argument');
});

test('timeline emits one station event for one action', () => {
    const ctx = context({ numFormat: new Intl.NumberFormat('en-US') });
    load(ctx, ['getTransactionTimeline']);
    const tx = {
        activity: [{ id: 'a1', type: 'station', text: 'تم تحديث المسار إلى: الحسابات', date: 1001 }],
        stations: [{ id: 's1', name: 'الحسابات', date: 1000 }],
        notes: [],
        payments: [],
        followUps: []
    };
    const stations = ctx.getTransactionTimeline(tx).filter(item => item.type === 'station');
    assert(stations.length === 1, 'one station action must not appear twice in the timeline');
});

test('completed transactions cannot become stalled', () => {
    const tx = { id: 'tx-complete', status: 'completed', activity: [], lastUpdate: 1 };
    const messages = [];
    const ctx = context({
        currentTxId: tx.id,
        getTransaction: () => tx,
        addActivity: () => { throw new Error('completed transaction must not receive a stall activity'); },
        saveData: () => { throw new Error('completed transaction must not be saved as stalled'); },
        closeModal: () => {},
        showToast: message => messages.push(message)
    });
    load(ctx, ['toggleStallTx']);
    ctx.toggleStallTx();
    assert(tx.status === 'completed', 'completed transaction status must remain completed');
    assert(messages.length === 1, 'the blocked transition should explain itself');
});

test('completion stores completedAt once and does not duplicate', () => {
    const tx = { id: 'tx-1', status: 'active', activity: [], lastUpdate: 1000 };
    let confirms = 0;
    let saves = 0;
    const ctx = context({
        currentTxId: tx.id,
        getTransaction: () => tx,
        makeId: () => 'activity-id',
        customConfirm: (_title, _message, action) => { confirms++; action(); },
        saveData: () => { saves++; return true; },
        saveDataWithAudit: () => { saves++; return true; },
        closeModal: () => {},
        showToast: () => {}
    });
    load(ctx, ['addActivity', 'reqMarkTxCompleted']);
    ctx.reqMarkTxCompleted();
    const completedAt = tx.completedAt;
    ctx.reqMarkTxCompleted();
    assert(tx.status === 'completed', 'transaction should complete');
    assert(Number(completedAt) > 0, 'completion should store completedAt');
    assert(tx.completedAt === completedAt, 'completedAt must remain stable');
    assert(tx.activity.filter(item => item.type === 'completed').length === 1, 'completion activity must not duplicate');
    assert(confirms === 1 && saves === 1, 'second completion request must be a no-op');
});

test('lawyer deletion cannot leave vault orphans', () => {
    const db = {
        lawyers: [{ id: 'lawyer-1' }],
        companies: [{ id: 'company-1', lawyerId: 'lawyer-1' }],
        transactions: [],
        vault: [{ id: 'doc-1', companyId: 'company-1', data: 'DATA' }]
    };
    let alerts = 0;
    let confirms = 0;
    const ctx = context({
        db,
        customAlert: () => { alerts++; },
        customConfirm: (_title, _message, action) => { confirms++; action(); },
        saveData: () => true,
        saveDataWithAudit: () => true,
        getAllStoredTransactions: () => db.transactions,
        showToast: () => {}
    });
    load(ctx, ['reqDeleteLawyer']);
    ctx.reqDeleteLawyer('lawyer-1');
    assert(alerts === 1 && confirms === 0, 'lawyer deletion must be blocked while linked vault documents exist');
    assert(db.lawyers.length === 1 && db.companies.length === 1 && db.vault.length === 1, 'blocked deletion must preserve every record');
});

test('quota failure still rerenders and queues cloud sync', () => {
    let renders = 0;
    let cloudCalls = 0;
    let alerts = 0;
    const quota = new Error('quota');
    quota.name = 'QuotaExceededError';
    const ctx = context({
        db: { lawyers: [], companies: [], transactions: [], vault: [], settings: {} },
        cloudSyncOwnerId: 'owner-1',
        LEGACY_DB_KEY: 'legacy',
        LOCAL_OWNER_KEY: 'owner-key',
        getUserDbKey: () => 'user-key',
        normalizeDb: value => value,
        localStorage: { setItem: () => { throw quota; } },
        scheduleRenderAll: () => { renders++; },
        saveDataToCloud: () => { cloudCalls++; },
        customAlert: () => { alerts++; }
    });
    load(ctx, ['saveData']);
    const saved = ctx.saveData();
    assert(saved === false, 'saveData must report failed local durability');
    assert(renders === 1, 'quota failure must not suppress UI rendering');
    assert(cloudCalls === 1, 'quota failure must not suppress cloud queueing');
    assert(alerts === 1, 'quota failure must be visible');
});

test('financial receipts are generated from recorded payments only', () => {
    assert(source.includes('function triggerPaymentReceipt('), 'payment-specific receipt function is required');
    assert(source.includes('function triggerLatestLawyerReceipt('), 'lawyer ledger must open a real recorded payment');
    assert(!source.includes("'receipt', " + '$' + "{remaining}"), 'remaining balance must never be passed as a receipt amount');
    assert(source.includes('triggerPaymentReceipt(' + '$' + '{jsArg(tx.id)},' + '$' + '{jsArg(p.id)})'), 'each payment needs its own receipt action');
    assert(source.includes('>المدفوع<') && source.includes('>المتبقي<'), 'account report must show paid and remaining columns');
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
        console.error('REMEDIATION_PHASE1_SMOKE FAILED', JSON.stringify(failures, null, 2));
        process.exitCode = 1;
        return;
    }
    console.log('REMEDIATION_PHASE1_SMOKE PASS', JSON.stringify({ tests: tests.length }));
})();
