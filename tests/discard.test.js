const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiscardPlan, runDiscardPlan } = require('../discard.js');

const collection = [
  { id: 'a1', card_id: 'A', count: 5, snapshot_rarity: 'C', snapshot_title: 'A' },
  { id: 'b1', card_id: 'B', count: 1, snapshot_rarity: 'C', snapshot_title: 'B' },
  { id: 'b2', card_id: 'B', count: 1, snapshot_rarity: 'C', snapshot_title: 'B', starred: true },
  { id: 'c1', card_id: 'C', count: 3, snapshot_rarity: 'R', snapshot_title: 'C' },
  { id: 'd1', card_id: 'D', count: 2, snapshot_rarity: 'C', snapshot_title: 'D', is_shiny: true },
  { id: 'e1', card_id: 'E', count: 2, snapshot_rarity: 'C', snapshot_title: 'E', user_card_tags: [{ tag_id: 1 }] },
  { id: 'broken', card_id: 'F', count: 3, snapshot_rarity: 'C', snapshot_title: 'F' }
];
for (let i = 0; i < 40; i++) {
  collection.push({ id: `x${i}`, card_id: `X${i}`, count: 2, snapshot_rarity: 'C', snapshot_title: `X${i}` });
}
const copiesOf = (plan, cardId) => plan.filter(p => p.cardId === cardId).length;

test('protections: starred, shiny, tagged and unselected rarities are kept', () => {
  const { plan } = buildDiscardPlan(collection, { rarities: ['C'], keepCount: 0 });
  assert.equal(copiesOf(plan, 'A'), 5);
  assert.equal(copiesOf(plan, 'B'), 1);
  assert.equal(copiesOf(plan, 'C'), 0);
  assert.equal(copiesOf(plan, 'D'), 0);
  assert.equal(copiesOf(plan, 'E'), 0);
});

test('keepCount keeps N copies per card, protected copies count toward N', () => {
  assert.equal(copiesOf(buildDiscardPlan(collection, { rarities: ['C'], keepCount: 1 }).plan, 'A'), 4);
  assert.equal(copiesOf(buildDiscardPlan(collection, { rarities: ['C'], keepCount: 3 }).plan, 'A'), 2);
  assert.equal(copiesOf(buildDiscardPlan(collection, { rarities: ['C'], keepCount: 1 }).plan, 'B'), 1);
});

test('manually excluded cards leave the plan but stay in the preview', () => {
  const res = buildDiscardPlan(collection, { rarities: ['C'], keepCount: 0, excluded: new Set(['A']) });
  assert.equal(copiesOf(res.plan, 'A'), 0);
  assert.equal(res.perCard.find(p => p.cardId === 'A').excluded, true);
});

test('runDiscardPlan: parallel, never twice the same row at once, survives 429s', async () => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let rowRace = false;
  const rowBusy = new Map();
  const discardedPerRow = new Map();

  async function sendToBridge(action, { userCardId }) {
    const callNo = ++calls;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (rowBusy.get(userCardId)) rowRace = true;
    rowBusy.set(userCardId, true);
    await new Promise(r => setTimeout(r, 5));
    rowBusy.set(userCardId, false);
    inFlight--;
    if (callNo === 20) return { success: false, status: 429 };
    if (userCardId === 'broken') return { success: false, status: 400, error: 'Carte introuvable' };
    discardedPerRow.set(userCardId, (discardedPerRow.get(userCardId) || 0) + 1);
    return { success: true, status: 200 };
  }

  const { plan } = buildDiscardPlan(collection, { rarities: ['C'], keepCount: 0 });
  const state = await runDiscardPlan(plan, { sendToBridge, shouldStop: () => false, onProgress: () => {} });

  assert.equal(state.done, plan.filter(p => p.userCardId !== 'broken').length);
  assert.equal(discardedPerRow.get('a1'), 5);
  assert.equal(state.errors, 1, 'the failing row is reported once, its other copies are skipped');
  assert.match(state.lastError, /introuvable/);
  assert.equal(state.rateLimited, 1);
  assert.equal(rowRace, false);
  assert.ok(maxInFlight > 1 && maxInFlight <= 4, `max in flight: ${maxInFlight}`);
});

test('runDiscardPlan stops when asked', async () => {
  let n = 0;
  const sendToBridge = async () => ({ success: true, status: 200 });
  const { plan } = buildDiscardPlan(collection, { rarities: ['C'], keepCount: 0 });
  const state = await runDiscardPlan(plan, { sendToBridge, shouldStop: () => n >= 10, onProgress: () => { n++; } });
  assert.ok(state.done < plan.length);
});
