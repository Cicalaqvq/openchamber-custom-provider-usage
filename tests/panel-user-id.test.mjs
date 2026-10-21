import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.hidden = false; this.value = ''; this.disabled = false; this.listeners = {}; this.className = ''; this._text = ''; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { for (const n of nodes) { this.children.push(n); n.parent = this; } }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(k, fn) { (this.listeners[k] ??= []).push(fn); }
  dispatch(k) { for (const fn of this.listeners[k] ?? []) fn({ target: this }); }
  get innerText() { return this.textContent; }
  querySelectorAll(selector) {
    const out = [];
    const matches = (e) => selector === 'input' ? e.tagName === 'INPUT' : selector === 'button' ? e.tagName === 'BUTTON' : selector.startsWith('.') ? e.className.split(/\s+/).includes(selector.slice(1)) : false;
    const visit = (e) => { for (const c of e.children) { if (matches(c)) out.push(c); visit(c); } };
    visit(this); return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() {}
}

function makeDocument() {
  const root = new Element();
  for (const key of ['list', 'empty', 'summary', 'banner', 'actions', 'auto', 'interval']) { const e = new Element(); e.dataset[key] = ''; root.append(e); }
  const document = { documentElement: new Element(), createElement: (tag) => new Element(tag), querySelector: (s) => s === '#root' ? root : null };
  root.querySelector = (s) => {
    if (s === '#root') return root;
    const key = s.match(/^\[data-(.+)\]$/)?.[1];
    return key ? root.children.find((e) => Object.hasOwn(e.dataset, key)) ?? null : root.querySelectorAll(s)[0] ?? null;
  };
  return { document, root };
}

function field(parent, opts) {
  const wrap = new Element('label'); wrap.textContent = opts.label;
  const input = new Element('input'); input.value = opts.value ?? ''; input.disabled = !!opts.disabled;
  input.addEventListener('input', () => opts.onChange(input.value)); wrap.append(input);
  if (opts.helper) { const h = new Element(); h.textContent = opts.helper; wrap.append(h); }
  if (opts.error) { const e = new Element(); e.className = 'field-error'; e.textContent = opts.error; wrap.append(e); }
  parent.append(wrap);
  return { update(next) { if ('value' in next) input.value = next.value; if ('error' in next) { /* only interval field uses update */ } }, dispose() {} };
}

function button(parent, opts) {
  const b = new Element('button'); b.textContent = opts.label; b.disabled = !!opts.disabled; b.click = () => { if (!b.disabled) opts.onClick(); };
  parent.append(b);
  return { update(next) { if ('disabled' in next) b.disabled = next.disabled; }, dispose() {} };
}

