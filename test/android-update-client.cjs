const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('../mobile/node_modules/typescript');
function fixture() {
  const dialogs = [], cleanups = [];
  let installs = 0, discards = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: value => ({ current: value }), useState: value => [value, () => {}],
    useEffect: effect => { cleanups.push(effect()); },
  };
  const updater = { prepare: async () => {}, install: async () => { installs++; return 'installer_opened'; }, discard: async () => { discards++; } };
  const file = path.resolve(__dirname, '../mobile/src/AndroidUpdate.tsx');
  const mod = new Module(file, module);
  mod.require = name => ({
    react: React,
    'react-native': { Alert: { alert: (...args) => dialogs.push(args) }, Platform: { OS: 'android' }, Pressable: 'button', Text: 'text', View: 'view' },
    'expo-modules-core': { requireOptionalNativeModule: () => updater },
    '@clerk/expo': { useAuth: () => ({ userId: 'fixture-user', getToken: async () => 'fixture-token' }) },
    './config': { ORIGIN: 'https://fixture.invalid' },
    './android-release': { validateAndroidRelease: value => value },
  })[name];
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText, file);
  const tree = mod.exports.default();
  return { download: tree.children[0].props.onPress, dialogs, cleanups, counts: () => ({ installs, discards }) };
}
(async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ version: '1.0.1' }) });
  try {
    const f = fixture();
    await f.download(); await f.download();
    assert.equal(f.dialogs.length, 2);
    f.dialogs[0][2][0].onPress(); f.dialogs[0][2][1].onPress();
    assert.deepEqual(f.counts(), { installs: 0, discards: 0 }, 'old dialog cannot cancel or install newer download');
    f.dialogs[1][2][1].onPress();
    assert.equal(f.counts().installs, 1, 'current reviewed dialog can launch installer');
    f.cleanups.forEach(cleanup => cleanup?.());
    f.dialogs[1][2][0].onPress(); f.dialogs[1][2][1].onPress();
    assert.deepEqual(f.counts(), { installs: 1, discards: 1 }, 'unmounted dialogs cannot act on another account/component');
    console.log('PASS: stale update dialogs cannot cancel/install newer downloads or act after unmount.');
  } finally { global.fetch = previousFetch; }
})().catch(error => { console.error(error); process.exitCode = 1; });
