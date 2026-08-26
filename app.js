/*
 * ================================================================
 * نظام إدارة المعاملات المتقدم V6 — app.js
 * ================================================================
 *
 * ترتيب هذا الملف مهم:
 * 01. Configuration / Database / Migration
 * 02. Supabase / Auth / Cloud Sync
 * 03. UI / Modals / Helpers
 * 04. Backup & Settings
 * 05. CRUD / Entities
 * 06. Transactions / Follow-ups / Notes / Payments
 * 07. Vault
 * 08. Details / Timeline / Stations
 * 09. Analytics / Archive / Accounting
 * 10. V6.4 Financial Reports
 * 11. V6.5 Advanced Analytics
 * 12. PDF / QR
 * 13. V6 Dashboard / Smart Views
 *
 * ملاحظات الصيانة:
 * - لا تغيّر أسماء IDs في index.html دون تحديث المراجع هنا.
 * - db هي قاعدة بيانات الواجهة الحالية، وSupabase تحفظ Snapshot لها.
 * - RLS وStorage إعدادات Backend وليست بدائل داخل JavaScript.
 * - لا تعيد تحميل بيانات localStorage قبل التحقق من Auth.
 *
 * تنظيم Full Redesign:
 * - Core V6 يبقى في أقسامه الأصلية ولا يُنقل لمجرد أغراض التصميم.
 * - أي كود Presentation جديد يحمل عنوان FULL REDESIGN/UI PRESENTATION.
 * - Renderers قد تغيّر HTML المعروض، لكنها لا تغيّر Schema أو قواعد الحساب.
 * - قبل اعتماد أي مرحلة: Syntax + IDs + handlers + Core diff + ZIP integrity.
 * ================================================================
 */

