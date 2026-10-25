const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { harness, base } = require('../src/obsidian-folder-overview/tests/helpers/host.cjs');

function processorHarness(layoutReady = true) {
  const h = harness();
  const { OverviewBlockLifecycle } = h.load(path.join(base, 'utils/OverviewBlockLifecycle.ts'));
  // Run the actual processor method, isolating the plugin's unrelated startup imports.
  const entry = 'src/main.ts';
  const file = ts.createSourceFile(entry, fs.readFileSync(path.resolve(__dirname, '..', entry), 'utf8'), ts.ScriptTarget.Latest, true);
  const cls = file.statements.find(ts.isClassDeclaration);
  const method = cls.members.find(member => member.name?.getText(file) === 'handleOverviewBlock');
  const code = ts.transpileModule(`class Processor { ${method.getText(file)} }; Processor`, { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText;
  const ready = [], created = [], rendered = [], opened = [];
  const Processor = vm.runInNewContext(code, {
    OverviewBlockLifecycle,
    MutationObserver: h.MutationObserver,
    FolderOverview: class {
      constructor(...args) { created.push(args); }
      create(...args) { rendered.push(args); return Promise.resolve(); }
    },
    FolderOverviewSettings: class {
      constructor(...args) { this.args = args; }
      open() { opened.push(this.args); }
    },
    parseYaml: JSON.parse, Notice: class {}, console,
  });
  const processor = new Processor();
  processor.overviewEditHandlers = new WeakMap();
  processor.settings = { defaultOverview: { title: 'initial defaults' } };
  processor.app = { workspace: { layoutReady, onLayoutReady(fn) { ready.push(fn); } } };
  function context(sourcePath) {
    const children = [];
    return { sourcePath, children, addChild(child) { children.push(child); } };
  }
  return { ...h, processor, ready, created, rendered, opened, context };
}

test('closing before layout ready prevents deferred overview creation', async () => {
  const h = processorHarness(false);
  const ctx = h.context('fixture/overview.md');
  h.processor.handleOverviewBlock('{}', new h.Element(), ctx);
  assert.equal(ctx.children.length, 1, 'the processor must register a lifecycle child');
  ctx.children[0].unload();
  await h.ready[0]();
  assert.equal(h.created.length, 0);
  assert.equal(h.rendered.length, 0);
  assert.ok(h.observers.every(observer => !observer.active));
});

test('processor edit handlers use current source, context and defaults through replacement and reprocessing', () => {
  const h = processorHarness();
  const el = new h.Element();
  let button = new h.Element();
  el.parentElement = { childNodes: { item: () => button } };
  const firstContext = h.context('fixture/first.md');
  const firstSource = JSON.stringify({ title: 'first overview' });
  h.processor.handleOverviewBlock(firstSource, el, firstContext);
  h.observers[0].fire();
  assert.deepEqual(h.created[0], [h.processor, firstContext, firstSource, el, h.processor.settings.defaultOverview]);
  assert.deepEqual(h.rendered[0], [h.processor, el, firstContext]);
  assert.equal(button.listeners.get('click')?.size ?? 0, 1, 'the initial edit button must have one handler');
  button.click();
  assert.deepEqual(h.opened[0], [h.processor.app, h.processor, { title: 'first overview' }, firstContext, el, h.processor.settings.defaultOverview]);

  const previousButton = button;
  button = new h.Element();
  for (let i = 0; i < 1000; i++) h.observers[0].fire();
  assert.equal(previousButton.listeners.get('click').size, 0);
  assert.equal(button.listeners.get('click').size, 1);
  h.processor.settings.defaultOverview = { title: 'updated defaults' };
  button.click();
  assert.deepEqual(h.opened[1], [h.processor.app, h.processor, { title: 'first overview' }, firstContext, el, h.processor.settings.defaultOverview]);

  const secondContext = h.context('fixture/second.md');
  const secondSource = JSON.stringify({ title: 'reprocessed overview' });
  h.processor.handleOverviewBlock(secondSource, el, secondContext);
  assert.equal(button.listeners.get('click').size, 1);
  for (let i = 0; i < 1000; i++) h.observers.forEach(observer => observer.fire());
  assert.equal(button.listeners.get('click').size, 1);
  firstContext.children[0].unload();
  assert.equal(h.observers[0].active, false);
  button.click();
  assert.equal(h.opened.length, 3);
  assert.deepEqual(h.opened[2], [h.processor.app, h.processor, { title: 'reprocessed overview' }, secondContext, el, h.processor.settings.defaultOverview]);

  secondContext.children[0].unload();
  assert.ok(h.observers.every(observer => !observer.active));
  assert.equal(button.listeners.get('click').size, 0);
  button.click();
  h.observers.forEach(observer => observer.fire());
  assert.equal(h.opened.length, 3);
  assert.equal(button.listeners.get('click').size, 0);
});
