import assert from 'node:assert/strict';
import {waitForWorkerState} from './runtime-maturity-worker.mjs';

class WorkerEmitter {
  constructor(state, onAdd = null) {
    this.state = state;
    this.scriptURL = '/sw.js?v=current';
    this.listeners = new Set();
    this.onAdd = onAdd;
  }
  addEventListener(type, listener) {
    assert.equal(type, 'statechange');
    this.onAdd?.(this);
    this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    assert.equal(type, 'statechange');
    this.listeners.delete(listener);
  }
  transition(state) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

const registration = worker => ({installing: worker, waiting: null, active: null});
class RegistrationEmitter {
  constructor() {
    this.installing = null;
    this.waiting = null;
    this.active = null;
    this.listeners = new Set();
  }
  addEventListener(type, listener) {
    assert.equal(type, 'updatefound');
    this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    assert.equal(type, 'updatefound');
    this.listeners.delete(listener);
  }
  updateFound(worker) {
    this.installing = worker;
    for (const listener of [...this.listeners]) listener();
  }
}

await assert.rejects(
  waitForWorkerState({installing: null, waiting: null, active: null}, ['redundant'], 20),
  /No service worker is available/,
  'an absent installing worker must fail closed',
);
const missingCandidate = new RegistrationEmitter();
await assert.rejects(waitForWorkerState(missingCandidate, ['redundant'], 5), /Timed out waiting/);
assert.equal(missingCandidate.listeners.size, 0, 'an absent worker never resolves and updatefound is cleaned up on timeout');

const listenerRace = new WorkerEmitter('installing', worker => { worker.state = 'activated'; });
assert.equal(await waitForWorkerState(registration(listenerRace), ['activated'], 20), 'activated');
assert.equal(listenerRace.listeners.size, 0, 'a state change before listener attachment is rechecked and cleaned up');

const registrationRace = new RegistrationEmitter();
const appearsAfterRegister = new WorkerEmitter('installing');
const updateWait = waitForWorkerState(registrationRace, ['activated'], 100, '/sw.js?v=current');
registrationRace.updateFound(appearsAfterRegister);
appearsAfterRegister.transition('activated');
assert.equal(await updateWait, 'activated', 'updatefound installs the state listener for a late candidate');
assert.equal(registrationRace.listeners.size, 0, 'updatefound listener is removed');
assert.equal(appearsAfterRegister.listeners.size, 0, 'late worker state listener is removed');

const updateListenerRace = new WorkerEmitter('activated');
const registrationChangesDuringSubscribe = new RegistrationEmitter();
registrationChangesDuringSubscribe.addEventListener = function(type, listener) {
  RegistrationEmitter.prototype.addEventListener.call(this, type, listener);
  this.installing = updateListenerRace;
};
assert.equal(await waitForWorkerState(registrationChangesDuringSubscribe, ['activated'], 20, '/sw.js?v=current'), 'activated');
assert.equal(registrationChangesDuringSubscribe.listeners.size, 0, 'post-subscription state recheck removes updatefound listener');
assert.equal(updateListenerRace.listeners.size, 0, 'post-subscription state recheck removes worker listener');

const lostInstallingWorker = new WorkerEmitter('installing');
const stateChangesBeforeWorkerListener = new RegistrationEmitter();
stateChangesBeforeWorkerListener.installing = lostInstallingWorker;
stateChangesBeforeWorkerListener.addEventListener = function(type, listener) {
  RegistrationEmitter.prototype.addEventListener.call(this, type, listener);
  lostInstallingWorker.state = 'redundant';
  this.installing = null;
};
assert.equal(await waitForWorkerState(stateChangesBeforeWorkerListener, ['redundant'], 20, '/sw.js?v=current'), 'redundant');
assert.equal(stateChangesBeforeWorkerListener.listeners.size, 0);
assert.equal(lostInstallingWorker.listeners.size, 0, 'the original installing worker is retained across registration state changes');

const expectedRedundant = new WorkerEmitter('installing');
const redundantWait = waitForWorkerState(registration(expectedRedundant), ['redundant'], 100);
expectedRedundant.transition('redundant');
assert.equal(await redundantWait, 'redundant', 'the required failure path must observe redundant');
assert.equal(expectedRedundant.listeners.size, 0);

const unexpectedRedundant = new WorkerEmitter('redundant');
await assert.rejects(waitForWorkerState(registration(unexpectedRedundant), ['activated'], 20), /became redundant/);
assert.equal(unexpectedRedundant.listeners.size, 0);

const activated = new WorkerEmitter('installing');
const activatedWait = waitForWorkerState(registration(activated), ['activated'], 100);
activated.transition('activated');
assert.equal(await activatedWait, 'activated');
assert.equal(activated.listeners.size, 0, 'activated listeners are removed after success');

const timedOut = new WorkerEmitter('installing');
await assert.rejects(waitForWorkerState(registration(timedOut), ['activated'], 5), /Timed out waiting/);
assert.equal(timedOut.listeners.size, 0, 'timeout listeners are removed');

console.log('runtime-maturity worker waiter: 10 cases passed');
