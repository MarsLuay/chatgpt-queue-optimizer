const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ChatGPTOptimizer } = require('../content.js');

const wasmPath = path.join(__dirname, '..', 'optimizer_core.wasm');

function optimizer() {
    const instance = Object.create(ChatGPTOptimizer.prototype);
    instance.config = { windowSize: 50, batchSize: 25 };
    instance.nativeCore = null;
    return instance;
}

test('fallback policy preserves configured and expanded windows', () => {
    const instance = optimizer();
    assert.equal(instance.policyVisible(500), 50);
    assert.equal(instance.policyVisible(500, 75), 75);
    assert.equal(instance.policyVisible(4, 75), 4);
    assert.equal(instance.policyBatch(5), 5);
    instance.config.windowSize = 2;
    assert.equal(instance.policyVisible(100), 8);
});

test('compiled Rust WASM implements the same window and batch policy', {
    skip: !fs.existsSync(wasmPath) && 'Build WASM with python Installers/build_optimizer.py'
}, async () => {
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    const core = instance.exports;
    assert.equal(core.cpo_abi_version(), 1);
    assert.equal(core.cpo_expand_count(500, 50, 25), 75);
    assert.equal(core.cpo_hidden_count(500, 50), 450);
    assert.equal(core.cpo_offscreen_end(500), 492);
    assert.equal(core.cpo_expand_count(-1, -2, 25) >>> 0, 0xffffffff);
    const js = optimizer();
    const native = optimizer();
    native.nativeCore = core;
    for (const windowSize of [0, 2, 10, 50, 500]) {
        js.config.windowSize = native.config.windowSize = windowSize;
        for (const total of [0, 4, 10, 50, 500, 10000]) {
            for (const expanded of [0, 8, 50, 100, 500]) {
                assert.equal(native.policyVisible(total, expanded), js.policyVisible(total, expanded));
            }
            assert.equal(native.policyBatch(total), js.policyBatch(total));
        }
    }
});

test('native failure falls back to JS without breaking conversation window', () => {
    const instance = optimizer();
    instance.nativeCore = { cpo_visible_count() { throw new Error('test trap'); } };
    assert.equal(instance.policyVisible(500), 50);
    assert.equal(instance.nativeCore, null);
    assert.equal(instance.nativeCoreState, 'unavailable');
});
