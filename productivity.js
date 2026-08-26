/* ============================================================================
   MOAQIB V6 — PRODUCTIVITY 06
   ============================================================================
   This layer adds:
   - Performance-first rendering wrappers (lazy hidden views)
   - Lazy loading of heavy Chart/PDF libraries
   - Daily Command Center + full Daily Workspace (read-only over db)
   - Quick Actions router that reuses audited V6 mutation paths
   - PWA install / service-worker registration / online state
   - Notification permission + active-session reminders
   - Offline-first sync status + online retry bridge
   - Web Push subscription client (activated when VAPID is configured)

   IMPORTANT MAINTENANCE RULES
   ---------------------------
   1) No V6 database schema is changed here.
   2) No transaction/accounting/PDF calculation is reimplemented here.
   3) Notification preferences/history are device-local and stored under their
      own productivity keys, not inside db/Supabase snapshots.
   4) Fully closed-app Web Push activates only after the optional Supabase/VAPID
      backend package included in this build is deployed and configured.
   ============================================================================ */
(() => {
    'use strict';

    const PRODUCTIVITY_VERSION = 'v6-productivity-06';
    const PREF_KEY = 'moaqib_productivity_prefs_v1';
    const NOTIFY_HISTORY_KEY = 'moaqib_notification_history_v1';
    const SYNC_META_KEY = 'moaqib_sync_meta_v1';
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const STALE_AFTER = 7 * ONE_DAY;
    const REMINDER_WINDOW = 60 * 60 * 1000;
    const REMINDER_SCAN_INTERVAL = 5 * 60 * 1000;
    const DAILY_CACHE_TTL = 60 * 1000;

    // Productivity preferences are device-local. They are never written into V6 db.
    const DEFAULT_PREFS = Object.freeze({
        notificationsEnabled: false,
        remindSoon: true,
        remindLate: true,
        remindStalled: true,
        remindStale: true,
        dailyBrief: true,
        dailyBriefTime: '08:00'
    });

    // Reuse formatters instead of rebuilding Intl objects during every dashboard refresh.
    const DAY_FORMATTER = new Intl.DateTimeFormat('ar-IQ', { weekday: 'short' });
    const DATE_FORMATTER = new Intl.DateTimeFormat('ar-IQ', { day: 'numeric', month: 'short' });
    const TIME_FORMATTER = new Intl.DateTimeFormat('ar-IQ', { hour: '2-digit', minute: '2-digit' });

    const LIBRARIES = {
        chart: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
        jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
        qrcode: 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
    };

    const state = {
        deferredInstallPrompt: null,
        swRegistration: null,
        reminderTimer: null,
        libraryPromises: new Map(),
        chartIdleHandle: null,
        pushSubscription: null,
        lastSyncSignal: null,
        // Productivity 04: volatile UI state only. Never persisted into V6 db.
        dailyQueueSnapshot: null,
        dailyFilter: 'all',
        quickAction: null,
        quickPickerSource: null,
        quickPickerTimer: null,
        // PRODUCTIVITY 05 — performance bookkeeping only; never persisted into V6 db.
        firstRenderDone: false,
        deferredHiddenRender: false,
        dataRevision: 0,
        dailyQueueRevision: -1,
        lastRenderMs: 0,
        renderSamples: []
    };

    /* -------------------------------------------------------------------------
       01. Small safe helpers
       ------------------------------------------------------------------------- */
    function idle(callback, timeout = 1200) {
        if ('requestIdleCallback' in window) return requestIdleCallback(callback, { timeout });
        return setTimeout(callback, Math.min(timeout, 250));
    }

    function activeViewName() {
        const active = document.querySelector('.mq-view.active');
        return active?.id?.replace(/^view-/, '') || 'home';
    }

    function readPrefs() {
        try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}) }; }
        catch (_) { return { ...DEFAULT_PREFS }; }
    }

    function writePrefs(next) {
        const merged = { ...readPrefs(), ...next };
        localStorage.setItem(PREF_KEY, JSON.stringify(merged));
        return merged;
    }

    function validBriefTime(value) {
        const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
        if (!match) return false;
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
    }

    function localTimezone() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
        catch (_) { return 'UTC'; }
    }

    function readSyncMeta() {
        try {
            return { pendingChanges: 0, lastSyncedAt: null, lastStatus: 'idle', ...(JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}') || {}) };
        } catch (_) {
            return { pendingChanges: 0, lastSyncedAt: null, lastStatus: 'idle' };
        }
    }

    function writeSyncMeta(next) {
        const merged = { ...readSyncMeta(), ...next };
        localStorage.setItem(SYNC_META_KEY, JSON.stringify(merged));
        return merged;
    }

    function formatSyncTime(value) {
        if (!value) return 'لم تتم مزامنة بعد';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'لم تتم مزامنة بعد';
        return `آخر مزامنة ${date.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' })}`;
    }

    function requestBackgroundSync() {
        const registration = state.swRegistration;
        if (!registration?.sync?.register) return;
        registration.sync.register('moaqib-cloud-sync').catch(() => {});
    }

    function updateSyncUi(statusOverride = null) {
        const meta = readSyncMeta();
        const online = navigator.onLine;
        const status = statusOverride || meta.lastStatus || 'idle';
        const stateEl = document.getElementById('mq-online-state');
        const label = document.getElementById('mq-online-label') || stateEl?.querySelector('span');
        const note = document.getElementById('mq-sync-note');
        const settingsStatus = document.getElementById('mq-sync-status');
        const settingsDetail = document.getElementById('mq-sync-detail');
        const banner = document.getElementById('mq-sync-banner');
        const bannerIcon = document.getElementById('mq-sync-banner-icon');
        const bannerTitle = document.getElementById('mq-sync-banner-title');
        const bannerDetail = document.getElementById('mq-sync-banner-detail');

        stateEl?.classList.toggle('is-offline', !online);
        stateEl?.classList.toggle('is-syncing', status === 'syncing');
        stateEl?.classList.toggle('has-pending', Number(meta.pendingChanges) > 0);
        stateEl?.classList.toggle('has-conflict', status === 'conflict');

        if (label) {
            if (!online) label.textContent = 'غير متصل';
            else if (status === 'conflict') label.textContent = 'تعارض يحتاج قراراً';
            else if (status === 'syncing') label.textContent = 'مزامنة...';
            else if (meta.pendingChanges > 0) label.textContent = 'بانتظار المزامنة';
            else label.textContent = 'متصل';
        }
        if (note) {
            note.textContent = status === 'conflict'
                ? 'اختر النسخة المطلوبة قبل استئناف المزامنة'
                : !online
                ? (meta.pendingChanges ? `${meta.pendingChanges} تغييرات محفوظة محلياً` : 'العمل المحلي متاح')
                : (meta.pendingChanges ? `${meta.pendingChanges} تغييرات بانتظار الرفع` : formatSyncTime(meta.lastSyncedAt));
        }
        if (settingsStatus) {
            settingsStatus.textContent = status === 'conflict' ? 'تعارض' : !online ? 'Offline' : status === 'syncing' ? 'جارٍ الرفع' : meta.pendingChanges ? 'بانتظار الرفع' : 'متزامن';
            settingsStatus.classList.toggle('is-warning', status === 'conflict' || !online || meta.pendingChanges > 0);
        }
        if (settingsDetail) settingsDetail.textContent = status === 'conflict'
            ? 'أوقف التطبيق الرفع لحماية النسختين. افتح نافذة حل التعارض واختر النسخة المطلوبة.'
            : meta.pendingChanges
            ? `${meta.pendingChanges} تغييرات محفوظة على هذا الجهاز وستُرفع تلقائياً.`
            : formatSyncTime(meta.lastSyncedAt);

        // A single compact banner communicates offline/pending/syncing states across
        // every screen. It stays hidden when everything is healthy to avoid noise.
        if (banner) {
            const show = status === 'conflict' || !online || status === 'syncing' || Number(meta.pendingChanges) > 0;
            banner.classList.toggle('hidden', !show);
            banner.classList.toggle('is-offline', !online);
            banner.classList.toggle('is-syncing', status === 'syncing');
            banner.classList.toggle('has-conflict', status === 'conflict');
            banner.classList.toggle('has-pending', online && !['syncing', 'conflict'].includes(status) && Number(meta.pendingChanges) > 0);
            if (bannerIcon) bannerIcon.className = status === 'conflict' ? 'fa-solid fa-code-compare' : !online ? 'fa-solid fa-cloud-slash' : status === 'syncing' ? 'fa-solid fa-arrows-rotate' : 'fa-solid fa-cloud-arrow-up';
            if (bannerTitle) bannerTitle.textContent = status === 'conflict' ? 'تعارض بين نسختين' : !online ? 'أنت تعمل بدون إنترنت' : status === 'syncing' ? 'جارٍ مزامنة التغييرات' : 'تغييرات بانتظار الرفع';
            if (bannerDetail) bannerDetail.textContent = status === 'conflict'
                ? 'أوقف MOAQIB الرفع تلقائياً. اضغط مزامنة لفتح خيارات الحل دون فقدان أي نسخة.'
                : !online
                ? (meta.pendingChanges ? `${meta.pendingChanges} تغييرات محفوظة بأمان على هذا الجهاز.` : 'يمكنك متابعة العمل وسيتم الرفع عند عودة الاتصال.')
                : status === 'syncing' ? 'لا تغلق التطبيق للحظات حتى يكتمل الرفع.' : `${meta.pendingChanges} تغييرات محفوظة محلياً وجاهزة للمزامنة.`;
        }
    }

    function handleSyncSignal(detail = {}) {
        const status = detail.status || 'idle';
        const current = readSyncMeta();
        let pendingChanges = Number(current.pendingChanges) || 0;
        if (detail.localChange) pendingChanges += 1;
        if (status === 'synced') pendingChanges = 0;
        if (status === 'conflict') pendingChanges = Math.max(1, pendingChanges);
        const next = writeSyncMeta({
            pendingChanges,
            lastStatus: status,
            lastSyncedAt: status === 'synced' ? Date.now() : current.lastSyncedAt
        });
        if (detail.localChange || ['cloud-load','local-cache','local-pending-recovery'].includes(detail.source)) {
            state.dataRevision += 1;
            state.dailyQueueSnapshot = null;
            state.dailyQueueRevision = -1;
        }
        state.lastSyncSignal = { ...detail, meta: next, at: Date.now() };
        updateSyncUi(status);
        if ((status === 'pending-offline' || (!navigator.onLine && pendingChanges)) && pendingChanges) requestBackgroundSync();
    }

    // app.js calls this bridge after local saves / cloud results. It is defined
    // before app.js executes, so the core never imports productivity code.
    window.MOAQIB_PRODUCTIVITY_SYNC_STATE = handleSyncSignal;

    window.syncMoaqibNow = async function syncMoaqibNow(options = {}) {
        if (!navigator.onLine) {
            updateSyncUi('pending-offline');
            if (!options.silent) window.showToast?.('لا يوجد اتصال. بياناتك محفوظة محلياً.', 'info');
            return false;
        }
        try {
            updateSyncUi('syncing');
            const ok = await window.flushMoaqibCloudSync?.();
            if (!options.silent) window.showToast?.(ok ? 'تمت المزامنة مع السحابة' : 'لا توجد مزامنة متاحة الآن', ok ? 'success' : 'info');
            return !!ok;
        } catch (error) {
            console.warn('Manual sync failed:', error);
            if (!options.silent) window.showToast?.('تعذر إكمال المزامنة الآن', 'error');
            return false;
        }
    };

    // MOAQIB FINAL — bounded lazy-loader. A failed CDN request is removable and
    // retryable instead of leaving PDF/Chart actions waiting on a stale <script>.
    function loadScriptOnce(src, ready) {
        if (typeof ready === 'function' && ready()) return Promise.resolve(true);
        if (state.libraryPromises.has(src)) return state.libraryPromises.get(src);

        const promise = new Promise((resolve, reject) => {
            let script = [...document.scripts].find(s => s.src === src);
            if (script?.dataset?.mqLoadState === 'failed' || (script?.dataset?.mqLoadState === 'loaded' && typeof ready === 'function' && !ready())) {
                script.remove();
                script = null;
            }

            if (!script) {
                script = document.createElement('script');
                script.src = src;
                script.async = true;
                script.crossOrigin = 'anonymous';
                script.dataset.mqLazyLibrary = PRODUCTIVITY_VERSION;
                script.dataset.mqLoadState = 'loading';
                document.head.appendChild(script);
            }

            let settled = false;
            const cleanup = () => {
                clearTimeout(timer);
                script.removeEventListener('load', onLoad);
                script.removeEventListener('error', onError);
            };
            const fail = (error) => {
                if (settled) return;
                settled = true;
                script.dataset.mqLoadState = 'failed';
                cleanup();
                script.remove();
                reject(error instanceof Error ? error : new Error(`تعذر تحميل المكتبة: ${src}`));
            };
            const onLoad = () => {
                if (settled) return;
                if (typeof ready === 'function' && !ready()) return fail(new Error(`تم تحميل المكتبة دون تهيئة واجهتها: ${src}`));
                settled = true;
                script.dataset.mqLoadState = 'loaded';
                cleanup();
                resolve(true);
            };
            const onError = () => fail(new Error(`تعذر تحميل المكتبة: ${src}`));
            const timer = window.setTimeout(() => fail(new Error(`انتهت مهلة تحميل المكتبة: ${src}`)), 15000);
            script.addEventListener('load', onLoad, { once: true });
            script.addEventListener('error', onError, { once: true });

            // A script may have completed between discovery and listener setup.
            if (typeof ready === 'function' && ready()) onLoad();
        }).finally(() => {
            if (typeof ready === 'function' && !ready()) state.libraryPromises.delete(src);
        });

        state.libraryPromises.set(src, promise);
        return promise;
    }

    async function ensureChartLibrary() {
        return loadScriptOnce(LIBRARIES.chart, () => typeof window.Chart !== 'undefined');
    }

    async function ensurePdfLibraries() {
        await Promise.all([
            loadScriptOnce(LIBRARIES.jspdf, () => !!(window.jspdf?.jsPDF || window.jsPDF)),
            loadScriptOnce(LIBRARIES.qrcode, () => typeof window.QRCode !== 'undefined')
        ]);
        return true;
    }

    /* -------------------------------------------------------------------------
       02. Performance wrappers
       -------------------------------------------------------------------------
       V6 renderAll() historically refreshes every hidden screen after each save.
       This wrapper keeps the original function intact but temporarily no-ops
       expensive hidden-view renderers. The selected view is refreshed on entry.
       ------------------------------------------------------------------------- */
    function installPerformanceWrappers() {
        const baseRenderAll = window.renderAll;
        const baseSwitchTab = window.switchTab;
        const baseInitChart = window.initChart;
        const baseDashboard = window.renderV6Dashboard;
        const baseSaveData = window.saveData;

        // Keep the Daily Workspace cache coherent without duplicating any mutation
        // logic. V6 still performs the actual save; we only invalidate derived UI.
        if (typeof baseSaveData === 'function') {
            window.saveData = function productivitySaveBridge(...args) {
                state.dataRevision += 1;
                state.dailyQueueSnapshot = null;
                state.dailyQueueRevision = -1;
                return baseSaveData.apply(this, args);
            };
        }

        if (typeof baseDashboard === 'function') {
            window.renderV6Dashboard = function productivityDashboardBridge(...args) {
                const result = baseDashboard.apply(this, args);
                try { renderProductivityDashboard(); } catch (error) { console.warn('Productivity dashboard skipped:', error); }
                return result;
            };
        }

        if (typeof baseInitChart === 'function') {
            window.initChart = function deferredChartRender() {
                const view = activeViewName();
                if (!['home', 'analytics'].includes(view)) return;
                if (state.chartIdleHandle) {
                    try { if ('cancelIdleCallback' in window) cancelIdleCallback(state.chartIdleHandle); else clearTimeout(state.chartIdleHandle); } catch (_) {}
                }
                state.chartIdleHandle = idle(async () => {
                    try {
                        await ensureChartLibrary();
                        baseInitChart();
                    } catch (error) {
                        console.warn('Chart library unavailable:', error);
                    }
                }, 1600);
            };
        }

        if (typeof baseRenderAll === 'function') {
            const heavyRenderers = [
                'renderSettingsEntities', 'renderGovernancePanel', 'renderTransactionsHub', 'renderArchive',
                'renderAccounting', 'renderVault', 'initChart', 'renderV6Dashboard'
            ];

            window.renderAll = function optimizedRenderAll() {
                // Always allow the first render. After startup, background saves do not
                // waste CPU rebuilding invisible DOM; one consolidated render runs when
                // the app becomes visible again.
                if (document.hidden && state.firstRenderDone) {
                    state.deferredHiddenRender = true;
                    state.dailyQueueSnapshot = null;
                    return;
                }

                const view = activeViewName();
                const allow = {
                    renderSettingsEntities: view === 'settings',
                    renderGovernancePanel: view === 'settings',
                    renderTransactionsHub: view === 'active',
                    renderArchive: view === 'archive',
                    renderAccounting: view === 'accounting',
                    renderVault: view === 'archive' && document.getElementById('archive-vault-content')?.style.display === 'block',
                    initChart: view === 'home' || view === 'analytics',
                    renderV6Dashboard: view === 'home'
                };

                const originals = new Map();
                heavyRenderers.forEach(name => {
                    if (allow[name] || typeof window[name] !== 'function') return;
                    originals.set(name, window[name]);
                    window[name] = () => {};
                });

                const started = performance.now();
                try {
                    return baseRenderAll();
                } finally {
                    originals.forEach((fn, name) => { window[name] = fn; });
                    state.firstRenderDone = true;
                    state.deferredHiddenRender = false;
                    state.lastRenderMs = Math.max(0, performance.now() - started);
                    state.renderSamples.push(state.lastRenderMs);
                    if (state.renderSamples.length > 20) state.renderSamples.shift();
                }
            };
        }

        if (typeof baseSwitchTab === 'function') {
            window.switchTab = function optimizedSwitchTab(tabId, preserveHubMode = false) {
                const result = baseSwitchTab.call(this, tabId, preserveHubMode);
                const normalized = tabId === 'stalled' ? 'active' : tabId;
                setTimeout(() => renderEnteredView(normalized), 28);
                return result;
            };
        }

        // PDF/QR libraries are lazy; FINAL FIX 01 uses native browser rasterization + jsPDF.
        // Wrap only the public export actions so first export loads them on demand.
        ['exportFinancialReport', 'exportCurrentTransactionPDF', 'triggerPDF'].forEach(name => {
            const original = window[name];
            if (typeof original !== 'function') return;
            window[name] = async function lazyPdfAction(...args) {
                try {
                    if (!(window.jspdf?.jsPDF || window.jsPDF)) {
                        window.showToast?.('جاري تجهيز أدوات PDF لأول مرة...', 'info');
                    }
                    await ensurePdfLibraries();
                    return await original.apply(this, args);
                } catch (error) {
                    console.error('PDF libraries failed:', error);
                    window.showToast?.('تعذر تحميل أدوات PDF. تحقق من الاتصال وحاول مجدداً.', 'error');
                }
            };
        });
    }

    function renderEnteredView(view) {
        try {
            if (view === 'home') {
                window.renderV6Dashboard?.();
                window.initChart?.();
            } else if (view === 'archive') {
                window.renderArchive?.();
                if (document.getElementById('archive-vault-content')?.style.display === 'block') window.renderVault?.();
            } else if (view === 'analytics') {
                window.initChart?.();
            } else if (view === 'settings') {
                window.renderSettingsEntities?.();
                window.renderGovernancePanel?.();
            }
        } catch (error) {
            console.warn('Lazy view render skipped:', error);
        }
    }

    /* -------------------------------------------------------------------------
       03. Daily Workspace — read-only prioritisation + on-demand presentation
       -------------------------------------------------------------------------
       Design rule: calculate once, render twice. The home summary and the full
       Daily Workspace share the same queue snapshot so opening the sheet adds
       no repeated full-db work unless data changed and V6 refreshed Dashboard.
       ------------------------------------------------------------------------- */
    function buildDailyWorkQueue(now = new Date()) {
        if (typeof db === 'undefined' || !db || !Array.isArray(db.transactions)) {
            return { generatedAt: Date.now(), overdueFollowUps: 0, todayFollowUps: 0, needsAttention: 0, items: [] };
        }

        const nowMs = now.getTime();
        const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const endMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
        const byTx = new Map();
        let overdueFollowUps = 0;
        let todayFollowUps = 0;
        let needsAttention = 0;

        function addReason(tx, { score, reason, category, icon = 'fa-circle-exclamation', critical = false, dueAt = null, followUpId = null }) {
            const key = String(tx.id);
            const existing = byTx.get(key) || {
                tx, score: 0, reasons: [], categories: new Set(), icon,
                critical: false, dueAt: null, primaryCategory: category,
                followUpId: null
            };
            const becomesPrimary = score > existing.score || (score === existing.score && dueAt && (!existing.dueAt || Number(new Date(dueAt)) < Number(new Date(existing.dueAt))));
            existing.score = Math.max(existing.score, score);
            if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
            if (category) existing.categories.add(category);
            if (becomesPrimary) {
                existing.icon = icon;
                existing.primaryCategory = category;
                existing.followUpId = followUpId || existing.followUpId;
            }
            existing.critical = existing.critical || critical;
            if (dueAt && (!existing.dueAt || Number(new Date(dueAt)) < Number(new Date(existing.dueAt)))) existing.dueAt = dueAt;
            byTx.set(key, existing);
        }

        db.transactions.forEach(tx => {
            if (!tx || tx.status === 'completed') return;
            let attentionFlag = false;
            const lastTouch = Number(tx.lastUpdate || tx.createdAt || Date.now());
            const age = nowMs - lastTouch;

            if (tx.status === 'stalled') {
                addReason(tx, { score: 92, reason: 'المعاملة متلكئة وتحتاج تدخلاً', category: 'stalled', icon: 'fa-triangle-exclamation', critical: true });
                attentionFlag = true;
            }
            if (tx.priority === 'urgent') {
                addReason(tx, { score: 88, reason: 'أولوية عاجلة', category: 'urgent', icon: 'fa-bolt', critical: true });
                attentionFlag = true;
            } else if (tx.priority === 'high') {
                addReason(tx, { score: 58, reason: 'أولوية مهمة', category: 'high', icon: 'fa-flag' });
            }
            if (tx.status === 'active' && age >= STALE_AFTER) {
                const days = Math.max(7, Math.floor(age / ONE_DAY));
                addReason(tx, { score: 72, reason: `لم تُحدّث منذ ${days} أيام`, category: 'stale', icon: 'fa-clock-rotate-left' });
                attentionFlag = true;
            }

            (Array.isArray(tx.followUps) ? tx.followUps : []).forEach(f => {
                if (!f || f.done || !f.dueAt) return;
                const due = new Date(f.dueAt).getTime();
                if (!Number.isFinite(due)) return;
                if (due < startMs) {
                    overdueFollowUps += 1;
                    addReason(tx, { score: 100, reason: `متابعة متأخرة: ${String(f.title || 'متابعة')}`, category: 'overdue', icon: 'fa-bell', critical: true, dueAt: f.dueAt, followUpId: f.id });
                    attentionFlag = true;
                } else if (due >= startMs && due < endMs) {
                    todayFollowUps += 1;
                    addReason(tx, { score: 82, reason: `متابعة اليوم: ${String(f.title || 'متابعة')}`, category: 'today', icon: 'fa-calendar-day', dueAt: f.dueAt, followUpId: f.id });
                }
            });
            if (attentionFlag) needsAttention += 1;
        });

        const items = [...byTx.values()].sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
            const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
            if (ad !== bd) return ad - bd;
            return Number(b.tx.lastUpdate || 0) - Number(a.tx.lastUpdate || 0);
        });

        return { generatedAt: Date.now(), overdueFollowUps, todayFollowUps, needsAttention, items };
    }

    function getDailyWorkQueue(force = false) {
        const cached = state.dailyQueueSnapshot;
        const freshEnough = cached && (Date.now() - Number(cached.generatedAt || 0)) < DAILY_CACHE_TTL;
        if (!force && freshEnough && state.dailyQueueRevision === state.dataRevision) return cached;
        const snapshot = buildDailyWorkQueue();
        state.dailyQueueSnapshot = snapshot;
        state.dailyQueueRevision = state.dataRevision;
        return snapshot;
    }

    function dailyCategoryLabel(category) {
        return ({ overdue: 'متأخرة', today: 'اليوم', stalled: 'متلكئة', stale: 'بلا تحديث', urgent: 'عاجلة', high: 'مهمة' })[category] || 'أولوية';
    }

    function formatDailyDue(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const now = new Date();
        const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
        if (sameDay) return date.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });
        return date.toLocaleDateString('ar-IQ', { day: 'numeric', month: 'short' });
    }

    // UI/UX REBUILD 02: Home renderer emits ONLY the new mq-command-* components.
    // Keep queue/ranking logic above untouched; this function is presentation-only.
    function renderProductivityDashboard() {
        const snapshot = buildDailyWorkQueue();
        state.dailyQueueSnapshot = snapshot;
        const now = new Date();
        const greeting = document.getElementById('mq-brief-greeting');
        const summary = document.getElementById('mq-brief-summary');
        const day = document.getElementById('mq-brief-day');
        const date = document.getElementById('mq-brief-date');
        const attention = document.getElementById('mq-needs-attention-count');
        const list = document.getElementById('mq-priority-list');

        const hour = now.getHours();
        if (greeting) greeting.textContent = hour < 12 ? 'صباح الخير' : hour < 18 ? 'مساء الخير' : 'مساء هادئ';
        if (day) day.textContent = DAY_FORMATTER.format(now);
        if (date) date.textContent = DATE_FORMATTER.format(now);
        if (attention) attention.textContent = snapshot.needsAttention;

        if (summary) {
            if (!snapshot.overdueFollowUps && !snapshot.todayFollowUps && !snapshot.needsAttention) {
                summary.textContent = 'لا توجد عناصر حرجة الآن. يمكنك متابعة العمل حسب الأولوية.';
            } else {
                const parts = [];
                if (snapshot.overdueFollowUps) parts.push(`${snapshot.overdueFollowUps} متابعة متأخرة`);
                if (snapshot.todayFollowUps) parts.push(`${snapshot.todayFollowUps} متابعة اليوم`);
                if (snapshot.needsAttention) parts.push(`${snapshot.needsAttention} معاملة تحتاج انتباهاً`);
                summary.textContent = `لديك ${parts.join('، ')}.`;
            }
        }

        if (list) {
            const rows = snapshot.items.slice(0, 5);
            list.innerHTML = rows.length ? rows.map(item => {
                const company = window.companyName?.(item.tx.companyId) || 'شركة غير مسجلة';
                const reason = item.reasons.slice(0, 2).join(' · ');
                return `<button class="mq-command-item ${item.critical ? 'is-critical' : ''}" onclick="openTxDetails(${window.jsArg(item.tx.id)})"><span class="mq-command-item-icon"><i class="fa-solid ${item.icon}"></i></span><span class="mq-command-item-copy"><strong>${window.escapeHtml(item.tx.type || company)}</strong><span>${window.escapeHtml(company)} — ${window.escapeHtml(reason)}</span></span><i class="fa-solid fa-chevron-left"></i></button>`;
            }).join('') : `<div class="mq-command-empty"><i class="fa-solid fa-circle-check"></i><span>لا توجد أولويات حرجة الآن. يومك منظم.</span></div>`;
        }

        // If the workspace is already open, refresh it after any normal V6 save.
        if (document.getElementById('mqDailyWorkspace')?.classList.contains('active')) renderDailyWorkspace();
    }

    function filteredDailyItems(snapshot, filter) {
        if (!snapshot?.items) return [];
        if (filter === 'all') return snapshot.items;
        return snapshot.items.filter(item => item.categories?.has(filter));
    }

    function updateDailyCounts(snapshot) {
        const counts = {
            all: snapshot.items.length,
            overdue: snapshot.items.filter(i => i.categories.has('overdue')).length,
            today: snapshot.items.filter(i => i.categories.has('today')).length,
            stalled: snapshot.items.filter(i => i.categories.has('stalled')).length,
            stale: snapshot.items.filter(i => i.categories.has('stale')).length
        };
        Object.entries(counts).forEach(([key, value]) => {
            const el = document.getElementById(`mq-day-count-${key}`);
            if (el) el.textContent = value;
        });
        return counts;
    }

    function renderDailyWorkspace() {
        const list = document.getElementById('mq-day-work-list');
        if (!list) return;
        const snapshot = getDailyWorkQueue();
        const counts = updateDailyCounts(snapshot);
        const filter = ['all','overdue','today','stalled','stale'].includes(state.dailyFilter) ? state.dailyFilter : 'all';
        const rows = filteredDailyItems(snapshot, filter);

        document.querySelectorAll('[data-mq-day-filter]').forEach(button => {
            const active = button.dataset.mqDayFilter === filter;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        const summary = document.getElementById('mq-day-work-summary');
        if (summary) summary.textContent = filter === 'all'
            ? `${counts.all} ملفات مرتبة حسب ما يحتاج التنفيذ أولاً.`
            : `${rows.length} ملفات ضمن «${dailyCategoryLabel(filter)}».`;

        if (!rows.length) {
            list.innerHTML = `<div class="mq-day-empty"><i class="fa-solid fa-circle-check"></i><strong>لا توجد عناصر هنا</strong><span>هذا الجزء من يومك منجز حالياً.</span></div>`;
            return;
        }

        list.innerHTML = rows.map((item, index) => {
            const tx = item.tx;
            const company = window.companyName?.(tx.companyId) || 'شركة غير مسجلة';
            const lawyer = window.lawyerName?.(tx.lawyerId) || '';
            const due = formatDailyDue(item.dueAt);
            const canCompleteFollowUp = item.followUpId && (item.categories.has('overdue') || item.categories.has('today'));
            const category = dailyCategoryLabel(item.primaryCategory);
            return `<article class="mq-day-card ${item.critical ? 'is-critical' : ''}" style="--mq-order:${Math.min(index, 8)}">
                <button type="button" class="mq-day-card-main" onclick="closeDailyWorkspace(); openTxDetails(${window.jsArg(tx.id)})">
                    <span class="mq-day-rank">${String(index + 1).padStart(2, '0')}</span>
                    <span class="mq-day-card-copy"><span class="mq-day-category">${window.escapeHtml(category)}${due ? ` · ${window.escapeHtml(due)}` : ''}</span><strong>${window.escapeHtml(tx.type || company)}</strong><small>${window.escapeHtml(company)}${lawyer ? ` — ${window.escapeHtml(lawyer)}` : ''}</small><em>${window.escapeHtml(item.reasons.slice(0, 2).join(' · '))}</em></span>
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                <div class="mq-day-card-actions">
                    ${canCompleteFollowUp ? `<button type="button" class="is-success" onclick="completeDailyFollowUp(${window.jsArg(tx.id)},${window.jsArg(item.followUpId)})"><i class="fa-solid fa-check"></i><span>إنجاز المتابعة</span></button>` : ''}
                    <button type="button" onclick="closeDailyWorkspace(); openTxDetails(${window.jsArg(tx.id)})"><i class="fa-solid fa-arrow-up-right-from-square"></i><span>فتح الملف</span></button>
                </div>
            </article>`;
        }).join('');
    }

    function updateProductivitySheetLock() {
        const anyOpen = ['mqDailyWorkspace','mqQuickActions','mqQuickPicker'].some(id => document.getElementById(id)?.classList.contains('active'));
        document.body.classList.toggle('mq-productivity-sheet-open', anyOpen);
    }

    window.openDailyWorkspace = function openDailyWorkspace(filter = 'all') {
        state.dailyFilter = ['all','overdue','today','stalled','stale'].includes(filter) ? filter : 'all';
        // Rebuild on explicit open to account for the clock crossing a day boundary.
        state.dailyQueueSnapshot = getDailyWorkQueue(true);
        renderDailyWorkspace();
        document.getElementById('mqDailyWorkspace')?.classList.add('active');
        updateProductivitySheetLock();
    };

    window.closeDailyWorkspace = function closeDailyWorkspace() {
        document.getElementById('mqDailyWorkspace')?.classList.remove('active');
        updateProductivitySheetLock();
    };

    window.setDailyWorkspaceFilter = function setDailyWorkspaceFilter(filter) {
        state.dailyFilter = ['all','overdue','today','stalled','stale'].includes(filter) ? filter : 'all';
        renderDailyWorkspace();
    };

    window.completeDailyFollowUp = function completeDailyFollowUp(txId, followUpId) {
        const before = window.getTransaction?.(txId)?.followUps?.find(f => String(f.id) === String(followUpId));
        if (!before || before.done) return;
        // Reuse the audited V6 mutation path; this layer never writes tx.followUps itself.
        // Important legacy guard: V5/V6 data may contain numeric follow-up IDs while
        // inline handlers receive strings. Pass the actual stored ID back to V6 because
        // toggleFollowUp() intentionally uses strict equality.
        window.toggleFollowUp?.(txId, before.id);
        state.dailyQueueSnapshot = null;
        state.dailyQueueRevision = -1;
        window.renderV6Dashboard?.();
        renderDailyWorkspace();
        window.showToast?.('تم إنجاز المتابعة', 'success');
    };

    window.startMyDay = function startMyDay() {
        window.openDailyWorkspace('all');
    };

    /* -------------------------------------------------------------------------
       04. Quick Actions — no duplicate business logic
       -------------------------------------------------------------------------
       Each action routes into existing V6 functions/UI. For note/follow-up/
       payment we only choose a transaction, open its audited Workspace and then
       call startTxAction(). Document upload routes to the existing company Vault.
       ------------------------------------------------------------------------- */
    const QUICK_ACTION_META = {
        followup: { kicker: 'QUICK FOLLOW-UP', title: 'جدولة متابعة', subtitle: 'اختر المعاملة ثم أدخل سبب المتابعة وموعدها.', icon: 'fa-calendar-plus' },
        payment:  { kicker: 'QUICK PAYMENT', title: 'تسجيل دفعة', subtitle: 'اختر المعاملة وسيتم فتح سجلها المالي مباشرة.', icon: 'fa-coins' },
        note:     { kicker: 'QUICK NOTE', title: 'إضافة ملاحظة', subtitle: 'اختر المعاملة وسيتم تركيز حقل الملاحظة فوراً.', icon: 'fa-note-sticky' },
        document: { kicker: 'QUICK DOCUMENT', title: 'رفع مستند', subtitle: 'اختر معاملة لفتح خزنة الشركة المرتبطة بها.', icon: 'fa-file-arrow-up' }
    };

    window.openQuickActions = function openQuickActions() {
        document.getElementById('mqQuickActions')?.classList.add('active');
        updateProductivitySheetLock();
    };

    window.closeQuickActions = function closeQuickActions() {
        document.getElementById('mqQuickActions')?.classList.remove('active');
        updateProductivitySheetLock();
    };

    window.beginQuickAction = function beginQuickAction(action) {
        if (action === 'newTx') {
            window.closeQuickActions();
            window.closeDailyWorkspace();
            return window.switchTab?.('newTx');
        }
        if (!QUICK_ACTION_META[action]) return;
        state.quickAction = action;
        // Build the sorted picker source once per quick-action opening. Searching then
        // only filters the cached array instead of sorting the whole transaction list
        // on every keystroke; this keeps the picker snappy with large offices.
        const includeCompleted = action === 'document';
        state.quickPickerSource = (typeof db !== 'undefined' && Array.isArray(db.transactions))
            ? db.transactions.filter(tx => tx && (includeCompleted || tx.status !== 'completed')).slice()
                .sort((a, b) => Number(b.lastUpdate || b.createdAt || 0) - Number(a.lastUpdate || a.createdAt || 0))
            : [];
        window.closeQuickActions();
        const search = document.getElementById('mq-quick-picker-search');
        if (search) search.value = '';
        const meta = QUICK_ACTION_META[action];
        const kicker = document.getElementById('mq-quick-picker-kicker');
        const title = document.getElementById('mqQuickPickerTitle');
        const subtitle = document.getElementById('mq-quick-picker-subtitle');
        const icon = document.querySelector('#mq-quick-picker-icon i');
        if (kicker) kicker.textContent = meta.kicker;
        if (title) title.textContent = meta.title;
        if (subtitle) subtitle.textContent = meta.subtitle;
        if (icon) icon.className = `fa-solid ${meta.icon}`;
        window.renderQuickPicker();
        document.getElementById('mqQuickPicker')?.classList.add('active');
        updateProductivitySheetLock();
        setTimeout(() => search?.focus({ preventScroll: true }), 90);
    };

    window.closeQuickPicker = function closeQuickPicker() {
        document.getElementById('mqQuickPicker')?.classList.remove('active');
        updateProductivitySheetLock();
    };


    window.scheduleQuickPickerRender = function scheduleQuickPickerRender() {
        clearTimeout(state.quickPickerTimer);
        state.quickPickerTimer = setTimeout(() => window.renderQuickPicker(), 70);
    };

    window.renderQuickPicker = function renderQuickPicker() {
        const list = document.getElementById('mq-quick-picker-list');
        if (!list || typeof db === 'undefined' || !Array.isArray(db.transactions)) return;
        const action = state.quickAction;
        const term = String(document.getElementById('mq-quick-picker-search')?.value || '').trim().toLowerCase();
        const source = Array.isArray(state.quickPickerSource) ? state.quickPickerSource : [];

        const filtered = !term ? source : source.filter(tx => {
            const company = window.companyName?.(tx.companyId) || '';
            const lawyer = window.lawyerName?.(tx.lawyerId) || '';
            return [tx.type, tx.dept, company, lawyer].join(' ').toLowerCase().includes(term);
        });
        const shown = filtered.slice(0, 18);
        const count = document.getElementById('mq-quick-picker-count');
        if (count) count.textContent = `${filtered.length} معاملة${filtered.length > shown.length ? ' · أول 18 نتيجة' : ''}`;

        if (!shown.length) {
            list.innerHTML = `<div class="mq-launch-picker-empty"><span><i class="fa-solid fa-magnifying-glass"></i></span><strong>لا توجد نتيجة</strong><small>جرّب اسم الشركة أو نوع المعاملة.</small></div>`;
            return;
        }

        list.innerHTML = shown.map(tx => {
            const company = window.companyName?.(tx.companyId) || 'شركة غير مسجلة';
            const lawyer = window.lawyerName?.(tx.lawyerId) || '—';
            const stateLabel = tx.status === 'stalled' ? 'متلكئة' : tx.status === 'completed' ? 'منجزة' : 'جارية';
            return `<button type="button" class="mq-launch-case ${tx.status === 'stalled' ? 'is-stalled' : tx.status === 'completed' ? 'is-completed' : ''}" onclick="chooseQuickTransaction(${window.jsArg(tx.id)})"><span class="mq-launch-case-state">${window.escapeHtml(stateLabel)}</span><span class="mq-launch-case-copy"><strong>${window.escapeHtml(tx.type || company)}</strong><small>${window.escapeHtml(company)} — ${window.escapeHtml(lawyer)}</small></span><span class="mq-launch-case-open"><i class="fa-solid fa-arrow-left"></i></span></button>`;
        }).join('');
    };

    window.chooseQuickTransaction = function chooseQuickTransaction(txId) {
        const action = state.quickAction;
        const tx = window.getTransaction?.(txId);
        if (!tx || !QUICK_ACTION_META[action]) return window.showToast?.('تعذر العثور على المعاملة', 'error');
        window.closeQuickPicker();

        if (action === 'document') {
            if (!tx.companyId) return window.showToast?.('لا توجد شركة مرتبطة بهذه المعاملة', 'error');
            window.switchTab?.('archive');
            window.toggleArchiveTab?.('vault');
            window.updateVaultDropdown?.();
            const select = document.getElementById('vault-company-select');
            if (select) {
                select.value = String(tx.companyId);
                window.updateCustomSelectText?.('vault-company-select', '- اختر الشركة -');
                window.renderVault?.();
            }
            // This click remains inside the user's picker click gesture, which is
            // important because mobile browsers block synthetic file dialogs later.
            document.getElementById('vault-file-upload')?.click();
            return;
        }

        window.openTxDetails?.(txId);
        setTimeout(() => window.startTxAction?.(action), 100);
    };

    /* -------------------------------------------------------------------------
       05. PWA install + connectivity
       ------------------------------------------------------------------------- */
    function updateConnectivity() {
        updateSyncUi();
        if (navigator.onLine && readSyncMeta().pendingChanges > 0) {
            window.syncMoaqibNow?.({ silent: true });
        }
    }

    function standaloneMode() {
        return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
    }

    function updateInstallButton() {
        const button = document.getElementById('mq-install-button');
        if (!button) return;
        const canInstall = !!state.deferredInstallPrompt && !standaloneMode();
        button.classList.toggle('hidden', !canInstall);
    }

    window.installMoaqibApp = async function installMoaqibApp() {
        if (!state.deferredInstallPrompt) {
            window.showToast?.(standaloneMode() ? 'التطبيق مثبت بالفعل' : 'خيار التثبيت غير متاح حالياً', 'info');
            return;
        }
        state.deferredInstallPrompt.prompt();
        await state.deferredInstallPrompt.userChoice.catch(() => null);
        state.deferredInstallPrompt = null;
        updateInstallButton();
    };

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return null;
        try {
            state.swRegistration = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
            return state.swRegistration;
        } catch (error) {
            console.warn('Service worker registration failed:', error);
            return null;
        }
    }

    /* -------------------------------------------------------------------------
       06. Web Push subscription — zero startup cost when not configured
       ------------------------------------------------------------------------- */
    function pushConfig() {
        return window.MOAQIB_PUSH_CONFIG || {};
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
    }

    function updateBackgroundPushStatus(status, detail = '') {
        const el = document.getElementById('mq-push-status');
        const detailEl = document.getElementById('mq-push-detail');
        if (el) el.textContent = status;
        if (detailEl) detailEl.textContent = detail;
    }

    async function savePushSubscription(subscription) {
        const config = pushConfig();
        if (!subscription || !config.subscriptionTable || typeof supabaseClient === 'undefined' || !supabaseClient) return false;
        const { data: sessionData } = await supabaseClient.auth.getSession();
        const user = sessionData?.session?.user;
        if (!user) return false;
        const json = subscription.toJSON();
        const prefs = readPrefs();
        const payload = {
            owner_id: user.id,
            endpoint: json.endpoint,
            p256dh: json.keys?.p256dh || '',
            auth: json.keys?.auth || '',
            enabled: !!prefs.notificationsEnabled,
            user_agent: navigator.userAgent.slice(0, 500),
            device_label: String(navigator.userAgentData?.platform || navigator.platform || 'Web').slice(0, 120),
            timezone: localTimezone(),
            preferences: {
                remindSoon: !!prefs.remindSoon,
                remindLate: !!prefs.remindLate,
                remindStalled: !!prefs.remindStalled,
                remindStale: !!prefs.remindStale,
                dailyBrief: !!prefs.dailyBrief,
                dailyBriefTime: validBriefTime(prefs.dailyBriefTime) ? prefs.dailyBriefTime : DEFAULT_PREFS.dailyBriefTime
            },
            updated_at: new Date().toISOString()
        };
        const { error } = await supabaseClient.from(config.subscriptionTable).upsert(payload, { onConflict: 'owner_id,endpoint' });
        if (error) throw error;
        return true;
    }

    async function ensurePushSubscription() {
        const prefs = readPrefs();
        if (!prefs.notificationsEnabled) return false;
        const config = pushConfig();
        if (!config.enabled || !config.vapidPublicKey) {
            updateBackgroundPushStatus('محلي', 'إشعارات الجلسة مفعلة؛ Web Push ينتظر إعداد VAPID/Supabase.');
            return false;
        }
        if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
            updateBackgroundPushStatus('غير مدعوم', 'هذا المتصفح لا يدعم Web Push.');
            return false;
        }
        if (Notification.permission !== 'granted') return false;
        try {
            const registration = state.swRegistration || await registerServiceWorker() || await navigator.serviceWorker.ready;
            if (!registration) return false;
            let subscription = await registration.pushManager.getSubscription();
            if (!subscription) {
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
                });
            }
            state.pushSubscription = subscription;
            await savePushSubscription(subscription);
            updateBackgroundPushStatus('Push مفعّل', 'يمكن للخادم إرسال التذكيرات حتى عند إغلاق التطبيق.');
            return true;
        } catch (error) {
            console.warn('Web Push subscription failed:', error);
            updateBackgroundPushStatus('محلي فقط', 'تعذر تسجيل Web Push؛ تظل إشعارات الجلسة فعالة.');
            return false;
        }
    }

    /* -------------------------------------------------------------------------
       07. Notification foundation
       -------------------------------------------------------------------------
       Local reminders work while the page/PWA process is alive. When the optional
       VAPID/Supabase package is configured, the same permission also registers
       a Web Push subscription for fully closed-app delivery.
       ------------------------------------------------------------------------- */
    function updateNotificationButton() {
        const button = document.getElementById('mq-notify-button');
        if (!button) return;
        const granted = 'Notification' in window && Notification.permission === 'granted';
        const enabled = granted && !!readPrefs().notificationsEnabled;
        button.classList.toggle('is-enabled', enabled);
        const text = button.querySelector('span');
        if (text) text.textContent = enabled ? 'مفعّلة' : 'الإشعارات';
        const icon = button.querySelector('i');
        if (icon) icon.className = granted ? 'fa-solid fa-bell' : 'fa-regular fa-bell';
    }

    async function showDeviceNotification(title, options = {}) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return false;
        const registration = state.swRegistration || await navigator.serviceWorker?.ready?.catch(() => null);
        const safeOptions = {
            icon: './icons/icon-192.png', badge: './icons/icon-192.png',
            dir: 'rtl', lang: 'ar', tag: options.tag || undefined,
            renotify: false, ...options
        };
        if (registration?.showNotification) {
            await registration.showNotification(title, safeOptions);
            return true;
        }
        new Notification(title, safeOptions);
        return true;
    }

    window.enableMoaqibNotifications = async function enableMoaqibNotifications() {
        if (!('Notification' in window)) {
            window.showToast?.('هذا المتصفح لا يدعم إشعارات الجهاز', 'error');
            return;
        }
        try {
            const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
            updateNotificationButton();
            if (permission === 'granted') {
                writePrefs({ notificationsEnabled: true });
                renderNotificationPreferences();
                await showDeviceNotification('تم تفعيل إشعارات MOAQIB', { body: 'سنذكّرك بالمتابعات المهمة، وWeb Push يعمل تلقائياً إذا تم إعداد الخادم.', tag: 'mq-enabled' });
                idle(() => ensurePushSubscription(), 900);
                scanDueReminders();
            } else {
                writePrefs({ notificationsEnabled: false });
                renderNotificationPreferences();
                window.showToast?.('لم يتم منح إذن الإشعارات', 'info');
            }
        } catch (error) {
            console.error(error);
            window.showToast?.('تعذر تفعيل الإشعارات على هذا الجهاز', 'error');
        }
    };

    function renderNotificationPreferences() {
        const prefs = readPrefs();
        const ids = {
            'mq-pref-master': prefs.notificationsEnabled,
            'mq-pref-soon': prefs.remindSoon,
            'mq-pref-late': prefs.remindLate,
            'mq-pref-stalled': prefs.remindStalled,
            'mq-pref-stale': prefs.remindStale,
            'mq-pref-brief': prefs.dailyBrief
        };
        Object.entries(ids).forEach(([id, value]) => {
            const input = document.getElementById(id);
            if (input) input.checked = !!value;
        });
        const time = document.getElementById('mq-pref-brief-time');
        if (time) time.value = validBriefTime(prefs.dailyBriefTime) ? prefs.dailyBriefTime : DEFAULT_PREFS.dailyBriefTime;
        const permission = document.getElementById('mq-notification-permission');
        if (permission) permission.textContent = !('Notification' in window) ? 'غير مدعوم' : Notification.permission === 'granted' ? 'مسموح' : Notification.permission === 'denied' ? 'محظور' : 'بانتظار الإذن';
        updateNotificationButton();
    }

    async function refreshStoredPushPreferences() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
        try {
            const registration = state.swRegistration || await navigator.serviceWorker.getRegistration?.('./');
            const subscription = state.pushSubscription || await registration?.pushManager?.getSubscription?.();
            if (!subscription) return false;
            return await savePushSubscription(subscription);
        } catch (error) {
            console.warn('Push preference refresh skipped:', error);
            return false;
        }
    }

    window.setNotificationPreference = function setNotificationPreference(key, value) {
        if (!(key in DEFAULT_PREFS)) return;
        const next = writePrefs({ [key]: !!value });
        if (key === 'notificationsEnabled') {
            if (next.notificationsEnabled) {
                if ('Notification' in window && Notification.permission !== 'granted') {
                    window.enableMoaqibNotifications?.();
                } else {
                    startReminderLoop();
                    idle(() => ensurePushSubscription(), 600);
                }
            } else {
                clearInterval(state.reminderTimer);
                state.reminderTimer = null;
                idle(() => refreshStoredPushPreferences(), 500);
            }
        } else if (next.notificationsEnabled) {
            idle(() => refreshStoredPushPreferences(), 500);
        }
        renderNotificationPreferences();
    };

    window.setDailyBriefTime = function setDailyBriefTime(value) {
        if (!validBriefTime(value)) {
            window.showToast?.('اختر وقتاً صحيحاً بين 00:00 و23:59', 'error');
            renderNotificationPreferences();
            return false;
        }
        writePrefs({ dailyBriefTime: value });
        idle(() => refreshStoredPushPreferences(), 500);
        return true;
    };

    window.testMoaqibNotification = async function testMoaqibNotification() {
        if (!('Notification' in window)) return window.showToast?.('هذا الجهاز لا يدعم الإشعارات', 'error');
        if (Notification.permission !== 'granted') {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return window.showToast?.('لم يتم منح إذن الإشعارات', 'info');
        }
        writePrefs({ notificationsEnabled: true });
        renderNotificationPreferences();
        await showDeviceNotification('اختبار MOAQIB', { body: 'الإشعارات المحلية تعمل على هذا الجهاز.', tag: 'mq-local-test' });
        startReminderLoop();
    };

    async function invokePushFunction(action) {
        const config = pushConfig();
        if (!config.enabled) throw new Error('Web Push غير مفعّل في push-config.js');
        if (typeof supabaseClient === 'undefined' || !supabaseClient?.functions?.invoke) throw new Error('Supabase غير جاهز');
        const functionName = config.functionName || 'send-reminders';
        const { data, error } = await supabaseClient.functions.invoke(functionName, { body: { action } });
        if (error) throw error;
        return data || {};
    }

    window.checkMoaqibPushBackend = async function checkMoaqibPushBackend() {
        updateBackgroundPushStatus('جارٍ الفحص', 'يتم الاتصال بخادم Web Push...');
        try {
            const result = await invokePushFunction('health');
            updateBackgroundPushStatus(result.ok ? 'الخادم جاهز' : 'غير جاهز', result.message || (result.ok ? 'خدمة Push متاحة.' : 'راجع إعدادات الخادم.'));
            window.showToast?.(result.ok ? 'خادم الإشعارات جاهز' : 'الخادم يحتاج إعداداً', result.ok ? 'success' : 'info');
            return !!result.ok;
        } catch (error) {
            updateBackgroundPushStatus('غير متصل', String(error?.message || 'تعذر فحص الخادم'));
            window.showToast?.('تعذر فحص خادم Push', 'error');
            return false;
        }
    };

    window.sendMoaqibPushTest = async function sendMoaqibPushTest() {
        try {
            const subscribed = await ensurePushSubscription();
            if (!subscribed) throw new Error('لم يتم تسجيل هذا الجهاز في Web Push');
            const result = await invokePushFunction('test');
            window.showToast?.(result.sent > 0 ? 'تم إرسال Push تجريبي' : 'لم يتم العثور على جهاز مفعّل', result.sent > 0 ? 'success' : 'info');
            return result;
        } catch (error) {
            console.warn('Push test failed:', error);
            window.showToast?.('تعذر إرسال Push تجريبي', 'error');
            return null;
        }
    };

    function readNotificationHistory() {
        try { return JSON.parse(localStorage.getItem(NOTIFY_HISTORY_KEY) || '{}') || {}; }
        catch (_) { return {}; }
    }

    function saveNotificationHistory(history) {
        const cutoff = Date.now() - 7 * ONE_DAY;
        Object.keys(history).forEach(key => { if (Number(history[key]) < cutoff) delete history[key]; });
        localStorage.setItem(NOTIFY_HISTORY_KEY, JSON.stringify(history));
    }

    async function scanDueReminders() {
        const prefs = readPrefs();
        if (!prefs.notificationsEnabled) return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        if (typeof db === 'undefined' || !db?.transactions) return;
        const now = Date.now();
        const history = readNotificationHistory();
        const candidates = [];
        const dayBucket = new Date(now).toISOString().slice(0, 10);

        db.transactions.forEach(tx => {
            if (tx.status === 'completed') return;
            (tx.followUps || []).forEach(f => {
                if (f.done || !f.dueAt) return;
                const due = new Date(f.dueAt).getTime();
                if (!Number.isFinite(due)) return;
                const delta = due - now;
                const kind = delta >= 0 && delta <= REMINDER_WINDOW ? 'soon' : delta < 0 && delta >= -ONE_DAY ? 'late' : null;
                if (!kind || (kind === 'soon' && !prefs.remindSoon) || (kind === 'late' && !prefs.remindLate)) return;
                const id = String(f.id || `${tx.id}-${f.dueAt}-${f.title}`);
                const key = `${kind}:${id}:${dayBucket}`;
                if (history[key]) return;
                candidates.push({ tx, f, kind, key, due, priority: kind === 'late' ? 100 : 90 });
            });
        });

        // One daily summary is enough for stalled/stale work; it avoids notification
        // spam while still honoring the user's chosen categories.
        const briefTime = validBriefTime(prefs.dailyBriefTime) ? prefs.dailyBriefTime : DEFAULT_PREFS.dailyBriefTime;
        const [briefHour, briefMinute] = briefTime.split(':').map(Number);
        const current = new Date(now);
        const afterBriefTime = current.getHours() > briefHour || (current.getHours() === briefHour && current.getMinutes() >= briefMinute);
        if (afterBriefTime) {
            const stalled = db.transactions.filter(tx => tx?.status === 'stalled').length;
            const stale = db.transactions.filter(tx => tx?.status === 'active' && now - Number(tx.lastUpdate || tx.createdAt || now) >= STALE_AFTER).length;
            const pendingToday = db.transactions.reduce((sum, tx) => sum + (tx?.followUps || []).filter(f => !f?.done && f?.dueAt && new Date(f.dueAt).toDateString() === current.toDateString()).length, 0);

            if (prefs.dailyBrief && !history[`brief:${dayBucket}`]) {
                candidates.push({ kind: 'brief', key: `brief:${dayBucket}`, due: now, priority: 55, title: 'ملخص يوم العمل', body: `${pendingToday} متابعة اليوم · ${stalled} متلكئة · ${stale} بلا تحديث` });
            }
            if (prefs.remindStalled && stalled > 0 && !history[`stalled:${dayBucket}`]) {
                candidates.push({ kind: 'summary', key: `stalled:${dayBucket}`, due: now, priority: 45, title: 'معاملات متلكئة', body: `${stalled} معاملات تحتاج تدخلك اليوم.` });
            }
            if (prefs.remindStale && stale > 0 && !history[`stale:${dayBucket}`]) {
                candidates.push({ kind: 'summary', key: `stale:${dayBucket}`, due: now, priority: 40, title: 'معاملات بلا تحديث', body: `${stale} معاملات لم تُحدّث منذ 7 أيام أو أكثر.` });
            }
        }

        candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.due - b.due);
        for (const item of candidates.slice(0, 3)) {
            if (item.tx && item.f) {
                const company = window.companyName?.(item.tx.companyId) || item.tx.type || 'معاملة';
                const title = item.kind === 'late' ? 'متابعة متأخرة' : 'متابعة خلال ساعة';
                await showDeviceNotification(title, {
                    body: `${company} — ${item.f.title || 'متابعة'}`,
                    tag: `followup-${item.f.id || item.tx.id}`,
                    data: { url: `./index.html?tx=${encodeURIComponent(item.tx.id)}` }
                });
            } else {
                await showDeviceNotification(item.title || 'MOAQIB', { body: item.body || 'لديك أعمال تحتاج انتباهك.', tag: item.key });
            }
            history[item.key] = Date.now();
        }
        saveNotificationHistory(history);
    }

    function startReminderLoop() {
        clearInterval(state.reminderTimer);
        const prefs = readPrefs();
        if (!prefs.notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
        scanDueReminders();
        state.reminderTimer = setInterval(scanDueReminders, REMINDER_SCAN_INTERVAL);
    }

    /* -------------------------------------------------------------------------
       08. Deep link from notification
       ------------------------------------------------------------------------- */
    function processTransactionDeepLink() {
        const txId = new URLSearchParams(location.search).get('tx');
        if (!txId) return;
        let attempts = 0;
        const timer = setInterval(() => {
            attempts += 1;
            try {
                if (typeof window.getTransaction === 'function' && window.getTransaction(txId)) {
                    clearInterval(timer);
                    window.openTxDetails?.(txId);
                    const clean = `${location.pathname}${location.hash || ''}`;
                    history.replaceState({}, '', clean);
                } else if (attempts >= 30) clearInterval(timer);
            } catch (_) { if (attempts >= 30) clearInterval(timer); }
        }, 500);
    }

    /* -------------------------------------------------------------------------
       09. Bootstrap entry — called by app.js after all V6 functions exist
       ------------------------------------------------------------------------- */
    window.getMoaqibPerformanceSnapshot = function getMoaqibPerformanceSnapshot() {
        const samples = state.renderSamples.slice();
        const sorted = samples.slice().sort((a, b) => a - b);
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
        return {
            version: PRODUCTIVITY_VERSION,
            runtime: 'web-pwa',
            renders: samples.length,
            lastRenderMs: Number(state.lastRenderMs.toFixed(2)),
            medianRenderMs: Number(median.toFixed(2)),
            pendingChanges: Number(readSyncMeta().pendingChanges) || 0,
            dailyCacheRevision: state.dailyQueueRevision,
            dataRevision: state.dataRevision
        };
    };

    window.MOAQIB_PRODUCTIVITY_BOOTSTRAP = function productivityBootstrap(startV6) {
        installPerformanceWrappers();
        startV6();

        window.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (document.getElementById('mqQuickPicker')?.classList.contains('active')) return window.closeQuickPicker();
            if (document.getElementById('mqQuickActions')?.classList.contains('active')) return window.closeQuickActions();
            if (document.getElementById('mqDailyWorkspace')?.classList.contains('active')) return window.closeDailyWorkspace();
        });

        window.addEventListener('online', () => {
            // updateConnectivity() already performs exactly one retry when pending.
            // Do not issue a duplicate Supabase flush on the same online event.
            updateConnectivity();
        });
        window.addEventListener('offline', updateConnectivity);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                if (state.deferredHiddenRender) window.renderAll?.();
                scanDueReminders();
                updateSyncUi();
                if (navigator.onLine && readSyncMeta().pendingChanges > 0) window.syncMoaqibNow?.({ silent: true });
            }
        });
        navigator.serviceWorker?.addEventListener?.('message', event => {
            if (event.data?.type === 'MQ_RETRY_SYNC') window.syncMoaqibNow?.({ silent: true });
            if (event.data?.type === 'MQ_SW_UPDATED') window.showToast?.('تم تحديث ملفات التطبيق في الخلفية', 'success');
        });
        window.addEventListener('beforeinstallprompt', event => {
            event.preventDefault();
            state.deferredInstallPrompt = event;
            updateInstallButton();
        });
        window.addEventListener('appinstalled', () => {
            state.deferredInstallPrompt = null;
            updateInstallButton();
            window.showToast?.('تم تثبيت MOAQIB كتطبيق على الجهاز', 'success');
        });

        updateConnectivity();
        updateInstallButton();
        renderNotificationPreferences();
        updateBackgroundPushStatus(pushConfig().enabled && pushConfig().vapidPublicKey ? 'جاهز للتسجيل' : 'محلي', pushConfig().enabled && pushConfig().vapidPublicKey ? 'سيتم تسجيل هذا الجهاز بعد منح إذن الإشعارات.' : 'فعّل إعداد Web Push في push-config.js والخادم لإشعارات التطبيق المغلق.');
        if (readPrefs().notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') startReminderLoop();

        // Service worker and chart are intentionally registered/warmed after the
        // first usable render so they do not compete with startup on mobile.
        idle(async () => {
            await registerServiceWorker();
            startReminderLoop();
            if (navigator.onLine && readSyncMeta().pendingChanges > 0) await window.syncMoaqibNow?.({ silent: true });
            if (readPrefs().notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') await ensurePushSubscription();
            if (activeViewName() === 'home') window.initChart?.();
        }, 1300);
        setTimeout(processTransactionDeepLink, 450);
    };
})();
