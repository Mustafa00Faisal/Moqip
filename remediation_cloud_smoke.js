'use strict';

const fs = require('fs');
const vm = require('vm');
const appSource = fs.readFileSync(__dirname + '/app.js', 'utf8');
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
        if (char === '"' || char === "'" || char.charCodeAt(0) === 96) {
            quote = char;
            continue;
        }
        if (char === '(') parenDepth++;
        else if (char === ')') parenDepth--;
        else if (char === '{' && parenDepth === 0) {
            brace = i;
            break;
        }
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
        if (char === '"' || char === "'" || char.charCodeAt(0) === 96) {
            quote = char;
            continue;
        }
        if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('Unterminated function: ' + name);
}

function createContext(values) {
    const ctx = {
        console,
        Date,
        Math,
        Number,
        String,
        JSON,
        Promise,
        setTimeout,
        clearTimeout,
        ...values
    };
    vm.createContext(ctx);
    return ctx;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function testLocalQuotaDoesNotBlockCloud() {
    let writes = 0;
    let synced = 0;
    const ctx = createContext({
        cloudSyncEnabled: true,
        cloudSyncBusy: false,
        cloudSyncQueued: true,
        cloudSyncOwnerId: null,
        cloudConflict: null,
        cloudSyncRetryDelay: 2000,
        CLOUD_SYNC_RETRY_MAX: 60000,
        cloudSyncTimer: null,
        navigator: { onLine: true },
        db: { schemaVersion: 6, settings: {}, lawyers: [], companies: [], transactions: [], vault: [] },
        supabaseClient: {
            auth: { getSession: async () => ({ data: { session: { user: { id: 'owner-1' } } } }) },
            from: () => ({})
        },
        withCloudTimeout: promise => Promise.resolve(promise),
        normalizeDb: value => value,
        storeLocalSnapshot: () => false,
        writeCloudSnapshot: async () => { writes++; return { saved: true, record: { revision: 2, updated_at: '2026-08-26T00:00:00Z' } }; },
        handleCloudConflict: () => false,
        setCloudRecordState: () => {},
        clearCloudPending: () => {},
        publishCloudSyncState: state => { if (state === 'synced') synced++; },
        isLikelyNetworkError: () => false,
        isRetryableCloudError: () => false,
        showToast: () => {}
    });
    vm.runInContext(extractFunction(appSource, 'flushCloudSave'), ctx);
    const result = await ctx.flushCloudSave();
    assert(result === true, 'cloud save should succeed even when the local cache write fails');
    assert(writes === 1 && synced === 1, 'conditional cloud write and synced state must occur exactly once');
}

async function testPermanentCloudErrorsDoNotLoop() {
    let scheduled = 0;
    let errorToasts = 0;
    const ctx = createContext({
        cloudSyncEnabled: true,
        cloudSyncBusy: false,
        cloudSyncQueued: true,
        cloudSyncOwnerId: null,
        cloudConflict: null,
        cloudSyncRetryDelay: 2000,
        CLOUD_SYNC_RETRY_MAX: 60000,
        cloudSyncTimer: null,
        navigator: { onLine: true },
        db: { schemaVersion: 6, settings: {}, lawyers: [], companies: [], transactions: [], vault: [] },
        supabaseClient: {
            auth: { getSession: async () => ({ data: { session: { user: { id: 'owner-1' } } } }) },
            from: () => ({})
        },
        withCloudTimeout: promise => Promise.resolve(promise),
        normalizeDb: value => value,
        storeLocalSnapshot: () => true,
        writeCloudSnapshot: async () => { throw { code: '42501', status: 403, message: 'permission denied' }; },
        handleCloudConflict: () => false,
        setCloudRecordState: () => {},
        clearCloudPending: () => {},
        publishCloudSyncState: () => {},
        isCloudSchemaUpgradeError: () => false,
        isLikelyNetworkError: () => false,
        isRetryableCloudError: () => false,
        showToast: () => { errorToasts++; },
        setTimeout: () => { scheduled++; return 1; },
        clearTimeout: () => {}
    });
    vm.runInContext(extractFunction(appSource, 'flushCloudSave'), ctx);
    const result = await ctx.flushCloudSave();
    assert(result === false, 'RLS rejection should report failure');
    assert(ctx.cloudSyncQueued === false, 'permanent RLS rejection must leave the retry queue');
    assert(scheduled === 0, 'permanent RLS rejection must not schedule an infinite retry');
    assert(errorToasts === 1, 'permanent RLS rejection must be visible once');
}

function testMissingAuthLibraryNeverLoadsLastOwner() {
    const start = appSource.indexOf('function init()');
    const end = appSource.indexOf('// تطبيق إعدادات قاعدة البيانات', start);
    const initSource = appSource.slice(start, end);
    assert(start >= 0 && end > start, 'init source must be discoverable');
    assert(!initSource.includes('localStorage.getItem'), 'init must not read cached owner data when Auth is unavailable');
    assert(!initSource.includes('LOCAL_OWNER_KEY'), 'init must not select the last owner when Auth is unavailable');
    assert(initSource.includes('showSupabaseLogin'), 'missing Auth library must stop at the secure login gate');
}

function testNotificationTargetsStaySameOrigin() {
    assert(workerSource.includes('requested.origin === self.location.origin'), 'notification click must enforce same-origin navigation');
    assert(workerSource.includes('client.navigate(target.href)'), 'validated URL should be used for existing clients');
    assert(workerSource.includes('openWindow(target.href)'), 'validated URL should be used for new windows');
}

function testSupabaseSecurityScriptIsComplete() {
    assert(sqlSource.includes('enable row level security'), 'app_data must enable RLS');
    assert(sqlSource.includes('force row level security'), 'app_data must force RLS for defense in depth');
    assert(sqlSource.includes('grant select, insert, update, delete'), 'authenticated Data API grants must be explicit');
    assert(sqlSource.includes('revoke all on table public.app_data from public, anon, authenticated'), 'public and anon must have no app_data privileges');
    assert(sqlSource.includes('id bigint not null default 1'), 'snapshot id type must match the numeric client contract');
    assert(sqlSource.includes('incompatible app_data columns'), 'unsafe legacy column types must abort the migration');
    assert(sqlSource.includes('legacy uniqueness on id alone'), 'a global legacy id key must not silently break multi-user snapshots');
    for (const operation of ['select', 'insert', 'update', 'delete']) {
        assert(sqlSource.includes('for ' + operation), 'missing RLS policy for ' + operation);
    }
    assert((sqlSource.match(/auth\.uid\(\)/g) || []).length >= 4, 'every operation must enforce row ownership');
    assert(sqlSource.includes('with check ((select auth.uid()) = owner_id)'), 'insert/update must prevent owner reassignment');
    assert(sqlSource.includes('revision bigint not null default 0'), 'optimistic concurrency requires a revision column');
    assert(sqlSource.includes('check (revision >= 0)'), 'revision must never become negative');
    assert(sqlSource.includes('check (id = 1)'), 'each owner must use the single snapshot id contract');
    assert(sqlSource.includes("notify pgrst, 'reload schema'"), 'PostgREST schema cache should refresh after migration');
    assert(sqlSource.includes("select policyname\n        from pg_policies"), 'legacy permissive policies must be removed before owner policies are rebuilt');
    assert(sqlSource.includes('has an unexpected definition'), 'named legacy constraints/indexes must be verified instead of trusted by name');
    assert(sqlSource.includes('new.revision <> old.revision + 1'), 'server must reject clients that do not advance the revision');
    assert(sqlSource.includes('before insert or update on public.app_data'), 'revision guard trigger must cover inserts and updates');
    assert(sqlSource.includes("using errcode = '40001'"), 'revision conflicts need a machine-readable PostgreSQL code');
}

(async () => {
    const tests = [
        ['local quota does not block cloud', testLocalQuotaDoesNotBlockCloud],
        ['permanent cloud errors do not loop', testPermanentCloudErrorsDoNotLoop],
        ['missing Auth library keeps data locked', testMissingAuthLibraryNeverLoadsLastOwner],
        ['notification navigation is same-origin', testNotificationTargetsStaySameOrigin],
        ['Supabase security script is complete', testSupabaseSecurityScriptIsComplete]
    ];
    const failures = [];
    for (const [name, run] of tests) {
        try {
            await run();
            console.log('PASS', name);
        } catch (error) {
            failures.push({ name, error: error.message });
            console.error('FAIL', name, '-', error.message);
        }
    }
    if (failures.length) {
        console.error('REMEDIATION_CLOUD_SMOKE FAILED', JSON.stringify(failures, null, 2));
        process.exitCode = 1;
        return;
    }
    console.log('REMEDIATION_CLOUD_SMOKE PASS', JSON.stringify({ tests: tests.length }));
})();
