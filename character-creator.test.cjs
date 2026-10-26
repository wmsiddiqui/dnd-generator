const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = readFileSync(join(__dirname, 'character-creator.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup({ legacy = false, breaker = false } = {}) {
    const elements = new Map();
    const storage = new Map();
    const alerts = [];
    const context = vm.createContext({
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, { innerHTML: '', style: {} });
                return elements.get(id);
            },
            addEventListener() {}
        },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value)
        },
        window: {},
        alert: message => alerts.push(message)
    });
    vm.runInContext(script, context);
    vm.runInContext(`
        STATE.chars = [{
            id: 'test', name: 'Test Guardian', race: 'human', class: 'titan',
            subclass: '${breaker ? 'breaker' : 'striker'}', lightLevel: 1,
            characterLevel: 3, cp: 9, unspentPoints: 0,
            stats: { strength: 3, agility: 2, wisdom: 1, health: 1, speed: 1, stamina: 1 },
            armor: { helmet: 'Test Helmet', helmetVal: 2, chest: '', boots: '' },
            weapons: ['', '', ''], selectedAbilities: [], currentHP: 1
        }];
        STATE.activeId = 'test';
        ${legacy ? '' : 'getActive().statPointBudget = 9;'}
    `, context);
    const run = code => vm.runInContext(code, context);
    return { run, storage, alerts, elements };
}

test('source and deployed pages stay identical', () => {
    assert.equal(readFileSync(join(__dirname, 'index.html'), 'utf8'), html);
});

test('direct armor stats stack without changing base stats or CL', () => {
    const { run } = setup();
    run("getActive().armor.helmetBonuses = {strength: 3, agility: 2, wisdom: 2, health: 2, speed: 3, stamina: 7}; getActive().armor.chest = 'Chest'; getActive().armor.chestBonuses = {strength: 2};");
    assert.equal(run('effectiveStats(getActive()).strength'), 8);
    assert.equal(run('getActive().stats.strength'), 3);
    assert.equal(run('getCL(getActive())'), 3);
    assert.equal(run('derived(getActive()).wepDmgBonus'), 2);
    assert.equal(run('derived(getActive()).atkBonus'), 2);
    assert.equal(run('derived(getActive()).ltDmgBonus'), 1);
    assert.equal(run('derived(getActive()).hp'), run('3 * CLASSES.titan.healthConversion'));
    assert.equal(run('derived(getActive()).bonusActions'), 2);
    const speed = run('derived(getActive()).totalSpd');
    run("toggleArmorEquipped('helmet')");
    assert.equal(run('effectiveStats(getActive()).strength'), 5);
    assert.equal(run('derived(getActive()).armorRating'), 0);
    assert.equal(run('derived(getActive()).totalSpd'), speed - 10);
    run("toggleArmorEquipped('helmet')");
    assert.equal(run('effectiveStats(getActive()).strength'), 8);
});

test('armor CP can be banked, allocated, removed and resolved with chosen reductions', () => {
    const { run } = setup();
    run("getActive().armor.helmetBonuses = {cp: 3}; save();");
    assert.equal(run('pointBalance(getActive())'), 3);
    run("openPointBalance(); adjPendingStat('strength', 1); adjPendingStat('strength', 1); adjPendingStat('strength', 1); confirmLevelUp();");
    assert.equal(run('getCL(getActive())'), 4);
    assert.equal(run('pointBalance(getActive())'), 0);
    run("toggleArmorEquipped('helmet')");
    assert.equal(run('getActive().unspentPoints'), -3);
    run("openPointBalance(); adjPendingStat('strength', -1); adjPendingStat('agility', -1); adjPendingStat('wisdom', -1); confirmLevelUp();");
    assert.equal(run('pointBalance(getActive())'), 0);
    assert.equal(run('getActive().stats.strength'), 5);
    assert.equal(run('getActive().stats.agility'), 1);
    assert.equal(run('getActive().stats.wisdom'), 0);
    run("toggleArmorEquipped('helmet')");
    assert.equal(run('pointBalance(getActive())'), 3);
});

test('banked CP absorbs armor removal before a deficit appears', () => {
    const { run } = setup();
    run("getActive().armor.helmetBonuses = {cp: 3}; save(); toggleArmorEquipped('helmet');");
    assert.equal(run('pointBalance(getActive())'), 0);
    assert.equal(run('getActive().stats.strength'), 3);
});

test('deficit reductions cannot overspend, go below base zero, or remove direct bonuses', () => {
    const { run, alerts } = setup();
    run("getActive().statPointBudget = 7; getActive().armor.helmetBonuses = {wisdom: 4}; openPointBalance();");
    run("adjPendingStat('wisdom', -1); adjPendingStat('wisdom', -1);");
    assert.equal(run('STATE.pendingLevelUp.allocated.wisdom'), -1);
    run('confirmLevelUp()');
    assert.equal(alerts.length, 1);
    run("adjPendingStat('strength', -1); adjPendingStat('strength', -1);");
    assert.equal(run('STATE.pendingLevelUp.allocated.strength'), -1);
    run("adjPendingStat('wisdom', 1);");
    assert.equal(run('STATE.pendingLevelUp.allocated.wisdom'), 0);
    run("adjPendingStat('agility', -1); confirmLevelUp();");
    assert.equal(run('pointBalance(getActive())'), 0);
    assert.equal(run('effectiveStats(getActive()).wisdom'), 5);
});