// ==========================================================
        // SUPABASE - طبقة الاتصال السحابي
        // ==========================================================
        // ملاحظة:
        // لا نغيّر db الأصلية. هذه الطبقة تضيف الحفظ السحابي فقط.
        // لا تضع Service Role Key داخل HTML.
        // ==========================================================
        const SUPABASE_URL = 'https://giidtugteyiobaagqohy.supabase.co';
        const SUPABASE_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpaWR0dWd0ZXlpb2JhYWdxb2h5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMTgyMjYsImV4cCI6MjEwMjY5NDIyNn0.v7Nwag2BTrCWG6zzeYo1kTG4w2xAuzSmiZpCLJtvBow';

        let supabaseClient = null;
        let cloudSyncEnabled = false;
        let cloudSyncBusy = false;
        let cloudSyncQueued = false;
        let cloudSyncTimer = null;
        let cloudSyncOwnerId = null;
        let cloudInitBusy = false;
        let cloudRevision = 0;
        let cloudRecordExists = false;
        let cloudConflict = null;
        // PRODUCTIVITY 02: backoff prevents an offline/network failure from creating
        // a tight retry loop that wastes CPU/battery on mobile.
        let cloudSyncRetryDelay = 2000;
        const CLOUD_SYNC_RETRY_MAX = 60000;

        // مفاتيح التخزين المحلية المعزولة لكل مستخدم.
        // لا نستخدم localStorage كقاعدة بيانات سحابية؛ هو Cache/Offline fallback فقط.
        const APP_VERSION = '6.1.0-remediation';
        const SCHEMA_VERSION = 6;
        const LEGACY_DB_KEY = 'moaqib_db_v5';
        const LEGACY_DB_KEYS = ['moaqib_db_v4', 'moaqib_db_v3'];
        const LOCAL_OWNER_KEY = 'moaqib_db_owner_id';
        const LOCAL_PENDING_PREFIX = 'moaqib_cloud_pending_';
        const LOCAL_CLOUD_META_PREFIX = 'moaqib_cloud_meta_';
        const LOCAL_DEVICE_KEY = 'moaqib_device_id';

        function getUserDbKey(userId) {
            return `moaqib_db_v5_${String(userId)}`;
        }
        function getPendingSyncKey(userId) {
            return `${LOCAL_PENDING_PREFIX}${String(userId)}`;
        }
        function getCloudMetaKey(userId) {
            return `${LOCAL_CLOUD_META_PREFIX}${String(userId)}`;
        }
        function readCloudMeta(userId) {
            if (!userId) return { revision: 0, exists: false, updatedAt: null };
            try {
                const value = JSON.parse(localStorage.getItem(getCloudMetaKey(userId)) || 'null');
                return {
                    revision: Math.max(0, Number(value?.revision) || 0),
                    exists: value?.exists === true,
                    updatedAt: value?.updatedAt || null
                };
            } catch (error) {
                console.warn('Cloud metadata could not be read:', error);
                return { revision: 0, exists: false, updatedAt: null };
            }
        }
        function storeCloudMeta(userId, revision = cloudRevision, exists = cloudRecordExists, updatedAt = null) {
            if (!userId) return false;
            try {
                localStorage.setItem(getCloudMetaKey(userId), JSON.stringify({
                    revision: Math.max(0, Number(revision) || 0),
                    exists: exists === true,
                    updatedAt: updatedAt || null
                }));
                return true;
            } catch (error) {
                console.warn('Cloud metadata could not be stored:', error);
                return false;
            }
        }
        function setCloudRecordState(userId, record = null) {
            cloudRevision = Math.max(0, Number(record?.revision) || 0);
            cloudRecordExists = !!record;
            storeCloudMeta(userId, cloudRevision, cloudRecordExists, record?.updated_at || null);
        }
        function restoreCloudRecordState(userId) {
            const meta = readCloudMeta(userId);
            cloudRevision = meta.revision;
            cloudRecordExists = meta.exists;
            return meta;
        }
        function getDeviceId() {
            try {
                const existing = localStorage.getItem(LOCAL_DEVICE_KEY);
                if (existing) return existing;
                const generated = typeof globalThis.crypto?.randomUUID === 'function'
                    ? globalThis.crypto.randomUUID()
                    : `device-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
                localStorage.setItem(LOCAL_DEVICE_KEY, generated);
                return generated;
            } catch (_) {
                return 'device-unavailable';
            }
        }
        function markCloudPending(userId = cloudSyncOwnerId) {
            if (!userId) return false;
            try { localStorage.setItem(getPendingSyncKey(userId), '1'); return true; }
            catch (error) { console.warn('Pending marker could not be stored:', error); return false; }
        }
        function clearCloudPending(userId = cloudSyncOwnerId) {
            if (!userId) return false;
            try { localStorage.removeItem(getPendingSyncKey(userId)); return true; }
            catch (error) { console.warn('Pending marker could not be cleared:', error); return false; }
        }
        function hasCloudPending(userId = cloudSyncOwnerId) {
            if (!userId) return false;
            try { return localStorage.getItem(getPendingSyncKey(userId)) === '1'; }
            catch (error) { console.warn('Pending marker could not be read:', error); return false; }
        }

        function storeLocalSnapshot(userId, snapshot, notify = false) {
            if (!userId) return false;
            try {
                const serialized = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);
                localStorage.setItem(getUserDbKey(userId), serialized);
                localStorage.setItem(LOCAL_OWNER_KEY, String(userId));
                return true;
            } catch (error) {
                console.error('Local snapshot write error:', error);
                if (notify) customAlert('تعذر الحفظ المحلي', 'تعذر تحديث نسخة الجهاز، لكن ستستمر محاولة الحفظ السحابي.', 'error');
                return false;
            }
        }

        function createEmptyDb() {
            return {
                schemaVersion: SCHEMA_VERSION,
                governanceVersion: 1,
                paymentLedgerVersion: 2,
                settings: { name: '', address: '', theme: 'light', signature: null },
                lawyers: [],
                companies: [],
                transactions: [],
                vault: [],
                trash: { transactions: [] },
                auditLog: []
            };
        }

        // ==========================================================
        // PRODUCTIVITY 02 — OFFLINE / SYNC BRIDGE
        // ==========================================================
        // Keeps V6's snapshot model intact. LocalStorage remains the immediate
        // durable copy; Supabase is retried only when connectivity is available.
        function isLikelyNetworkError(error) {
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
            const message = String(error?.message || error?.details || error || '').toLowerCase();
            return /failed to fetch|network|load failed|timeout|offline|connection|fetch failed/.test(message);
        }

        function isRetryableCloudError(error) {
            if (isLikelyNetworkError(error)) return true;
            const status = Number(error?.status || error?.statusCode || 0);
            const code = String(error?.code || '').toUpperCase();
            return status === 408 || status === 425 || status === 429 || status >= 500 ||
                ['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'].includes(code);
        }

        function isCloudSchemaUpgradeError(error) {
            const code = String(error?.code || '').toUpperCase();
            const message = String(error?.message || error?.details || error?.hint || error || '').toLowerCase();
            return ['42703', 'PGRST204'].includes(code) ||
                (message.includes('revision') && /column|schema|cache|does not exist|could not find/.test(message));
        }

        function withCloudTimeout(promise, timeoutMs = 15000, code = 'CLOUD_TIMEOUT') {
            let timer = null;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(code);
                    error.code = code;
                    reject(error);
                }, timeoutMs);
            });
            return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
        }

        function publishCloudSyncState(status, extra = {}) {
            try {
                window.MOAQIB_PRODUCTIVITY_SYNC_STATE?.({
                    status,
                    queued: cloudSyncQueued,
                    busy: cloudSyncBusy,
                    ownerId: cloudSyncOwnerId,
                    ...extra
                });
            } catch (_) {}
        }

        function loadLocalUserSnapshot(userId) {
            if (!userId) return false;
            const userKey = getUserDbKey(userId);
            const saved = localStorage.getItem(userKey);
            if (!saved) return false;
            try {
                db = normalizeDb(JSON.parse(saved));
                cloudSyncOwnerId = userId;
                restoreCloudRecordState(userId);
                try { localStorage.setItem(LOCAL_OWNER_KEY, String(userId)); } catch (_) {}
                publishCloudSyncState('offline-ready', { source: 'local-cache' });
                return true;
            } catch (error) {
                console.error('Local offline snapshot error:', error);
                return false;
            }
        }

        // توحيد شكل البيانات بعد التحميل أو الاستيراد لمنع البيانات التالفة/الناقصة.
        // ==========================================================
        // V6 DATA MODEL / MIGRATION
        // ==========================================================
        // V6 يضيف المتابعة والملاحظات والدفعات والسجل الزمني والأولوية
        // بدون حذف أي حقل قديم. البيانات القديمة تُحوّل تلقائياً.
        // ==========================================================
        function makeId() {
            try { return crypto.randomUUID(); }
            catch (_) { return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
        }

        function buildPaymentReceiptRef(paymentId) {
            const raw = String(paymentId || 'payment');
            const compact = raw.replace(/[^a-zA-Z0-9]/g, '').slice(-12).toUpperCase();
            if (compact) return `MQP-${compact}`;
            let hash = 2166136261;
            for (let index = 0; index < raw.length; index += 1) {
                hash ^= raw.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            return `MQP-${(hash >>> 0).toString(36).toUpperCase().padStart(7, '0')}`;
        }

        function normalizeDb(source) {
            const base = createEmptyDb();
            const input = source && typeof source === 'object' ? source : {};
            const requiredId = value => value === null || value === undefined || value === '' ? makeId() : String(value);
            const referenceId = value => value === null || value === undefined || value === '' ? '' : String(value);
            const normalized = {
                ...base,
                ...input,
                schemaVersion: SCHEMA_VERSION,
                governanceVersion: 1,
                paymentLedgerVersion: 2,
                settings: { ...base.settings, ...(input.settings && typeof input.settings === 'object' ? input.settings : {}) },
                lawyers: Array.isArray(input.lawyers) ? input.lawyers.map(l => ({
                    ...l,
                    id: requiredId(l?.id),
                    name: String(l?.name || '').trim()
                })) : [],
                companies: Array.isArray(input.companies) ? input.companies.map(c => ({
                    ...c,
                    id: requiredId(c?.id),
                    lawyerId: referenceId(c?.lawyerId),
                    name: String(c?.name || '').trim()
                })) : [],
                transactions: Array.isArray(input.transactions) ? input.transactions : [],
                trash: {
                    transactions: Array.isArray(input.trash?.transactions) ? input.trash.transactions : []
                },
                auditLog: Array.isArray(input.auditLog) ? input.auditLog.map(entry => ({
                    ...entry,
                    id: requiredId(entry?.id),
                    date: Number(entry?.date) || Date.now(),
                    action: String(entry?.action || 'unknown'),
                    entityType: String(entry?.entityType || 'system'),
                    entityId: referenceId(entry?.entityId),
                    summary: String(entry?.summary || ''),
                    actorId: referenceId(entry?.actorId) || 'local',
                    deviceId: referenceId(entry?.deviceId) || 'unknown',
                    details: entry?.details && typeof entry.details === 'object' && !Array.isArray(entry.details) ? entry.details : {}
                })) : [],
                vault: Array.isArray(input.vault) ? input.vault.map(doc => ({
                    ...doc,
                    id: requiredId(doc?.id),
                    companyId: referenceId(doc?.companyId),
                    date: Number(doc?.date) || Date.now(),
                    data: String(doc?.data || '')
                })) : []
            };

            // فهارس محلية على النسخة التي يتم تطبيعها فعلياً.
            // مهم: normalizeDb قد تعمل قبل إسناد النتيجة إلى db، لذلك لا نعتمد على db الحالية هنا.
            const lawyerIndex = new Map(normalized.lawyers.map(l => [String(l.id), l]));
            const companyIndex = new Map(normalized.companies.map(c => [String(c.id), c]));

            const normalizeTransaction = t => {
                const company = companyIndex.get(String(t.companyId));
                const currentLawyerId = t.lawyerId;
                // بعض بيانات V5/البيانات القديمة قد تحتوي الشركة لكن لا تحتوي lawyerId صالحاً.
                // الشركة مرتبطة بمحاميها، لذلك نعيد ربط المعاملة تلقائياً إذا كان الربط القديم مفقوداً/غير صالح.
                const resolvedLawyerId = lawyerIndex.has(String(currentLawyerId))
                    ? currentLawyerId
                    : (company && lawyerIndex.has(String(company.lawyerId)) ? company.lawyerId : currentLawyerId);
                const createdAt = Number(t.createdAt) || Number(t.date) || Date.now();
                const lastUpdate = Number(t.lastUpdate) || createdAt;
                const fee = Number.isFinite(Number(t.fee)) ? Number(t.fee) : 0;
                const explicitLegacyPaid = Number.isFinite(Number(t.legacyPaidAmount)) ? Math.max(0, Number(t.legacyPaidAmount)) : null;
                const oldPaidAmount = Number.isFinite(Number(t.paidAmount)) ? Math.max(0, Number(t.paidAmount)) : 0;
                const rawPayments = Array.isArray(t.payments) ? t.payments : [];
                const payments = rawPayments.map(p => {
                    const paymentId = requiredId(p?.id);
                    const paymentStatus = p?.status === 'reversed' ? 'reversed' : 'posted';
                    return {
                        ...p,
                        id: paymentId,
                        amount: Math.max(0, Number(p.amount) || 0),
                        date: Number(p.date) || createdAt,
                        method: String(p.method || 'نقدي'),
                        status: paymentStatus,
                        receiptRef: String(p?.receiptRef || buildPaymentReceiptRef(paymentId)),
                        reversedAt: paymentStatus === 'reversed' ? (Number(p?.reversedAt) || Number(p?.date) || createdAt) : null,
                        reversalReason: paymentStatus === 'reversed' ? String(p?.reversalReason || 'عكس مسجل') : ''
                    };
                }).filter(p => p.amount > 0);
                const stations = (Array.isArray(t.stations) ? t.stations : []).map(station => {
                    const raw = station && typeof station === 'object' ? station : { name: station };
                    return {
                        ...raw,
                        id: requiredId(raw.id),
                        name: String(raw.name || '').trim(),
                        user: String(raw.user || '').trim(),
                        date: Number(raw.date) || createdAt
                    };
                }).filter(station => station.name);
                const notes = (Array.isArray(t.notes) ? t.notes : []).map(note => {
                    const raw = note && typeof note === 'object' ? note : { text: note };
                    return {
                        ...raw,
                        id: requiredId(raw.id),
                        text: String(raw.text || '').trim(),
                        date: Number(raw.date) || createdAt
                    };
                }).filter(note => note.text);
                const followUps = (Array.isArray(t.followUps) ? t.followUps : []).map(f => ({
                    ...f,
                    id: requiredId(f?.id),
                    title: String(f?.title || '').trim(),
                    done: !!f?.done,
                    createdAt: Number(f?.createdAt) || createdAt,
                    completedAt: f?.done ? (Number(f?.completedAt) || Number(f?.createdAt) || createdAt) : null
                })).filter(f => f.title);
                const activity = (Array.isArray(t.activity) ? t.activity : []).map(a => ({
                    ...a,
                    id: requiredId(a?.id),
                    date: Number(a?.date) || createdAt,
                    text: String(a?.text || ''),
                    ...(a?.sourceId !== undefined && a?.sourceId !== null ? { sourceId: String(a.sourceId) } : {}),
                    ...(a?.followUpId !== undefined && a?.followUpId !== null ? { followUpId: String(a.followUpId) } : {})
                }));
                const status = ['active','stalled','completed'].includes(t.status) ? t.status : 'active';
                const completionEventDates = activity
                    .filter(a => a.type === 'completed' && Number(a.date))
                    .map(a => Number(a.date));
                const inferredCompletedAt = completionEventDates.length ? Math.min(...completionEventDates) : lastUpdate;
                // V5 stored the paid total directly. V6 stores individual payments.
                // Preserve the old total as a historical baseline when no explicit V6 baseline exists.
                const preservedLegacyPaid = explicitLegacyPaid !== null ? explicitLegacyPaid : oldPaidAmount;
                return {
                    ...t,
                    id: requiredId(t.id),
                    companyId: company ? company.id : referenceId(t.companyId),
                    lawyerId: referenceId(resolvedLawyerId),
                    createdAt,
                    lastUpdate,
                    completedAt: status === 'completed' ? (Number(t.completedAt) || inferredCompletedAt) : null,
                    stations,
                    notes,
                    payments,
                    legacyPaidAmount: preservedLegacyPaid,
                    paidAmount: 0,
                    paymentLedgerVersion: 2,
                    followUps,
                    activity,
                    priority: ['normal','high','urgent'].includes(t.priority) ? t.priority : 'normal',
                    fee,
                    status
                };
            };
            normalized.transactions = normalized.transactions.map(normalizeTransaction);
            normalized.trash.transactions = normalized.trash.transactions.map(t => ({
                ...normalizeTransaction(t),
                deletedAt: Number(t?.deletedAt) || Number(t?.lastUpdate) || Date.now(),
                deletedBy: referenceId(t?.deletedBy) || 'local',
                deletionReason: String(t?.deletionReason || 'حذف يدوي')
            }));
            rebuildEntityIndexes(normalized);
            return normalized;
        }

        // حماية جميع القيم النصية التي تدخل HTML الديناميكي من XSS.
        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function escapeAttr(value) {
            return escapeHtml(value);
        }

        // V6.11: تمرير القيم الديناميكية إلى inline handlers بطريقة آمنة.
        function jsArg(value) {
            return escapeAttr(JSON.stringify(String(value ?? '')));
        }

        // تنظيف اسم الملف قبل تمريره إلى html2pdf.
        function safeFileName(value) {
            return String(value ?? 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'document';
        }

        // ==========================================================
        // V6 HELPERS - Timeline / Follow-ups / Notes / Payments
        // ==========================================================
        function getTransaction(id) {
            if (id === null || id === undefined || id === '') return null;
            return db.transactions.find(t => String(t.id) === String(id)) || null;
        }

        function addActivity(tx, type, text, meta = {}) {
            if (!tx.activity) tx.activity = [];
            tx.activity.push({ id: makeId(), type, text, date: Date.now(), ...meta });
            tx.lastUpdate = Date.now();
        }

        function getAllStoredTransactions() {
            return [
                ...(Array.isArray(db.transactions) ? db.transactions : []),
                ...(Array.isArray(db.trash?.transactions) ? db.trash.transactions : [])
            ];
        }

        function appendAudit(action, entityType, entityId, summary, details = {}) {
            if (!Array.isArray(db.auditLog)) db.auditLog = [];
            const entry = {
                id: makeId(),
                date: Date.now(),
                action: String(action || 'unknown'),
                entityType: String(entityType || 'system'),
                entityId: entityId === null || entityId === undefined ? '' : String(entityId),
                summary: String(summary || ''),
                actorId: cloudSyncOwnerId ? String(cloudSyncOwnerId) : 'local',
                deviceId: getDeviceId(),
                details: details && typeof details === 'object' && !Array.isArray(details) ? { ...details } : {}
            };
            db.auditLog.push(entry);
            return entry;
        }

        function saveDataWithAudit(action, entityType, entityId, summary, details = {}) {
            const audit = appendAudit(action, entityType, entityId, summary, details);
            if (saveData()) return true;
            db.auditLog = db.auditLog.filter(entry => String(entry.id) !== String(audit.id));
            return false;
        }

        function getPaidAmount(tx) {
            const historical = Math.max(0, Number(tx.legacyPaidAmount) || 0);
            const payments = Array.isArray(tx.payments)
                ? tx.payments.reduce((sum, p) => p?.status === 'reversed' ? sum : sum + Math.max(0, Number(p.amount) || 0), 0)
                : 0;
            const fallback = !Array.isArray(tx.payments) || tx.payments.length === 0
                ? Math.max(0, Number(tx.paidAmount) || 0)
                : 0;
            const recorded = historical + payments + fallback;
            return Math.min(recorded, Math.max(0, Number(tx.fee) || 0));
        }

        function getRemainingAmount(tx) {
            return Math.max(0, (Number(tx.fee) || 0) - getPaidAmount(tx));
        }

        function getPendingFollowUps(tx) {
            return (tx.followUps || []).filter(f => !f.done);
        }

        function getNextFollowUp(tx) {
            return getPendingFollowUps(tx).sort((a,b) => new Date(a.dueAt) - new Date(b.dueAt))[0] || null;
        }

        function formatShortDate(value) {
            if (!value) return '—';
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return '—';
            return d.toLocaleDateString('ar-IQ', { day: '2-digit', month: '2-digit', year: 'numeric' });
        }

        function formatDateTimeLocal(value) {
            if (!value) return '';
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return '';
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }


        // ملاحظة مهمة:
        // تم تحميل مكتبة Supabase قبل هذا الكود، لذلك window.supabase
        // يجب أن يكون موجودًا الآن.
        if (window.supabase && typeof window.supabase.createClient === 'function') {
            supabaseClient = window.supabase.createClient(
                SUPABASE_URL,
                SUPABASE_PUBLISHABLE_KEY,
                {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                }
            );
            cloudSyncEnabled = true;
        } else {
            console.error('Supabase JS library was not loaded.');
        }

        // ==========================================================
        // SUPABASE AUTH - نافذة تسجيل الدخول
        // ==========================================================
                // ==========================================================
        // 1. مترجم أخطاء السحابة (لتحويل الإنجليزي لعربي)
        // ==========================================================
        function translateAuthError(errorMsg) {
            if (!errorMsg) return 'حدث خطأ غير معروف.';
            const msg = errorMsg.toLowerCase();
            if (msg.includes('invalid login credentials')) return 'البريد أو كلمة المرور غير صحيحة.';
            if (msg.includes('password should be at least')) return 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.';
            if (msg.includes('user already registered')) return 'هذا الحساب مسجل مسبقاً، يرجى تسجيل الدخول.';
            if (msg.includes('rate limit')) return 'حاولت مرات كثيرة، يرجى الانتظار قليلاً.';
            return 'تنبيه: ' + errorMsg;
        }

        // ==========================================================
        // 2. تبديل واجهة الدخول والتسجيل (مع أنميشن انسيابي)
        // ==========================================================
        function toggleAuthMode(mode) {
            const root = document.getElementById('supabase-login-modal');
            const title = document.getElementById('auth-title');
            const subtitle = document.getElementById('auth-subtitle');
            const icon = document.getElementById('auth-icon');
            const iconBg = document.getElementById('auth-icon-bg');
            const loginGroup = document.getElementById('login-action-group');
            const registerGroup = document.getElementById('register-action-group');
            const msg = document.getElementById('supabase-login-message');
            if (msg) msg.innerText = '';
            const registerMode = mode === 'register';
            if (root) root.dataset.authMode = registerMode ? 'register' : 'login';
            if (loginGroup) { loginGroup.style.display = registerMode ? 'none' : 'grid'; loginGroup.classList.toggle('hidden', registerMode); }
            if (registerGroup) { registerGroup.style.display = registerMode ? 'grid' : 'none'; registerGroup.classList.toggle('hidden', !registerMode); }
            if (title) title.textContent = registerMode ? 'إنشاء حساب جديد' : 'تسجيل الدخول';
            if (subtitle) subtitle.innerText = registerMode ? 'أنشئ مساحة عمل آمنة مرتبطة بحسابك.' : 'أدخل بيانات حسابك للوصول إلى مساحة المكتب.';
            if (icon) icon.className = registerMode ? 'fa-solid fa-user-plus' : 'fa-solid fa-fingerprint';
            if (iconBg) iconBg.className = `mq-auth-symbol ${registerMode ? 'is-register' : 'is-login'}`;
        }

        // ==========================================================
        // 3. دوال تسجيل الدخول وإنشاء الحساب (مربوطة بالمترجم)
        // ==========================================================
        // MOAQIB FINAL — startup and busy-state presentation helpers only.
        function setBootStatus(message = '') {
            const status = document.getElementById('mq-boot-status');
            if (status && message) status.textContent = message;
        }

        function finishBoot() {
            const boot = document.getElementById('mq-boot-screen');
            if (!boot || boot.classList.contains('is-done')) return;
            boot.classList.add('is-done');
            window.setTimeout(() => { if (boot?.parentNode) boot.remove(); }, 380);
        }

        function setAuthButtonBusy(button, busy, label) {
            if (!button) return;
            if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
            button.disabled = !!busy;
            button.setAttribute('aria-busy', busy ? 'true' : 'false');
            if (busy) button.innerHTML = `<span>${escapeHtml(label || 'جارٍ التنفيذ...')}</span><i class="fa-solid fa-spinner"></i>`;
            else button.innerHTML = button.dataset.idleHtml;
        }

    function showSupabaseLogin(message = '') {
    const appShell = document.getElementById('app-shell');
    const modal = document.getElementById('supabase-login-modal');
    const messageEl = document.getElementById('supabase-login-message');

    if (appShell) appShell.classList.add('hidden');
    if (messageEl) messageEl.innerText = message;
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
    // FINAL: authentication is a complete startup state, never a blank screen.
    finishBoot();
}

        function hideSupabaseLogin() {
    const modal = document.getElementById('supabase-login-modal');
    const appShell = document.getElementById('app-shell');

    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }

    // إظهار التطبيق بعد تسجيل الدخول
    if (appShell) {
        appShell.classList.remove('hidden');
    }
}

        async function supabaseLogin() {
            if (!supabaseClient) return showSupabaseLogin('لم يتم تحميل مكتبة السحابة.');
            
            const email = document.getElementById('supabase-login-email').value.trim();
            const password = document.getElementById('supabase-login-password').value;
            
            if (!email || !password) return showSupabaseLogin('يرجى إدخال البريد الإلكتروني وكلمة المرور.');

            const button = document.getElementById('supabase-login-button');
            setAuthButtonBusy(button, true, 'جاري التحقق...');

            try {
                const { error } = await withCloudTimeout(supabaseClient.auth.signInWithPassword({ email, password }), 15000, 'AUTH_LOGIN_TIMEOUT');
                if (error) return showSupabaseLogin(translateAuthError(error.message));

                await initializeCloudSync();
                showToast('تم تسجيل الدخول بنجاح.', 'success');
            } catch (error) {
                console.error('Login error:', error);
                showSupabaseLogin(translateAuthError(error?.message));
            } finally {
                setAuthButtonBusy(button, false);
            }
        }
async function supabaseLogout() {
    if (!supabaseClient) {
        showToast('خدمة تسجيل الدخول غير متاحة.', 'error');
        return;
    }

    try {
        // لا نترك عملية مزامنة معلقة خلف جلسة سيتم إغلاقها.
        if (cloudSyncQueued || cloudSyncBusy) {
            await flushCloudSave();
        }
    } catch (error) {
        console.error('Logout flush error:', error);
        showToast('تعذر حفظ آخر تعديل سحابياً، لكن البيانات المحلية محفوظة.', 'info');
    }

    const { error } = await withCloudTimeout(supabaseClient.auth.signOut(), 12000, 'AUTH_LOGOUT_TIMEOUT');

    if (error) {
        showToast('تعذر تسجيل الخروج.', 'error');
        return;
    }

    showToast('تم تسجيل الخروج بنجاح.', 'success');
}
        async function supabaseRegister() {
            if (!supabaseClient) return showSupabaseLogin('لم يتم تحميل مكتبة السحابة.');
            
            const email = document.getElementById('supabase-login-email').value.trim();
            const password = document.getElementById('supabase-login-password').value;
            
            if (!email || !password) return showSupabaseLogin('يرجى إدخال البريد الإلكتروني وكلمة المرور.');
            if (password.length < 6) return showSupabaseLogin('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');

            const button = document.getElementById('supabase-register-button');
            setAuthButtonBusy(button, true, 'جاري إنشاء الحساب...');

            try {
                const { data, error } = await withCloudTimeout(supabaseClient.auth.signUp({ email, password }), 15000, 'AUTH_REGISTER_TIMEOUT');
                if (error) return showSupabaseLogin(translateAuthError(error.message));

                if (data?.session) {
                    await initializeCloudSync();
                    showToast('تم إنشاء الحساب بنجاح.', 'success');
                } else {
                    showSupabaseLogin('تم الإنشاء بنجاح. تحقق من بريدك الإلكتروني.');
                }
            } catch (error) {
                console.error('Register error:', error);
                showSupabaseLogin(translateAuthError(error?.message));
            } finally {
                setAuthButtonBusy(button, false);
            }
        }


        // ==========================================================
        // SUPABASE DATA - نفس db الحالية بدون تغيير بنيتها
        // ==========================================================
        async function fetchCloudRecord(userId) {
            const { data, error } = await withCloudTimeout(
                supabaseClient
                    .from('app_data')
                    .select('data,revision,updated_at')
                    .eq('owner_id', userId)
                    .eq('id', 1)
                    .maybeSingle(),
                15000,
                'CLOUD_LOAD_TIMEOUT'
            );
            if (error) throw error;
            return data || null;
        }

        async function writeCloudSnapshot(user, snapshot) {
            const nextRevision = cloudRevision + 1;
            const payload = {
                data: snapshot,
                revision: nextRevision,
                updated_at: new Date().toISOString()
            };

            if (!cloudRecordExists) {
                const { data, error } = await withCloudTimeout(
                    supabaseClient
                        .from('app_data')
                        .insert({ id: 1, owner_id: user.id, ...payload })
                        .select('revision,updated_at')
                        .maybeSingle(),
                    15000,
                    'CLOUD_SAVE_TIMEOUT'
                );
                if (!error && data) return { saved: true, record: data };
                if (error && String(error.code || '') !== '23505') throw error;
                const remote = await fetchCloudRecord(user.id);
                return { saved: false, conflict: true, remote };
            }

            const { data, error } = await withCloudTimeout(
                supabaseClient
                    .from('app_data')
                    .update(payload)
                    .eq('owner_id', user.id)
                    .eq('id', 1)
                    .eq('revision', cloudRevision)
                    .select('revision,updated_at')
                    .maybeSingle(),
                15000,
                'CLOUD_SAVE_TIMEOUT'
            );
            if (error) throw error;
            if (data) return { saved: true, record: data };
            const remote = await fetchCloudRecord(user.id);
            return { saved: false, conflict: true, remote };
        }

        function showCloudConflictDialog() {
            const modal = document.getElementById('cloudConflictModal');
            if (!modal || !cloudConflict) return;
            const expected = document.getElementById('cloud-conflict-expected');
            const remote = document.getElementById('cloud-conflict-remote');
            const remoteButton = document.getElementById('cloud-conflict-use-remote');
            if (expected) expected.textContent = String(cloudConflict.expectedRevision);
            if (remote) remote.textContent = cloudConflict.remote
                ? String(Math.max(0, Number(cloudConflict.remote.revision) || 0))
                : 'غير موجودة';
            if (remoteButton) remoteButton.disabled = !cloudConflict.remote?.data;
            openModal('cloudConflictModal');
        }

        function handleCloudConflict(userId, localSnapshot, remote) {
            cloudSyncQueued = false;
            cloudConflict = {
                ownerId: String(userId),
                localSnapshot,
                remote,
                expectedRevision: cloudRevision,
                detectedAt: Date.now()
            };
            markCloudPending(userId);
            publishCloudSyncState('conflict', {
                expectedRevision: cloudRevision,
                remoteRevision: Number(remote?.revision) || null
            });
            showCloudConflictDialog();
            return false;
        }

        function exportConflictLocalCopy() {
            if (!cloudConflict) return showToast('لا يوجد تعارض نشط', 'info');
            exportData();
        }

        async function resolveCloudConflict(choice) {
            const conflict = cloudConflict;
            if (!conflict) return false;

            if (choice === 'remote') {
                if (!conflict.remote?.data) return showToast('لا توجد نسخة سحابية لاعتمادها', 'error');
                db = normalizeDb(conflict.remote.data);
                setCloudRecordState(conflict.ownerId, conflict.remote);
                appendAudit(
                    'cloud.conflict_resolved_remote', 'system', 'cloud-sync',
                    'تم اعتماد النسخة السحابية بعد تعارض مزامنة',
                    { expectedRevision: conflict.expectedRevision, remoteRevision: Number(conflict.remote.revision) || 0 }
                );
                cloudConflict = null;
                closeModal('cloudConflictModal');
                storeLocalSnapshot(conflict.ownerId, db, true);
                markCloudPending(conflict.ownerId);
                cloudSyncQueued = true;
                applyCurrentSettingsToUI();
                renderAll();
                const saved = await flushCloudSave();
                showToast(saved
                    ? 'تم اعتماد النسخة السحابية وتسجيل قرار التعارض'
                    : 'تم اعتماد النسخة السحابية محلياً، وسيتكرر رفع قيد التدقيق عند توفر الاتصال',
                    saved ? 'success' : 'info');
                return saved;
            }

            if (choice === 'local') {
                setCloudRecordState(conflict.ownerId, conflict.remote || null);
                appendAudit(
                    'cloud.conflict_resolved_local', 'system', 'cloud-sync',
                    'تم اعتماد نسخة هذا الجهاز بعد تعارض مزامنة',
                    { expectedRevision: conflict.expectedRevision, remoteRevision: Number(conflict.remote?.revision) || null }
                );
                cloudConflict = null;
                closeModal('cloudConflictModal');
                storeLocalSnapshot(conflict.ownerId, db, true);
                cloudSyncQueued = true;
                markCloudPending(conflict.ownerId);
                const saved = await flushCloudSave();
                if (saved) showToast('تم رفع نسخة هذا الجهاز بعد التحقق من التعارض', 'success');
                return saved;
            }
            return false;
        }

        async function loadCloudData() {
            if (!cloudSyncEnabled) return false;

            const { data: sessionData } = await withCloudTimeout(supabaseClient.auth.getSession(), 12000, 'AUTH_SESSION_TIMEOUT');
            const user = sessionData?.session?.user;
            if (!user) return false;

            cloudSyncOwnerId = user.id;
            const userKey = getUserDbKey(user.id);

            // If a previous offline session left unsynced edits, LOCAL MUST win
            // before reading the older cloud snapshot. This prevents reopening
            // online from overwriting work completed while disconnected.
            if (hasCloudPending(user.id) && localStorage.getItem(userKey)) {
                if (loadLocalUserSnapshot(user.id)) {
                    publishCloudSyncState('pending', { source: 'local-pending-recovery' });
                    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
                        await flushCloudSave();
                    }
                    return true;
                }
            }

            // Offline-first: after one successful online sign-in, the isolated
            // local snapshot can open immediately without waiting for the network.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                if (loadLocalUserSnapshot(user.id)) return true;
                const error = new Error('OFFLINE_NO_LOCAL_SNAPSHOT');
                error.code = 'OFFLINE_NO_LOCAL_SNAPSHOT';
                throw error;
            }

            let result;
            try {
                result = await fetchCloudRecord(user.id);
            } catch (error) {
                if (isLikelyNetworkError(error) && loadLocalUserSnapshot(user.id)) return true;
                throw error;
            }

            if (result?.data) {
                db = normalizeDb(result.data);
                setCloudRecordState(user.id, result);
                storeLocalSnapshot(user.id, db, true);
                clearCloudPending(user.id);
                publishCloudSyncState('synced', { source: 'cloud-load' });
                return true;
            }

            // أول دخول: لا نرحّل بيانات localStorage القديمة إلا إذا لم يكن هناك مستخدم سابق معروف.
            // هذا يمنع انتقال بيانات المستخدم A تلقائياً إلى المستخدم B على نفس الجهاز.
            const lastOwnerId = localStorage.getItem(LOCAL_OWNER_KEY);
            let localSaved = localStorage.getItem(userKey);
            let migratedLegacy = false;

            if (!localSaved && !lastOwnerId) {
                localSaved = localStorage.getItem(LEGACY_DB_KEY);
                if (!localSaved) {
                    for (const legacyKey of LEGACY_DB_KEYS) {
                        const candidate = localStorage.getItem(legacyKey);
                        if (candidate) {
                            localSaved = candidate;
                            break;
                        }
                    }
                }
                migratedLegacy = !!localSaved;
            }

            if (localSaved && (!lastOwnerId || lastOwnerId === user.id)) {
                try {
                    db = normalizeDb(JSON.parse(localSaved));
                } catch (e) {
                    console.error('Local migration error:', e);
                    db = createEmptyDb();
                }
            } else {
                // مستخدم جديد بلا نسخة سحابية: لا نترك في الذاكرة بيانات مستخدم آخر.
                db = createEmptyDb();
            }

            setCloudRecordState(user.id, null);
            const migratedSnapshotStored = storeLocalSnapshot(user.id, db, true);
            if (migratedLegacy && migratedSnapshotStored) {
                localStorage.removeItem(LEGACY_DB_KEY);
                LEGACY_DB_KEYS.forEach(key => localStorage.removeItem(key));
            }

            await saveDataToCloud(true);
            return true;
        }

        async function flushCloudSave() {
            if (!cloudSyncEnabled || cloudSyncBusy) return false;
            if (cloudConflict) {
                publishCloudSyncState('conflict');
                showCloudConflictDialog();
                return false;
            }

            // Never hammer the network while the browser reports offline. The local
            // snapshot is already durable and will be flushed on the next online event.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                cloudSyncQueued = true;
                publishCloudSyncState('pending-offline');
                return false;
            }

            let success = false;
            let shouldRetry = false;
            let localCacheSaved = false;
            try {
                cloudSyncBusy = true;
                cloudSyncQueued = false;
                publishCloudSyncState('syncing');

                const { data: sessionData } = await withCloudTimeout(supabaseClient.auth.getSession(), 12000, 'AUTH_SESSION_TIMEOUT');
                const user = sessionData?.session?.user;
                if (!user) {
                    publishCloudSyncState('signed-out');
                    return false;
                }

                cloudSyncOwnerId = user.id;
                const snapshot = normalizeDb(JSON.parse(JSON.stringify(db)));

                // حفظ نسخة محلية معزولة حسب الحساب قبل الرفع السحابي.
                localCacheSaved = storeLocalSnapshot(user.id, snapshot, false);

                const writeResult = await writeCloudSnapshot(user, snapshot);
                if (writeResult?.conflict) return handleCloudConflict(user.id, snapshot, writeResult.remote);
                if (!writeResult?.saved || !writeResult.record) throw new Error('CLOUD_SAVE_EMPTY_RESULT');
                setCloudRecordState(user.id, writeResult.record);
                success = true;
                clearCloudPending(user.id);
                cloudSyncRetryDelay = 2000;
                publishCloudSyncState('synced');
                return true;
            } catch (error) {
                console.error('Supabase save error:', error);
                shouldRetry = isRetryableCloudError(error) && (typeof navigator === 'undefined' || navigator.onLine !== false);
                cloudSyncQueued = shouldRetry;

                if (isCloudSchemaUpgradeError(error)) {
                    publishCloudSyncState('schema-upgrade-required', { error: String(error?.message || '') });
                    showToast('تحتاج قاعدة Supabase إلى تشغيل ملف SUPABASE_SECURITY_SETUP.sql قبل استئناف المزامنة.', 'error');
                } else if (isLikelyNetworkError(error)) {
                    publishCloudSyncState('pending-offline', { error: String(error?.message || '') });
                } else {
                    publishCloudSyncState('error', { error: String(error?.message || '') });
                    showToast(localCacheSaved
                        ? 'رفضت السحابة آخر تعديل؛ النسخة المحلية محفوظة وتحتاج فحص الإعدادات.'
                        : 'رفضت السحابة آخر تعديل وتعذر تحديث نسخة الجهاز. لا تغلق التطبيق قبل معالجة الخطأ.', 'error');
                }
                return false;
            } finally {
                cloudSyncBusy = false;
                if (cloudSyncQueued && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
                    clearTimeout(cloudSyncTimer);
                    const delay = success ? 350 : cloudSyncRetryDelay;
                    cloudSyncTimer = setTimeout(() => flushCloudSave(), delay);
                    if (!success && shouldRetry) cloudSyncRetryDelay = Math.min(CLOUD_SYNC_RETRY_MAX, cloudSyncRetryDelay * 2);
                }
            }
        }

        // مزامنة مؤجلة تمنع فقدان آخر تعديل وتمنع إرسال طلب مع كل ضغطة مفتاح.
        async function saveDataToCloud(immediate = false) {
            if (!cloudSyncEnabled) return false;
            if (cloudConflict) {
                publishCloudSyncState('conflict');
                showCloudConflictDialog();
                return false;
            }

            cloudSyncQueued = true;
            markCloudPending();
            publishCloudSyncState('pending', { localChange: !immediate });

            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                publishCloudSyncState('pending-offline');
                return false;
            }

            if (immediate) {
                clearTimeout(cloudSyncTimer);
                return flushCloudSave();
            }

            clearTimeout(cloudSyncTimer);
            cloudSyncTimer = setTimeout(() => flushCloudSave(), 650);
            return true;
        }

        // Stable public bridge used only by the productivity layer when the
        // browser reports that connectivity has returned.
        window.flushMoaqibCloudSync = () => saveDataToCloud(true);

        async function initializeCloudSync() {
            if (!cloudSyncEnabled || cloudInitBusy) return;
            cloudInitBusy = true;
            setBootStatus('التحقق من الجلسة السحابية...');

            try {
                const { data: sessionData } = await withCloudTimeout(supabaseClient.auth.getSession(), 12000, 'AUTH_SESSION_TIMEOUT');

                // إذا لا توجد جلسة، نظهر شاشة الدخول.
                if (!sessionData?.session?.user) {
                    cloudSyncOwnerId = null;
                    cloudRevision = 0;
                    cloudRecordExists = false;
                    cloudConflict = null;
                    db = createEmptyDb();
                    document.getElementById('app-shell')?.classList.add('hidden');
                    renderAll();
                    showSupabaseLogin('سجّل الدخول لاستخدام البيانات السحابية.');
                    return;
                }

                hideSupabaseLogin();
                setBootStatus('مزامنة مساحة العمل...');
                const loaded = await loadCloudData();
                if (loaded) {
                    applyCurrentSettingsToUI();
                    renderAll();
                    finishBoot();
                } else {
                    document.getElementById('app-shell')?.classList.add('hidden');
                    showSupabaseLogin('تعذر تحميل مساحة العمل. أعد تسجيل الدخول ثم حاول مجددًا.');
                }
            } catch (error) {
                console.error('Supabase initialization error:', error);
                if (error?.code === 'OFFLINE_NO_LOCAL_SNAPSHOT' || error?.message === 'OFFLINE_NO_LOCAL_SNAPSHOT') {
                    showSupabaseLogin('لا توجد نسخة محلية لهذا الحساب بعد. اتصل بالإنترنت مرة واحدة لتهيئة العمل دون اتصال.');
                    publishCloudSyncState('offline-no-cache');
                } else if (isCloudSchemaUpgradeError(error)) {
                    publishCloudSyncState('schema-upgrade-required', { error: String(error?.message || '') });
                    showSupabaseLogin('قاعدة Supabase تحتاج ترقية آمنة قبل تشغيل هذا الإصدار. شغّل ملف SUPABASE_SECURITY_SETUP.sql ثم أعد المحاولة.');
                } else if (isLikelyNetworkError(error) && cloudSyncOwnerId && loadLocalUserSnapshot(cloudSyncOwnerId)) {
                    hideSupabaseLogin();
                    applyCurrentSettingsToUI();
                    renderAll();
                    finishBoot();
                    showToast('تم فتح النسخة المحلية. ستتم المزامنة عند عودة الإنترنت.', 'info');
                } else {
                    publishCloudSyncState('error', { error: String(error?.message || '') });
                    showSupabaseLogin('تعذر الاتصال بالسحابة الآن. تحقق من الإنترنت ثم حاول تسجيل الدخول مجددًا.');
                }
            } finally {
                cloudInitBusy = false;
            }
        }

        // متابعة تغيّر الجلسة.
        supabaseClient?.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_OUT') {
                cloudSyncOwnerId = null;
                cloudSyncQueued = false;
                cloudRevision = 0;
                cloudRecordExists = false;
                cloudConflict = null;
                clearTimeout(cloudSyncTimer);
                if (document.getElementById('cloudConflictModal')) closeModal('cloudConflictModal');
                db = createEmptyDb();
                renderAll();
                showSupabaseLogin('تم تسجيل الخروج.');
            }
        });

        // REBUILD 11: runtime Tailwind compatibility bridge removed; the mq-* design system is self-contained.

// ==========================================
        // 1. نظام البيانات الأساسي والترقية (CORE DATA)
        // ==========================================
        
        // كائن الـ db هو قاعدة البيانات الرئيسية التي تحفظ كل بيانات التطبيق
        let db = createEmptyDb();

        // V6.11: فهارس خفيفة لتقليل البحث المتكرر داخل المصفوفات.
        let entityIndexes = { lawyers: new Map(), companies: new Map() };
        let renderScheduled = false;
        function rebuildEntityIndexes(source = db) {
            const sourceDb = source && typeof source === 'object' ? source : createEmptyDb();
            entityIndexes.lawyers = new Map((sourceDb.lawyers || []).map(l => [String(l.id), l]));
            entityIndexes.companies = new Map((sourceDb.companies || []).map(c => [String(c.id), c]));
        }
        function getLawyerById(id) { return entityIndexes.lawyers.get(String(id)) || null; }
        function getCompanyById(id) { return entityIndexes.companies.get(String(id)) || null; }
        function lawyerName(id) { return getLawyerById(id)?.name || ''; }
        function companyName(id) { return getCompanyById(id)?.name || ''; }

        // متغيرات عامة للمساعدة في العمليات (مثل رقم المعاملة المفتوحة حالياً)
        let currentTxId = null; 
        let pendingPaymentReversal = null;
        let confirmAction = null; 
        let chartInstance = null;
        
        // أدوات مساعدة لتنسيق الأرقام والتواريخ
        const numFormat = new Intl.NumberFormat('en-US');
        const formatDate = (ts) => { 
            let d = new Date(ts); 
            return d.toLocaleDateString('ar-IQ', {month: 'short', day: 'numeric'}) + ' - ' + d.toLocaleTimeString('ar-IQ', {hour: '2-digit', minute:'2-digit'}); 
        };

        // دالة الإقلاع الرئيسية (تعمل عند فتح الصفحة)
        function init() {
            setBootStatus('تهيئة مساحة العمل المحلية...');
            // ----------------------------------------------------------
            // أمان الإقلاع: لا نعرض بيانات آخر مستخدم قبل التحقق من
            // جلسة Supabase الحالية. هذا يمنع تسرب بيانات عابرة أثناء
            // تحميل الصفحة، خصوصاً على الأجهزة المشتركة.
            // ----------------------------------------------------------
            if (cloudSyncEnabled) {
                db = createEmptyDb();
                document.getElementById('app-shell')?.classList.add('hidden');
            } else {
                // Security gate: failure to load the Auth library is not an
                // authenticated offline session. Never expose the last owner's
                // cached legal/financial data merely because a CDN failed.
                db = createEmptyDb();
                renderAll();
                showSupabaseLogin('تعذر تحميل مكتبة الدخول الآمن. اتصل بالإنترنت ثم أعد فتح التطبيق.');
                return;
            }

            applyCurrentSettingsToUI();
            renderAll();
        }

        // تطبيق إعدادات قاعدة البيانات على الواجهة دون تغيير التصميم.
        function applyCurrentSettingsToUI() {
            if (db.settings.theme === 'dark') document.documentElement.classList.add('dark');
            else document.documentElement.classList.remove('dark');

            const nameEl = document.getElementById('set-name');
            const addressEl = document.getElementById('set-address');
            if (nameEl) nameEl.value = db.settings.name || '';
            if (addressEl) addressEl.value = db.settings.address || '';

            const previewContainer = document.getElementById('sig-preview-container');
            const preview = document.getElementById('sig-preview');
            if (previewContainer && preview) {
                if (db.settings.signature) {
                    previewContainer.classList.remove('hidden');
                    preview.src = db.settings.signature;
                } else {
                    previewContainer.classList.add('hidden');
                    preview.src = '';
                }
            }
        }

        // دالة حفظ البيانات في المتصفح لعدم ضياعها، مع عزلها حسب المستخدم عند توفر جلسة.
        function scheduleRenderAll() {
            if (renderScheduled) return;
            renderScheduled = true;
            const run = () => {
                renderScheduled = false;
                rebuildEntityIndexes();
                renderAll();
            };
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
            else setTimeout(run, 0);
        }

        function saveData() {
            let snapshot = null;
            let localSaved = false;
            try {
                snapshot = JSON.stringify(normalizeDb(db));
            } catch (error) {
                console.error('Data serialization error:', error);
                customAlert('تعذر تجهيز البيانات', 'تعذر تجهيز آخر تعديل للحفظ. لم يتم اعتبار العملية محفوظة.', 'error');
            }

            if (snapshot !== null) {
                try {
                const localKey = cloudSyncOwnerId ? getUserDbKey(cloudSyncOwnerId) : LEGACY_DB_KEY;
                localStorage.setItem(localKey, snapshot);
                if (cloudSyncOwnerId) localStorage.setItem(LOCAL_OWNER_KEY, cloudSyncOwnerId);
                    localSaved = true;
                } catch (error) {
                    if(error.name === 'QuotaExceededError') {
                        customAlert('الذاكرة ممتلئة', 'تعذر تثبيت آخر تعديل على الجهاز بسبب امتلاء التخزين. ستستمر محاولة المزامنة السحابية إن كانت الجلسة متصلة.', 'error');
                    } else {
                        console.error('Local save error:', error);
                        customAlert('تعذر الحفظ المحلي', 'تعذر تثبيت آخر تعديل على الجهاز. لم يتم اعتبار العملية محفوظة.', 'error');
                    }
                }
            }

            // Rendering and cloud queueing are intentionally independent from
            // localStorage. A quota error must never leave the UI stale or block
            // an authenticated cloud save.
            scheduleRenderAll();
            try {
                saveDataToCloud();
            } catch (error) {
                console.error('Cloud queue error:', error);
            }
            return localSaved;
        }

        // ==========================================================
        // UI PRESENTATION LAYER — SYSTEM FEEDBACK
        // ==========================================================
        // هذه المجموعة مسؤولة عن المظهر والتفاعل فقط. لا تقرأ/تكتب db
        // ولا تتعامل مع Supabase أو PDF. إبقاؤها منفصلة يسهل تدقيق V6.
        // ==========================================================

        // إشعار سريع غير حاجب. النوع يستخدم CSS دلالياً فقط ولا يغيّر الرسالة.
        function showToast(message, type = 'info') {
            const container = document.getElementById('toast-container');
            if (!container) return;
            const safeType = ['success', 'error', 'info'].includes(type) ? type : 'info';
            const iconByType = { success: 'fa-circle-check', error: 'fa-triangle-exclamation', info: 'fa-circle-info' };
            const toast = document.createElement('div');
            toast.className = `mq-toast is-${safeType}`;
            toast.setAttribute('role', 'status');
            toast.innerHTML = `<div class="mq-toast-icon"><i class="fa-solid ${iconByType[safeType]}" aria-hidden="true"></i></div>`;
            const copy = document.createElement('div');
            copy.className = 'mq-toast-copy';
            const label = document.createElement('small');
            label.textContent = safeType === 'success' ? 'تم بنجاح' : safeType === 'error' ? 'تنبيه' : 'MOAQIB';
            const toastText = document.createElement('span');
            toastText.textContent = message;
            copy.append(label, toastText);
            toast.appendChild(copy);
            container.appendChild(toast);
            setTimeout(() => { toast.classList.add('is-leaving'); setTimeout(() => toast.remove(), 260); }, 3000);
        }

        // دالة عرض تنبيه بمنتصف الشاشة
        function customAlert(title, message, type = 'info') {
            document.getElementById('uiAlertTitle').innerText = title;
            document.getElementById('uiAlertMsg').innerText = message;
            const icon = document.getElementById('uiAlertIcon');
            const safeType = ['error', 'success', 'info'].includes(type) ? type : 'info';
            if (icon) {
                icon.className = `mq-dialog-symbol is-${safeType}`;
                icon.innerHTML = `<i class="fa-solid ${safeType === 'error' ? 'fa-circle-xmark' : safeType === 'success' ? 'fa-circle-check' : 'fa-circle-info'}"></i>`;
            }
            document.getElementById('uiAlert').classList.add('active');
        }
        
        // دالة إغلاق التنبيه
        function closeUiAlert() { 
            document.getElementById('uiAlert').classList.remove('active'); 
        }

        // دالة طلب تأكيد لعملية معينة (مثل الحذف)
        function customConfirm(title, message, onConfirmCallback) {
            document.getElementById('uiConfirmTitle').innerText = title; 
            document.getElementById('uiConfirmMsg').innerText = message;
            confirmAction = onConfirmCallback; 
            document.getElementById('uiConfirm').classList.add('active');
        }
        
        // دوال إغلاق وتنفيذ نافذة التأكيد
        function closeUiConfirm() { 
            document.getElementById('uiConfirm').classList.remove('active'); 
            confirmAction = null; 
        }
        
        document.getElementById('uiConfirmBtn').addEventListener('click', () => { 
            if(confirmAction) confirmAction(); 
            closeUiConfirm(); 
        });

        // قائمة الاختيار المخصصة للموبايل.
        // نقرأ options من <select> الأصلي ثم نعيد عرضها كأزرار؛ القيمة النهائية
        // تبقى في الـselect نفسه، لذلك منطق النماذج الحالي لا يتغير.
        function openCustomSelect(selectId, title) {
            const selectEl = document.getElementById(selectId);
            if (!selectEl) return;

            const titleEl = document.getElementById('customSelectTitle');
            const listContainer = document.getElementById('customSelectList');
            if (titleEl) titleEl.innerText = title;
            if (!listContainer) return;
            listContainer.innerHTML = '';

            const choices = Array.from(selectEl.options).filter(opt => opt.value !== '');
            if (choices.length === 0) {
                listContainer.innerHTML = `<div class="mq-picker-empty"><i class="fa-solid fa-list-ul"></i><strong>لا توجد خيارات</strong><span>أضف البيانات المطلوبة أولاً ثم حاول مرة أخرى.</span></div>`;
            } else {
                choices.forEach(opt => {
                    const isSelected = selectEl.value === opt.value;
                    const optionButton = document.createElement('button');
                    optionButton.type = 'button';
                    optionButton.className = `mq-picker-option ${isSelected ? 'selected' : ''}`;
                    optionButton.innerHTML = `<span>${escapeHtml(opt.text)}</span>${isSelected ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-chevron-left"></i>'}`;
                    optionButton.onclick = () => {
                        selectEl.value = opt.value;
                        selectEl.dispatchEvent(new Event('change'));
                        updateCustomSelectText(selectId);
                        closeCustomSelect();
                    };
                    listContainer.appendChild(optionButton);
                });
            }

            openModal('customSelectModal');
        }

        function closeCustomSelect() { 
            closeModal('customSelectModal'); 
        }
        
        // تحديث النص الظاهر في زر القائمة المنسدلة المخصصة
        function updateCustomSelectText(selectId, defaultText = '- اختر -') {
            const selectEl = document.getElementById(selectId);
            const textSpan = document.getElementById(`text-${selectId}`);
            
            if(selectEl && textSpan) {
                const selected = selectEl.options[selectEl.selectedIndex];
                if(selected && selected.value) {
                    textSpan.innerText = selected.text;
                    textSpan.classList.remove('is-placeholder');
                } else {
                    textSpan.innerText = defaultText;
                    textSpan.classList.add('is-placeholder');
                }
            }
        }

        // ==========================================================
        // V6.8/V6.9 SAFETY HELPERS
        // ==========================================================
        // UI/UX REBUILD 04 — TRANSACTION WORKSPACE NAVIGATION
        // One continuous scroll surface. No hidden panels/tabs remain.
        // Core actions call these helpers only to focus the relevant section.
        function navigateTxWorkspace(section = 'overview', smooth = true) {
            const valid = ['overview','route','finance','history'];
            txWorkspaceSection = valid.includes(section) ? section : 'overview';
            document.querySelectorAll('[data-workspace-jump]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.workspaceJump === txWorkspaceSection);
            });
            const scroll = document.querySelector('#txDetailsContent .mq-case-scroll');
            if (txWorkspaceSection === 'overview') {
                if (scroll) scroll.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
                return;
            }
            const targetId = {
                route: 'tx-workspace-route',
                finance: 'tx-workspace-finance',
                history: 'tx-workspace-history'
            }[txWorkspaceSection];
            const target = targetId ? document.getElementById(targetId) : null;
            if (target) setTimeout(() => target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }), 20);
        }

        function focusTxSection(elementId) {
            const sectionMap = {
                'det-stations': 'route',
                'det-payments-list': 'finance',
                'det-notes-list': 'history',
                'det-followups-list': 'history',
                'det-timeline-list': 'history'
            };
            txWorkspaceSection = sectionMap[elementId] || 'overview';
            document.querySelectorAll('[data-workspace-jump]').forEach(btn => btn.classList.toggle('active', btn.dataset.workspaceJump === txWorkspaceSection));
            const el = document.getElementById(elementId);
            if (!el) return;
            setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
        }

        function openTxActionSheet() {
            document.getElementById('txActionSheet')?.classList.add('active');
        }

        function closeTxActionSheet() {
            document.getElementById('txActionSheet')?.classList.remove('active');
        }

        function startTxAction(type) {
            closeTxActionSheet();
            if (type === 'route') {
                navigateTxWorkspace('route');
                return openModal('addStationModal');
            }
            if (type === 'payment') {
                navigateTxWorkspace('finance');
                return setTimeout(() => document.getElementById('tx-payment-amount')?.focus(), 260);
            }
            navigateTxWorkspace('history');
            if (type === 'note') return setTimeout(() => document.getElementById('tx-note-input')?.focus(), 260);
            if (type === 'followup') return setTimeout(() => document.getElementById('tx-follow-title')?.focus(), 260);
        }

        function runDatabaseHealthCheck(showToastMessage = true) {
            rebuildEntityIndexes();
            const issues = [];
            const lawyerIds = new Set(), companyIds = new Set(), txIds = new Set();
            const paymentIds = new Set(), receiptRefs = new Set(), vaultIds = new Set(), auditIds = new Set();
            (db.lawyers || []).forEach((lawyer, index) => {
                const key = String(lawyer.id ?? '');
                if (!key) issues.push(`العميل رقم ${index + 1} بلا معرف.`);
                if (lawyerIds.has(key)) issues.push(`معرف عميل مكرر: ${key}`);
                lawyerIds.add(key);
                if (!String(lawyer.name || '').trim()) issues.push(`العميل ${key || index + 1} بلا اسم.`);
            });
            (db.companies || []).forEach((company, index) => {
                const key = String(company.id ?? '');
                if (!key) issues.push(`الشركة رقم ${index + 1} بلا معرف.`);
                if (companyIds.has(key)) issues.push(`معرف شركة مكرر: ${key}`);
                companyIds.add(key);
                if (!String(company.name || '').trim()) issues.push(`الشركة ${key || index + 1} بلا اسم.`);
                if (!getLawyerById(company.lawyerId)) issues.push(`الشركة ${key || index + 1} مرتبطة بمحامٍ غير موجود.`);
            });
            const inspectTransaction = (tx, index, location = 'النشطة') => {
                const key = String(tx.id ?? '');
                if (!key) issues.push(`المعاملة رقم ${index + 1} في ${location} بلا معرف.`);
                if (txIds.has(key)) issues.push(`معرف معاملة مكرر: ${key}`);
                txIds.add(key);
                if (!getCompanyById(tx.companyId)) issues.push(`المعاملة ${key || index + 1} مرتبطة بشركة غير موجودة.`);
                if (!getLawyerById(tx.lawyerId)) issues.push(`المعاملة ${key || index + 1} مرتبطة بمحامٍ غير موجود.`);
                if (!['active', 'stalled', 'completed'].includes(tx.status)) issues.push(`المعاملة ${key || index + 1} ذات حالة غير صالحة.`);
                if (tx.status === 'completed' && !Number(tx.completedAt)) issues.push(`المعاملة المنجزة ${key || index + 1} بلا تاريخ إنجاز.`);
                if (tx.status !== 'completed' && tx.completedAt) issues.push(`المعاملة المفتوحة ${key || index + 1} تحمل تاريخ إنجاز غير متسق.`);
                if (!Number.isFinite(Number(tx.fee)) || Number(tx.fee) < 0) issues.push(`أتعاب المعاملة ${key || index + 1} غير صالحة.`);
                if (!Array.isArray(tx.stations)) issues.push(`المعاملة ${key || index + 1}: المحطات غير صالحة.`);
                if (!Array.isArray(tx.notes)) issues.push(`المعاملة ${key || index + 1}: الملاحظات غير صالحة.`);
                if (!Array.isArray(tx.payments)) issues.push(`المعاملة ${key || index + 1}: الدفعات غير صالحة.`);
                if (!Array.isArray(tx.followUps)) issues.push(`المعاملة ${key || index + 1}: المتابعات غير صالحة.`);
                (tx.payments || []).forEach(payment => {
                    const paymentKey = String(payment.id ?? '');
                    if (!paymentKey) issues.push(`دفعة في المعاملة ${key || index + 1} بلا معرف.`);
                    if (paymentIds.has(paymentKey)) issues.push(`معرف دفعة مكرر: ${paymentKey}`);
                    paymentIds.add(paymentKey);
                    if (!Number.isFinite(Number(payment.amount)) || Number(payment.amount) <= 0) issues.push(`الدفعة ${paymentKey || 'بلا معرف'} ذات مبلغ غير صالح.`);
                    const receiptRef = String(payment.receiptRef || '').trim();
                    if (!receiptRef) issues.push(`الدفعة ${paymentKey || 'بلا معرف'} بلا مرجع سند ثابت.`);
                    if (receiptRef && receiptRefs.has(receiptRef)) issues.push(`مرجع سند قبض مكرر: ${receiptRef}`);
                    if (receiptRef) receiptRefs.add(receiptRef);
                    if (!['posted', 'reversed'].includes(payment.status || 'posted')) issues.push(`الدفعة ${payment.id || 'بلا معرف'} ذات حالة غير صالحة.`);
                    if (payment.status === 'reversed' && !payment.reversedAt) issues.push(`الدفعة ${payment.id || 'بلا معرف'} معكوسة بلا تاريخ عكس.`);
                    if (payment.status === 'reversed' && !String(payment.reversalReason || '').trim()) issues.push(`الدفعة ${payment.id || 'بلا معرف'} معكوسة بلا سبب.`);
                });
            };
            (db.transactions || []).forEach((tx, index) => inspectTransaction(tx, index, 'المعاملات النشطة'));
            (db.trash?.transactions || []).forEach((tx, index) => {
                inspectTransaction(tx, index, 'المحذوفات');
                if (!tx.deletedAt) issues.push(`المعاملة المحذوفة ${tx.id || index + 1} بلا تاريخ حذف.`);
            });
            (db.vault || []).forEach((doc, index) => {
                const key = String(doc.id ?? '');
                if (!key) issues.push(`المستند رقم ${index + 1} بلا معرف.`);
                if (vaultIds.has(key)) issues.push(`معرف مستند مكرر: ${key}`);
                vaultIds.add(key);
                if (!doc.data) issues.push(`المستند ${key || index + 1} لا يحتوي على صورة.`);
                if (doc.companyId !== null && doc.companyId !== undefined && !getCompanyById(doc.companyId)) issues.push(`المستند ${key || index + 1} مرتبط بشركة غير موجودة.`);
            });
            (db.auditLog || []).forEach((entry, index) => {
                const key = String(entry.id ?? '');
                if (!key) issues.push(`سجل التدقيق رقم ${index + 1} بلا معرف.`);
                if (auditIds.has(key)) issues.push(`معرف سجل تدقيق مكرر: ${key}`);
                auditIds.add(key);
                if (!entry.action || !entry.date) issues.push(`سجل التدقيق ${key || index + 1} ناقص البيانات.`);
                if (!entry.actorId || !entry.deviceId) issues.push(`سجل التدقيق ${key || index + 1} بلا هوية منفذ أو جهاز.`);
            });
            let rawSize=0; try { rawSize=new Blob([JSON.stringify(db)]).size; } catch (_) {}
            const sizeLabel=rawSize>=1048576?`${(rawSize/1048576).toFixed(2)} MB`:`${Math.max(0,Math.round(rawSize/1024))} KB`;
            const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
            set('health-tx-count',db.transactions.length); set('health-vault-count',db.vault.length); set('health-storage-size',sizeLabel);
            const st=document.getElementById('health-status');
            if(st){st.textContent=issues.length?`${issues.length} ملاحظة`:'سليمة';st.className=issues.length?'is-warning':'is-good';}
            const details=document.getElementById('health-details');
            if(details) details.innerHTML=issues.length?issues.slice(0,12).map(x=>`<div class="mq-health-message is-warning">• ${escapeHtml(x)}</div>`).join(''):'<div class="mq-health-message is-good"><i class="fa-solid fa-circle-check"></i> لم يتم العثور على مشاكل بنيوية.</div>';
            const breakdown=document.getElementById('health-breakdown');
            if(breakdown) breakdown.innerHTML=`<div class="mq-data-snapshot-item"><i class="fa-solid fa-user-tie"></i><span>محامون</span><b>${db.lawyers.length}</b></div><div class="mq-data-snapshot-item"><i class="fa-regular fa-building"></i><span>شركات</span><b>${db.companies.length}</b></div><div class="mq-data-snapshot-item"><i class="fa-solid fa-trash-arrow-up"></i><span>محذوفات</span><b>${db.trash?.transactions?.length || 0}</b></div><div class="mq-data-snapshot-item"><i class="fa-solid fa-clock-rotate-left"></i><span>سجل التدقيق</span><b>${db.auditLog?.length || 0}</b></div>`;
            if(showToastMessage) showToast(issues.length?`تم الفحص: ${issues.length} ملاحظة تحتاج مراجعة`:'تم فحص البيانات ولم تظهر مشاكل بنيوية',issues.length?'info':'success');
            return {issues,sizeBytes:rawSize};
        }

        function repairDatabase() {
            const before=runDatabaseHealthCheck(false);
            if(!before.issues.length) return showToast('البيانات سليمة ولا تحتاج إلى إصلاح','success');
            customConfirm('إصلاح آمن للبيانات','سيعاد تنظيم البنية والمعرفات المكررة عند الحاجة فقط، ولن يتم حذف الصور أو المعاملات. هل تريد المتابعة؟',()=>{
                const previousDb = db;
                const normalized=normalizeDb(JSON.parse(JSON.stringify(db)));
                const seenTx=new Set();
                normalized.transactions=normalized.transactions.map(tx=>{let id=String(tx.id??'');if(!id||seenTx.has(id))id=makeId();seenTx.add(id);return {...tx,id};});
                normalized.trash.transactions=normalized.trash.transactions.map(tx=>{let id=String(tx.id??'');if(!id||seenTx.has(id))id=makeId();seenTx.add(id);return {...tx,id};});
                const seenVault=new Set();
                normalized.vault=normalized.vault.map(doc=>{let id=String(doc.id??'');if(!id||seenVault.has(id))id=makeId();seenVault.add(id);return {...doc,id};});
                const seenAudit=new Set();
                normalized.auditLog=normalized.auditLog.map(entry=>{let id=String(entry.id??'');if(!id||seenAudit.has(id))id=makeId();seenAudit.add(id);return {...entry,id};});
                db=normalizeDb(normalized);
                const saved=saveDataWithAudit('data.repaired','system','database','تم تنفيذ إصلاح آمن لبنية البيانات',{ issueCount: before.issues.length });
                if (!saved) db = previousDb;
                const after = runDatabaseHealthCheck(false);
                if(saved) showToast(
                    after.issues.length ? `اكتمل الإصلاح الآمن، وتبقى ${after.issues.length} ملاحظة تحتاج مراجعة يدوية` : 'تم تنفيذ الإصلاح الآمن بدون حذف البيانات',
                    after.issues.length ? 'info' : 'success'
                );
            });
        }

        // ==========================================
        // 3. التنقل (Navigation) وفتح الواجهات
        // ==========================================

        // دالة التبديل بين الواجهات الرئيسية للتطبيق (الرئيسية، التأسيس، الأرشيف، إلخ)
        let transactionsHubMode = 'all';
        let txWorkspaceSection = 'overview';

        function openTransactionsHub(mode = 'all') {
            transactionsHubMode = ['all','active','stalled','completed'].includes(mode) ? mode : 'all';
            switchTab('active', true);
            renderTransactionsHub();
        }

        function setTransactionsHubMode(mode = 'all', shouldScroll = false) {
            transactionsHubMode = ['all','active','stalled','completed'].includes(mode) ? mode : 'all';
            renderTransactionsHub();
            if (shouldScroll) document.getElementById('transactions-hub')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function clearTransactionsHubSearch() {
            const input = document.getElementById('search-active');
            if (input) input.value = '';
            renderTransactionsHub();
            input?.focus();
        }

        function renderTransactionsHub() {
            const container = document.getElementById('active-list');
            if (!container || !document.getElementById('transactions-hub')) return;

            const all = Array.isArray(db.transactions) ? db.transactions : [];
            const counts = {
                all: all.length,
                active: all.filter(t => t.status === 'active').length,
                stalled: all.filter(t => t.status === 'stalled').length,
                completed: all.filter(t => t.status === 'completed').length
            };
            Object.entries(counts).forEach(([key, value]) => {
                const el = document.getElementById(`hub-count-${key}`);
                if (el) el.textContent = value;
            });

            document.querySelectorAll('[data-hub-mode]').forEach(btn => {
                const active = btn.dataset.hubMode === transactionsHubMode;
                btn.classList.toggle('active', active);
                btn.setAttribute('aria-selected', active ? 'true' : 'false');
            });

            const labels = {
                all: ['كل المعاملات', 'عرض موحد لجميع الحالات'],
                active: ['المعاملات الجارية', 'المعاملات المفتوحة قيد العمل'],
                stalled: ['المعاملات المتلكئة', 'تحتاج إلى تدخل أو متابعة'],
                completed: ['المعاملات المنجزة', 'المعاملات المكتملة والمؤرشفة']
            };
            const [title, subtitle] = labels[transactionsHubMode] || labels.all;
            const titleEl = document.getElementById('hub-result-title');
            const subtitleEl = document.getElementById('hub-result-subtitle');
            if (titleEl) titleEl.textContent = title;
            if (subtitleEl) subtitleEl.textContent = subtitle;

            const search = String(document.getElementById('search-active')?.value || '').trim().toLowerCase();
            // UI/UX REBUILD 03: نمرر نسخة مستقلة، وrenderTxList لا يغيّر ترتيب db.transactions.
            const base = transactionsHubMode === 'all' ? all.slice() : all.filter(t => t.status === transactionsHubMode);
            const filtered = !search ? base : base.filter(t => {
                const stationText = (t.stations || []).map(s => `${s.name || ''} ${s.user || ''}`).join(' ');
                const haystack = [t.type, t.dept, companyName(t.companyId), lawyerName(t.lawyerId), stationText].join(' ').toLowerCase();
                return haystack.includes(search);
            });

            const resultCount = document.getElementById('hub-result-count');
            if (resultCount) resultCount.textContent = filtered.length;
            const input = document.getElementById('search-active');
            if (input) input.placeholder = transactionsHubMode === 'all' ? 'ابحث في كل المعاملات...' : `ابحث في ${title}...`;

            const emptyMessages = {
                all: 'لا توجد معاملات مسجلة', active: 'لا توجد معاملات جارية', stalled: 'لا توجد معاملات متلكئة', completed: 'لا توجد معاملات منجزة'
            };
            renderTxList('active-list', filtered, search ? 'لا توجد نتائج بحث مطابقة' : emptyMessages[transactionsHubMode]);
        }

        // دالة التبديل بين الواجهات الرئيسية. "stalled" القديمة تُوجّه إلى مركز المعاملات الموحد.
        function switchTab(tabId, preserveHubMode = false) {
            if (tabId === 'stalled') {
                transactionsHubMode = 'stalled';
                tabId = 'active';
                preserveHubMode = true;
            }
            // الاستدعاءات القديمة switchTab('active') كانت تعني "الجارية"؛ نحافظ على هذا السلوك.
            if (tabId === 'active' && !preserveHubMode) transactionsHubMode = 'active';
            const target = document.getElementById(`view-${tabId}`);
            if (!target) return;
            document.querySelectorAll('.mq-view').forEach(el => el.classList.remove('active'));
            setTimeout(() => target.classList.add('active'), 10);

            document.querySelectorAll('.mq-dock-item').forEach(el => el.classList.remove('active'));
            const directNav = document.getElementById(`nav-${tabId}`);
            const moreTabs = new Set(['archive','analytics','settings']);
            const navTarget = directNav || (moreTabs.has(tabId) ? document.getElementById('nav-more') : null);
            if (navTarget) navTarget.classList.add('active');
            closeMoreMenu();
            if (tabId === 'active') renderTransactionsHub();
            if (tabId === 'newTx') setTimeout(refreshNewTxPreview, 20);
            if (tabId === 'accounting') renderAccounting();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function openMoreMenu() {
            const modal = document.getElementById('moreMenuModal');
            if (!modal) return;
            modal.classList.add('active');
            document.body.classList.add('mq-overlay-open');
        }

        function closeMoreMenu() {
            const modal = document.getElementById('moreMenuModal');
            if (modal) modal.classList.remove('active');
            document.body.classList.remove('mq-overlay-open');
        }

        // التبديل بين علامتي تبويب (الأرشيف) و (الخزنة) في قسم الأرشيف
        function toggleArchiveTab(type) {
            const mode = type === 'vault' ? 'vault' : 'tx';
            document.getElementById('tab-arch-tx')?.classList.toggle('active', mode === 'tx');
            document.getElementById('tab-arch-vault')?.classList.toggle('active', mode === 'vault');
            const txPanel = document.getElementById('archive-tx-content');
            const vaultPanel = document.getElementById('archive-vault-content');
            if (txPanel) { txPanel.style.display = mode === 'tx' ? 'block' : 'none'; txPanel.classList.toggle('hidden', mode !== 'tx'); }
            if (vaultPanel) { vaultPanel.style.display = mode === 'vault' ? 'block' : 'none'; vaultPanel.classList.toggle('hidden', mode !== 'vault'); }
            if(mode === 'vault') { updateVaultDropdown(); renderVault(); }
        }

        // FULL REDESIGN 04: تبديل أقسام مركز التحكم — طبقة عرض فقط.
        function setSettingsPanel(panel = 'profile') {
            const allowed = ['profile','entities','data','system'];
            const target = allowed.includes(panel) ? panel : 'profile';
            document.querySelectorAll('[data-settings-panel]').forEach(section => section.classList.toggle('active', section.dataset.settingsPanel === target));
            document.querySelectorAll('[data-settings-tab]').forEach(button => button.classList.toggle('active', button.dataset.settingsTab === target));
            if (target === 'entities') renderSettingsEntities();
            if (target === 'data') renderGovernancePanel();
        }

        function renderGovernancePanel() {
            rebuildEntityIndexes();
            const trash = Array.isArray(db.trash?.transactions) ? db.trash.transactions : [];
            const audit = Array.isArray(db.auditLog) ? db.auditLog : [];
            const trashCount = document.getElementById('trash-count');
            const auditCount = document.getElementById('audit-count');
            if (trashCount) trashCount.textContent = trash.length;
            if (auditCount) auditCount.textContent = audit.length;

            const trashList = document.getElementById('trash-list');
            if (trashList) trashList.innerHTML = trash.length
                ? trash.slice().sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt)).map(tx => `
                    <article class="mq-governance-entry"><i class="fa-solid fa-file-circle-xmark"></i><div><strong>${escapeHtml(tx.type || 'معاملة محذوفة')}</strong><span>${escapeHtml(companyName(tx.companyId) || 'شركة غير مسجلة')} · ${escapeHtml(lawyerName(tx.lawyerId) || 'محامٍ غير مسجل')}</span><small>حُذفت ${formatShortDate(tx.deletedAt)}</small></div><button type="button" onclick="restoreDeletedTransaction(${jsArg(tx.id)})"><i class="fa-solid fa-trash-arrow-up"></i> استعادة</button></article>`).join('')
                : '<div class="mq-governance-empty"><i class="fa-solid fa-circle-check"></i><span>لا توجد معاملات محذوفة</span></div>';

            const auditList = document.getElementById('audit-list');
            const auditIcons = {
                payment: 'fa-coins', transaction: 'fa-folder-open', lawyer: 'fa-user-tie',
                company: 'fa-building', vault: 'fa-file-shield', system: 'fa-shield-halved'
            };
            if (auditList) auditList.innerHTML = audit.length
                ? audit.slice().sort((a, b) => Number(b.date) - Number(a.date)).slice(0, 80).map(entry => `
                    <article class="mq-governance-entry mq-audit-entry"><i class="fa-solid ${auditIcons[entry.entityType] || 'fa-clock-rotate-left'}"></i><div><strong>${escapeHtml(entry.summary || entry.action)}</strong><span>${escapeHtml(entry.action)} · ${formatDate(entry.date)}</span><small>${escapeHtml(entry.actorId || 'local')} · ${escapeHtml(entry.deviceId || 'جهاز غير معروف')}</small></div></article>`).join('')
                : '<div class="mq-governance-empty"><i class="fa-solid fa-clock-rotate-left"></i><span>يبدأ السجل مع أول عملية جديدة</span></div>';
        }

        function restoreDeletedTransaction(id) {
            const deleted = db.trash?.transactions?.find(tx => String(tx.id) === String(id));
            if (!deleted) return showToast('المعاملة المحذوفة غير موجودة', 'error');
            if (db.transactions.some(tx => String(tx.id) === String(id))) {
                return customAlert('تعارض معرف', 'توجد معاملة نشطة تحمل المعرف نفسه. شغّل فحص البيانات قبل الاستعادة.', 'error');
            }
            customConfirm('استعادة المعاملة', `هل تريد إعادة «${deleted.type || 'المعاملة'}» إلى سجلات العمل؟`, () => {
                const previousTransactions = db.transactions;
                const previousTrash = db.trash.transactions;
                const { deletedAt, deletedBy, deletionReason, ...restored } = deleted;
                db.trash.transactions = db.trash.transactions.filter(tx => String(tx.id) !== String(id));
                db.transactions = [...db.transactions, restored];
                const saved = saveDataWithAudit(
                    'transaction.restored', 'transaction', restored.id,
                    `تمت استعادة المعاملة: ${restored.type || restored.id}`,
                    { deletedAt: Number(deletedAt) || null, previousDeletionReason: deletionReason || '' }
                );
                if (!saved) {
                    db.transactions = previousTransactions;
                    db.trash.transactions = previousTrash;
                    return;
                }
                renderGovernancePanel();
                renderSettingsEntities();
                showToast('تمت استعادة المعاملة', 'success');
            });
        }

        function clearSettingsEntitySearch() {
            const input = document.getElementById('settings-entity-search');
            if (input) input.value = '';
            renderSettingsEntities();
            input?.focus();
        }

        // UI/UX REBUILD 09: Control OS directory renderer.
        // Presentation only: filtering/deletion rules and source collections remain unchanged.
        function renderSettingsEntities() {
            const term = String(document.getElementById('settings-entity-search')?.value || '').trim().toLowerCase();
            const lawyers = db.lawyers.filter(item => !term || String(item.name || '').toLowerCase().includes(term));
            const companies = db.companies.filter(item => !term || String(item.name || '').toLowerCase().includes(term) || String(lawyerName(item.lawyerId) || '').toLowerCase().includes(term));
            const lawyerCount = document.getElementById('settings-lawyers-count');
            const companyCount = document.getElementById('settings-companies-count');
            const lawyerVisible = document.getElementById('settings-lawyers-visible');
            const companyVisible = document.getElementById('settings-companies-visible');
            if (lawyerCount) lawyerCount.textContent = db.lawyers.length;
            if (companyCount) companyCount.textContent = db.companies.length;
            if (lawyerVisible) lawyerVisible.textContent = lawyers.length;
            if (companyVisible) companyVisible.textContent = companies.length;

            const lawyerList = document.getElementById('settings-lawyers-list');
            if (lawyerList) lawyerList.innerHTML = lawyers.map((item, index) => {
                const companyTotal = db.companies.filter(c => String(c.lawyerId) === String(item.id)).length;
                const txTotal = getAllStoredTransactions().filter(t => String(t.lawyerId) === String(item.id)).length;
                return `<article class="mq-directory-card mq-enter" style="animation-delay:${index*.025}s"><span class="mq-directory-avatar"><i class="fa-solid fa-user-tie"></i></span><span class="mq-directory-copy"><small>عميل / محامي</small><b>${escapeHtml(item.name)}</b><em>${companyTotal} شركة · ${txTotal} معاملة</em></span><button class="mq-directory-delete ${txTotal ? 'is-locked' : ''}" onclick="reqDeleteLawyer(${jsArg(item.id)})" aria-label="حذف ${escapeAttr(item.name)}"><i class="fa-solid ${txTotal ? 'fa-lock' : 'fa-trash-can'}"></i></button></article>`;
            }).join('') || `<div class="mq-directory-empty"><span><i class="fa-solid fa-user-group"></i></span><strong>لا توجد نتائج</strong><small>أضف جهة جديدة أو غيّر عبارة البحث.</small></div>`;

            const companyList = document.getElementById('settings-companies-list');
            if (companyList) companyList.innerHTML = companies.map((item, index) => {
                const txTotal = getAllStoredTransactions().filter(t => String(t.companyId) === String(item.id)).length;
                const docTotal = db.vault.filter(v => String(v.companyId) === String(item.id)).length;
                return `<article class="mq-directory-card is-company mq-enter" style="animation-delay:${index*.025}s"><span class="mq-directory-avatar"><i class="fa-regular fa-building"></i></span><span class="mq-directory-copy"><small>${escapeHtml(lawyerName(item.lawyerId) || 'بدون محامٍ')}</small><b>${escapeHtml(item.name)}</b><em>${txTotal} معاملة · ${docTotal} مستند</em></span><button class="mq-directory-delete ${txTotal ? 'is-locked' : ''}" onclick="reqDeleteCompany(${jsArg(item.id)})" aria-label="حذف ${escapeAttr(item.name)}"><i class="fa-solid ${txTotal ? 'fa-lock' : 'fa-trash-can'}"></i></button></article>`;
            }).join('') || `<div class="mq-directory-empty"><span><i class="fa-regular fa-building"></i></span><strong>لا توجد نتائج</strong><small>أضف شركة جديدة أو غيّر عبارة البحث.</small></div>`;
        }

        // دالة تبديل الوضع بين الفاتح والداكن (Theme)
        function toggleTheme() {
            const isDark = document.documentElement.classList.toggle('dark');
            db.settings.theme = isDark ? 'dark' : 'light';
            saveData();
            initChart(); // Redraw chart to match new color scheme
        }

        // دالة لفتح النوافذ المنبثقة (Modals) بحركة سلسة
        function openModal(id) {
            const modal = document.getElementById(id); 
            modal.style.display = 'flex';
            
            setTimeout(() => { 
                modal.classList.add('active'); 
                const content = modal.children[0]; 
                if(content && content.classList.contains('is-closed')) {
                    content.classList.remove('is-closed'); 
                }
            }, 10);
        }

        // دالة إغلاق النوافذ المنبثقة
        function closeModal(id) {
            const modal = document.getElementById(id); 
            const content = modal.children[0];
            
            if(content && !content.classList.contains('is-closed')) {
                content.classList.add('is-closed');
            }
            
            modal.classList.remove('active'); 
            setTimeout(() => modal.style.display = 'none', 300);
        }

        // ==========================================
        // 4. النسخ الاحتياطي والأمان (Backup & Restore)
        // ==========================================

        // ==========================================================
        // V6.7 - النسخ الاحتياطي الموثق
        // ==========================================================
        // النسخة الجديدة تحتوي على غلاف واضح للإصدار وتاريخ الإنشاء.
        // لا نكسر النسخ القديمة: importData() يقبل db الخام أيضًا.
        // ==========================================================
        async function exportData() {
            try {
                // Freeze one normalized snapshot before the asynchronous digest so
                // user activity cannot make the checksum and embedded data diverge.
                const snapshot = normalizeDb(JSON.parse(JSON.stringify(db)));
                const payload = JSON.stringify(snapshot);
                let checksum = null;
                if (window.crypto?.subtle && window.TextEncoder) {
                    const bytes = new TextEncoder().encode(payload);
                    const digest = await crypto.subtle.digest('SHA-256', bytes);
                    checksum = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
                }
                const backup = {
                    format: 'MOAQIB_BACKUP',
                    backupVersion: 2,
                    appVersion: APP_VERSION,
                    schemaVersion: SCHEMA_VERSION,
                    exportedAt: new Date().toISOString(),
                    checksum,
                    data: snapshot
                };
                const backupJson = JSON.stringify(backup);
                const blob = new Blob([backupJson], { type: 'application/json;charset=utf-8' });
                const objectUrl = URL.createObjectURL(blob);
                const exportFileDefaultName = `moaqib_backup_v6_${new Date().getTime()}.json`;
                const linkElement = document.createElement('a');
                linkElement.href = objectUrl;
                linkElement.download = exportFileDefaultName;
                document.body.appendChild(linkElement);
                linkElement.click();
                linkElement.remove();
                setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                showToast('تم تصدير نسخة V6 احتياطية موثقة بنجاح', 'success');
            } catch (error) {
                console.error('Backup export error:', error);
                showToast('تعذر إنشاء النسخة الاحتياطية', 'error');
            }
        }

        // استيراد النسخ الجديدة والقديمة مع تحقق آمن من البنية.
        async function importData(event) {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 50 * 1024 * 1024) {
                customAlert('ملف كبير جداً', 'حجم النسخة الاحتياطية يتجاوز الحد المسموح (50MB).', 'error');
                event.target.value = '';
                return;
            }

            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const parsed = JSON.parse(e.target.result);
                    const importedDb = parsed?.format === 'MOAQIB_BACKUP' ? parsed.data : parsed;
                    if (!importedDb || typeof importedDb !== 'object' ||
                        !importedDb.settings || !Array.isArray(importedDb.transactions) ||
                        !Array.isArray(importedDb.lawyers) || !Array.isArray(importedDb.companies)) {
                        throw new Error('INVALID_BACKUP_STRUCTURE');
                    }

                    if (parsed?.format === 'MOAQIB_BACKUP' && parsed.checksum && window.crypto?.subtle && window.TextEncoder) {
                        const payload = JSON.stringify(importedDb);
                        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
                        const checksum = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
                        if (checksum !== parsed.checksum) throw new Error('BACKUP_CHECKSUM_MISMATCH');
                    }

                    const normalizedPreview = normalizeDb(importedDb);
                    const txCount = normalizedPreview.transactions.length;
                    const vaultCount = normalizedPreview.vault.length;
                    customConfirm(
                        'استعادة النسخة الاحتياطية',
                        `سيتم استبدال البيانات الحالية بنسخة تحتوي على ${txCount} معاملة و${vaultCount} مستند. هل أنت متأكد؟`,
                        () => {
                            const previousDb = db;
                            db = normalizedPreview;
                            if (!saveDataWithAudit(
                                'data.imported', 'system', 'database',
                                'تمت استعادة نسخة احتياطية بعد التحقق منها',
                                { transactionCount: txCount, vaultCount, backupVersion: String(parsed?.appVersion || parsed?.version || 'legacy') }
                            )) {
                                db = previousDb;
                                rebuildEntityIndexes();
                                renderAll();
                                return;
                            }
                            showToast('تمت استعادة النسخة والتحقق من بنيتها بنجاح', 'success');
                            setTimeout(() => location.reload(), 900);
                        }
                    );
                } catch (err) {
                    console.error('Backup import error:', err);
                    const msg = err?.message === 'BACKUP_CHECKSUM_MISMATCH'
                        ? 'النسخة الاحتياطية تالفة أو تم تعديلها بعد التصدير.'
                        : 'تعذرت قراءة النسخة. تأكد أنها نسخة MOAQIB صحيحة.';
                    customAlert('تعذر الاستعادة', msg, 'error');
                } finally {
                    event.target.value = '';
                }
            };
            reader.readAsText(file);
        }

        // دالة لتصفير وحذف كل بيانات التطبيق
        function reqClearData() {
            customConfirm('تصفير جذري', 'تحذير: سيتم مسح كافة البيانات والصور والأرشيف نهائياً. تأكد من "تصدير البيانات" قبل هذه الخطوة. هل أنت متأكد؟', async () => {
                const ownerId = cloudSyncOwnerId;
                try {
                    if (ownerId && supabaseClient) {
                        const { error } = await supabaseClient
                            .from('app_data')
                            .delete()
                            .eq('owner_id', ownerId)
                            .eq('id', 1);
                        if (error) throw error;
                    }

                    [LEGACY_DB_KEY, ...LEGACY_DB_KEYS, LOCAL_OWNER_KEY].forEach(key => localStorage.removeItem(key));
                    if (ownerId) {
                        localStorage.removeItem(getUserDbKey(ownerId));
                        localStorage.removeItem(getPendingSyncKey(ownerId));
                        localStorage.removeItem(getCloudMetaKey(ownerId));
                    }
                    cloudRevision = 0;
                    cloudRecordExists = false;
                    cloudConflict = null;
                    db = createEmptyDb();
                    showToast('تم تصفير البيانات بنجاح', 'success');
                    setTimeout(() => location.reload(), 250);
                } catch (error) {
                    console.error('Cloud clear error:', error);
                    customAlert('تعذر التصفير', 'فشل حذف النسخة السحابية، لذلك لم يتم حذف النسخة المحلية. جرّب مرة أخرى بعد التأكد من الاتصال.', 'error');
                }
            });
        }

        // ==========================================
        // 5. العمليات البرمجية (الإضافة والحفظ)
        // ==========================================

        // حفظ إعدادات المستخدم (الاسم والعنوان) مباشرة عند الكتابة
        let settingsSaveTimer = null;
        function saveSettingsRealtime() {
            db.settings.name = document.getElementById('set-name').value;
            db.settings.address = document.getElementById('set-address').value;
            clearTimeout(settingsSaveTimer);
            settingsSaveTimer = setTimeout(() => saveData(), 450);
        }

        // معالجة وحفظ صورة التوقيع الإلكتروني
        function handleSignatureUpload(event) {
            const file = event.target.files[0]; 
            if(!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                const previousSignature = db.settings.signature;
                db.settings.signature = e.target.result;
                document.getElementById('sig-preview-container').classList.remove('hidden'); 
                document.getElementById('sig-preview').src = db.settings.signature;
                if (saveDataWithAudit('settings.signature_updated', 'system', 'signature', 'تم تحديث التوقيع الإلكتروني')) showToast('تم تحديث التوقيع بنجاح', 'success');
                else {
                    db.settings.signature = previousSignature;
                    document.getElementById('sig-preview-container').classList.toggle('hidden', !previousSignature);
                    document.getElementById('sig-preview').src = previousSignature || '';
                }
            }; 
            reader.readAsDataURL(file);
        }

        // حذف التوقيع الإلكتروني
        function removeSignature() {
            const previousSignature = db.settings.signature;
            db.settings.signature = null; 
            document.getElementById('sig-preview-container').classList.add('hidden'); 
            document.getElementById('sig-preview').src = ''; 
            document.getElementById('sig-upload').value = ''; 
            if (saveDataWithAudit('settings.signature_removed', 'system', 'signature', 'تمت إزالة التوقيع الإلكتروني')) showToast('تم إزالة التوقيع');
            else {
                db.settings.signature = previousSignature;
                document.getElementById('sig-preview-container').classList.toggle('hidden', !previousSignature);
                document.getElementById('sig-preview').src = previousSignature || '';
            }
        }

        // حفظ محامي أو عميل جديد
        function saveLawyer() {
            const name = document.getElementById('in-lawyer-name').value;
            if(!name) return showToast('يرجى إدخال اسم العميل/المحامي', 'error');
            
            const lawyer = { id: makeId(), name: name.trim() };
            db.lawyers.push(lawyer);
            rebuildEntityIndexes();
            if (!saveDataWithAudit('lawyer.created', 'lawyer', lawyer.id, `تمت إضافة العميل: ${lawyer.name}`)) {
                db.lawyers = db.lawyers.filter(item => String(item.id) !== String(lawyer.id));
                rebuildEntityIndexes();
                return;
            }
            closeModal('addLawyerModal'); 
            document.getElementById('in-lawyer-name').value = ''; 
            showToast('تمت إضافة العميل بنجاح', 'success');
        }

        // طلب حذف محامي مع التأكد من عدم ارتباطه بمعاملات
        function reqDeleteLawyer(id) {
            const companyIds = new Set(db.companies
                .filter(c => String(c.lawyerId) === String(id))
                .map(c => String(c.id)));
            const hasTransactions = getAllStoredTransactions().some(t =>
                String(t.lawyerId) === String(id) || companyIds.has(String(t.companyId))
            );
            if(hasTransactions) {
                return customAlert('تنبيه أمان', 'لا يمكن حذف عميل مرتبط بمعاملات سابقة أو جارية.', 'error');
            }
            const hasVaultDocuments = db.vault.some(doc => companyIds.has(String(doc.companyId)));
            if (hasVaultDocuments) {
                return customAlert('مستندات مرتبطة', 'لا يمكن حذف العميل لأن إحدى شركاته تحتوي مستندات في الخزنة. احذف المستندات أو انقلها أولاً.', 'error');
            }
            
            customConfirm('حذف العميل', 'هل أنت متأكد من حذف هذا العميل وشركاته المرتبطة؟', () => {
                const previousLawyers = db.lawyers;
                const previousCompanies = db.companies;
                const removedCompanyIds = db.companies.filter(c => String(c.lawyerId) === String(id)).map(c => String(c.id));
                const removedLawyer = db.lawyers.find(l => String(l.id) === String(id));
                db.lawyers = db.lawyers.filter(l => String(l.id) !== String(id)); 
                db.companies = db.companies.filter(c => String(c.lawyerId) !== String(id)); 
                if (!saveDataWithAudit(
                    'lawyer.deleted', 'lawyer', id,
                    `تم حذف العميل: ${removedLawyer?.name || id}`,
                    { removedCompanyIds }
                )) {
                    db.lawyers = previousLawyers;
                    db.companies = previousCompanies;
                    rebuildEntityIndexes();
                    return;
                }
                showToast('تم الحذف بنجاح', 'success');
            });
        }

        // حفظ شركة جديدة وربطها بمحامي/عميل
        function saveCompany() {
            const name = document.getElementById('in-comp-name').value; 
            const lawyerId = document.getElementById('in-comp-lawyer').value;
            
            if(!name || !lawyerId) return showToast('يرجى تعبئة كافة حقول الشركة', 'error');
            
            const lawyer = getLawyerById(lawyerId);
            if (!lawyer) return showToast('المحامي المختار غير موجود', 'error');
            const company = { id: makeId(), name: name.trim(), lawyerId: String(lawyer.id) };
            db.companies.push(company);
            rebuildEntityIndexes();
            if (!saveDataWithAudit(
                'company.created', 'company', company.id,
                `تمت إضافة الشركة: ${company.name}`,
                { lawyerId: company.lawyerId }
            )) {
                db.companies = db.companies.filter(item => String(item.id) !== String(company.id));
                rebuildEntityIndexes();
                return;
            }
            closeModal('addCompanyModal'); 
            document.getElementById('in-comp-name').value = ''; 
            document.getElementById('in-comp-lawyer').value = '';
            
            showToast('تمت إضافة الشركة', 'success');
        }

        // طلب حذف شركة والتأكد من أمان الحذف
        function reqDeleteCompany(id) {
            if(getAllStoredTransactions().some(t => String(t.companyId) === String(id))) {
                return customAlert('تنبيه أمان', 'لا يمكن حذف شركة لها سجل معاملات.', 'error');
            }
            
            customConfirm('حذف الشركة', 'سيتم حذف الشركة ومستندات خزينتها، هل تستمر؟', () => {
                const previousCompanies = db.companies;
                const previousVault = db.vault;
                const removedCompany = db.companies.find(c => String(c.id) === String(id));
                const removedVaultIds = db.vault.filter(v => String(v.companyId) === String(id)).map(v => String(v.id));
                db.companies = db.companies.filter(c => String(c.id) !== String(id)); 
                db.vault = db.vault.filter(v => String(v.companyId) !== String(id));
                if (!saveDataWithAudit(
                    'company.deleted', 'company', id,
                    `تم حذف الشركة: ${removedCompany?.name || id}`,
                    { removedVaultIds }
                )) {
                    db.companies = previousCompanies;
                    db.vault = previousVault;
                    rebuildEntityIndexes();
                    return;
                }
                showToast('تم حذف الشركة', 'success');
            });
        }

        // تحديث قائمة الشركات المنسدلة بناءً على المحامي المختار
        function updateCompanyDropdown() {
            const lIdStr = document.getElementById('new-tx-lawyer').value; 
            const compSelect = document.getElementById('new-tx-company');
            
            if(!lIdStr) { 
                compSelect.innerHTML = '<option value="">- أختر محامي أولاً -</option>'; 
            } else {
                const comps = db.companies.filter(c => String(c.lawyerId) === String(lIdStr));
                compSelect.innerHTML = '<option value="">- اختر الشركة -</option>' + 
                                       comps.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
            }
            
            compSelect.value = ""; 
            updateCustomSelectText('new-tx-company', '- اختر الشركة -');
        }

        // تحديث بطاقة مراجعة المعاملة الجديدة — عرض فقط ولا يغيّر البيانات.
        function refreshNewTxPreview() {
            const lawyerSelect = document.getElementById('new-tx-lawyer');
            const companySelect = document.getElementById('new-tx-company');
            const typeValue = String(document.getElementById('new-tx-type')?.value || '').trim();
            const feeValue = Number(document.getElementById('new-tx-fee')?.value || 0);
            const deptValue = document.querySelector('input[name="new-tx-dept"]:checked')?.value || '—';
            const lawyerText = lawyerSelect?.value ? lawyerSelect.options[lawyerSelect.selectedIndex]?.text : '—';
            const companyText = companySelect?.value ? companySelect.options[companySelect.selectedIndex]?.text : '—';
            const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
            setText('new-tx-preview-lawyer', lawyerText || '—');
            setText('new-tx-preview-company', companyText || '—');
            setText('new-tx-preview-dept', deptValue);
            setText('new-tx-preview-type', typeValue || 'لم يُحدد بعد');
            const feeEl = document.getElementById('new-tx-preview-fee');
            if (feeEl) feeEl.innerHTML = `${numFormat.format(Number.isFinite(feeValue) && feeValue > 0 ? feeValue : 0)} <small>د.ع</small>`;

            const complete = [lawyerSelect?.value, companySelect?.value, typeValue, feeValue > 0].filter(Boolean).length;
            const percent = Math.round((complete / 4) * 100);
            setText('new-tx-preview-progress', `${percent}%`);
            const bar = document.getElementById('new-tx-preview-progress-bar');
            if (bar) bar.style.width = `${percent}%`;
            const ready = document.getElementById('new-tx-preview-ready');
            if (ready) {
                const isReady = complete === 4;
                ready.classList.toggle('is-ready', isReady);
                ready.innerHTML = isReady
                    ? '<i class="fa-solid fa-circle-check"></i><span>القيد مكتمل وجاهز للإنشاء</span>'
                    : '<i class="fa-regular fa-circle"></i><span>أكمل الحقول المطلوبة لإنشاء القيد</span>';
            }
        }

        // إنشاء قيد معاملة جديد (العملية الأهم)
        function createNewTransaction() {
            const compId = document.getElementById('new-tx-company').value; 
            const lawyerId = document.getElementById('new-tx-lawyer').value;
            const type = document.getElementById('new-tx-type').value; 
            const fee = document.getElementById('new-tx-fee').value;
            const deptEl = document.querySelector('input[name="new-tx-dept"]:checked');
            const dept = deptEl?.value || '';
            
            if(!compId || !lawyerId || !type || !fee) {
                return customAlert('بيانات ناقصة', 'يرجى تعبئة كافة حقول المعاملة.', 'error');
            }

            const company = getCompanyById(compId);
            const lawyer = getLawyerById(lawyerId);
            const numericFee = Number(fee);
            if (!company || !lawyer) return customAlert('بيانات غير صالحة', 'الشركة أو المحامي المختار لم يعد موجوداً.', 'error');
            if (String(company.lawyerId) !== String(lawyer.id)) return customAlert('ارتباط غير صالح', 'الشركة المختارة لا تتبع للمحامي المحدد. أعد اختيار الجهة والشركة.', 'error');
            if (!Number.isFinite(numericFee) || numericFee <= 0) return customAlert('مبلغ غير صالح', 'يرجى إدخال أتعاب صحيحة أكبر من صفر.', 'error');

            const now = Date.now();
            const tx = {
                id: makeId(),
                companyId: company.id,
                lawyerId: lawyer.id,
                type: type.trim(),
                dept,
                fee: numericFee,
                paidAmount: 0,
                status: 'active',
                priority: 'normal',
                createdAt: now,
                lastUpdate: now,
                stations: [],
                notes: [],
                payments: [],
                followUps: [],
                activity: []
            };
            addActivity(tx, 'created', 'تم إنشاء المعاملة');
            db.transactions.push(tx);

            const saved = saveDataWithAudit(
                'transaction.created', 'transaction', tx.id,
                `تم إنشاء المعاملة: ${tx.type}`,
                { companyId: tx.companyId, lawyerId: tx.lawyerId, fee: tx.fee, department: tx.dept }
            );
            if (!saved) {
                db.transactions = db.transactions.filter(item => String(item.id) !== String(tx.id));
                return;
            }

            document.getElementById('new-tx-type').value = ''; 
            document.getElementById('new-tx-fee').value = ''; 
            document.getElementById('new-tx-company').value = '';
            document.getElementById('new-tx-lawyer').value = '';
            // UI/UX REBUILD 05: keep the creation studio visually in sync with
            // the Core reset above. This changes presentation state only.
            updateCustomSelectText('new-tx-lawyer', 'اختر جهة التعامل');
            updateCustomSelectText('new-tx-company', 'اختر المحامي أولاً');
            refreshNewTxPreview();

            switchTab('active');
            showToast('تم تأسيس القيد بنجاح', 'success');
        }

        // ==========================================
        // 6. الرسم البياني، البحث، والتحديث (Render & Search)
        // ==========================================

        let deptChartInstance = null;
        let statusChartInstance = null;
        let paymentsTrendChartInstance = null;

        // إعداد ورسم المخططات البيانية المتقدمة (الرئيسية والتحليلات)
        function initChart() {
            // 1. الرسم البياني للرئيسية
            const ctx = document.getElementById('performanceChart')?.getContext('2d');
            if(ctx && typeof Chart !== 'undefined') {
                if(chartInstance) chartInstance.destroy();
                // UI/UX REBUILD 02: performanceChart always sits on the deep Olive panel.
                // Keep its axes readable independently from the global light/dark preference.
                const textColor = '#d7dfd0';
                const gridColor = 'rgba(255,255,255,0.08)';

                const completedTxs = db.transactions.filter(t => t.status === 'completed');
                const dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
                const chartDays = [];
                const dataCounts = [];
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                for (let offset = 4; offset >= 0; offset--) {
                    const day = new Date(today);
                    day.setDate(today.getDate() - offset);
                    chartDays.push(day);
                    dataCounts.push(completedTxs.filter(t => {
                        const txDate = new Date(t.completedAt || t.lastUpdate || t.date || 0);
                        txDate.setHours(0, 0, 0, 0);
                        return txDate.getTime() === day.getTime();
                    }).length);
                }

                chartInstance = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: chartDays.map(day => dayNames[day.getDay()]),
                        datasets: [{
                            label: 'المعاملات المنجزة',
                            data: dataCounts, 
                            borderColor: '#eb6b18', 
                            backgroundColor: 'rgba(235, 107, 24, 0.12)',
                            borderWidth: 3, 
                            tension: 0.4, 
                            fill: true, 
                            pointBackgroundColor: '#4b5b3d'
                        }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                            y: { ticks: { color: textColor, stepSize: 1 }, grid: { color: gridColor } },
                            x: { ticks: { color: textColor }, grid: { display: false } }
                        }
                    }
                });
            }

            // 2. الرسوم البيانية لوواجهة التحليلات المتقدمة
            renderAnalyticsData();
        }

        // دالة حساب ورسم تحليلات الأداء المالي
        function renderAnalyticsData() {
            const completedTxs = db.transactions.filter(t => t.status === 'completed');
            const totalCompletedSum = completedTxs.reduce((acc, t) => acc + (Number(t.fee) || 0), 0);
            const allTxsCount = db.transactions.length;
            const feeTotal = db.transactions.reduce((acc, t) => acc + Math.max(0, Number(t.fee) || 0), 0);
            const avgFeeVal = allTxsCount > 0 ? Math.round(feeTotal / allTxsCount) : 0;

            const compSumEl = document.getElementById('analytics-completed-sum');
            const avgFeeEl = document.getElementById('analytics-avg-fee');
            if(compSumEl) compSumEl.textContent = `${numFormat.format(totalCompletedSum)} د.ع`;
            if(avgFeeEl) avgFeeEl.textContent = `${numFormat.format(avgFeeVal)} د.ع`;
            const totalCountEl = document.getElementById('analytics-total-count');
            if (totalCountEl) totalCountEl.textContent = allTxsCount;

            // V6.5: مؤشرات تشغيلية محسوبة من تواريخ الإنشاء والإنجاز الفعلية.
            const paidTotal = db.transactions.reduce((sum,t)=>sum+getPaidAmount(t),0);
            const remainingTotal = db.transactions.reduce((sum,t)=>sum+getRemainingAmount(t),0);
            const completedWithDates = completedTxs.filter(t => Number(t.createdAt) && Number(t.completedAt) && Number(t.completedAt) >= Number(t.createdAt));
            const avgDurationMs = completedWithDates.length ? completedWithDates.reduce((sum,t)=>sum+(Number(t.completedAt)-Number(t.createdAt)),0)/completedWithDates.length : 0;
            const avgDays = avgDurationMs ? Math.max(0, Math.round(avgDurationMs / 86400000)) : 0;
            const completionRate = db.transactions.length ? Math.round((completedTxs.length / db.transactions.length) * 100) : 0;
            const setMetric = (id, text) => { const el=document.getElementById(id); if(el) el.textContent=text; };
            setMetric('analytics-avg-duration', completedWithDates.length ? `${avgDays} يوم` : '—');
            setMetric('analytics-completion-rate', `${completionRate}%`);
            setMetric('analytics-paid-total', `${numFormat.format(paidTotal)} د.ع`);
            setMetric('analytics-remaining-total', `${numFormat.format(remainingTotal)} د.ع`);
            // UI/UX REBUILD 08 — presentation-only analytics metrics. Financial math still uses V6 helpers.
            const activeCount = db.transactions.filter(t => t.status === 'active').length;
            const stalledCount = db.transactions.filter(t => t.status === 'stalled').length;
            const completedCount = completedTxs.length;
            const collectionRate = feeTotal > 0 ? Math.min(100, Math.round((paidTotal / feeTotal) * 100)) : 0;
            setMetric('analytics-fee-total', `${numFormat.format(feeTotal)} د.ع`);
            setMetric('analytics-active-count', String(activeCount));
            setMetric('analytics-stalled-count', String(stalledCount));
            setMetric('analytics-completed-count', String(completedCount));
            setMetric('analytics-collection-rate', `${collectionRate}%`);
            const completionRing = document.getElementById('analytics-completion-ring');
            if (completionRing) completionRing.style.setProperty('--mq-progress', `${completionRate * 3.6}deg`);
            const collectionBar = document.getElementById('analytics-collection-bar');
            if (collectionBar) collectionBar.style.width = `${collectionRate}%`;

            const isDark = document.documentElement.classList.contains('dark');
            const textColor = isDark ? '#d9ded4' : '#6e7468';
            const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(65,76,55,0.08)';

            // أ. رسم دائرة / أعمدة مساهمة الدوائر الحكومية
            const deptCtx = document.getElementById('deptPerformanceChart')?.getContext('2d');
            if(deptCtx && typeof Chart !== 'undefined') {
                if(deptChartInstance) deptChartInstance.destroy();

                let deptTotals = {};
                db.transactions.forEach(t => {
                    let dName = t.dept || 'أخرى';
                    deptTotals[dName] = (deptTotals[dName] || 0) + Math.max(0, Number(t.fee) || 0);
                });

                deptChartInstance = new Chart(deptCtx, {
                    type: 'bar',
                    data: {
                        labels: Object.keys(deptTotals).length > 0 ? Object.keys(deptTotals) : ['مسجل الشركات', 'الاستيراد والتصدير'],
                        datasets: [{
                            label: 'إجمالي الأتعاب (د.ع)',
                            data: Object.keys(deptTotals).length > 0 ? Object.values(deptTotals) : [0, 0],
                            backgroundColor: ['#52623f', '#f47a1f', '#9aa770', '#d7a45b'],
                            borderRadius: 10
                        }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                            y: { ticks: { color: textColor }, grid: { color: gridColor } },
                            x: { ticks: { color: textColor }, grid: { display: false } }
                        }
                    }
                });
            }

            // ب. رسم توزيع حالات المعاملات (جارية، متلكئة، منجزة)
            const statusCtx = document.getElementById('statusDistributionChart')?.getContext('2d');
            if(statusCtx && typeof Chart !== 'undefined') {
                if(statusChartInstance) statusChartInstance.destroy();

                statusChartInstance = new Chart(statusCtx, {
                    type: 'doughnut',
                    data: {
                        labels: ['جارية', 'متلكئة', 'منجزة'],
                        datasets: [{
                            data: [activeCount, stalledCount, completedCount],
                            backgroundColor: ['#f47a1f', '#d65d55', '#65794d'],
                            borderWidth: 0
                        }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: {
                            legend: { position: 'bottom', labels: { color: textColor, font: { family: 'Cairo', weight: 'bold' } } }
                        }
                    }
                });
            }

            // V6.5: اتجاه التحصيل خلال آخر 6 أشهر. يعتمد على تاريخ كل دفعة فعلياً.
            const payCtx = document.getElementById('paymentsTrendChart')?.getContext('2d');
            if (payCtx && typeof Chart !== 'undefined') {
                if (paymentsTrendChartInstance) paymentsTrendChartInstance.destroy();
                const monthLabels = [];
                const monthValues = [];
                const now = new Date();
                for (let i = 5; i >= 0; i--) {
                    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                    monthLabels.push(d.toLocaleDateString('ar-IQ', { month:'short', year:'numeric' }));
                    const y=d.getFullYear(), m=d.getMonth();
                    let total=0;
                    db.transactions.forEach(tx => {
                        (tx.payments || []).forEach(pay => { const pd=new Date(Number(pay.date)||0); if(pay.status !== 'reversed' && pd.getFullYear()===y && pd.getMonth()===m) total += Number(pay.amount)||0; });
                    });
                    monthValues.push(total);
                }
                paymentsTrendChartInstance = new Chart(payCtx,{
                    type:'line',
                    data:{labels:monthLabels,datasets:[{label:'التحصيل (د.ع)',data:monthValues,tension:.35,fill:true,borderColor:'#f47a1f',backgroundColor:'rgba(244,122,31,.12)',pointBackgroundColor:'#52623f'}]},
                    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{color:textColor},grid:{color:gridColor}},x:{ticks:{color:textColor},grid:{display:false}}}}
                });
            }

            // ج. حساب قائمة العملاء الأعلى عائداً
            const topClientsContainer = document.getElementById('analytics-top-clients');
            if(topClientsContainer) {
                const companyRevenue = {};
                db.transactions.forEach(t => {
                    const key = String(t.companyId ?? '');
                    companyRevenue[key] = (companyRevenue[key] || 0) + Math.max(0, Number(t.fee) || 0);
                });

                const sortedCompanies = Object.keys(companyRevenue).sort((a,b) => companyRevenue[b] - companyRevenue[a]).slice(0, 3);

                if(sortedCompanies.length === 0) {
                    topClientsContainer.innerHTML = `<div class="mq-analytics-empty"><i class="fa-solid fa-chart-column"></i><strong>لا توجد بيانات كافية</strong><span>ستظهر الشركات الأعلى قيمة بعد تسجيل معاملات.</span></div>`;
                } else {
                    topClientsContainer.innerHTML = sortedCompanies.map((companyId, idx) => {
                        const companyObj = getCompanyById(companyId);
                        const rev = companyRevenue[companyId];
                        return `
                        <article class="mq-analytics-rank-row"><div class="mq-analytics-rank-pos"><small>#</small><strong>${idx+1}</strong></div><div class="mq-analytics-rank-copy"><span>شركة</span><strong>${escapeHtml(companyObj?.name || 'شركة غير معروفة')}</strong><small>${db.transactions.filter(t => String(t.companyId ?? '') === String(companyId)).length} معاملات</small></div><div class="mq-analytics-rank-value"><span>إجمالي الأتعاب</span><strong>${numFormat.format(rev)}</strong><small>د.ع</small></div></article>`;
                    }).join('');
                }
            }
        }


        // ==========================================================
        // V6.10 / FULL REDESIGN 05 — GLOBAL SEARCH
        // ==========================================================
        // حدود المسؤولية:
        // - لا نعدل db داخل البحث.
        // - الفلاتر تعمل على نسخة نتائج مشتقة فقط.
        // - جميع النصوص التي تدخل HTML تمر عبر escapeHtml/jsArg.
        // - التأخير 120ms محفوظ من V6.10 لتقليل إعادة الرسم أثناء الكتابة.
        // ==========================================================
        let globalSearchTimer = null;

        const GLOBAL_SEARCH_TEXT_FIELDS = [
            'global-search-query',
            'global-search-dept',
            'global-search-date-from',
            'global-search-date-to'
        ];

        const GLOBAL_SEARCH_SELECT_FIELDS = [
            'global-search-status',
            'global-search-priority',
            'global-search-payment',
            'global-search-company',
            'global-search-lawyer'
        ];

        // تعبئة فلاتر الكيانات من الفهارس الحالية دون لمس بيانات المعاملات.
        function populateGlobalSearchEntityFilters() {
            rebuildEntityIndexes();
            const companySelect = document.getElementById('global-search-company');
            const lawyerSelect = document.getElementById('global-search-lawyer');

            if (companySelect) {
                companySelect.innerHTML = '<option value="">كل الشركات</option>' +
                    db.companies.map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)}</option>`).join('');
            }
            if (lawyerSelect) {
                lawyerSelect.innerHTML = '<option value="">كل المحامين</option>' +
                    db.lawyers.map(l => `<option value="${escapeAttr(l.id)}">${escapeHtml(l.name)}</option>`).join('');
            }
        }

        function resetGlobalSearchControls() {
            GLOBAL_SEARCH_TEXT_FIELDS.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            GLOBAL_SEARCH_SELECT_FIELDS.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
        }

        function openGlobalSearch() {
            populateGlobalSearchEntityFilters();
            resetGlobalSearchControls();
            renderGlobalSearchResults();
            openModal('globalSearchModal');
            setTimeout(() => document.getElementById('global-search-query')?.focus(), 120);
        }

        function clearGlobalSearch() {
            resetGlobalSearchControls();
            renderGlobalSearchResults();
            document.getElementById('global-search-query')?.focus();
        }

        function scheduleGlobalSearch() {
            clearTimeout(globalSearchTimer);
            globalSearchTimer = setTimeout(renderGlobalSearchResults, 120);
        }

        // بطاقة نتيجة واحدة. فصل القالب هنا يجعل دالة الفلترة قابلة للتدقيق بسهولة.
        function renderGlobalSearchResultCard(tx) {
            const statusMeta = {
                active: { label: 'جارية', className: 'is-active' },
                stalled: { label: 'متلكئة', className: 'is-stalled' },
                completed: { label: 'منجزة', className: 'is-completed' }
            }[tx.status] || { label: 'جارية', className: 'is-active' };

            const nextFollowUp = getNextFollowUp(tx);
            const remaining = getRemainingAmount(tx);
            const paid = getPaidAmount(tx);
            const fee = Math.max(0, Number(tx.fee) || 0);
            const paidRatio = fee > 0 ? Math.min(100, Math.round((paid / fee) * 100)) : 0;

            return `
                <button class="mq-search-result ${statusMeta.className}" onclick="closeModal('globalSearchModal'); openTxDetails(${jsArg(tx.id)})">
                    <div class="mq-search-result-status"><i></i><span>${statusMeta.label}</span></div>
                    <div class="mq-search-result-copy">
                        <span>${escapeHtml(companyName(tx.companyId))}</span>
                        <h4>${escapeHtml(tx.type)}</h4>
                        <p><i class="fa-solid fa-user-tie"></i>${escapeHtml(lawyerName(tx.lawyerId))}<b>·</b><i class="fa-regular fa-building"></i>${escapeHtml(tx.dept || 'بدون دائرة')}</p>
                    </div>
                    <div class="mq-search-result-money">
                        <span>المتبقي</span>
                        <strong>${numFormat.format(remaining)} <small>د.ع</small></strong>
                        <div><i style="width:${paidRatio}%"></i></div>
                    </div>
                    <div class="mq-search-result-foot">
                        <span><i class="fa-regular fa-clock"></i>${escapeHtml(formatShortDate(tx.lastUpdate))}</span>
                        ${nextFollowUp ? `<span class="is-followup"><i class="fa-regular fa-calendar"></i>متابعة ${escapeHtml(formatShortDate(nextFollowUp.dueAt))}</span>` : '<span>لا توجد متابعة قادمة</span>'}
                        <i class="fa-solid fa-chevron-left"></i>
                    </div>
                </button>`;
        }

        function renderGlobalSearchResults() {
            rebuildEntityIndexes();

            const query = String(document.getElementById('global-search-query')?.value || '').trim().toLocaleLowerCase('ar-IQ');
            const status = document.getElementById('global-search-status')?.value || '';
            const priority = document.getElementById('global-search-priority')?.value || '';
            const payment = document.getElementById('global-search-payment')?.value || '';
            const companyId = document.getElementById('global-search-company')?.value || '';
            const lawyerId = document.getElementById('global-search-lawyer')?.value || '';
            const department = String(document.getElementById('global-search-dept')?.value || '').trim().toLocaleLowerCase('ar-IQ');
            const from = document.getElementById('global-search-date-from')?.value || '';
            const to = document.getElementById('global-search-date-to')?.value || '';

            const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
            const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;

            const results = db.transactions.filter(tx => {
                if (status && tx.status !== status) return false;
                if (priority && tx.priority !== priority) return false;
                if (companyId && String(tx.companyId) !== String(companyId)) return false;
                if (lawyerId && String(tx.lawyerId) !== String(lawyerId)) return false;
                if (department && !String(tx.dept || '').toLocaleLowerCase('ar-IQ').includes(department)) return false;
                if (fromTs !== null && Number(tx.createdAt) < fromTs) return false;
                if (toTs !== null && Number(tx.createdAt) > toTs) return false;

                if (payment === 'unpaid' && getRemainingAmount(tx) <= 0) return false;
                if (payment === 'partial' && !(getPaidAmount(tx) > 0 && getRemainingAmount(tx) > 0)) return false;
                if (payment === 'paid' && getRemainingAmount(tx) > 0) return false;

                if (query) {
                    const searchableText = [
                        tx.id, tx.type, tx.dept,
                        companyName(tx.companyId), lawyerName(tx.lawyerId),
                        ...(tx.stations || []).map(item => item.name),
                        ...(tx.notes || []).map(item => item.text),
                        ...(tx.followUps || []).map(item => item.title),
                        ...(tx.activity || []).map(item => item.text)
                    ].filter(value => value != null).join(' ').toLocaleLowerCase('ar-IQ');
                    if (!searchableText.includes(query)) return false;
                }

                return true;
            }).sort((a, b) => Number(b.lastUpdate) - Number(a.lastUpdate));

            const count = document.getElementById('global-search-count');
            const container = document.getElementById('global-search-results');
            if (count) count.textContent = `${results.length} نتيجة`;
            if (!container) return;

            container.innerHTML = results.length
                ? results.map(renderGlobalSearchResultCard).join('')
                : `<div class="mq-empty-state is-search"><i class="fa-solid fa-magnifying-glass"></i><strong>لا توجد نتائج مطابقة</strong><span>غيّر عبارة البحث أو خفف أحد الفلاتر.</span></div>`;
        }

        // UI/UX REBUILD 03 — بحث مركز المعاملات فقط.
        // الاسم محفوظ كعقد للـHTML، أما واجهة stalled القديمة فقد أزيلت نهائياً.
        function filterTransactions(status = 'active') {
            if (status !== 'active') return;
            renderTransactionsHub();
        }

        // الدالة الأساسية التي تقوم بتحديث الواجهة بالكامل وقراءة البيانات
        function renderAll() {
            // تحديث القوائم المنسدلة للعملاء
            const lOpts = '<option value="">- اختر العميل/المحامي -</option>' + 
                          db.lawyers.map(l => `<option value="${escapeAttr(l.id)}">${escapeHtml(l.name)}</option>`).join('');
            
            ['new-tx-lawyer', 'in-comp-lawyer'].forEach(id => {
                const el = document.getElementById(id); 
                const prev = el.value; 
                el.innerHTML = lOpts; 
                el.value = prev; 
                updateCustomSelectText(id);
            });
            
            updateCompanyDropdown(); 
            updateVaultDropdown();

            // حساب أرقام وإحصائيات لوحة التحكم (الرئيسية)
            const activeTxs = db.transactions.filter(t => t.status === 'active');
            const stalledTxs = db.transactions.filter(t => t.status === 'stalled');

            document.getElementById('home-weekly-profit').innerText = numFormat.format(activeTxs.reduce((sum, t) => sum + t.fee, 0));
            document.getElementById('home-lawyers-count').innerText = db.lawyers.length; 
            document.getElementById('home-companies-count').innerText = db.companies.length;
            document.getElementById('home-active-count').innerText = activeTxs.length; 
            document.getElementById('home-stalled-count').innerText = stalledTxs.length;
            
            // شارة التنبيه الحمراء لشريط التنقل
            const openTxCount = activeTxs.length + stalledTxs.length;
            document.getElementById('badge-active').innerText = openTxCount;
            document.getElementById('badge-active').style.display = openTxCount > 0 ? 'flex' : 'none';

            document.getElementById('badge-stalled').innerText = stalledTxs.length;
            document.getElementById('badge-stalled').style.display = stalledTxs.length > 0 ? 'flex' : 'none';


            // FULL REDESIGN 04: دليل الكيانات يعاد رسمه كطبقة عرض فقط.
            renderSettingsEntities();
            renderGovernancePanel();

            // UI/UX REBUILD 03: مركز المعاملات هو العرض الوحيد؛ لا توجد قائمة stalled مخفية بعد الآن.
            renderTransactionsHub();
            
            renderArchive(); 
            renderAccounting();
            
            if(document.getElementById('archive-vault-content').style.display === 'block') {
                renderVault();
            }
            
            initChart();
            renderV6Dashboard();
        }

        // UI/UX REBUILD 03 — بطاقة ملف معاملة جديدة بالكامل.
        // صيانة: هذه دالة Presentation فقط. الحسابات تمر حصراً عبر getPaidAmount/getRemainingAmount.
        function renderTxList(containerId, txs, emptyMsg) {
            const container = document.getElementById(containerId);
            if (!container) return;
            const rows = Array.isArray(txs) ? txs.slice().sort((a,b)=> Number(b.lastUpdate) - Number(a.lastUpdate)) : [];
            if(rows.length === 0) {
                container.innerHTML = `<div class="mq-cases-empty mq-enter"><div class="mq-cases-empty-mark"><i class="fa-regular fa-folder-open"></i></div><span>لا توجد ملفات هنا</span><h3>${escapeHtml(emptyMsg)}</h3><p>غيّر الحالة أو البحث، أو أنشئ معاملة جديدة لبدء العمل.</p><button onclick="switchTab('newTx')"><i class="fa-solid fa-plus"></i> تأسيس معاملة</button></div>`;
                return;
            }

            container.innerHTML = rows.map((tx, index) => {
                const comp = companyName(tx.companyId) || 'غير معروف';
                const lawyer = lawyerName(tx.lawyerId) || 'غير مسجل';
                const status = ['active','stalled','completed'].includes(tx.status) ? tx.status : 'active';
                const isStagnant = (Date.now() - Number(tx.lastUpdate)) > (48 * 60 * 60 * 1000) && status === 'active';
                const statusMap = {
                    active: { label:'جارية', icon:'fa-bolt' },
                    stalled: { label:'متلكئة', icon:'fa-triangle-exclamation' },
                    completed: { label:'منجزة', icon:'fa-check' }
                };
                const priorityMap = { urgent:'عاجلة', high:'مهمة', normal:'عادية' };
                const priority = ['urgent','high','normal'].includes(tx.priority) ? tx.priority : 'normal';
                const lastStation = tx.stations?.length ? tx.stations[tx.stations.length - 1].name : (tx.dept || 'لم يبدأ المسار');
                const fee = Math.max(0, Number(tx.fee) || 0);
                const paid = getPaidAmount(tx);
                const remaining = getRemainingAmount(tx);
                const collection = fee > 0 ? Math.max(0, Math.min(100, Math.round((paid / fee) * 100))) : 0;
                const next = getNextFollowUp(tx);
                const due = next ? new Date(next.dueAt) : null;
                const overdue = !!(due && !next.done && due < new Date());
                const followLabel = next ? (overdue ? 'متابعة متأخرة' : `المتابعة ${formatShortDate(next.dueAt)}`) : 'لا توجد متابعة قادمة';
                const updatedLabel = tx.lastUpdate ? formatShortDate(tx.lastUpdate) : '—';
                const state = statusMap[status];
                return `
                <article onclick="openTxDetails(${jsArg(tx.id)})" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ') openTxDetails(${jsArg(tx.id)})" class="mq-case-card is-${escapeAttr(status)} ${isStagnant ? 'is-stagnant' : ''} mq-enter" style="animation-delay:${Math.min(index,10) * .03}s">
                    <span class="mq-case-rail" aria-hidden="true"></span>
                    <header class="mq-case-head">
                        <div class="mq-case-badges">
                            <span class="mq-case-status"><i class="fa-solid ${state.icon}"></i>${state.label}${isStagnant ? ' · بلا تحديث' : ''}</span>
                            <span class="mq-case-priority is-${escapeAttr(priority)}">${priorityMap[priority]}</span>
                        </div>
                        <span class="mq-case-open"><i class="fa-solid fa-arrow-left"></i></span>
                    </header>

                    <div class="mq-case-primary">
                        <div class="mq-case-title"><span><i class="fa-regular fa-building"></i>${escapeHtml(comp)}</span><h3>${escapeHtml(tx.type || 'معاملة بدون عنوان')}</h3></div>
                        <div class="mq-case-balance"><span>المتبقي</span><strong>${numFormat.format(remaining)}</strong><small>د.ع</small></div>
                    </div>

                    <div class="mq-case-context">
                        <div><i class="fa-solid fa-user-tie"></i><span>المحامي</span><strong>${escapeHtml(lawyer)}</strong></div>
                        <div><i class="fa-solid fa-location-dot"></i><span>المحطة الحالية</span><strong>${escapeHtml(lastStation)}</strong></div>
                    </div>

                    <div class="mq-case-progress">
                        <div class="mq-case-progress-head"><span>تحصيل الأتعاب</span><b>${collection}%</b></div>
                        <div class="mq-case-progress-track"><span style="width:${collection}%"></span></div>
                        <div class="mq-case-progress-money"><span>مدفوع <b>${numFormat.format(paid)}</b></span><span>أتعاب <b>${numFormat.format(fee)}</b></span></div>
                    </div>

                    <footer class="mq-case-foot">
                        <span class="mq-case-follow ${overdue ? 'is-overdue' : ''}"><i class="fa-regular fa-calendar-check"></i>${escapeHtml(followLabel)}</span>
                        <span class="mq-case-updated"><i class="fa-regular fa-clock"></i>آخر تحديث ${escapeHtml(updatedLabel)}</span>
                    </footer>
                </article>`;
            }).join('');
        }

        // ==========================================
        // 7. منطق خزنة المستندات (الرفع والضغط والعرض)
        // ==========================================

        // تحديث القائمة المنسدلة للشركات في قسم الخزنة
        function updateVaultDropdown() {
            const select = document.getElementById('vault-company-select'); 
            const prevVal = select.value;
            
            select.innerHTML = `<option value="">- اختر الشركة -</option>` + 
                               db.companies.map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)}</option>`).join('');
                               
            select.value = prevVal; 
            updateCustomSelectText('vault-company-select', '- اختر الشركة -');
        }

        // UI/UX REBUILD 07: Vault renderer — presentation rebuilt; Base64 storage rules stay unchanged.
        function renderVault() {
            const compId = document.getElementById('vault-company-select').value;
            const btnUpload = document.getElementById('btn-vault-upload');
            const gallery = document.getElementById('vault-gallery');
            const summary = document.getElementById('vault-company-summary');
            const caption = document.getElementById('vault-doc-caption');
            const count = document.getElementById('vault-doc-count');
            const totalCount = document.getElementById('records-doc-count');
            if (totalCount) totalCount.textContent = db.vault.length;

            if(!compId) {
                btnUpload.classList.add('hidden');
                if (summary) summary.textContent = 'حدد شركة لفتح خزينتها الرقمية.';
                if (caption) caption.textContent = 'لا توجد شركة محددة';
                if (count) count.textContent = '0';
                gallery.innerHTML = `<div class="mq-records-empty is-vault"><span><i class="fa-solid fa-building-lock"></i></span><h3>الخزنة بانتظار شركة</h3><p>اختر الشركة أولًا، وسنفتح مكتبة مستنداتها المحفوظة هنا.</p></div>`;
                return;
            }

            btnUpload.classList.remove('hidden');
            const company = getCompanyById(compId);
            const companyDocs = db.vault.filter(v => String(v.companyId) === String(compId)).sort((a,b) => Number(b.date) - Number(a.date));
            if (summary) summary.textContent = company?.name ? `الخزنة الرقمية لشركة ${company.name}` : 'خزنة الشركة المحددة';
            if (caption) caption.textContent = company?.name || 'الشركة المحددة';
            if (count) count.textContent = companyDocs.length;

            if(companyDocs.length === 0) {
                gallery.innerHTML = `<div class="mq-records-empty is-vault"><span><i class="fa-regular fa-images"></i></span><h3>لا توجد مستندات بعد</h3><p>استخدم «إيداع مستند جديد» لإضافة أول وثيقة لهذه الشركة.</p></div>`;
                return;
            }

            gallery.innerHTML = companyDocs.map((doc, index) => `
                <article class="mq-vault-file mq-enter" style="animation-delay:${index*.03}s">
                    <button class="mq-vault-preview" onclick="openVaultLightbox(${jsArg(doc.id)})" aria-label="فتح المستند"><img src="${escapeAttr(doc.data)}" alt="مستند محفوظ" loading="lazy"><span><i class="fa-solid fa-expand"></i></span><small>DOCUMENT ${String(index + 1).padStart(2,'0')}</small></button>
                    <div class="mq-vault-file-meta"><div><span>محفوظ في الخزنة</span><strong>${formatShortDate(doc.date)}</strong></div><button onclick="reqDeleteVaultItem(${jsArg(doc.id)})" aria-label="حذف المستند"><i class="fa-solid fa-trash-can"></i></button></div>
                </article>`).join('');
        }

        // رفع صورة للخزنة مع تصغير حجمها (Compression) لتوفير الذاكرة
        function handleVaultUpload(event) {
            const compId = document.getElementById('vault-company-select').value; 
            const file = event.target.files[0]; 
            if(!file || !compId) return;
            const company = getCompanyById(compId);
            if (!company) return showToast('الشركة المحددة لم تعد موجودة', 'error');
            if (!String(file.type || '').startsWith('image/')) return showToast('الخزنة تقبل ملفات الصور فقط في هذا الإصدار', 'error');
            if (Number(file.size) > 12 * 1024 * 1024) return showToast('حجم الصورة كبير جداً. الحد الأقصى 12MB.', 'error');
            
            const reader = new FileReader();
            reader.onload = function(e) {
                const img = new Image(); 
                img.onload = function() {
                    const canvas = document.createElement('canvas'); 
                    
                    // Image Compression to save localStorage space (ضغط الصورة)
                    const MAX_WIDTH = 1000; 
                    const MAX_HEIGHT = 1000; 
                    let width = img.width; 
                    let height = img.height;
                    
                    if (width > height) { 
                        if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; } 
                    } else { 
                        if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; } 
                    }
                    
                    canvas.width = width; 
                    canvas.height = height; 
                    const ctx = canvas.getContext('2d'); 
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.7); 
                    
                    const vaultItem = {
                        id: makeId(),
                        companyId: String(company.id),
                        data: dataUrl,
                        date: Date.now(),
                        name: String(file.name || 'مستند'),
                        mimeType: 'image/jpeg',
                        originalSize: Number(file.size) || 0
                    };
                    db.vault.push(vaultItem);
                    const saved = saveDataWithAudit(
                        'vault.created', 'vault', vaultItem.id,
                        `تم حفظ مستند في خزنة: ${company.name}`,
                        { companyId: company.id, originalName: vaultItem.name, originalSize: vaultItem.originalSize }
                    ); 
                    if (!saved) db.vault = db.vault.filter(doc => String(doc.id) !== String(vaultItem.id));
                    document.getElementById('vault-file-upload').value = ''; 
                    renderVault(); 
                    if (saved) showToast('تم الحفظ في الخزنة', 'success');
                }; 
                img.onerror = function() {
                    showToast('تعذرت قراءة الصورة المحددة', 'error');
                };
                img.src = e.target.result;
            }; 
            reader.onerror = function() {
                showToast('تعذرت قراءة الملف المحدد', 'error');
            };
            reader.readAsDataURL(file);
        }

        // طلب حذف صورة من الخزنة
        function reqDeleteVaultItem(id) { 
            customConfirm('حذف الصورة', 'حذف هذه الصورة من الخزنة لا يمكن التراجع عنه.', () => { 
                const previousVault = db.vault;
                const removed = db.vault.find(v => String(v.id) === String(id));
                db.vault = db.vault.filter(v => String(v.id) !== String(id)); 
                if (!saveDataWithAudit(
                    'vault.deleted', 'vault', id,
                    'تم حذف مستند من الخزنة',
                    { companyId: removed?.companyId || '', originalName: removed?.name || '' }
                )) db.vault = previousVault;
                renderVault(); 
            }); 
        }

        // UI/UX REBUILD 07: فتح معاينة الخزنة داخل Lightbox الجديدة.
        function openLightbox(src) {
            const image = document.getElementById('lightboxImage');
            const modal = document.getElementById('lightboxModal');
            image.src = src;
            image.classList.remove('is-ready');
            modal.style.display = 'flex';
            requestAnimationFrame(() => {
                modal.classList.add('is-visible');
                image.classList.add('is-ready');
            });
        }

        // فتح مستند الخزنة بواسطة المعرّف بدلاً من تمرير Base64 داخل onclick.
        function openVaultLightbox(id) {
            const doc = db.vault.find(v => String(v.id) === String(id));
            if (doc?.data) openLightbox(doc.data);
        }
        
        function closeLightbox() {
            const modal = document.getElementById('lightboxModal');
            document.getElementById('lightboxImage').classList.remove('is-ready');
            modal.classList.remove('is-visible');
            setTimeout(() => modal.style.display = 'none', 220);
        }

        // ==========================================
        // 8. منطق تفاصيل المعاملة وإضافة المحطات
        // ==========================================

        // فتح النافذة المنبثقة لتفاصيل معاملة محددة
        function openTxDetails(id) {
            currentTxId = id;
            const tx = getTransaction(id);
            if (!tx) return showToast('تعذر العثور على المعاملة', 'error');

            document.getElementById('det-fee').innerText = numFormat.format(tx.fee) + ' د.ع';
            document.getElementById('det-type').innerText = tx.type;
            document.getElementById('det-comp').innerText = companyName(tx.companyId) || 'غير مسجلة';
            document.getElementById('det-lawyer').innerText = lawyerName(tx.lawyerId) || 'غير مسجل';
            document.getElementById('det-dept').innerText = tx.dept || 'غير محددة';

            const badge = document.getElementById('det-status-badge');
            badge.innerText = tx.status === 'active' ? 'قيد العمل' : (tx.status === 'stalled' ? 'متلكئة' : 'منجزة');
            badge.className = `mq-case-status status-${tx.status}`;

            const priorityEl = document.getElementById('det-priority');
            if (priorityEl) {
                const map = { normal: 'عادية', high: 'مهمة', urgent: 'عاجلة' };
                priorityEl.innerText = map[tx.priority] || map.normal;
                priorityEl.className = `mq-case-priority priority-${tx.priority || 'normal'}`;
            }

            const paid = getPaidAmount(tx);
            const remaining = getRemainingAmount(tx);
            const paidEl = document.getElementById('det-paid');
            const remainingEl = document.getElementById('det-remaining');
            if (paidEl) paidEl.innerText = numFormat.format(paid) + ' د.ع';
            if (remainingEl) remainingEl.innerText = numFormat.format(remaining) + ' د.ع';

            const next = getNextFollowUp(tx);
            const followText = next ? `${formatShortDate(next.dueAt)} — ${next.title}` : 'لا توجد متابعة مجدولة';
            const followEl = document.getElementById('det-next-followup');
            const followOverview = document.getElementById('det-next-followup-overview');
            if (followEl) followEl.innerText = followText;
            if (followOverview) followOverview.innerText = followText;

            const lastUpdateEl = document.getElementById('det-last-update');
            if (lastUpdateEl) lastUpdateEl.innerText = formatShortDate(tx.lastUpdate);

            const btnStall = document.getElementById('btn-toggle-stall');
            if (btnStall) {
                const stallTitle = document.getElementById('btn-toggle-stall-title');
                const stallSubtitle = document.getElementById('btn-toggle-stall-subtitle');
                const stallIcon = document.querySelector('#btn-toggle-stall-icon i');
                const isStalled = tx.status === 'stalled';
                btnStall.classList.toggle('hidden', tx.status === 'completed');
                btnStall.className = isStalled ? 'is-reactivate' : 'is-stall';
                if (tx.status === 'completed') btnStall.classList.add('hidden');
                if (stallTitle) stallTitle.textContent = isStalled ? 'تفعيل المعاملة' : 'إيقاف مؤقت';
                if (stallSubtitle) stallSubtitle.textContent = isStalled ? 'إلغاء التلكؤ والعودة للعمل' : 'نقل المعاملة إلى حالة التلكؤ';
                if (stallIcon) stallIcon.className = isStalled ? 'fa-solid fa-rotate-left' : 'fa-solid fa-pause';
            }
            const btnComplete = document.getElementById('btn-mark-completed');
            if (btnComplete) btnComplete.classList.toggle('hidden', tx.status === 'completed');
            const btnReopen = document.getElementById('btn-reopen-transaction');
            if (btnReopen) btnReopen.classList.toggle('hidden', tx.status !== 'completed');

            renderTxStations(tx);
            renderTxWorkspaceSections(tx);
            navigateTxWorkspace('overview', false);
            closeTxActionSheet();
            openModal('txDetailsModal');
        }

        function renderTxStations(tx) {
            const statContainer = document.getElementById('det-stations');
            if (!statContainer) return;
            if ((tx.stations || []).length === 0) {
                statContainer.innerHTML = `<div class="mq-case-route-empty"><div><i class="fa-solid fa-route"></i></div><strong>لم يبدأ المسار بعد</strong><span>أضف أول محطة لتوثيق حركة المعاملة داخل الدوائر.</span><button onclick="openModal('addStationModal')"><i class="fa-solid fa-plus"></i> إضافة أول محطة</button></div>`;
                return;
            }
            statContainer.innerHTML = [...tx.stations].reverse().map((station, index) => `
                <article class="mq-case-route-step ${index === 0 ? 'is-current' : ''} mq-enter" style="animation-delay:${index * 0.04}s">
                    <div class="mq-case-route-index"><span>${tx.stations.length - index}</span></div>
                    <div class="mq-case-route-card">
                        <header><h5>${escapeHtml(station.name)}</h5>${index === 0 ? '<b>المحطة الحالية</b>' : ''}</header>
                        ${station.user ? `<p><i class="fa-regular fa-user"></i><span>${escapeHtml(station.user)}</span></p>` : ''}
                        <time><i class="fa-regular fa-clock"></i>${formatDate(station.date)}</time>
                    </div>
                </article>`).join('');
        }

        function getTransactionTimeline(tx) {
            const items = [];
            const seen = new Set();
            const add = (item, key) => {
                const id = key || item?.id;
                if (id && seen.has(String(id))) return;
                if (id) seen.add(String(id));
                items.push(item);
            };
            const activity = Array.isArray(tx.activity) ? tx.activity : [];
            activity.forEach(a => add(a, `activity:${a.id || `${a.date}:${a.text}`}`));
            const hasActivityFor = (type, sourceId, date) => activity.some(a => {
                if (String(a.type || '') !== String(type || '')) return false;
                const activitySourceId = a.sourceId ?? a.followUpId;
                if (sourceId !== null && sourceId !== undefined && activitySourceId !== null && activitySourceId !== undefined) {
                    return String(activitySourceId) === String(sourceId);
                }
                const activityDate = Number(a.date);
                const sourceDate = Number(date);
                return Number.isFinite(activityDate) && Number.isFinite(sourceDate) && Math.abs(activityDate - sourceDate) <= 5000;
            });
            const addLegacy = (type, source, item, key) => {
                if (hasActivityFor(type, source?.id, item.date)) return;
                add(item, key);
            };
            // Legacy compatibility: V5 records may have stations/notes/payments/followUps
            // without a corresponding activity entry. Add only those missing from the activity log.
            (tx.stations || []).forEach(s => addLegacy('station', s, { date:s.date, type:'station', sourceId:s.id, text:`وصلت المعاملة إلى: ${s.name}` }, `station:${s.id || `${s.date}:${s.name}`}`));
            (tx.notes || []).forEach(n => {
                const text = typeof n === 'string' ? n : n.text;
                addLegacy('note', n, { date:n.date, type:'note', sourceId:n.id, text:`تمت إضافة ملاحظة: ${text}` }, `note:${n.id || `${n.date}:${text}`}`);
            });
            (tx.payments || []).forEach(p => addLegacy('payment', p, {
                date:p.date, type:'payment', sourceId:p.id,
                text:p.status === 'reversed'
                    ? `دفعة معكوسة بقيمة ${numFormat.format(Number(p.amount)||0)} د.ع — ${p.reversalReason || 'عكس مسجل'}`
                    : `تم تسجيل دفعة بقيمة ${numFormat.format(Number(p.amount)||0)} د.ع`
            }, `payment:${p.id || `${p.date}:${p.amount}`}`));
            (tx.followUps || []).forEach(f => addLegacy('followup', f, { date:f.createdAt || f.dueAt, type:'followup', sourceId:f.id, text:`تمت جدولة متابعة: ${f.title}` }, `followup:${f.id || `${f.createdAt}:${f.title}`}`));
            return items.sort((a,b) => Number(b.date) - Number(a.date));
        }

        function renderTxWorkspaceSections(tx) {
            const notes = document.getElementById('det-notes-list');
            const followups = document.getElementById('det-followups-list');
            const payments = document.getElementById('det-payments-list');
            const timeline = document.getElementById('det-timeline-list');

            const counts = {
                'det-stations-count': (tx.stations || []).length,
                'det-notes-count': (tx.notes || []).length,
                'det-followups-count': (tx.followUps || []).length,
                'det-payments-count': (tx.payments || []).length
            };
            Object.entries(counts).forEach(([id, value]) => { const el = document.getElementById(id); if (el) el.textContent = value; });
            const followSectionCount = document.getElementById('tx-followup-section-count');
            if (followSectionCount) followSectionCount.textContent = `${(tx.followUps || []).filter(f => !f.done).length} مفتوحة`;

            const next = getNextFollowUp(tx);
            const nextText = next ? `${formatShortDate(next.dueAt)} — ${next.title}` : 'لا توجد متابعة مجدولة';
            const nextCompact = document.getElementById('det-next-followup');
            const nextOverview = document.getElementById('det-next-followup-overview');
            if (nextCompact) nextCompact.textContent = next ? 'متابعة مسجلة' : 'لا توجد متابعة مجدولة';
            if (nextOverview) nextOverview.textContent = nextText;
            const paidNow = document.getElementById('det-paid');
            const remainingNow = document.getElementById('det-remaining');
            if (paidNow) paidNow.textContent = `${numFormat.format(getPaidAmount(tx))} د.ع`;
            if (remainingNow) remainingNow.textContent = `${numFormat.format(getRemainingAmount(tx))} د.ع`;
            const lastUpdateNow = document.getElementById('det-last-update');
            if (lastUpdateNow) lastUpdateNow.textContent = formatShortDate(tx.lastUpdate);

            if (notes) notes.innerHTML = (tx.notes || []).slice().reverse().map(n => `
                <article class="mq-case-note-card">
                    <div class="mq-case-note-icon"><i class="fa-solid fa-note-sticky"></i></div>
                    <div><p>${escapeHtml(n.text)}</p><time>${formatDate(n.date)}</time></div>
                </article>`).join('') || `<div class="mq-case-empty"><i class="fa-regular fa-note-sticky"></i><span>لا توجد ملاحظات بعد</span></div>`;

            if (followups) followups.innerHTML = (tx.followUps || []).slice().sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt)).map(f => {
                const overdue = !f.done && new Date(f.dueAt) < new Date();
                return `<article class="mq-case-follow-card ${f.done ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}">
                    <button onclick="toggleFollowUp(${jsArg(tx.id)},${jsArg(f.id)})" aria-label="${f.done ? 'إعادة فتح المتابعة' : 'إنجاز المتابعة'}"><i class="fa-solid ${f.done ? 'fa-check' : 'fa-clock'}"></i></button>
                    <div><p>${escapeHtml(f.title)}</p><time>${formatShortDate(f.dueAt)}${overdue ? ' — متأخرة' : ''}</time></div>
                    <span>${f.done ? 'منجزة' : overdue ? 'متأخرة' : 'مفتوحة'}</span>
                </article>`;
            }).join('') || `<div class="mq-case-empty"><i class="fa-regular fa-calendar-check"></i><span>لا توجد متابعات</span></div>`;

            if (payments) payments.innerHTML = (tx.payments || []).slice().reverse().map(p => {
                const reversed = p.status === 'reversed';
                return `<article class="mq-case-payment-card ${reversed ? 'is-reversed' : ''}">
                    <div class="mq-case-payment-icon"><i class="fa-solid ${reversed ? 'fa-arrow-rotate-left' : 'fa-arrow-trend-up'}"></i></div>
                    <div><strong>${numFormat.format(Number(p.amount)||0)} د.ع</strong><span>${escapeHtml(p.method || 'نقدي')} · ${formatShortDate(p.date)}</span>${reversed ? `<small>معكوسة: ${escapeHtml(p.reversalReason || 'عكس مسجل')} · ${formatShortDate(p.reversedAt)}</small>` : `<small>${escapeHtml(p.receiptRef || '')}</small>`}</div>
                    <div class="mq-payment-actions">
                        ${reversed
                            ? '<span class="mq-payment-reversed-badge"><i class="fa-solid fa-ban"></i> معكوسة</span>'
                            : `<button class="mq-payment-receipt" type="button" onclick="triggerPaymentReceipt(${jsArg(tx.id)},${jsArg(p.id)})" aria-label="طباعة إيصال هذه الدفعة"><i class="fa-solid fa-receipt"></i><span>إيصال</span></button><button class="mq-payment-reverse" type="button" onclick="openPaymentReversal(${jsArg(tx.id)},${jsArg(p.id)})" aria-label="عكس هذه الدفعة"><i class="fa-solid fa-arrow-rotate-left"></i><span>عكس</span></button>`}
                    </div>
                </article>`;
            }).join('') || `<div class="mq-case-empty"><i class="fa-solid fa-coins"></i><span>لا توجد دفعات مسجلة</span></div>`;

            if (timeline) {
                const items = getTransactionTimeline(tx);
                timeline.innerHTML = items.map(item => `<article class="mq-case-timeline-item"><span></span><div><p>${escapeHtml(item.text)}</p><time>${formatDate(item.date)}</time></div></article>`).join('') || `<div class="mq-case-empty"><i class="fa-solid fa-clock-rotate-left"></i><span>لا يوجد سجل زمني بعد</span></div>`;
            }
        }

        // حفظ محطة جديدة (تحديث مسار) للمعاملة
        function saveStation() {
            const name = document.getElementById('stat-name').value.trim(); 
            const user = document.getElementById('stat-user').value.trim();
            
            if(!name) return showToast('الرجاء كتابة اسم المحطة', 'error');
            
            const tx = getTransaction(currentTxId);
            if (!tx) return showToast('المعاملة غير موجودة', 'error');
            if (tx.status === 'completed') return showToast('المعاملة منجزة؛ أعد فتحها قبل تحديث المسار', 'error');
            const previousLastUpdate = tx.lastUpdate;
            const previousActivityLength = tx.activity.length;
            const station = { id: makeId(), name, user, date: Date.now() };
            tx.stations.push(station);
            addActivity(tx, 'station', `تم تحديث المسار إلى: ${name}`, { sourceId: station.id, date: station.date });
            
            document.getElementById('stat-name').value = ''; 
            document.getElementById('stat-user').value = '';
            
            closeModal('addStationModal'); 
            const saved = saveDataWithAudit(
                'transaction.station_added', 'transaction', tx.id,
                `تم تحديث مسار المعاملة إلى: ${name}`,
                { stationId: station.id, assignedTo: user }
            );
            if (!saved) {
                tx.stations = tx.stations.filter(item => String(item.id) !== String(station.id));
                tx.activity.length = previousActivityLength;
                tx.lastUpdate = previousLastUpdate;
                return;
            }
            openTxDetails(currentTxId); 
            if (saved) showToast('تم تحديث المسار', 'success');
        }

        // إيقاف المعاملة مؤقتاً (جعلها متلكئة) أو العكس
        function toggleStallTx() { 
            const tx = getTransaction(currentTxId);
            if (!tx) return showToast('المعاملة غير موجودة', 'error');
            if (tx.status === 'completed') return showToast('لا يمكن إيقاف معاملة منجزة. يجب إعادة فتحها أولاً.', 'error');
            const previousStatus = tx.status;
            const previousLastUpdate = tx.lastUpdate;
            const previousActivityLength = tx.activity.length;
            tx.status = tx.status === 'stalled' ? 'active' : 'stalled';
            addActivity(tx, 'status', tx.status === 'stalled' ? 'تم وضع المعاملة في حالة تلكؤ' : 'تم إلغاء حالة التلكؤ'); 
            const saved = saveDataWithAudit(
                'transaction.status_changed', 'transaction', tx.id,
                tx.status === 'stalled' ? 'تم وضع المعاملة في حالة تلكؤ' : 'تم إلغاء حالة التلكؤ',
                { previousStatus, nextStatus: tx.status }
            ); 
            if (!saved) {
                tx.status = previousStatus;
                tx.activity.length = previousActivityLength;
                tx.lastUpdate = previousLastUpdate;
                return;
            }
            closeModal('txDetailsModal'); 
            if (saved) showToast(tx.status === 'stalled' ? 'تم إيقاف المعاملة' : 'تم تفعيل المعاملة'); 
        }

        // إنجاز المعاملة ونقلها للأرشيف
        function reqMarkTxCompleted() { 
            const current = getTransaction(currentTxId);
            if (!current) return showToast('المعاملة غير موجودة', 'error');
            if (current.status === 'completed') return showToast('المعاملة منجزة بالفعل', 'info');
            customConfirm('إنجاز للأرشيف', 'هل تم إنجاز المعاملة بالدوائر بالكامل؟', () => { 
                const tx = getTransaction(currentTxId); 
                if (!tx || tx.status === 'completed') return;
                const previousStatus = tx.status;
                const previousCompletedAt = tx.completedAt;
                const previousLastUpdate = tx.lastUpdate;
                const previousActivityLength = tx.activity.length;
                const completedAt = Date.now();
                tx.status = 'completed';
                tx.completedAt = completedAt;
                addActivity(tx, 'completed', 'تم إنجاز المعاملة ونقلها إلى الأرشيف', { sourceId: tx.id, date: completedAt }); 
                const saved = saveDataWithAudit(
                    'transaction.completed', 'transaction', tx.id,
                    `تم إنجاز المعاملة: ${tx.type || tx.id}`,
                    { previousStatus, completedAt }
                ); 
                if (!saved) {
                    tx.status = previousStatus;
                    tx.completedAt = previousCompletedAt;
                    tx.activity.length = previousActivityLength;
                    tx.lastUpdate = previousLastUpdate;
                    return;
                }
                closeModal('txDetailsModal'); 
                if (saved) showToast('تمت الأرشفة بنجاح', 'success'); 
            }); 
        }

        function reqReopenTx() {
            const current = getTransaction(currentTxId);
            if (!current) return showToast('المعاملة غير موجودة', 'error');
            if (current.status !== 'completed') return showToast('المعاملة مفتوحة بالفعل', 'info');
            customConfirm('إعادة فتح المعاملة', 'ستعود المعاملة إلى العمل وتخرج من سجل المنجزات. يبقى تاريخ الإنجاز السابق محفوظاً في السجل الزمني.', () => {
                const tx = getTransaction(currentTxId);
                if (!tx || tx.status !== 'completed') return;
                const previousStatus = tx.status;
                const previousCompletedAt = tx.completedAt;
                const previousLastUpdate = tx.lastUpdate;
                const previousActivityLength = tx.activity.length;
                tx.status = 'active';
                tx.completedAt = null;
                addActivity(tx, 'reopened', 'تمت إعادة فتح المعاملة وإعادتها إلى العمل', { sourceId: tx.id });
                const saved = saveDataWithAudit(
                    'transaction.reopened', 'transaction', tx.id,
                    `تمت إعادة فتح المعاملة: ${tx.type || tx.id}`,
                    { previousCompletedAt }
                );
                if (!saved) {
                    tx.status = previousStatus;
                    tx.completedAt = previousCompletedAt;
                    tx.activity.length = previousActivityLength;
                    tx.lastUpdate = previousLastUpdate;
                    return;
                }
                openTxDetails(tx.id);
                showToast('تمت إعادة فتح المعاملة', 'success');
            });
        }

        // حذف ناعم: ينتقل السجل إلى سلة قابلة للاستعادة ولا يدخل التحاسب أو الأرشيف.
        function reqDeleteTx() { 
            customConfirm('نقل إلى المحذوفات', 'لن يظهر السجل في العمل أو التحاسب، ويمكن استعادته لاحقاً من مركز البيانات.', () => { 
                const tx = getTransaction(currentTxId);
                if (!tx) return showToast('المعاملة غير موجودة', 'error');
                const previousTransactions = db.transactions;
                const previousTrash = db.trash?.transactions || [];
                const deletedAt = Date.now();
                const deletedRecord = {
                    ...tx,
                    deletedAt,
                    deletedBy: cloudSyncOwnerId ? String(cloudSyncOwnerId) : 'local',
                    deletionReason: 'حذف يدوي'
                };
                db.transactions = db.transactions.filter(t => String(t.id) !== String(tx.id));
                if (!db.trash || typeof db.trash !== 'object') db.trash = { transactions: [] };
                db.trash.transactions = [...previousTrash, deletedRecord];
                const saved = saveDataWithAudit(
                    'transaction.deleted', 'transaction', tx.id,
                    `نُقلت المعاملة إلى المحذوفات: ${tx.type || tx.id}`,
                    { deletedAt, status: tx.status, fee: Number(tx.fee) || 0 }
                ); 
                if (!saved) {
                    db.transactions = previousTransactions;
                    db.trash.transactions = previousTrash;
                    return;
                }
                closeModal('txDetailsModal'); 
                if (saved) showToast('نُقلت المعاملة إلى المحذوفات ويمكن استعادتها', 'success'); 
            }); 
        }

        // ==========================================================
        // TRANSACTION CORE ACTIONS — preserved; UI contract updated in REBUILD 04
        // ==========================================================
        function addTxNote() {
            const tx = getTransaction(currentTxId);
            const input = document.getElementById('tx-note-input');
            const text = input?.value.trim();
            if (!tx || !text) return showToast('اكتب الملاحظة أولاً', 'error');
            const previousLastUpdate = tx.lastUpdate;
            const previousActivityLength = tx.activity.length;
            const note = { id: makeId(), text, date: Date.now() };
            tx.notes.push(note);
            addActivity(tx, 'note', `تمت إضافة ملاحظة: ${text}`, { sourceId: note.id, date: note.date });
            input.value = '';
            const saved = saveDataWithAudit(
                'transaction.note_added', 'transaction', tx.id,
                'تمت إضافة ملاحظة إلى المعاملة',
                { noteId: note.id }
            );
            if (!saved) {
                tx.notes = tx.notes.filter(item => String(item.id) !== String(note.id));
                tx.activity.length = previousActivityLength;
                tx.lastUpdate = previousLastUpdate;
                return;
            }
            renderTxWorkspaceSections(tx);
            if (saved) showToast('تم حفظ الملاحظة', 'success');
        }

        function addTxFollowUp() {
            const tx = getTransaction(currentTxId);
            const title = document.getElementById('tx-follow-title')?.value.trim();
            const dueAt = document.getElementById('tx-follow-date')?.value;
            if (!tx || !title || !dueAt) return showToast('أدخل سبب المتابعة وموعدها', 'error');
            if (tx.status === 'completed') return showToast('المعاملة منجزة؛ أعد فتحها قبل إضافة متابعة جديدة', 'error');
            const previousLastUpdate = tx.lastUpdate;
            const previousActivityLength = tx.activity.length;
            const follow = { id: makeId(), title, dueAt, done:false, createdAt:Date.now() };
            tx.followUps.push(follow);
            addActivity(tx, 'followup', `تمت جدولة متابعة: ${title}`, { sourceId: follow.id, followUpId: follow.id, date: follow.createdAt });
            document.getElementById('tx-follow-title').value = '';
            document.getElementById('tx-follow-date').value = '';
            const saved = saveDataWithAudit(
                'transaction.followup_added', 'transaction', tx.id,
                `تمت جدولة متابعة: ${title}`,
                { followUpId: follow.id, dueAt }
            );
            if (!saved) {
                tx.followUps = tx.followUps.filter(item => String(item.id) !== String(follow.id));
                tx.activity.length = previousActivityLength;
                tx.lastUpdate = previousLastUpdate;
                return;
            }
            renderTxWorkspaceSections(tx);
            renderV6Dashboard();
            if (saved) showToast('تمت جدولة المتابعة', 'success');
        }

        function toggleFollowUp(txId, followId) {
            const tx = getTransaction(txId);
            const follow = tx?.followUps?.find(f => String(f.id) === String(followId));
            if (!follow) return;
            const previousDone = follow.done;
            const previousCompletedAt = follow.completedAt;
            const previousLastUpdate = tx.lastUpdate;
            const previousActivityLength = tx.activity.length;
            follow.done = !follow.done;
            follow.completedAt = follow.done ? Date.now() : null;
            addActivity(tx, 'followup', follow.done ? `تم إنجاز المتابعة: ${follow.title}` : `تم إعادة فتح المتابعة: ${follow.title}`, { sourceId: follow.id, followUpId: follow.id });
            if (!saveDataWithAudit(
                follow.done ? 'transaction.followup_completed' : 'transaction.followup_reopened',
                'transaction', tx.id,
                follow.done ? `تم إنجاز المتابعة: ${follow.title}` : `تمت إعادة فتح المتابعة: ${follow.title}`,
                { followUpId: follow.id, completedAt: follow.completedAt }
            )) {
                follow.done = previousDone;
                follow.completedAt = previousCompletedAt;
                tx.activity.length = previousActivityLength;
                tx.lastUpdate = previousLastUpdate;
                return;
            }
            renderTxWorkspaceSections(tx);
            renderV6Dashboard();
        }

        function openPaymentReversal(txId, paymentId) {
            const tx = getTransaction(txId);
            const payment = tx?.payments?.find(item => String(item.id) === String(paymentId));
            if (!tx || !payment) return showToast('تعذر العثور على الدفعة', 'error');
            if (payment.status === 'reversed') return showToast('هذه الدفعة معكوسة بالفعل', 'info');
            pendingPaymentReversal = { txId: String(tx.id), paymentId: String(payment.id) };
            const amount = document.getElementById('reverse-payment-amount');
            const reference = document.getElementById('reverse-payment-reference');
            const reason = document.getElementById('reverse-payment-reason');
            if (amount) amount.textContent = `${numFormat.format(Number(payment.amount) || 0)} د.ع`;
            if (reference) reference.textContent = payment.receiptRef || '—';
            if (reason) reason.value = '';
            openModal('reversePaymentModal');
            setTimeout(() => reason?.focus(), 320);
        }

        function closePaymentReversal() {
            pendingPaymentReversal = null;
            const reason = document.getElementById('reverse-payment-reason');
            if (reason) reason.value = '';
            closeModal('reversePaymentModal');
        }

        function confirmPaymentReversal() {
            if (!pendingPaymentReversal) return showToast('لا توجد دفعة محددة', 'error');
            const tx = getTransaction(pendingPaymentReversal.txId);
            const payment = tx?.payments?.find(item => String(item.id) === String(pendingPaymentReversal.paymentId));
            const reason = String(document.getElementById('reverse-payment-reason')?.value || '').trim();
            if (!tx || !payment) return showToast('تعذر العثور على الدفعة', 'error');
            if (payment.status === 'reversed') return showToast('هذه الدفعة معكوسة بالفعل', 'info');
            if (reason.length < 3) return showToast('اكتب سبباً واضحاً لعكس الدفعة', 'error');

            const previousLastUpdate = tx.lastUpdate;
            const previousActivityLength = tx.activity.length;
            const reversedAt = Date.now();
            payment.status = 'reversed';
            payment.reversedAt = reversedAt;
            payment.reversalReason = reason;
            addActivity(
                tx,
                'payment_reversed',
                `تم عكس دفعة بقيمة ${numFormat.format(Number(payment.amount) || 0)} د.ع — السبب: ${reason}`,
                { sourceId: payment.id, date: reversedAt }
            );
            const saved = saveDataWithAudit(
                'payment.reversed', 'payment', payment.id,
                `تم عكس دفعة من المعاملة: ${tx.type || tx.id}`,
                { transactionId: tx.id, amount: Number(payment.amount) || 0, reason, receiptRef: payment.receiptRef || '' }
            );
            if (!saved) {
                payment.status = 'posted';
                payment.reversedAt = null;
                payment.reversalReason = '';
                tx.activity.length = previousActivityLength;
                tx.lastUpdate = previousLastUpdate;
                return;
            }
            pendingPaymentReversal = null;
            closeModal('reversePaymentModal');
            openTxDetails(tx.id);
            renderV6Dashboard();
            showToast('تم عكس الدفعة مع إبقاء سجلها المالي', 'success');
        }

        function addTxPayment() {
            const tx = getTransaction(currentTxId);
            const amount = Number(document.getElementById('tx-payment-amount')?.value);
            const method = document.getElementById('tx-payment-method')?.value || 'نقدي';
            if (!tx || !amount || amount <= 0) return showToast('أدخل مبلغاً صحيحاً', 'error');
            const remaining = getRemainingAmount(tx);
            if (amount > remaining) return showToast(`المبلغ يتجاوز المتبقي (${numFormat.format(remaining)} د.ع)`, 'error');
            const previousLastUpdate = tx.lastUpdate;
            const previousActivityLength = tx.activity.length;
            const paymentId = makeId();
            const payment = {
                id: paymentId,
                amount,
                method,
                date: Date.now(),
                status: 'posted',
                receiptRef: buildPaymentReceiptRef(paymentId),
                reversedAt: null,
                reversalReason: ''
            };
            tx.payments.push(payment);
            addActivity(tx, 'payment', `تم تسجيل دفعة بقيمة ${numFormat.format(amount)} د.ع`, { sourceId: payment.id, date: payment.date });
            document.getElementById('tx-payment-amount').value = '';
            const saved = saveDataWithAudit(
                'payment.created', 'payment', payment.id,
                `تم تسجيل دفعة للمعاملة: ${tx.type || tx.id}`,
                { transactionId: tx.id, amount, method, receiptRef: payment.receiptRef }
            );
            if (!saved) {
                tx.payments = tx.payments.filter(item => String(item.id) !== String(payment.id));
                tx.activity.length = previousActivityLength;
                tx.lastUpdate = previousLastUpdate;
                return;
            }
            renderTxWorkspaceSections(tx);
            openTxDetails(tx.id);
            renderV6Dashboard();
            if (saved) showToast('تم تسجيل الدفعة', 'success');
        }

        function setTxPriority(value) {
            const tx = getTransaction(currentTxId);
            if (!tx || !['normal','high','urgent'].includes(value)) return;
            const previousPriority = tx.priority;
            const previousLastUpdate = tx.lastUpdate;
            const previousActivityLength = tx.activity.length;
            tx.priority = value;
            addActivity(tx, 'priority', `تم تغيير أولوية المعاملة إلى: ${value === 'urgent' ? 'عاجلة' : value === 'high' ? 'مهمة' : 'عادية'}`);
            if (!saveDataWithAudit(
                'transaction.priority_changed', 'transaction', tx.id,
                `تم تغيير أولوية المعاملة إلى: ${value}`,
                { previousPriority, nextPriority: value }
            )) {
                tx.priority = previousPriority;
                tx.activity.length = previousActivityLength;
                tx.lastUpdate = previousLastUpdate;
                return;
            }
            openTxDetails(tx.id);
            renderV6Dashboard();
        }

        // UI/UX REBUILD 02 — HOME PRESENTATION CONTRACT
        // Business data below is unchanged; only markup emitted into the new Home stream is owned here.
        // Do not reintroduce legacy Tailwind dashboard card classes.
        function renderV6Dashboard() {
            const list = document.getElementById('mq-home-followups');
            const overdueEl = document.getElementById('mq-home-overdue-count');
            const todayEl = document.getElementById('mq-home-today-count');
            const outstandingEl = document.getElementById('mq-home-outstanding');
            if (!list) return;

            const all = [];
            db.transactions.forEach(tx => (tx.followUps || []).forEach(f => {
                if (!f.done) all.push({ ...f, txId: tx.id, txType: tx.type, companyId: tx.companyId });
            }));
            all.sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt));
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1);
            const overdue = all.filter(f => new Date(f.dueAt) < start).length;
            const today = all.filter(f => new Date(f.dueAt) >= start && new Date(f.dueAt) < end).length;
            const outstanding = db.transactions.reduce((sum, tx)=>sum+getRemainingAmount(tx),0);
            if (overdueEl) overdueEl.innerText = overdue;
            if (todayEl) todayEl.innerText = today;
            if (outstandingEl) outstandingEl.innerText = numFormat.format(outstanding);
            list.innerHTML = all.slice(0,6).map(f => {
                const overdueClass = new Date(f.dueAt) < now ? 'is-overdue' : '';
                return `<button onclick="openTxDetails(${jsArg(f.txId)})" class="mq-followup-row ${overdueClass}"><span class="mq-followup-row-icon"><i class="fa-solid fa-bell"></i></span><span class="mq-followup-row-copy"><strong>${escapeHtml(f.title)}</strong><span>${escapeHtml(f.txType)} — ${formatShortDate(f.dueAt)}</span></span><i class="fa-solid fa-chevron-left"></i></button>`;
            }).join('') || `<div class="mq-followup-empty"><i class="fa-solid fa-circle-check"></i><span>لا توجد متابعات قادمة</span></div>`;
        }

        // ==========================================
        // 9. الأرشيف والتحاسب (Archive & Accounting)
        // ==========================================

        // UI/UX REBUILD 07: Archive renderer — new completion ledger, unchanged archive rules.
        function renderArchive() {
            const input = document.getElementById('archive-search');
            const q = String(input?.value || '').trim().toLowerCase();
            const allCompleted = db.transactions.filter(t => t.status === 'completed');
            let compTxs = q ? allCompleted.filter(t => String(t.type||'').toLowerCase().includes(q) || companyName(t.companyId).toLowerCase().includes(q) || lawyerName(t.lawyerId).toLowerCase().includes(q)) : allCompleted.slice();
            compTxs.sort((a,b)=>Number(b.completedAt || b.lastUpdate)-Number(a.completedAt || a.lastUpdate));
            const completedCount = document.getElementById('records-completed-count');
            const docsCount = document.getElementById('records-doc-count');
            const companiesCount = document.getElementById('records-company-count');
            const caption = document.getElementById('archive-results-caption');
            if (completedCount) completedCount.textContent = allCompleted.length;
            if (docsCount) docsCount.textContent = db.vault.length;
            if (companiesCount) companiesCount.textContent = db.companies.length;
            if (caption) caption.textContent = q ? `${compTxs.length} نتيجة مطابقة` : `${allCompleted.length} معاملة مكتملة محفوظة في السجل`;
            const target = document.getElementById('archive-list');
            if (!target) return;
            target.innerHTML = compTxs.map((tx,index)=>{
                const company = companyName(tx.companyId) || 'غير مسجلة';
                const lawyer = lawyerName(tx.lawyerId) || 'غير مسجل';
                const remaining = getRemainingAmount(tx);
                const paid = getPaidAmount(tx);
                const fee = Math.max(0, Number(tx.fee || 0));
                const paidRate = fee > 0 ? Math.min(100, Math.round((paid / fee) * 100)) : 0;
                return `<button onclick="openTxDetails(${jsArg(tx.id)})" class="mq-archive-entry mq-enter ${remaining > 0 ? 'has-balance' : 'is-settled'}" style="animation-delay:${index*.03}s"><span class="mq-archive-state"><i class="fa-solid fa-check"></i></span><span class="mq-archive-entry-main"><small>${escapeHtml(company)}</small><b>${escapeHtml(tx.type || 'معاملة منجزة')}</b><em><i class="fa-solid fa-user-tie"></i>${escapeHtml(lawyer)}</em></span><span class="mq-archive-entry-finance"><time>${formatShortDate(tx.completedAt || tx.lastUpdate)}</time><strong>${remaining > 0 ? `${numFormat.format(remaining)} <small>د.ع</small>` : 'مسددة'}</strong><span><i style="width:${paidRate}%"></i></span></span><i class="fa-solid fa-chevron-left mq-archive-arrow"></i></button>`;
            }).join('') || `<div class="mq-records-empty"><span><i class="fa-solid fa-box-archive"></i></span><h3>${q ? 'لا توجد نتائج مطابقة' : 'سجل الإنجاز فارغ'}</h3><p>${q ? 'جرّب اسم شركة أو محامٍ أو نوع معاملة آخر.' : 'كل معاملة تُنجز ستنتقل تلقائيًا إلى هذا السجل.'}</p></div>`;
        }

        // حالة العرض لدفتر حسابات المحامين — فلترة واجهة فقط.
        let accountingViewMode = 'all';

        function setAccountingViewMode(mode = 'all') {
            accountingViewMode = ['all','open','settled'].includes(mode) ? mode : 'all';
            document.querySelectorAll('[data-accounting-mode]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.accountingMode === accountingViewMode);
            });
            renderAccounting();
        }

        function clearAccountingSearch() {
            const input = document.getElementById('accounting-search');
            if (input) input.value = '';
            renderAccounting();
            input?.focus();
        }

        // طباعة وتوزيع حسابات المحامين لجمع أتعابهم
        const ACCOUNTING_STATUSES = new Set(['active', 'stalled', 'completed']);

        function resolveTransactionLawyerId(tx) {
            const company = getCompanyById(tx?.companyId);
            return getLawyerById(tx?.lawyerId) ? String(tx.lawyerId) : String(company?.lawyerId || '');
        }

        function getLawyerAccountTransactions(lawyerId) {
            return db.transactions.filter(tx => ACCOUNTING_STATUSES.has(tx.status) && resolveTransactionLawyerId(tx) === String(lawyerId));
        }

        function triggerPaymentReceipt(txId, paymentId) {
            const tx = getTransaction(txId);
            const payment = tx?.payments?.find(item => String(item.id) === String(paymentId));
            if (!tx || !payment) return showToast('تعذر العثور على الدفعة المطلوبة', 'error');
            if (payment.status === 'reversed') return showToast('لا يمكن إصدار سند قبض لدفعة معكوسة', 'error');
            const lawyerId = resolveTransactionLawyerId(tx);
            if (!lawyerId) return showToast('المعاملة غير مرتبطة بمحامٍ صالح', 'error');
            return triggerPDF(lawyerId, 'receipt', Number(payment.amount) || 0, { transaction: tx, payment });
        }

        function triggerLatestLawyerReceipt(lawyerId) {
            const latest = getLawyerAccountTransactions(lawyerId)
                .flatMap(tx => (tx.payments || []).filter(payment => payment.status !== 'reversed').map(payment => ({ tx, payment })))
                .sort((a, b) => Number(b.payment.date) - Number(a.payment.date))[0];
            if (!latest) return showToast('لا توجد دفعة مسجلة لإصدار سند قبض', 'error');
            return triggerPaymentReceipt(latest.tx.id, latest.payment.id);
        }

        function renderAccounting() {
            // One audited scope is shared by the ledger, portfolio and PDF report.
            const activeTxs = db.transactions.filter(t => ACCOUNTING_STATUSES.has(t.status));
            const lawyerDues = {};
            activeTxs.forEach(tx => {
                const company = getCompanyById(tx.companyId);
                const resolvedLawyerId = getLawyerById(tx.lawyerId) ? tx.lawyerId : company?.lawyerId;
                const key = String(resolvedLawyerId ?? '__unknown__');
                if(!lawyerDues[key]) lawyerDues[key] = [];
                lawyerDues[key].push(tx);
            });

            const totalDues = activeTxs.reduce((a,b)=>a+getRemainingAmount(b),0);
            const totalEl = document.getElementById('acc-total-dues');
            if (totalEl) totalEl.innerText = numFormat.format(totalDues);

            const search = String(document.getElementById('accounting-search')?.value || '').trim().toLowerCase();
            const groups = Object.keys(lawyerDues).map(lId => {
                const lawyer = getLawyerById(lId);
                const txs = lawyerDues[lId];
                const fees = txs.reduce((s,t)=>s+(Number(t.fee)||0),0);
                const paid = txs.reduce((s,t)=>s+getPaidAmount(t),0);
                const remaining = txs.reduce((s,t)=>s+getRemainingAmount(t),0);
                return { lId, lawyer, txs, fees, paid, remaining };
            }).filter(group => {
                if (accountingViewMode === 'open' && group.remaining <= 0) return false;
                if (accountingViewMode === 'settled' && group.remaining > 0) return false;
                if (search && !String(group.lawyer?.name || 'مجهول').toLowerCase().includes(search)) return false;
                return true;
            }).sort((a,b) => b.remaining - a.remaining || String(a.lawyer?.name || '').localeCompare(String(b.lawyer?.name || ''), 'ar'));

            const countEl = document.getElementById('accounting-group-count');
            if (countEl) countEl.textContent = groups.length;
            document.querySelectorAll('[data-accounting-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.accountingMode === accountingViewMode));

            const list = document.getElementById('accounting-list');
            if (list) list.innerHTML = groups.map((group,index)=>{
                const { lId, lawyer, txs, fees, paid, remaining } = group;
                const collectionRate = fees > 0 ? Math.max(0, Math.min(100, Math.round((paid / fees) * 100))) : 0;
                const isSettled = remaining <= 0;
                const displayName = lawyer?.name || 'مجهول';
                const accountCode = String(lId === '__unknown__' ? 'UNLINKED' : lId).slice(-6).toUpperCase();
                return `<article class="mq-ledger-account ${isSettled ? 'is-settled' : 'is-open'} mq-enter" style="animation-delay:${index*.035}s">
                    <header class="mq-ledger-account-head">
                        <div class="mq-ledger-person"><span class="mq-ledger-avatar"><i class="fa-solid fa-user-tie"></i></span><div><small>ACCOUNT ${escapeHtml(accountCode)}</small><h3>${escapeHtml(displayName)}</h3><p>${txs.length} ${txs.length === 1 ? 'معاملة' : 'معاملات'} مرتبطة</p></div></div>
                        <span class="mq-ledger-state"><i class="fa-solid ${isSettled ? 'fa-circle-check' : 'fa-circle-dot'}"></i>${isSettled ? 'مسدد' : 'مفتوح'}</span>
                    </header>
                    <div class="mq-ledger-balance-band">
                        <div><span>${isSettled ? 'حالة الرصيد' : 'الرصيد المطلوب تحصيله'}</span><strong>${isSettled ? '0' : numFormat.format(remaining)} <small>د.ع</small></strong></div>
                        <div class="mq-ledger-rate"><span><b>${collectionRate}%</b> تحصيل</span><div><i style="width:${collectionRate}%"></i></div></div>
                    </div>
                    <div class="mq-ledger-stats"><div><span>الأتعاب</span><b>${numFormat.format(fees)}</b><small>د.ع</small></div><div class="is-paid"><span>المدفوع</span><b>${numFormat.format(paid)}</b><small>د.ع</small></div><div class="is-remaining"><span>المتبقي</span><b>${numFormat.format(remaining)}</b><small>د.ع</small></div></div>
                    <footer class="mq-ledger-actions"><button onclick="triggerLatestLawyerReceipt(${jsArg(lId)})" type="button"><i class="fa-solid fa-receipt"></i><span><b>آخر إيصال</b><small>آخر دفعة مسجلة</small></span></button><button class="is-primary" onclick="triggerPDF(${jsArg(lId)}, 'report')" type="button"><i class="fa-solid fa-file-pdf"></i><span><b>كشف الحساب</b><small>تفاصيل جميع المعاملات</small></span></button></footer>
                </article>`;
            }).join('') || `<div class="mq-finance-empty"><span><i class="fa-solid fa-wallet"></i></span><h3>${search ? 'لا توجد حسابات مطابقة' : 'لا توجد حسابات في هذا التصنيف'}</h3><p>${search ? 'غيّر كلمة البحث أو امسحها لعرض جميع الحسابات.' : 'غيّر فلتر دفتر الأرصدة أو أضف معاملات مرتبطة بمحامٍ.'}</p></div>`;
            renderAdvancedAccounting();
        }

        // ==========================================================
        // V6.4 - التحاسب المالي المتقدم
        // ==========================================================
        // هذه الطبقة لا تستبدل شاشة التحاسب القديمة؛ بل تضيف ملخصاً
        // موحداً يعتمد على نفس دوال getPaidAmount/getRemainingAmount.
        // ==========================================================
        function renderAdvancedAccounting() {
            // REBUILD 06 full portfolio pulse. Business scope remains exactly
            // active + stalled + completed, matching the existing financial report.
            const txs = db.transactions.filter(t => ['active','stalled','completed'].includes(t.status));
            const fees = txs.reduce((sum, t) => sum + Math.max(0, Number(t.fee) || 0), 0);
            const paid = txs.reduce((sum, t) => sum + getPaidAmount(t), 0);
            const remaining = txs.reduce((sum, t) => sum + getRemainingAmount(t), 0);
            const unpaidCount = txs.filter(t => getRemainingAmount(t) > 0).length;
            const collectionRate = fees > 0 ? Math.max(0, Math.min(100, Math.round((paid / fees) * 100))) : 0;
            const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
            set('acc-advanced-fees', `${numFormat.format(fees)} د.ع`);
            set('acc-advanced-paid', `${numFormat.format(paid)} د.ع`);
            set('acc-advanced-remaining', `${numFormat.format(remaining)} د.ع`);
            set('acc-advanced-unpaid-count', String(unpaidCount));
            set('acc-collection-rate', `${collectionRate}%`);
            const ring = document.getElementById('acc-collection-ring');
            if (ring) ring.style.setProperty('--mq-rate', `${collectionRate * 3.6}deg`);
        }

        // إنشاء تقرير مالي مستقل دون تعديل قالب PDF القديم.
        async function exportFinancialReport(mode = 'all') {
            if (!(window.jspdf?.jsPDF || window.jsPDF)) return showToast('مكتبة PDF غير متاحة حالياً', 'error');
            const txs = db.transactions.filter(t => ['active','stalled','completed'].includes(t.status))
                .filter(t => mode !== 'unpaid' || getRemainingAmount(t) > 0);
            if (!txs.length) return showToast('لا توجد بيانات للتقرير', 'error');

            const totalFees = txs.reduce((s,t)=>s+(Number(t.fee)||0),0);
            const totalPaid = txs.reduce((s,t)=>s+getPaidAmount(t),0);
            const totalRemaining = txs.reduce((s,t)=>s+getRemainingAmount(t),0);
            const companyById = id => db.companies.find(c => String(c.id) === String(id));
            const companyName = id => companyById(id)?.name || 'غير مسجلة';
            const lawyerName = (id, companyId) => {
                const direct = db.lawyers.find(l => String(l.id) === String(id));
                if (direct?.name) return direct.name;
                const company = companyById(companyId);
                return db.lawyers.find(l => String(l.id) === String(company?.lawyerId))?.name || 'غير مسجل';
            };

            const wrapper = document.createElement('div');
            wrapper.dir = 'rtl';
            wrapper.style.cssText = 'width:1123px;box-sizing:border-box;background:#f7f3ea;color:#20261d;padding:30px;font-family:Tahoma,Arial,sans-serif;';
            wrapper.innerHTML = `
                <div style="border:2px solid #39482f;border-radius:22px;overflow:hidden;background:#fffdf8">
                    <div style="height:9px;background:linear-gradient(90deg,#f47a1f,#ff9a52 38%,#65734f 38%,#39482f 100%)"></div>
                    <div style="padding:28px 30px 30px">
                        <div style="display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:2px solid #d9ddcf;padding-bottom:18px;margin-bottom:18px">
                            <div><span style="display:inline-block;background:#fff0df;color:#d85c12;border:1px solid #ffd8b8;border-radius:999px;padding:4px 9px;font-size:10px;font-weight:900">FINANCE / MOAQIB</span><h1 style="margin:8px 0 3px;font-size:26px;color:#2b3725">${mode === 'unpaid' ? 'كشف المبالغ المتبقية' : 'التقرير المالي الشامل'}</h1><p style="margin:0;font-size:11px;color:#7d8378">${escapeHtml(new Date().toLocaleString('ar-IQ'))}</p></div>
                            <div style="text-align:left"><strong style="font-size:18px;color:#2b3725">${escapeHtml(db.settings.name || 'MOAQIB')}</strong><p style="margin:4px 0 0;font-size:11px;color:#6f7469">${escapeHtml(db.settings.address || '')}</p></div>
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:18px">
                            <div style="border:1px solid #f4cfaf;background:#fff0df;border-radius:14px;padding:12px;text-align:center"><span style="font-size:11px;color:#a75516;font-weight:800">الأتعاب</span><strong style="display:block;margin-top:4px;font-size:18px;color:#d85c12">${numFormat.format(totalFees)} د.ع</strong></div>
                            <div style="border:1px solid #cfd8c6;background:#eef1e7;border-radius:14px;padding:12px;text-align:center"><span style="font-size:11px;color:#65734f;font-weight:800">المدفوع</span><strong style="display:block;margin-top:4px;font-size:18px;color:#39482f">${numFormat.format(totalPaid)} د.ع</strong></div>
                            <div style="border:1px solid #d9ddcf;background:#fffdf8;border-radius:14px;padding:12px;text-align:center"><span style="font-size:11px;color:#6f7469;font-weight:800">المتبقي</span><strong style="display:block;margin-top:4px;font-size:18px;color:#2b3725">${numFormat.format(totalRemaining)} د.ع</strong></div>
                        </div>
                        <table style="width:100%;border-collapse:separate;border-spacing:0;font-size:11.5px;border:1px solid #cfd5c7;border-radius:14px;overflow:hidden">
                            <thead><tr style="background:#39482f;color:#fff"><th style="padding:9px;border-left:1px solid #536147">المعاملة</th><th style="padding:9px;border-left:1px solid #536147">الشركة</th><th style="padding:9px;border-left:1px solid #536147">المحامي</th><th style="padding:9px;border-left:1px solid #536147">الأتعاب</th><th style="padding:9px;border-left:1px solid #536147">المدفوع</th><th style="padding:9px">المتبقي</th></tr></thead>
                            <tbody>${txs.map((t,i)=>`<tr style="background:${i%2===0?'#fffdf8':'#f4f1e9'}"><td style="padding:8px;border-top:1px solid #d9ddcf;border-left:1px solid #e3e6dc;font-weight:800">${escapeHtml(t.type)}</td><td style="padding:8px;border-top:1px solid #d9ddcf;border-left:1px solid #e3e6dc">${escapeHtml(companyName(t.companyId))}</td><td style="padding:8px;border-top:1px solid #d9ddcf;border-left:1px solid #e3e6dc">${escapeHtml(lawyerName(t.lawyerId, t.companyId))}</td><td style="padding:8px;border-top:1px solid #d9ddcf;border-left:1px solid #e3e6dc">${numFormat.format(Number(t.fee)||0)}</td><td style="padding:8px;border-top:1px solid #d9ddcf;border-left:1px solid #e3e6dc;color:#486b42;font-weight:800">${numFormat.format(getPaidAmount(t))}</td><td style="padding:8px;border-top:1px solid #d9ddcf;color:#d85c12;font-weight:900">${numFormat.format(getRemainingAmount(t))}</td></tr>`).join('')}</tbody>
                        </table>
                    </div>
                </div>`;
            document.body.appendChild(wrapper);
            const filename = mode === 'unpaid' ? 'كشف_المبالغ_المتبقية.pdf' : 'التقرير_المالي.pdf';
            customAlert('جاري تجهيز التقرير', 'يتم إنشاء التقرير المالي الآن، يرجى الانتظار...', 'info');
            try {
                await exportPdfElement(wrapper, filename, {
                    margin: 0.25,
                    image: { type: 'png', quality: 1 },
                    raster: { scale: 2.2 },
                    jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape' }
                });
                showToast('تم إنشاء التقرير المالي بنجاح','success');
            } catch (err) {
                showToast(`تعذر إنشاء التقرير: ${err?.message || 'خطأ غير معروف'}`,'error');
            } finally {
                closeUiAlert();
                wrapper.remove();
            }
        }

        // ==========================================================
        // V6.6 - تقرير المعاملة الكامل PDF
        // ==========================================================
        // ينشئ تقريراً مستقلاً للمعاملة الحالية دون تغيير قالب PDF القديم.
        // لا يضم الصور Base64 حتى يبقى الملف خفيفاً؛ عدد المستندات يظهر في التقرير.
        // ==========================================================
        async function preparePdfElement(element) {
            if (!element) throw new Error('عنصر PDF غير موجود');

            // FINAL FIX 01:
            // PDF rendering uses the browser's native HTML/SVG layout engine.
            // Do NOT force an A4 min-height here: it was the source of trailing
            // blank pages, especially when a landscape report was shorter than A4.
            const root = element.closest('#pdf-export-wrapper') || element;
            const targets = root === element ? [root] : [root, element];
            // Preserve the template's intended paper aspect: portrait templates use
            // 794px, while the financial landscape template uses 1123px. Forcing
            // every source to 794px made normal landscape tables spill to another page.
            const renderWidth = Math.max(320, Math.ceil(
                root.getBoundingClientRect().width || root.scrollWidth ||
                element.getBoundingClientRect().width || element.scrollWidth || 794
            ));
            const snapshots = targets.map(target => ({
                target,
                style: {
                    position: target.style.position,
                    left: target.style.left,
                    top: target.style.top,
                    right: target.style.right,
                    width: target.style.width,
                    minHeight: target.style.minHeight,
                    maxWidth: target.style.maxWidth,
                    height: target.style.height,
                    opacity: target.style.opacity,
                    visibility: target.style.visibility,
                    zIndex: target.style.zIndex,
                    pointerEvents: target.style.pointerEvents,
                    overflow: target.style.overflow,
                    background: target.style.background,
                    direction: target.style.direction,
                    textAlign: target.style.textAlign
                }
            }));

            root.style.position = 'fixed';
            root.style.left = '0px';
            root.style.right = 'auto';
            root.style.top = '0px';
            root.style.width = `${renderWidth}px`;
            root.style.minHeight = '0px';
            root.style.maxWidth = 'none';
            root.style.height = 'auto';
            root.style.opacity = '1';
            root.style.visibility = 'visible';
            root.style.zIndex = '90';
            root.style.pointerEvents = 'none';
            root.style.overflow = 'visible';
            root.style.background = '#f7f3ea';
            root.style.direction = 'rtl';
            root.style.textAlign = 'right';
            root.classList.add('pdf-rendering');

            if (element !== root) {
                element.style.position = 'static';
                element.style.left = 'auto';
                element.style.top = 'auto';
                element.style.width = '100%';
                element.style.minHeight = '0px';
                element.style.maxWidth = 'none';
                element.style.height = 'auto';
                element.style.opacity = '1';
                element.style.visibility = 'visible';
                element.style.zIndex = 'auto';
                element.style.pointerEvents = 'none';
                element.style.overflow = 'visible';
                element.style.background = '#f7f3ea';
                element.style.direction = 'rtl';
                element.style.textAlign = 'right';
            }

            try {
                if (document.fonts && document.fonts.ready) await document.fonts.ready;
                const images = Array.from(root.querySelectorAll('img'));
                await Promise.all(images.map(img => {
                    if (img.complete) return img.decode?.().catch(() => {}) || Promise.resolve();
                    return new Promise(resolve => {
                        img.addEventListener('load', resolve, { once: true });
                        img.addEventListener('error', resolve, { once: true });
                    });
                }));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            } catch (_) {
                // Optional font/signature image must never block the document.
            }

            return () => {
                snapshots.forEach(({ target, style }) => {
                    Object.entries(style).forEach(([key, value]) => { target.style[key] = value; });
                });
                root.classList.remove('pdf-rendering');
            };
        }

        function pdfCloneWithCanvasImages(element) {
            const clone = element.cloneNode(true);
            const sourceCanvases = Array.from(element.querySelectorAll('canvas'));
            const clonedCanvases = Array.from(clone.querySelectorAll('canvas'));
            sourceCanvases.forEach((canvas, index) => {
                const target = clonedCanvases[index];
                if (!target) return;
                try {
                    const img = document.createElement('img');
                    img.src = canvas.toDataURL('image/png');
                    img.width = canvas.width;
                    img.height = canvas.height;
                    img.style.cssText = target.getAttribute('style') || '';
                    img.style.maxWidth = img.style.maxWidth || '100%';
                    target.replaceWith(img);
                } catch (_) {
                    // A decorative/QR canvas can be omitted if the browser blocks serialization.
                    target.remove();
                }
            });
            clone.removeAttribute('id');
            clone.style.margin = '0';
            clone.style.position = 'static';
            clone.style.left = 'auto';
            clone.style.top = 'auto';
            clone.style.opacity = '1';
            clone.style.visibility = 'visible';
            clone.style.direction = 'rtl';
            clone.style.textAlign = 'right';
            clone.style.fontFamily = 'Tahoma, Arial, sans-serif';
            return clone;
        }

        async function renderPdfElementNative(element, scale = 2.2) {
            // html2canvas's canvas-text path can split/reorder Arabic glyphs on
            // some mobile Chromium builds. Rendering the DOM through an
            // SVG <foreignObject> delegates Arabic shaping + RTL bidi to the
            // browser's native layout engine first, then rasterizes the result.
            const width = Math.max(1, Math.ceil(element.getBoundingClientRect().width || element.scrollWidth || 794));
            const height = Math.max(1, Math.ceil(element.scrollHeight || element.getBoundingClientRect().height || 1));
            const safeScale = Math.max(1, Math.min(3, Number(scale) || 2.2));
            const clone = pdfCloneWithCanvasImages(element);
            const serialized = new XMLSerializer().serializeToString(clone);
            const svg = `<?xml version="1.0" encoding="UTF-8"?>
                <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                    <foreignObject x="0" y="0" width="100%" height="100%">
                        <div xmlns="http://www.w3.org/1999/xhtml" dir="rtl" style="width:${width}px;min-height:${height}px;margin:0;padding:0;direction:rtl;text-align:right;font-family:Tahoma,Arial,sans-serif;unicode-bidi:plaintext;background:#f7f3ea;">
                            <style>*{box-sizing:border-box;text-rendering:geometricPrecision;-webkit-font-smoothing:antialiased}table{direction:rtl}th,td{direction:rtl;text-align:right}</style>
                            ${serialized}
                        </div>
                    </foreignObject>
                </svg>`;

            // A data URL keeps the SVG self-contained. Blob URLs + foreignObject
            // can mark the destination canvas as origin-unclean on Chromium,
            // which prevents PNG export in affected mobile browsers.
            const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
            try {
                const img = new Image();
                img.decoding = 'async';
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = () => reject(new Error('تعذر رسم قالب PDF بواسطة المتصفح'));
                    img.src = url;
                });
                if (img.decode) await img.decode().catch(() => {});

                const canvas = document.createElement('canvas');
                canvas.width = Math.ceil(width * safeScale);
                canvas.height = Math.ceil(height * safeScale);
                const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
                if (!ctx) throw new Error('تعذر إنشاء لوحة PDF');
                ctx.fillStyle = '#f7f3ea';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.setTransform(safeScale, 0, 0, safeScale, 0, 0);
                ctx.drawImage(img, 0, 0, width, height);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                return canvas;
            } finally {
                // Data URL needs no explicit revocation.
            }
        }

        function pdfSliceHasInk(canvas) {
            // Skip genuinely empty trailing slices. This protects against an
            // mobile-browser rounding pixel creating an extra blank A4 page.
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx || canvas.width < 2 || canvas.height < 2) return true;
            const step = Math.max(10, Math.floor(Math.min(canvas.width, canvas.height) / 70));
            const base = ctx.getImageData(1, 1, 1, 1).data;
            for (let y = 1; y < canvas.height; y += step) {
                for (let x = 1; x < canvas.width; x += step) {
                    const p = ctx.getImageData(x, y, 1, 1).data;
                    if (Math.abs(p[0]-base[0]) + Math.abs(p[1]-base[1]) + Math.abs(p[2]-base[2]) > 28) return true;
                }
            }
            return false;
        }

        async function exportPdfElement(element, filename, pdfOptions = {}) {
            if (!element) throw new Error('عنصر PDF غير موجود');
            const JsPDF = window.jspdf?.jsPDF || window.jsPDF;
            if (!JsPDF) throw new Error('مكتبة jsPDF غير متاحة حالياً');

            const restore = await preparePdfElement(element);
            try {
                const rasterOptions = (pdfOptions && pdfOptions.raster) || {};
                const canvas = await renderPdfElementNative(element, rasterOptions.scale || 2.2);
                if (!canvas || !canvas.width || !canvas.height) throw new Error('تعذر إنشاء صورة التقرير');

                const jsPdfOptions = (pdfOptions && pdfOptions.jsPDF) || {};
                const orientation = jsPdfOptions.orientation === 'landscape' ? 'landscape' : 'portrait';
                const pageSize = orientation === 'landscape'
                    ? { width: 297, height: 210 }
                    : { width: 210, height: 297 };
                const rawMargin = typeof pdfOptions.margin === 'number' ? pdfOptions.margin : 0.25;
                const marginMm = Math.max(0, rawMargin * 25.4);
                const contentWidth = Math.max(20, pageSize.width - (marginMm * 2));
                const contentHeight = Math.max(20, pageSize.height - (marginMm * 2));
                const sliceHeightPx = Math.max(1, Math.floor(canvas.width * contentHeight / contentWidth));
                const sliceCanvases = [];

                for (let sy = 0; sy < canvas.height; sy += sliceHeightPx) {
                    const sh = Math.min(sliceHeightPx, canvas.height - sy);
                    const pageCanvas = document.createElement('canvas');
                    pageCanvas.width = canvas.width;
                    pageCanvas.height = sh;
                    const ctx = pageCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
                    ctx.fillStyle = '#f7f3ea';
                    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, pageCanvas.width, sh);
                    if (sliceCanvases.length === 0 || pdfSliceHasInk(pageCanvas)) sliceCanvases.push(pageCanvas);
                }

                // Defensive final trim for a uniform trailing slice.
                while (sliceCanvases.length > 1 && !pdfSliceHasInk(sliceCanvases[sliceCanvases.length - 1])) {
                    sliceCanvases.pop();
                }

                const pdf = new JsPDF({ orientation, unit: 'mm', format: 'a4', compress: true });
                const imageConfig = (pdfOptions && pdfOptions.image) || {};
                const requestedType = String(imageConfig.type || 'png').toLowerCase();
                const useJpeg = requestedType === 'jpeg' || requestedType === 'jpg';
                const mime = useJpeg ? 'image/jpeg' : 'image/png';
                const quality = Number.isFinite(Number(imageConfig.quality)) ? Number(imageConfig.quality) : 1;

                sliceCanvases.forEach((pageCanvas, pageIndex) => {
                    if (pageIndex > 0) pdf.addPage('a4', orientation);
                    const imageData = pageCanvas.toDataURL(mime, quality);
                    const renderedHeight = contentWidth * (pageCanvas.height / pageCanvas.width);
                    pdf.addImage(imageData, useJpeg ? 'JPEG' : 'PNG', marginMm, marginMm, contentWidth, renderedHeight, undefined, useJpeg ? 'MEDIUM' : 'FAST');
                });

                pdf.save(filename);
            } finally {
                restore();
            }
        }

        async function exportCurrentTransactionPDF() {
            const tx = getTransaction(currentTxId);
            if (!tx) return showToast('المعاملة غير موجودة', 'error');
            if (!(window.jspdf?.jsPDF || window.jsPDF)) return showToast('مكتبة PDF غير متاحة حالياً', 'error');

            const company = db.companies.find(c => String(c.id) === String(tx.companyId));
            const directLawyer = db.lawyers.find(l => String(l.id) === String(tx.lawyerId));
            const lawyer = directLawyer || db.lawyers.find(l => String(l.id) === String(company?.lawyerId));
            const companyName = company?.name || 'غير مسجلة';
            const lawyerName = lawyer?.name || 'غير مسجل';
            const statusNames = { active: 'جارية', stalled: 'متلكئة', completed: 'منجزة' };
            const priorityNames = { normal: 'عادية', high: 'مهمة', urgent: 'عاجلة' };
            const payments = Array.isArray(tx.payments) ? tx.payments : [];
            const followUps = Array.isArray(tx.followUps) ? tx.followUps : [];
            const notes = Array.isArray(tx.notes) ? tx.notes : [];
            const activity = getTransactionTimeline(tx).slice().reverse();
            const stations = Array.isArray(tx.stations) ? tx.stations : [];
            const vaultCount = db.vault.filter(v => String(v.companyId) === String(tx.companyId)).length;

            const rows = activity.map(a => `<tr><td style="padding:7px;border:1px solid #d9ddcf">${escapeHtml(formatShortDate(a.date))}</td><td style="padding:7px;border:1px solid #d9ddcf">${escapeHtml(a.text || '')}</td></tr>`).join('');
            const paymentRows = payments.map(p => `<tr${p.status === 'reversed' ? ' style="opacity:.65"' : ''}><td style="padding:7px;border:1px solid #d9ddcf">${escapeHtml(formatShortDate(p.date))}</td><td style="padding:7px;border:1px solid #d9ddcf">${escapeHtml(p.method || 'نقدي')}${p.status === 'reversed' ? ` — معكوسة: ${escapeHtml(p.reversalReason || '')}` : ''}</td><td style="padding:7px;border:1px solid #d9ddcf;${p.status === 'reversed' ? 'text-decoration:line-through;' : ''}">${numFormat.format(Number(p.amount)||0)} د.ع</td></tr>`).join('');
            const noteRows = notes.map(n => `<li style="margin-bottom:6px">${escapeHtml(typeof n === 'string' ? n : (n.text || ''))}</li>`).join('');
            const followRows = followUps.map(f => `<tr><td style="padding:7px;border:1px solid #d9ddcf">${escapeHtml(formatShortDate(f.dueAt))}</td><td style="padding:7px;border:1px solid #d9ddcf">${escapeHtml(f.title || '')}</td><td style="padding:7px;border:1px solid #d9ddcf">${f.done ? 'منجزة' : 'مفتوحة'}</td></tr>`).join('');
            const stationRows = stations.map(st => `<tr><td style="padding:7px;border:1px solid #d9ddcf">${escapeHtml(formatShortDate(st.date))}</td><td style="padding:7px;border:1px solid #d9ddcf">${escapeHtml(st.name || '')}</td><td style="padding:7px;border:1px solid #d9ddcf">${escapeHtml(st.user || '')}</td></tr>`).join('');

            const pdfSection = (title, content) => `<div style="margin:14px 0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="width:5px;height:22px;border-radius:99px;background:#f47a1f"></span><h3 style="margin:0;font-size:15px;color:#2b3725">${title}</h3></div><table style="width:100%;border-collapse:separate;border-spacing:0;font-size:12px;border:1px solid #d9ddcf;border-radius:12px;overflow:hidden;background:#fff"><tbody>${content}</tbody></table></div>`;

            const wrapper = document.createElement('div');
            wrapper.dir = 'rtl';
            wrapper.style.cssText = 'width:794px;box-sizing:border-box;background:#f7f3ea;color:#20261d;padding:30px;font-family:Tahoma,Arial,sans-serif;';
            const cell = 'padding:8px;border-top:1px solid #d9ddcf;border-left:1px solid #e3e6dc;';
            const labelCell = `${cell}font-weight:900;color:#65734f;background:#f4f1e9;`;
            wrapper.innerHTML = `
                <div style="border:2px solid #39482f;border-radius:22px;overflow:hidden;background:#fffdf8">
                    <div style="height:9px;background:linear-gradient(90deg,#f47a1f,#ff9a52 38%,#65734f 38%,#39482f 100%)"></div>
                    <div style="padding:28px 30px 30px">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:2px solid #d9ddcf;padding-bottom:18px;margin-bottom:20px">
                            <div><span style="display:inline-block;background:#fff0df;color:#d85c12;border:1px solid #ffd8b8;border-radius:999px;padding:4px 9px;font-size:10px;font-weight:900">TRANSACTION / MOAQIB</span><h1 style="margin:8px 0 3px;font-size:26px;color:#2b3725">تقرير معاملة</h1><p style="margin:0;font-size:11px;color:#7d8378">${escapeHtml(new Date().toLocaleString('ar-IQ'))}</p></div>
                            <div style="text-align:left"><strong style="font-size:18px;color:#2b3725">${escapeHtml(db.settings.name || 'MOAQIB')}</strong><p style="margin:4px 0 0;font-size:11px;color:#6f7469">${escapeHtml(db.settings.address || '')}</p></div>
                        </div>
                        <div style="background:#eef1e7;border:1px solid #d9ddcf;border-radius:16px;padding:16px 18px;margin-bottom:14px"><span style="font-size:10px;color:#65734f;font-weight:900">CASE</span><h2 style="margin:3px 0 0;font-size:21px;color:#20261d">${escapeHtml(tx.type)}</h2></div>
                        <table style="width:100%;border-collapse:separate;border-spacing:0;font-size:12px;border:1px solid #d9ddcf;border-radius:14px;overflow:hidden;margin-bottom:14px"><tbody>
                            <tr><td style="${labelCell}border-top:0">الشركة</td><td style="${cell}border-top:0">${escapeHtml(companyName)}</td><td style="${labelCell}border-top:0">المحامي</td><td style="${cell}border-top:0;border-left:0">${escapeHtml(lawyerName)}</td></tr>
                            <tr><td style="${labelCell}">الدائرة</td><td style="${cell}">${escapeHtml(tx.dept || '')}</td><td style="${labelCell}">الحالة</td><td style="${cell}border-left:0">${escapeHtml(statusNames[tx.status] || tx.status)}</td></tr>
                            <tr><td style="${labelCell}">الأولوية</td><td style="${cell}">${escapeHtml(priorityNames[tx.priority] || tx.priority)}</td><td style="${labelCell}">المستندات</td><td style="${cell}border-left:0">${vaultCount}</td></tr>
                        </tbody></table>
                        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:20px">
                            <div style="border:1px solid #f4cfaf;background:#fff0df;border-radius:14px;padding:11px;text-align:center"><span style="font-size:10px;color:#a75516;font-weight:800">الأتعاب</span><strong style="display:block;margin-top:3px;font-size:17px;color:#d85c12">${numFormat.format(Number(tx.fee)||0)} د.ع</strong></div>
                            <div style="border:1px solid #cfd8c6;background:#eef1e7;border-radius:14px;padding:11px;text-align:center"><span style="font-size:10px;color:#65734f;font-weight:800">المدفوع</span><strong style="display:block;margin-top:3px;font-size:17px;color:#39482f">${numFormat.format(getPaidAmount(tx))} د.ع</strong></div>
                            <div style="border:1px solid #d9ddcf;background:#fffdf8;border-radius:14px;padding:11px;text-align:center"><span style="font-size:10px;color:#6f7469;font-weight:800">المتبقي</span><strong style="display:block;margin-top:3px;font-size:17px;color:#2b3725">${numFormat.format(getRemainingAmount(tx))} د.ع</strong></div>
                        </div>
                        ${pdfSection('المحطات', stationRows || '<tr><td style="padding:8px">لا توجد محطات مسجلة</td></tr>')}
                        ${pdfSection('الدفعات', paymentRows || '<tr><td style="padding:8px">لا توجد دفعات مسجلة</td></tr>')}
                        ${pdfSection('المتابعات', followRows || '<tr><td style="padding:8px">لا توجد متابعات</td></tr>')}
                        <div style="margin:14px 0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="width:5px;height:22px;border-radius:99px;background:#f47a1f"></span><h3 style="margin:0;font-size:15px;color:#2b3725">الملاحظات</h3></div><div style="border:1px solid #d9ddcf;border-radius:12px;background:#fff;padding:10px 14px"><ul style="font-size:11px;line-height:1.8;padding-right:18px;margin:0">${noteRows || '<li>لا توجد ملاحظات</li>'}</ul></div></div>
                        ${pdfSection('السجل الزمني', rows || '<tr><td style="padding:8px">لا يوجد سجل</td></tr>')}
                    </div>
                </div>`;
            document.body.appendChild(wrapper);

            const filename = `معاملة_${safeFileName(tx.type)}_${String(tx.id).slice(-8)}.pdf`;
            customAlert('جاري تجهيز التقرير', 'يتم إنشاء ملف PDF، يرجى الانتظار...', 'info');
            try {
                await exportPdfElement(wrapper, filename, {
                    raster: { scale: 2.2 },
                    image: { type: 'png', quality: 1 },
                    jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
                });
                showToast('تم إنشاء تقرير المعاملة بنجاح','success');
            } catch (err) {
                showToast(`تعذر إنشاء التقرير: ${err?.message || 'خطأ غير معروف'}`, 'error');
            } finally {
                closeUiAlert();
                wrapper.remove();
            }
        }

        // ==========================================
        // 10. محرك إنشاء الـ PDF والتصدير
        // ==========================================

        // الدالة المسؤولة عن تحويل الـ HTML المخفي إلى ملف PDF للطباعة
        async function triggerPDF(lawyerId, type, amount, receiptContext = null) {
            try {
                const lawyer = getLawyerById(lawyerId) || { name: 'عميل غير معروف' };
                const accountTransactions = type === 'report' ? getLawyerAccountTransactions(lawyerId) : [];
                const receiptPayment = receiptContext?.payment || null;
                const receiptTransaction = receiptContext?.transaction || null;
                if (type === 'receipt' && (!receiptPayment || !receiptTransaction)) {
                    return showToast('يجب اختيار دفعة مسجلة لإصدار سند قبض', 'error');
                }
                if (type === 'receipt' && receiptPayment.status === 'reversed') {
                    return showToast('لا يمكن إصدار سند قبض لدفعة معكوسة', 'error');
                }
                const documentAmount = type === 'receipt'
                    ? Math.max(0, Number(receiptPayment.amount) || 0)
                    : accountTransactions.reduce((sum, tx) => sum + getRemainingAmount(tx), 0);
                const dateStr = new Date().toLocaleDateString('ar-IQ'); 
                const refNo = type === 'receipt'
                    ? String(receiptPayment.receiptRef || buildPaymentReceiptRef(receiptPayment.id))
                    : 'REF-' + Date.now().toString().slice(-6);
                
                // 1. تعبئة البيانات الأساسية في قالب الـ PDF المخفي
                document.getElementById('pdf-title').innerText = type === 'receipt' ? 'سند استلام مالي رسمي' : 'كشف حساب معاملات تفصيلي';
                document.getElementById('pdf-date').innerText = dateStr; 
                document.getElementById('pdf-ref').innerText = refNo;
                document.getElementById('pdf-issuer-name').innerText = db.settings.name || 'مكتب تخليص المعاملات'; 
                document.getElementById('pdf-issuer-address').innerText = db.settings.address || 'بغداد - العراق';
                document.getElementById('pdf-sig-name').innerText = db.settings.name || 'التوقيع والختم المعتمد';
                document.getElementById('pdf-lawyer-name').innerText = lawyer.name; 
                document.getElementById('pdf-doc-type').innerText = type === 'receipt' ? 'قيد قبض دفعة مالية مسجلة' : 'كشف حساب جميع المعاملات';
                document.getElementById('pdf-amount').innerText = numFormat.format(documentAmount) + ' د.ع';

                // 2. معالجة إظهار التوقيع الإلكتروني
                const sigImg = document.getElementById('pdf-signature-img');
                if(db.settings.signature) { 
                    sigImg.src = db.settings.signature; 
                    sigImg.style.display = 'block'; 
                } else { 
                    sigImg.style.display = 'none'; 
                }

                // 3. تصميم وبناء جدول تفاصيل المعاملات (إذا كان المطلوب كشف وليس وصل)
                const listContainer = document.getElementById('pdf-tx-list-container');
                if(type === 'report') {
                    const txs = accountTransactions;
                    document.getElementById('pdf-tx-list').innerHTML = `
                        <table style="width:100%; border-collapse: collapse; margin-top: 10px;">
                            <thead>
                                <tr style="background-color: #39482f; color: #ffffff; font-size: 14px; text-align: right;">
                                    <th style="padding: 10px; border-bottom: 2px solid #65734f;">نوع المعاملة</th>
                                    <th style="padding: 10px; border-bottom: 2px solid #65734f;">الشركة المعنية</th>
                                    <th style="padding: 10px; border-bottom: 2px solid #65734f; text-align: left;">الأتعاب</th>
                                    <th style="padding: 10px; border-bottom: 2px solid #65734f; text-align: left;">المدفوع</th>
                                    <th style="padding: 10px; border-bottom: 2px solid #65734f; text-align: left;">المتبقي</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${txs.map(t => `
                                    <tr style="border-bottom: 1px solid #d9ddcf; font-size: 14px;">
                                        <td style="padding: 10px; font-weight: 700; color: #20261d;">${escapeHtml(t.type)}</td>
                                        <td style="padding: 10px; color: #6f7469;">${escapeHtml(companyName(t.companyId) || 'غير مسجلة')}</td>
                                        <td style="padding: 10px; text-align: left; direction: ltr; font-weight: 800; color: #d85c12;">${numFormat.format(t.fee)} IQD</td>
                                        <td style="padding: 10px; text-align: left; direction: ltr; font-weight: 800; color: #47703f;">${numFormat.format(getPaidAmount(t))} IQD</td>
                                        <td style="padding: 10px; text-align: left; direction: ltr; font-weight: 800; color: #9b3f2e;">${numFormat.format(getRemainingAmount(t))} IQD</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    `;
                    listContainer.style.display = 'block';
                } else {
                    document.getElementById('pdf-tx-list').innerHTML = `
                        <table style="width:100%; border-collapse: collapse; margin-top: 10px;">
                            <tbody>
                                <tr><td style="padding:9px;border:1px solid #d9ddcf;font-weight:800;">المعاملة</td><td style="padding:9px;border:1px solid #d9ddcf;">${escapeHtml(receiptTransaction.type || '—')}</td></tr>
                                <tr><td style="padding:9px;border:1px solid #d9ddcf;font-weight:800;">الشركة</td><td style="padding:9px;border:1px solid #d9ddcf;">${escapeHtml(companyName(receiptTransaction.companyId) || 'غير مسجلة')}</td></tr>
                                <tr><td style="padding:9px;border:1px solid #d9ddcf;font-weight:800;">تاريخ الدفعة</td><td style="padding:9px;border:1px solid #d9ddcf;">${escapeHtml(formatShortDate(receiptPayment.date))}</td></tr>
                                <tr><td style="padding:9px;border:1px solid #d9ddcf;font-weight:800;">طريقة الدفع</td><td style="padding:9px;border:1px solid #d9ddcf;">${escapeHtml(receiptPayment.method || 'نقدي')}</td></tr>
                            </tbody>
                        </table>`;
                    listContainer.style.display = 'block'; 
                }

                // 4. إنشاء الباركود (QR Code) بشكل آمن
                const qrTarget = document.getElementById("qr-target");
                qrTarget.innerHTML = "";
                if (typeof QRCode !== 'undefined') {
                    try {
                        new QRCode(qrTarget, { 
                            text: `Ref:${refNo}|Client:${lawyer.name}|Total:${documentAmount}|Type:${type}`, 
                            width: 85, 
                            height: 85, 
                            colorDark : "#2b3725", 
                            colorLight : "#ffffff" 
                        });
                    } catch (e) {
                        console.log("QR skipped safely");
                    }
                }

                customAlert('جاري التجهيز', 'يتم تصدير المستند الاحترافي الآن...', 'info');

                const wrapper = document.getElementById('pdf-export-wrapper');
                const pdfContent = document.getElementById('pdf-content');
                const filename = `${type}_${safeFileName(lawyer.name)}.pdf`;

                try {
                    await exportPdfElement(pdfContent, filename, {
                        margin: 0.25,
                        image: { type: 'png', quality: 1 },
                        raster: { scale: 2.2 },
                        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
                    });
                    showToast('تم تصدير المستند بنجاح', 'success');
                } catch (err) {
                    showToast('خطأ في التصدير: ' + (err?.message || 'خطأ غير معروف'), 'error');
                } finally {
                    closeUiAlert();
                    wrapper.classList.remove('pdf-rendering');
                }

            } catch (error) {
                alert('حدث خطأ في النظام: ' + error.message);
            }
        }

        // ==========================================================
        // PRODUCTIVITY 02 — BOOTSTRAP HOOK
        // ----------------------------------------------------------
        // V6 Core still owns init() and initializeCloudSync(). The optional
        // productivity layer can install presentation/performance wrappers
        // BEFORE the first render, then starts the untouched V6 lifecycle once.
        // If productivity.js is absent, V6 starts normally.
        // ==========================================================
        const startMoaqibV6 = () => {
            init();
            initializeCloudSync();
        };
        if (typeof window.MOAQIB_PRODUCTIVITY_BOOTSTRAP === 'function') {
            window.MOAQIB_PRODUCTIVITY_BOOTSTRAP(startMoaqibV6);
        } else {
            startMoaqibV6();
        }