function findButton(root, label) { return root.querySelectorAll('button').find((b) => b.textContent === label); }
function editorFields(root) {
  const editor = root.querySelectorAll('.site-editor').at(-1);
  return editor.querySelectorAll('input');
}
function setInput(input, value) { input.value = value; input.dispatch('input'); }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('panel user ID edit, validation, cancel, and save paths use actual panel module', async () => {
  const tempRoot = join(tmpdir(), "opencode");
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, "panel-user-id-test-"));
  let writeCount = 0;
  const storage = {
    'sites.v1': [{ id: 'existing', name: 'Existing', origin: 'https://relay.example.com', token: 'stored-PAT', userId: '9527' }],
    'settings.v1': undefined,
  };
  const { document, root } = makeDocument();
  globalThis.document = document;
  globalThis.window = { addEventListener() {} };
  const host = {
    storage: { get: async (key) => storage[key], set: async (key, value) => { writeCount += 1; storage[key] = structuredClone(value); } },
    onReady: () => () => {}, dispose() {}, openUrl: async () => {},
  };
  const ui = {
    mountButton: button,
    mountBadge(parent, opts) { const e = new Element(); e.textContent = opts.label; parent.append(e); return {}; },
    mountSwitch(parent, opts) { const e = new Element(); parent.append(e); return { update() {} }; },
    mountTextField: field,
    applyHostReady() {},
  };
  try {
    const outfile = join(dir, 'panel.mjs');
    await build({ entryPoints: [resolve('src/panel-main.ts')], outfile, bundle: true, format: 'esm', platform: 'node', plugins: [{
      name: 'panel-test-stubs', setup(buildApi) {
        buildApi.onResolve({ filter: /^@openchamber\/sdk$/ }, () => ({ path: 'sdk', namespace: 'stub' }));
        buildApi.onResolve({ filter: /^@openchamber\/sdk\/ui$/ }, () => ({ path: 'ui', namespace: 'stub' }));
        buildApi.onResolve({ filter: /^\.\/data$/ }, () => ({ path: 'data', namespace: 'stub' }));
        buildApi.onResolve({ filter: /^\.\/new-api$/ }, () => ({ path: 'new-api', namespace: 'stub' }));
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: args.path === 'sdk'
          ? `export const connectHost=()=>globalThis.__host;`
          : args.path === 'ui' ? Object.keys(ui).map((name) => `export const ${name}=globalThis.__ui.${name};`).join('\n')
            : args.path === 'data' ? `export const createQuerier=()=>({}); export const querySite=async()=>({display:'',unit:''});`
              : `export const safeErrorMessage=(e)=>String(e);`, loader: 'js' }));
      },
    }] });
    globalThis.__host = host; globalThis.__ui = ui;
    await import(`${pathToFileURL(outfile).href}?run=${Date.now()}`);
    await tick();

    // Existing ID is shown in the real editor; a blank token preserves the stored PAT.
    findButton(root, '编辑').click();
    let fields = editorFields(root);
    assert.equal(fields[2].value, '');
    assert.equal(fields[3].value, '9527');
    setInput(fields[3], '12345');
    findButton(root, '完成').click();
    findButton(root, '保存').click();
    await tick();
    assert.equal(storage['sites.v1'][0].userId, '12345');
    assert.equal(storage['sites.v1'][0].token, 'stored-PAT');

    // Direct header Save while editing commits the draft as well.
    findButton(root, '编辑').click(); fields = editorFields(root);
    setInput(fields[3], '777'); findButton(root, '保存').click(); await tick();
    assert.equal(storage['sites.v1'][0].userId, '777');

    // Cancel restores committed state and never writes the draft.
    findButton(root, "编辑").click(); fields = editorFields(root);
    const writesBeforeCancel = writeCount;
    setInput(fields[3], "888"); findButton(root, "取消").click();
    assert.equal(storage['sites.v1'][0].userId, '777');
    assert.equal(writeCount, writesBeforeCancel);
    findButton(root, "编辑").click();
    assert.equal(editorFields(root)[3].value, "777");
    findButton(root, "取消").click();

    // Clearing is committed as omission, not the old property.
    findButton(root, '编辑').click(); fields = editorFields(root);
    setInput(fields[3], ''); findButton(root, '完成').click(); findButton(root, '保存').click(); await tick();
    assert.equal(Object.hasOwn(storage['sites.v1'][0], 'userId'), false);

    // Invalid ID surfaces field validation and prevents persistence.
    findButton(root, "编辑").click(); fields = editorFields(root);
    const writesBeforeInvalid = writeCount;
    setInput(fields[3], "0"); findButton(root, "完成").click();
    assert.equal(storage['sites.v1'][0].userId, undefined);
    const errorText = root.querySelectorAll('.field-error').map((e) => e.textContent).join(' ');
    assert.match(errorText, /正整数/);
    findButton(root, "保存").click();
    await tick();
    assert.equal(writeCount, writesBeforeInvalid);
    assert.equal(storage['sites.v1'][0].userId, undefined);
    assert.match(root.querySelectorAll('.field-error').map((e) => e.textContent).join(' '), /正整数/);
    findButton(root, "取消").click();

    // A new site can be created with its optional user ID in the header Save path.
    findButton(root, "添加中转站").click();
    fields = editorFields(root);
    setInput(fields[1], "https://new-relay.example.com");
    setInput(fields[2], "new-PAT");
    setInput(fields[3], "7654");
    findButton(root, "保存").click();
    await tick();
    assert.equal(storage['sites.v1'].length, 2);
    assert.equal(storage['sites.v1'][1].userId, "7654");
  } finally {
    delete globalThis.__host; delete globalThis.__ui;
    delete globalThis.document; delete globalThis.window;
    await rm(dir, { recursive: true, force: true });
  }
});
