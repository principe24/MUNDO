import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { VirtualFiles } from '../src/files.js';
import { PluginManager } from '../src/plugins.js';

test('engine lifecycle and clamped delta', async () => {
  const events = [];
  const engine = new Engine().register('sample', {
    start: () => events.push('start'),
    update: dt => events.push(dt),
    stop: () => events.push('stop')
  });
  await engine.start();
  assert.equal(await engine.tick(1000), 0);
  assert.equal(await engine.tick(3000), 0.1);
  await engine.stop();
  assert.deepEqual(events, ['start', 0, 0.1, 'stop']);
});
test('virtual file paths and operations', () => {
  const fs = new VirtualFiles();
  fs.write('/assets/../world/scene.json', '{}');
  assert.equal(fs.read('/world/scene.json'), '{}');
  assert.deepEqual(fs.list('/world'), ['/world/scene.json']);
  assert.throws(() => fs.write('/../../escape', 'bad'));
  assert.equal(fs.remove('/world/scene.json'), true);
});
test('plugin lifecycle is idempotent', async () => {
  const events = [];
  const manager = new PluginManager();
  manager.register({ id: 'demo', activate: () => events.push('on'), deactivate: () => events.push('off') });
  await manager.activate('demo', {});
  await manager.activate('demo', {});
  await manager.shutdown();
  assert.deepEqual(events, ['on', 'off']);
});
