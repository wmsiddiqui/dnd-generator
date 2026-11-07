const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
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
                if (!elements.has(id)) elements.set(id, { innerHTML: '', style: {}, focus() {} });
                return elements.get(id);
            },
            addEventListener() {}
        },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value)
        },
        window: {},
        crypto: webcrypto,
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

test('CP subtraction uses banked points first and persists without changing stats', () => {
    const { run, storage } = setup();
    run('getActive().statPointBudget = 12; getActive().cp = 12; openAddCharacterPoints(true); adjCPInput(1); doAddCharacterPoints(true);');
    assert.equal(run('STATE.pendingLevelUp.cpCount'), -2);
    assert.equal(run('STATE.pendingLevelUp.pointsTotal'), 1);
    assert.equal(run('permanentPointBudget(getActive())'), 12);
    run('confirmLevelUp();');
    assert.equal(run('permanentPointBudget(getActive())'), 10);
    assert.equal(run('getActive().cp'), 10);
    assert.equal(run('pointBalance(getActive())'), 1);
    assert.equal(run('getActive().stats.strength'), 3);
    const saved = storage.get('dd_chars');
    run('STATE.chars = []; load(); save();');
    assert.equal(storage.get('dd_chars'), saved);
});

test('CP subtraction resolves deficits with chosen base reductions and preserves armor bonuses', () => {
    const { run, alerts, elements } = setup();
    run("getActive().armor.helmetBonuses = {strength: 4, cp: 1}; window._cpCount = 3; doAddCharacterPoints(true);");
    assert.equal(run('STATE.pendingLevelUp.pointsTotal'), -2);
    assert.match(elements.get('modal-content').innerHTML, /Subtract 3 CP/);
    run('confirmLevelUp();');
    assert.equal(alerts.length, 1);
    assert.equal(run('permanentPointBudget(getActive())'), 9);
    run("adjPendingStat('strength', -1); adjPendingStat('strength', 1);");
    assert.equal(run('STATE.pendingLevelUp.allocated.strength'), 0);
    run("adjPendingStat('wisdom', -1); adjPendingStat('wisdom', -1);");
    assert.equal(run('STATE.pendingLevelUp.allocated.wisdom'), -1);
    run("adjPendingStat('agility', -1); adjPendingStat('strength', -1);");
    assert.equal(run('STATE.pendingLevelUp.allocated.strength'), 0);
    run('confirmLevelUp();');
    assert.equal(run('permanentPointBudget(getActive())'), 6);
    assert.equal(run('getActive().cp'), 6);
    assert.equal(run('pointBalance(getActive())'), 0);
    assert.equal(run('effectiveStats(getActive()).strength'), 7);
    assert.equal(run('armorBonuses(getActive()).cp'), 1);
    assert.equal(run('getCL(getActive())'), 2);
});

test('canceling CP subtraction leaves the character unchanged', () => {
    const { run } = setup();
    const before = run('JSON.stringify(getActive())');
    run("window._cpCount = 2; doAddCharacterPoints(true); adjPendingStat('strength', -1); cancelLevelUp();");
    assert.equal(run('JSON.stringify(getActive())'), before);
});

