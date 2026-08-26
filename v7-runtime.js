/* ============================================================================
   MOAQIB V7 — FOUNDATION RUNTIME 01
   ----------------------------------------------------------------------------
   A small, dependency-free layer for:
   - deterministic view and settings-panel transitions;
   - adaptive motion on low-power/mobile devices;
   - modal transitions without blank timeout frames;
   - local-only performance measurements (nothing is transmitted).

   V6.1 remains the business/data core during this foundation phase. This file
   changes presentation scheduling only and never writes application records.
   ============================================================================ */
(() => {
    'use strict';

    const VERSION = '7.0.0-foundation.1';
    const MAX_SAMPLES = 30;
    const NAV_ORDER = ['home', 'active', 'newTx', 'accounting', 'archive', 'analytics', 'settings'];
    const state = {
        profile: 'full',
        bootStartedAt: performance?.now?.() || Date.now(),
        bootReadyMs: 0,
        navigationSamples: [],
        panelSamples: [],
        longTaskSamples: [],
        activeViewTransition: null,
        longTaskObserver: null
    };

    function now() {
        return globalThis.performance?.now?.() || Date.now();
    }

    function nextFrame(callback) {
        if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
        return setTimeout(callback, 0);
    }

    function idle(callback, timeout = 900) {
        if (typeof requestIdleCallback === 'function') return requestIdleCallback(callback, { timeout });
        return setTimeout(callback, Math.min(timeout, 180));
    }

    function rememberSample(list, value) {
        const safeValue = Math.max(0, Number(value) || 0);
        list.push(Number(safeValue.toFixed(2)));
        if (list.length > MAX_SAMPLES) list.shift();
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        return Number(sorted[Math.floor(sorted.length / 2)].toFixed(2));
    }

    function reducedMotionRequested() {
        try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
        catch (_) { return false; }
    }

    function chooseMotionProfile() {
        if (reducedMotionRequested()) return 'none';
        const saveData = navigator?.connection?.saveData === true;
        const memory = Number(navigator?.deviceMemory) || 0;
        const cores = Number(navigator?.hardwareConcurrency) || 0;
        if (saveData || (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4)) return 'lite';
        return 'full';
    }

    function viewName(element) {
        return element?.id?.replace(/^view-/, '') || '';
    }

    function navigationDirection(current, target) {
        const fromIndex = NAV_ORDER.indexOf(viewName(current));
        const toIndex = NAV_ORDER.indexOf(viewName(target));
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return 1;
        return toIndex > fromIndex ? 1 : -1;
    }

    function syncViewAccessibility(target) {
        document.querySelectorAll('.mq-view').forEach(view => {
            const active = view === target;
            view.setAttribute('aria-hidden', active ? 'false' : 'true');
            if ('inert' in view) view.inert = !active;
        });
    }

    function animateEntry(target, direction = 1, kind = 'view') {
        if (!target || state.profile === 'none' || typeof target.animate !== 'function') return null;
        const lite = state.profile === 'lite';
        const axis = kind === 'panel' ? 'Y' : 'X';
        const distance = kind === 'panel' ? (lite ? 4 : 7) : (lite ? 7 : 14) * direction;
        const duration = kind === 'panel' ? (lite ? 130 : 190) : (lite ? 150 : 230);
        const transform = axis === 'Y'
            ? `translate3d(0, ${distance}px, 0)`
            : `translate3d(${distance}px, 0, 0)`;
        return target.animate(
            [{ opacity: 0.25, transform }, { opacity: 1, transform: 'translate3d(0, 0, 0)' }],
            { duration, easing: 'cubic-bezier(.16,1,.3,1)' }
        );
    }

    function navigateView({ current, target, apply }) {
        if (!target || typeof apply !== 'function') return false;
        const startedAt = now();
        const direction = navigationDirection(current, target);
        document.documentElement.dataset.mqNavDirection = direction > 0 ? 'forward' : 'backward';

        const finish = () => {
            document.documentElement.classList.remove('mq-v7-transitioning');
            rememberSample(state.navigationSamples, now() - startedAt);
        };

        if (current === target) {
            apply();
            syncViewAccessibility(target);
            finish();
            return true;
        }

        const canUseNativeTransition = state.profile === 'full' &&
            typeof document.startViewTransition === 'function' &&
            !document.body.classList.contains('mq-overlay-open');

        if (canUseNativeTransition) {
            try {
                state.activeViewTransition?.skipTransition?.();
                document.documentElement.classList.add('mq-v7-transitioning');
                const transition = document.startViewTransition(() => {
                    apply();
                    syncViewAccessibility(target);
                });
                state.activeViewTransition = transition;
                transition.finished.catch(() => {}).finally(() => {
                    if (state.activeViewTransition === transition) state.activeViewTransition = null;
                    finish();
                });
                return true;
            } catch (_) {
                document.documentElement.classList.remove('mq-v7-transitioning');
            }
        }

        apply();
        syncViewAccessibility(target);
        nextFrame(() => {
            const animation = animateEntry(target, direction, 'view');
            if (animation?.finished) animation.finished.catch(() => {}).finally(finish);
            else finish();
        });
        return true;
    }

    function switchPanel({ current, target, apply, groupSelector = '' }) {
        if (!target || typeof apply !== 'function') return false;
        const startedAt = now();
        apply();
        if (groupSelector) {
            document.querySelectorAll(groupSelector).forEach(panel => {
                const active = panel === target;
                panel.setAttribute('aria-hidden', active ? 'false' : 'true');
                if ('inert' in panel) panel.inert = !active;
            });
        }
        if (current === target || state.profile === 'none') {
            rememberSample(state.panelSamples, now() - startedAt);
            return true;
        }
        nextFrame(() => {
            const animation = animateEntry(target, 1, 'panel');
            const finish = () => rememberSample(state.panelSamples, now() - startedAt);
            if (animation?.finished) animation.finished.catch(() => {}).finally(finish);
            else finish();
        });
        return true;
    }

    function openModal(modal) {
        if (!modal) return false;
        const content = modal.firstElementChild || modal.children?.[0] || null;
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        nextFrame(() => {
            modal.classList.add('active');
            if (content) content.classList.remove('is-closed');
        });
        return true;
    }

    function closeModal(modal) {
        if (!modal) return false;
        const content = modal.firstElementChild || modal.children?.[0] || null;
        if (content) content.classList.add('is-closed');
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');

        const finish = () => {
            modal.style.display = 'none';
            content?.removeEventListener?.('transitionend', finish);
        };
        if (state.profile === 'none') finish();
        else {
            content?.addEventListener?.('transitionend', finish, { once: true });
            setTimeout(finish, state.profile === 'lite' ? 230 : 340);
        }
        return true;
    }

    function installLongTaskObserver() {
        if (typeof PerformanceObserver !== 'function' ||
            !PerformanceObserver.supportedEntryTypes?.includes?.('longtask')) return;
        try {
            state.longTaskObserver = new PerformanceObserver(list => {
                list.getEntries().forEach(entry => rememberSample(state.longTaskSamples, entry.duration));
            });
            state.longTaskObserver.observe({ type: 'longtask', buffered: true });
        } catch (_) {
            state.longTaskObserver = null;
        }
    }

    function initializeRuntime() {
        state.profile = chooseMotionProfile();
        document.documentElement.dataset.mqRuntime = 'v7';
        document.documentElement.dataset.mqMotion = state.profile;
        document.body.classList.add('mq-v7');
        const shell = document.getElementById('app-shell');
        shell?.setAttribute('data-app-version', VERSION);
        syncViewAccessibility(document.querySelector('.mq-view.active'));
        installLongTaskObserver();
        idle(() => document.documentElement.classList.add('mq-v7-ready'));
    }

    window.MOAQIB_V7_VERSION = VERSION;
    window.MOAQIB_V7_NAVIGATE = navigateView;
    window.MOAQIB_V7_SWITCH_PANEL = switchPanel;
    window.MOAQIB_V7_OPEN_MODAL = openModal;
    window.MOAQIB_V7_CLOSE_MODAL = closeModal;
    window.getMoaqibV7PerformanceSnapshot = function getMoaqibV7PerformanceSnapshot() {
        return {
            version: VERSION,
            motionProfile: state.profile,
            bootReadyMs: Number(state.bootReadyMs.toFixed(2)),
            navigation: {
                samples: state.navigationSamples.length,
                medianMs: median(state.navigationSamples),
                lastMs: state.navigationSamples.at(-1) || 0
            },
            settingsPanels: {
                samples: state.panelSamples.length,
                medianMs: median(state.panelSamples),
                lastMs: state.panelSamples.at(-1) || 0
            },
            longTasks: {
                samples: state.longTaskSamples.length,
                longestMs: state.longTaskSamples.length ? Math.max(...state.longTaskSamples) : 0
            }
        };
    };

    window.MOAQIB_V7_BOOTSTRAP = function moaqibV7Bootstrap(startApplication) {
        initializeRuntime();
        startApplication();
        nextFrame(() => nextFrame(() => {
            state.bootReadyMs = Math.max(0, now() - state.bootStartedAt);
        }));
    };
})();
