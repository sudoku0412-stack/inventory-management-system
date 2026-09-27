import test from 'node:test';
import assert from 'node:assert/strict';
import { intentForAccount, isCurrentCreationResponse, persistCreationIntent, removeCreationIntent, validAccountContextKey } from '../public/shop-creation-client.js';

function storage({ fail = false } = {}) { const values = new Map(); return { getItem: key => values.get(key) || null, setItem(key, value) { if (fail) throw Error('blocked'); values.set(key, value); }, values }; }
const accountA='123e4567-e89b-42d3-a456-426614174000', accountB='123e4567-e89b-42d3-a456-426614174001';

test('creation intent persists before dispatch, survives reload, and remains private across A → B → A', () => {
  const store=storage(), intentA={ operationId:'op-a', accountContextKey:accountA, payload:{shopName:'A shop',displayName:'A'} }, intentB={ operationId:'op-b', accountContextKey:accountB, payload:{shopName:'B shop',displayName:'B'} };
  assert.equal(persistCreationIntent(store,intentA),true);
  assert.deepEqual(intentForAccount(store,accountA),intentA); // reload resumes only after context A is confirmed
  assert.equal(intentForAccount(store,accountB),null);
  assert.equal(persistCreationIntent(store,intentB),true);
  assert.deepEqual(intentForAccount(store,accountB),intentB);
  assert.deepEqual(intentForAccount(store,accountA),intentA);
  removeCreationIntent(store,accountB);
  assert.equal(intentForAccount(store,accountB),null);
  assert.deepEqual(intentForAccount(store,accountA),intentA);
});

test('bad context/storage blocks creation and stale responses cannot be attributed to another account', () => {
  assert.equal(validAccountContextKey(''),false);
  assert.equal(validAccountContextKey('not-an-account'),false);
  assert.equal(persistCreationIntent(storage({fail:true}),{accountContextKey:accountA}),false);
  const intent={accountContextKey:accountA};
  assert.equal(isCurrentCreationResponse(intent,accountA),true);
  assert.equal(isCurrentCreationResponse(intent,accountB),false);
  assert.equal(isCurrentCreationResponse(intent,null),false);
});
