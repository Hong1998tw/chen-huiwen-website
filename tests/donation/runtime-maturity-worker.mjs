/** Wait for a specific observed worker state, following updatefound and statechange races. */
export async function waitForWorkerState(registration, expectedStates, timeoutMs, expectedScriptURL = null) {
  if (!Array.isArray(expectedStates) || expectedStates.length === 0) {
    throw new TypeError('At least one expected service worker state is required');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('A positive service worker state timeout is required');
  }

  if (!registration) throw new Error('No service worker registration is available to observe');
  const findWorker = () => [registration.installing, registration.waiting, registration.active]
    .find(worker => worker && (!expectedScriptURL || worker.scriptURL === expectedScriptURL)) ?? null;
  const initialWorker = findWorker();
  if (initialWorker?.state === 'redundant' && !expectedStates.includes('redundant')) {
    throw new Error('Service worker became redundant');
  }
  if (initialWorker && expectedStates.includes(initialWorker.state)) return initialWorker.state;

  return new Promise((resolve, reject) => {
    let timer;
    let worker = initialWorker;
    let workerListening = false;
    let registrationListening = false;
    let settled = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (workerListening) {
        workerListening = false;
        worker.removeEventListener('statechange', onStateChange);
      }
      if (registrationListening) {
        registrationListening = false;
        registration.removeEventListener('updatefound', onUpdateFound);
      }
    };
    const finish = (error, state) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(state);
    };
    const inspect = () => {
      try {
        const found = findWorker();
        if (found && found !== worker) {
          if (workerListening) worker.removeEventListener('statechange', onStateChange);
          worker = found;
          workerListening = false;
        }
        if (worker && !workerListening) {
          workerListening = true;
          worker.addEventListener('statechange', onStateChange);
        }
        if (!worker) return;
        if (expectedStates.includes(worker.state)) finish(null, worker.state);
        else if (worker.state === 'redundant') finish(new Error('Service worker became redundant'));
      } catch (error) {
        finish(error);
      }
    };
    const onStateChange = () => inspect();
    const onUpdateFound = () => inspect();

    timer = setTimeout(() => finish(new Error(`Timed out waiting for service worker state: ${expectedStates.join(', ')}`)), timeoutMs);
    try {
      if (typeof registration.addEventListener === 'function') {
        registrationListening = true;
        registration.addEventListener('updatefound', onUpdateFound);
      }
      // Recheck after both listeners are attached to close updatefound/statechange races.
      inspect();
      if (!worker && !registrationListening) finish(new Error('No service worker is available to observe'));
    } catch (error) {
      finish(error);
    }
  });
}