test('CP subtraction rejects invalid amounts and cannot remove armor CP or go below zero', () => {
    const { run, alerts } = setup();
    run("getActive().armor.helmetBonuses = {cp: 3};");
    for (const amount of [0, -1, 1.5, NaN, Infinity, 10]) {
        run(`window._cpCount = ${amount}; doAddCharacterPoints(true);`);
        assert.equal(run('STATE.pendingLevelUp'), null);
    }
    assert.equal(alerts.length, 6);
    assert.equal(run('permanentPointBudget(getActive())'), 9);
    run("window._cpCount = 9; doAddCharacterPoints(true); adjPendingStat('strength', -1); adjPendingStat('strength', -1); adjPendingStat('strength', -1); adjPendingStat('agility', -1); adjPendingStat('agility', -1); adjPendingStat('wisdom', -1); confirmLevelUp();");
    assert.equal(run('permanentPointBudget(getActive())'), 0);
    assert.equal(run('pointBalance(getActive())'), 0);
    assert.equal(run('armorBonuses(getActive()).cp'), 3);
    run('window._cpCount = 1; doAddCharacterPoints(true);');
    assert.equal(run('STATE.pendingLevelUp'), null);
    assert.equal(alerts.length, 7);
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

test('active weapon bonuses stack with armor and affect derived stats without spending CP', () => {
    const { run } = setup();
    run(`
        getActive().weapons = ['Active', 'Holstered', 'Extra'];
        getActive().weaponBonuses = [
            {strength: 3, agility: 2, wisdom: 2, health: 2, speed: 3, stamina: 7, armor: 4},
            {strength: 10, armor: 20}, {strength: 20, armor: 30}
        ];
        getActive().armor.helmetBonuses = {strength: 3};
    `);
    assert.equal(run('effectiveStats(getActive()).strength'), 9);
    assert.equal(run('derived(getActive()).wepDmgBonus'), 3);
    assert.equal(run('derived(getActive()).atkBonus'), 2);
    assert.equal(run('derived(getActive()).ltDmgBonus'), 1);
    assert.equal(run('derived(getActive()).hp'), run('3 * CLASSES.titan.healthConversion'));
    assert.equal(run('derived(getActive()).bonusActions'), 2);
    assert.equal(run('derived(getActive()).armorRating'), 6);
    assert.equal(run('pointBalance(getActive())'), 0);
    assert.equal(run('getCL(getActive())'), 3);
    run("openPointBalance();");
    assert.equal(run('getActive().stats.strength'), 3);
});

test('weapon swaps move names, damage settings and bonuses together and preserve the extra slot', () => {
    const { run, storage, elements } = setup();
    run(`
        STATE.view = 'sheet';
        getActive().weapons = ['First', 'Second', 'Extra'];
        getActive().weaponDmg = [
            {count: 2, die: 8, mod: 'strength', expanded: true},
            {count: 1, die: 6, mod: 'wisdom', expanded: false},
            {count: 3, die: 4, mod: 'none'}
        ];
        getActive().weaponBonuses = [{health: 3, armor: 4}, {agility: 2, armor: 1}, {strength: 10}];
        getActive().currentHP = derived(getActive()).hp;
        swapWeapons();
    `);
    assert.equal(run('getActive().weapons[0]'), 'Second');
    assert.equal(run('getActive().weaponDmg[0].mod'), 'wisdom');
    assert.equal(run('getActive().weaponDmg[1].expanded'), true);
    assert.equal(run('getActive().weaponBonuses[0].armor'), 1);
    assert.equal(run('getActive().weaponBonuses[1].health'), 3);
    assert.equal(run('getActive().weapons[2]'), 'Extra');
    assert.equal(run('getActive().weaponDmg[2].die'), 4);
    assert.equal(run('getActive().weaponBonuses[2].strength'), 10);
    assert.equal(run('getActive().currentHP'), run('CLASSES.titan.healthConversion'));
    assert.equal(run('derived(getActive()).armorRating'), 3);
    assert.match(elements.get('app').innerHTML, /Swap Slots 1 &amp; 2/);
    assert.match(elements.get('app').innerHTML, /Edit Bonuses/);
    const saved = storage.get('dd_chars');
    run('STATE.chars = []; load(); save();');
    const restored = JSON.parse(storage.get('dd_chars'));
    const original = JSON.parse(saved);
    for (const characters of [restored, original]) {
        for (const damage of characters[0].weaponDmg || []) {
            if (damage) delete damage.expanded;
        }
    }
    assert.deepEqual(restored, original);
    run('swapWeapons();');
    assert.equal(run('getActive().weapons[0]'), 'First');
    assert.equal(run('getActive().weaponDmg[0].die'), 8);
    assert.equal(run('derived(getActive()).hp'), run('4 * CLASSES.titan.healthConversion'));
    assert.equal(run('getActive().currentHP'), run('CLASSES.titan.healthConversion'));
});

test('legacy weapon swaps support absent damage and bonus arrays and require two occupied slots', () => {
    const { run } = setup();
    run("getActive().weapons = ['First', 'Second', '']; swapWeapons();");
    assert.equal(run('getActive().weapons[0]'), 'Second');
    assert.equal(run('getActive().weaponDmg'), undefined);
    assert.equal(run('getActive().weaponBonuses'), undefined);
    run("updateWeapon(1, ''); swapWeapons();");
    assert.equal(run('getActive().weapons[0]'), 'Second');
    run("CLASSES.titan.weaponSlots = 1; getActive().weapons[1] = 'Other'; swapWeapons();");
    assert.equal(run('getActive().weapons[0]'), 'Second');
});

test('weapon bonus form saves whole numbers, rejects invalid values and clearing removes stale settings', () => {
    const { run, alerts } = setup();
    run(`
        getActive().weapons[0] = 'Test';
        const values = {strength: 3, agility: 0, wisdom: 0, health: 2, speed: 0, stamina: 0, armor: 4};
        const event = {preventDefault() {}, target: {reportValidity: () => true, elements: {namedItem: k => ({value: String(values[k])})}}};
        saveWeaponBonuses(event, 0);
    `);
    assert.equal(run('derived(getActive()).armorRating'), 6);
    assert.equal(run('derived(getActive()).wepDmgBonus'), 2);
    for (const value of [-1, 1.5, 1000, NaN]) {
        run(`values.armor = ${value}; saveWeaponBonuses(event, 0);`);
        assert.equal(run('getActive().weaponBonuses[0].armor'), 4);
    }
    assert.equal(alerts.length, 4);
    run("getActive().currentHP = derived(getActive()).hp; ensureWeaponDmg(getActive(), 0); updateWeapon(0, '   ');");
    assert.equal(run('getActive().weapons[0]'), '');
    assert.equal(run('getActive().weaponBonuses[0]'), null);
    assert.equal(run('getActive().weaponDmg[0]'), null);
    assert.equal(run('derived(getActive()).armorRating'), 2);
    assert.equal(run('getActive().currentHP'), run('CLASSES.titan.healthConversion'));
    run("updateWeapon(0, 'Replacement');");
    assert.equal(run('effectiveStats(getActive()).strength'), 3);
});

test('point allocation respects active weapon stat caps and deficits only reduce base stats', () => {
    const { run } = setup();
    run("getActive().weapons[0] = 'Test'; getActive().weaponBonuses = [{strength: 18, wisdom: 4}]; getActive().statPointBudget = 10; openPointBalance(); adjPendingStat('strength', 1);");
    assert.equal(run('STATE.pendingLevelUp.allocated.strength'), 0);
    run("cancelLevelUp(); getActive().statPointBudget = 8; openPointBalance(); adjPendingStat('wisdom', -1); adjPendingStat('wisdom', -1); confirmLevelUp();");
    assert.equal(run('getActive().stats.wisdom'), 0);
    assert.equal(run('effectiveStats(getActive()).wisdom'), 4);
    assert.equal(run('pointBalance(getActive())'), 0);
});

test('Devouring Light adds effective Wisdom damage once after summing all orbs at every LL', () => {
    const { run } = setup();
    run("rollDie = () => 2; getActive().stats.wisdom = 6; getActive().weapons[0] = 'Test'; getActive().weaponBonuses = [{wisdom: 3}];");
    for (let ll = 1; ll <= 5; ll++) {
        run(`getActive().lightLevel = ${ll}; STATE._roll = computeRollData('ability', 'devouring_light', getActive());`);
        assert.equal(run('STATE._roll.attackCount'), ll);
        assert.equal(run('STATE._roll.totalMod'), 3);
        assert.equal(run('STATE._roll.attacks.every(a => a.statMod === 0 && a.total === a.diceTotal)'), true);
        assert.equal(run('STATE._roll.attacks.every(a => a.diceTotal === 2 * getActive().lightLevel)'), true);
        assert.equal(run('STATE._roll.grandTotal'), 2 * ll * ll + 3);
        const chip = run("formatDamageChip(ABILITY_DAMAGE.devouring_light, getActive(), 'devouring_light')");
        assert.ok(chip.includes(`${ll}× [1d4 ×${ll}] +3`));
    }
});

test('Devouring Light shows Wisdom only once outside orb subtotals in the roll modal', () => {
    const { run, elements } = setup();
    run("rollDie = () => 2; animateRoll = () => {}; getActive().lightLevel = 3; getActive().stats.wisdom = 9; executeRoll('ability', 'devouring_light', 'test');");
    const modal = elements.get('modal-content').innerHTML;
    assert.equal((modal.match(/id="rdm-total"/g) || []).length, 1);
    assert.equal((modal.match(/id="rdm-\d+"/g) || []).length, 0);
    assert.match(modal, /Wisdom mod · once to total/);
    assert.equal(run('STATE._roll.grandTotal'), 21);
});

test('Devouring Light preserves per-orb Damage Boost while applying Wisdom once', () => {
    const { run } = setup();
    run("rollDie = () => 2; getActive().lightLevel = 3; getActive().stats.wisdom = 9; getActive().selectedAbilities = ['damage_boost']; STATE._roll = computeRollData('ability', 'devouring_light', getActive());");
    assert.equal(run('STATE._roll.totalMod'), 3);
    assert.equal(run('STATE._roll.attacks.every(a => a.statMod === 2 && a.total === 8)'), true);
    assert.equal(run('STATE._roll.statModName'), 'Damage Boost');
    assert.equal(run('STATE._roll.grandTotal'), 27);
    assert.ok(run("formatDamageChip(ABILITY_DAMAGE.devouring_light, getActive(), 'devouring_light')").includes('3× [1d4 ×3 +2] +3'));
});

test('zero Wisdom and other ability and melee modifiers retain their existing behavior', () => {
    const { run } = setup();
    run("rollDie = () => 2; getActive().lightLevel = 3;");
    assert.equal(run("computeRollData('ability', 'devouring_light', getActive()).grandTotal"), 18);
    run('getActive().stats.wisdom = 9;');
    assert.equal(run("computeRollData('ability', 'solar_spears', getActive()).grandTotal"), 27);
    assert.ok(run("formatDamageChip(ABILITY_DAMAGE.solar_spears, getActive(), 'solar_spears')").includes('3× [1d4 ×3 +3]'));
    assert.equal(run("computeRollData('ability', 'void_collapse', getActive()).grandTotal"), 9);
    assert.equal(run("computeRollData('melee', 'Grapple', getActive()).grandTotal"), 7);
});

test('Guardians list offers cloning with an escaped editable copy name and cancellation', () => {
    const { run, elements } = setup();
    run(`getActive().name = 'Test <Guardian> "One"'; renderHome(); openCloneChar('test');`);
    assert.match(elements.get('app').innerHTML, /onclick="openCloneChar\('test'\)">Clone/);
    assert.match(elements.get('modal-content').innerHTML, /value="Test &lt;Guardian&gt; &quot;One&quot; \(Copy\)"/);
    run('closeModal();');
    assert.equal(run('STATE.chars.length'), 1);
});

test('cloning preserves all character data with an independent ID and chosen trimmed name', () => {
    const { run, storage } = setup();
    run(`
        getActive().weapons = ['Active', 'Holstered', 'Extra'];
        getActive().weaponDmg = [{count: 2, die: 8, mod: 'wisdom'}, null, null];
        getActive().weaponBonuses = [{wisdom: 3, armor: 2}, null, null];
        getActive().armor.helmetBonuses = {cp: 3, health: 2};
        getActive().selectedAbilities = ['damage_boost'];
        getActive().specialAbilities = ['test-special'];
        getActive().notes = 'Original notes';
        getActive().currentHP = 2;
        getActive().glimmer = 100;
        getActive().grenadeUsed1 = true;
        getActive().superChargesUsed = 1;
        save();
        const original = JSON.stringify(getActive());
        const event = {preventDefault() {}, target: {reportValidity: () => true, elements: {namedItem: () => ({value: '  New Guardian  '})}}};
        cloneChar(event, 'test');
    `);
    assert.equal(run('STATE.chars.length'), 2);
    assert.equal(run('STATE.chars[1].name'), 'New Guardian');
    assert.notEqual(run('STATE.chars[1].id'), 'test');
    assert.equal(run('JSON.stringify(getActive())'), run('original'));
    assert.equal(run(`JSON.stringify({...STATE.chars[1], id: 'test', name: 'Test Guardian'})`), run('original'));
    assert.equal(JSON.parse(storage.get('dd_chars'))[1].name, 'New Guardian');
    run(`
        STATE.chars[1].stats.strength = 10;
        STATE.chars[1].weapons[0] = 'Changed';
        STATE.chars[1].weaponDmg[0].die = 4;
        STATE.chars[1].weaponBonuses[0].armor = 10;
        STATE.chars[1].armor.helmetBonuses.cp = 0;
        STATE.chars[1].selectedAbilities.push('other');
        STATE.chars[1].specialAbilities.push('another');
    `);
    assert.equal(run('JSON.stringify(getActive())'), run('original'));
    run('STATE.chars = []; load();');
    assert.equal(run('STATE.chars.length'), 2);
    assert.equal(run('STATE.chars[1].weaponBonuses[0].armor'), 2);
    assert.equal(run('STATE.view'), 'home');
});

test('cloning rejects blank names, invalid forms and a deleted original without creating a copy', () => {
    const { run, alerts } = setup();
    run(`
        const event = {preventDefault() {}, target: {reportValidity: () => true, elements: {namedItem: () => ({value: '   '})}}};
        cloneChar(event, 'test');
    `);
    assert.equal(alerts.length, 1);
    assert.equal(run('STATE.chars.length'), 1);
    run("event.target.reportValidity = () => false; cloneChar(event, 'test');");
    assert.equal(run('STATE.chars.length'), 1);
    run("openCloneChar('missing'); cloneChar(event, 'missing');");
    assert.equal(alerts.length, 3);
    assert.equal(run('STATE.chars.length'), 1);
});

test('repeated clones get distinct IDs even when their chosen names match', () => {
    const { run } = setup();
    run(`
        const event = {preventDefault() {}, target: {reportValidity: () => true, elements: {namedItem: () => ({value: 'Copy'})}}};
        cloneChar(event, 'test'); cloneChar(event, 'test');
    `);
    assert.equal(run('new Set(STATE.chars.map(ch => ch.id)).size'), 3);
    assert.equal(run('STATE.chars[1].name'), 'Copy');
    assert.equal(run('STATE.chars[2].name'), 'Copy');
});