test('canceling allocation, a deficit resolution, or CP award leaves data unchanged', () => {
    const { run } = setup();
    run("getActive().armor.helmetBonuses = {cp: 2}; openPointBalance(); adjPendingStat('strength', 1); cancelLevelUp();");
    assert.equal(run('getActive().stats.strength'), 3);
    run("getActive().statPointBudget = 7; getActive().armor.helmetBonuses = {}; openPointBalance(); adjPendingStat('strength', -1); cancelLevelUp();");
    assert.equal(run('pointBalance(getActive())'), -2);
    run("window._cpCount = 3; doAddCharacterPoints(); cancelLevelUp();");
    assert.equal(run('permanentPointBudget(getActive())'), 7);
});

test('permanent CP awards first cover deficits and can be saved without allocation', () => {
    const { run } = setup();
    run('getActive().statPointBudget = 6; window._cpCount = 1; doAddCharacterPoints(); confirmLevelUp();');
    assert.equal(run('pointBalance(getActive())'), -2);
    run('window._cpCount = 4; doAddCharacterPoints(); confirmLevelUp();');
    assert.equal(run('pointBalance(getActive())'), 2);
    assert.equal(run('getActive().stats.strength'), 3);
    run("openPointBalance(); adjPendingStat('strength', 1); confirmLevelUp();");
    assert.equal(run('pointBalance(getActive())'), 1);
});

test('allocation respects effective stat caps and supports undo', () => {
    const { run } = setup();
    run("getActive().armor.helmetBonuses = {strength: 18, cp: 3}; openPointBalance(); adjPendingStat('strength', 1);");
    assert.equal(run('STATE.pendingLevelUp.allocated.strength'), 0);
    run("adjPendingStat('agility', 1); adjPendingStat('agility', -1); adjPendingStat('agility', -1);");
    assert.equal(run('STATE.pendingLevelUp.allocated.agility'), 0);
});

test('spares retain their own bonuses and ratings and never apply until equipped', () => {
    const { run } = setup();
    run("getActive().armor.helmetBonuses = {strength: 2, cp: 2}; getActive().armor.helmetSpare = 'Spare'; getActive().armor.helmetSpareVal = 4; getActive().armor.helmetSpareBonuses = {agility: 3}; save();");
    assert.equal(run('effectiveStats(getActive()).agility'), 2);
    run("swapArmor('helmet')");
    assert.equal(run('pointBalance(getActive())'), 0);
    assert.equal(run('effectiveStats(getActive()).agility'), 5);
    assert.equal(run('derived(getActive()).armorRating'), 4);
    assert.equal(run('getActive().armor.helmetSpareBonuses.cp'), 2);
    run("swapArmor('helmet')");
    assert.equal(run('pointBalance(getActive())'), 2);
    assert.equal(run('derived(getActive()).armorRating'), 2);
});

test('clearing armor removes its bonuses and rating and clamps HP without healing on equip', () => {
    const { run } = setup();
    run("getActive().armor.helmetBonuses = {health: 3, cp: 2}; getActive().currentHP = derived(getActive()).hp; save(); toggleArmorEquipped('helmet');");
    assert.equal(run('getActive().currentHP'), run('CLASSES.titan.healthConversion'));
    run("toggleArmorEquipped('helmet')");
    assert.equal(run('getActive().currentHP'), run('CLASSES.titan.healthConversion'));
    run("updateArmor('helmet', '')");
    assert.equal(run('pointBalance(getActive())'), 0);
    assert.equal(run('getActive().armor.helmetVal'), 0);
    assert.equal(run('getActive().armor.helmetBonuses'), undefined);
});

test('legacy budgets preserve allocations, including Breaker and old unspent points', () => {
    const { run } = setup({ legacy: true, breaker: true });
    run('getActive().stats.strength = 12; getActive().unspentPoints = 2; save();');
    assert.equal(run('permanentPointBudget(getActive())'), 20);
    assert.equal(run('pointBalance(getActive())'), 2);
    run("doLevelUp('character'); confirmLevelUp();");
    assert.equal(run('pointBalance(getActive())'), 8);
});

test('save/reload preserves equipment, banked points and deficits without accumulating bonuses', () => {
    const { run, storage } = setup();
    run("getActive().armor.helmetBonuses = {cp: 3}; openPointBalance(); adjPendingStat('agility', 1); adjPendingStat('agility', 1); confirmLevelUp(); toggleArmorEquipped('helmet');");
    const saved = storage.get('dd_chars');
    run('STATE.chars = []; load(); save(); load(); save();');
    assert.equal(storage.get('dd_chars'), saved);
    assert.equal(run('pointBalance(getActive())'), -2);
    assert.equal(run('getActive().armor.helmetEquipped'), false);
});

test('armor bonus form saves valid integers and rejects invalid values explicitly', () => {
    const { run, alerts } = setup();
    run(`
        const values = {strength: 2, agility: 0, wisdom: 0, health: 0, speed: 0, stamina: 0, cp: 3};
        const event = {preventDefault() {}, target: {reportValidity: () => true, elements: {namedItem: k => ({value: String(values[k])})}}};
        saveArmorBonuses(event, 'helmet');
    `);
    assert.equal(run('pointBalance(getActive())'), 3);
    run("values.cp = 1.5; saveArmorBonuses(event, 'helmet');");
    assert.equal(alerts.length, 1);
    assert.equal(run('pointBalance(getActive())'), 3);
});
