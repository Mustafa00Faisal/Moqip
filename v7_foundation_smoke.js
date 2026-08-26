'use strict';

const fs = require('fs');
const vm = require('vm');

class ClassList {
    constructor(initial = []) { this.values = new Set(initial); }
    add(...names) { names.forEach(name => this.values.add(name)); }
    remove(...names) { names.forEach(name => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
    toggle(name, force) {
        if (force === undefined) force = !this.values.has(name);
        force ? this.values.add(name) : this.values.delete(name);
        return force;
    }
}

class Element {
    constructor(id = '', classes = []) {
        this.id = id;
        this.classList = new ClassList(classes);
        this.style = {};
        this.attributes = {};
        this.dataset = {};
        this.children = [];
        this.firstElementChild = null;
        this.inert = false;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener() {}
    removeEventListener() {}
    animate() { return { finished: Promise.resolve() }; }
}

const home = new Element('view-home', ['mq-view', 'active']);
const settings = new Element('view-settings', ['mq-view']);
const profile = new Element('', ['active']); profile.dataset.settingsPanel = 'profile';
const data = new Element(); data.dataset.settingsPanel = 'data';
const shell = new Element('app-shell');
const modalContent = new Element('', ['is-closed']);
const modal = new Element('modal'); modal.children = [modalContent]; modal.firstElementChild = modalContent;
const body = new Element('body');
const html = new Element('html');

const selectorMap = {
    '.mq-view': [home, settings],
    '[data-settings-panel]': [profile, data]
};
const document = {
    body,
    documentElement: html,
    getElementById: id => id === 'app-shell' ? shell : null,
    querySelector: selector => selector === '.mq-view.active' ? [home, settings].find(item => item.classList.contains('active')) : null,
    querySelectorAll: selector => selectorMap[selector] || []
};

let clock = 10;
const context = {
    console,
    document,
    navigator: { deviceMemory: 8, hardwareConcurrency: 8, connection: { saveData: false } },
    performance: { now: () => ++clock },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: callback => { callback(); return 1; },
    requestIdleCallback: callback => { callback(); return 1; },
    setTimeout: callback => { callback(); return 1; },
    clearTimeout: () => {},
    Promise,
    Date,
    Math,
    globalThis: null,
    window: null
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(__dirname + '/v7-runtime.js', 'utf8'), context);

const assert = (condition, message) => { if (!condition) throw new Error(message); };

(async () => {
    assert(context.MOAQIB_V7_VERSION === '7.0.0-foundation.1', 'wrong V7 version');
    let started = 0;
    context.MOAQIB_V7_BOOTSTRAP(() => { started += 1; });
    assert(started === 1, 'bootstrap must start the application exactly once');
    assert(body.classList.contains('mq-v7'), 'V7 body class missing');
    assert(html.dataset.mqMotion === 'full', 'motion profile not selected');
    assert(shell.attributes['data-app-version'] === '7.0.0-foundation.1', 'shell version missing');

    context.MOAQIB_V7_NAVIGATE({
        current: home,
        target: settings,
        apply: () => {
            home.classList.remove('active');
            settings.classList.add('active');
        }
    });
    await Promise.resolve();
    assert(settings.classList.contains('active') && !home.classList.contains('active'), 'view state not applied');
    assert(settings.attributes['aria-hidden'] === 'false' && home.attributes['aria-hidden'] === 'true', 'view accessibility state wrong');

    context.MOAQIB_V7_SWITCH_PANEL({
        current: profile,
        target: data,
        groupSelector: '[data-settings-panel]',
        apply: () => {
            profile.classList.remove('active');
            data.classList.add('active');
        }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert(data.attributes['aria-hidden'] === 'false' && profile.inert === true, 'panel accessibility state wrong');

    assert(context.MOAQIB_V7_OPEN_MODAL(modal), 'modal open driver rejected');
    assert(modal.classList.contains('active') && !modalContent.classList.contains('is-closed'), 'modal did not open');
    assert(context.MOAQIB_V7_CLOSE_MODAL(modal), 'modal close driver rejected');
    assert(modal.style.display === 'none' && modal.attributes['aria-hidden'] === 'true', 'modal did not close');

    const snapshot = context.getMoaqibV7PerformanceSnapshot();
    assert(snapshot.navigation.samples === 1, 'navigation measurement missing');
    assert(snapshot.settingsPanels.samples === 1, 'panel measurement missing');

    const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
    const css = fs.readFileSync(__dirname + '/v7-motion.css', 'utf8');
    const htmlSource = fs.readFileSync(__dirname + '/index.html', 'utf8');
    assert(!app.includes("setTimeout(() => target.classList.add('active'), 10)"), 'blank-frame navigation delay remains');
    assert(css.includes('content-visibility:auto'), 'offscreen rendering containment missing');
    assert(css.includes('prefers-reduced-motion:reduce'), 'reduced motion contract missing');
    assert(htmlSource.indexOf('src="v7-runtime.js"') < htmlSource.indexOf('src="app.js"'), 'V7 runtime must load before app core');
    console.log('V7_FOUNDATION_SMOKE PASS', JSON.stringify({ motion: snapshot.motionProfile, navigationSamples: snapshot.navigation.samples, panelSamples: snapshot.settingsPanels.samples }));
})().catch(error => {
    console.error(error);
    process.exit(1);
});
