import assert from 'node:assert/strict';
import test from 'node:test';
import { withTimeout } from './page-font-artifact-lifecycle.mjs';

test('host deadline rejects an operation that never settles', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 15, 'never-settling fixture'),
    /never-settling fixture: exceeded 15ms/);
});

test('host deadline rejects when requestAnimationFrame never calls back', async () => {
  const requestAnimationFrame = () => 1;
  const frame = new Promise(resolve => requestAnimationFrame(resolve));
  await assert.rejects(withTimeout(frame, 15, 'requestAnimationFrame fixture'),
    /requestAnimationFrame fixture: exceeded 15ms/);
});

test('host deadline preserves an operation rejection', async () => {
  const failure = new Error('fixture operation failed');
  await assert.rejects(withTimeout(Promise.reject(failure), 100, 'rejected fixture'),
    error => error === failure);
});

test('host deadline returns a successful operation value', async () => {
  assert.equal(await withTimeout(Promise.resolve('ready'), 100, 'successful fixture'), 'ready');
});
