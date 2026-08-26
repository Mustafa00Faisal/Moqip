'use strict';

const fs = require('fs');
const vm = require('vm');
const { performance } = require('perf_hooks');
const source = fs.readFileSync(__dirname + '/app.js', 'utf8');

function extractFunction(name) {
    const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
    if (!match) throw new Error(`missing ${name}`);
    const brace = source.indexOf('{', match.index);
    let depth = 0, quote = null, escaped = false;
    for (let index = brace; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
        if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) return source.slice(match.index, index + 1);
    }
    throw new Error(`unterminated ${name}`);
}

class Element {
    constructor() { this.value = ''; this.textContent = ''; this.innerHTML = ''; }
}

const lawyers = Array.from({ length: 240 }, (_, index) => ({ id: `l${index}`, name: `محامي ${index}` }));
const companies = Array.from({ length: 720 }, (_, index) => ({ id: `c${index}`, name: `شركة ${index}`, lawyerId: `l${index % lawyers.length}` }));
const transactions = Array.from({ length: 6000 }, (_, index) => ({
    id: `t${index}`,
    lawyerId: `l${index % lawyers.length}`,
    companyId: `c${index % companies.length}`
}));
const vault = Array.from({ length: 1600 }, (_, index) => ({ id: `v${index}`, companyId: `c${index % companies.length}` }));
const db = { lawyers, companies, transactions, vault, trash: { transactions: [] } };

const elements = new Map();
const getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
};
let transactionReads = 0;
const context = {
    db,
    document: { getElementById },
    getAllStoredTransactions: () => { transactionReads += 1; return transactions; },
    lawyerName: id => lawyers[Number(String(id).slice(1))]?.name || '',
    escapeHtml: value => String(value ?? ''),
    escapeAttr: value => String(value ?? ''),
    jsArg: value => JSON.stringify(String(value)),
    console,
    String,
    Math,
    Map
};
vm.createContext(context);
vm.runInContext(extractFunction('renderSettingsEntities'), context);

const startedAt = performance.now();
context.renderSettingsEntities();
const elapsedMs = performance.now() - startedAt;

if (transactionReads !== 1) throw new Error(`transactions were scanned ${transactionReads} times instead of once`);
if (!getElementById('settings-lawyers-list').innerHTML.includes('محامي 239')) throw new Error('large lawyer list was not rendered');
if (!getElementById('settings-companies-list').innerHTML.includes('شركة 719')) throw new Error('large company list was not rendered');
if (elapsedMs > 1200) throw new Error(`linear directory renderer exceeded budget: ${elapsedMs.toFixed(2)}ms`);

console.log('V7_PERFORMANCE_SMOKE PASS', JSON.stringify({
    lawyers: lawyers.length,
    companies: companies.length,
    transactions: transactions.length,
    documents: vault.length,
    transactionScans: transactionReads,
    elapsedMs: Number(elapsedMs.toFixed(2))
}));
