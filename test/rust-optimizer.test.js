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
    assert.equal(core.cpo_abi_version(), 3);
    assert.equal(core.cpo_image_surface_bytes(1920, 1080), 8294400);
    assert.equal(core.cpo_can_evict_playback(1, 1, 0, 0), 1);
    assert.equal(core.cpo_can_evict_playback(0, 1, 0, 0), 0);
    assert.equal(core.cpo_can_evict_playback(1, 0, 0, 0), 0);
    assert.equal(core.cpo_resource_units(100, 129, 2, 1, 1, 0), 422);
    assert.equal(core.cpo_adaptive_window(500, 50, 20, 4000, 4000), 20);
    assert.equal(core.cpo_adaptive_window(500, 50, 20, 4000, 1), 8);
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

test('adaptive budget selects a bounded recent window and matches native policy', async () => {
    const js = optimizer();
    js.config.resourceBudget = 4000;
    js.getResourceSample = () => ({ sampledTurns: 20, units: 4000 });
    const messages = { length: 500 };
    assert.equal(js.policyAdaptiveTarget(messages), 20);
    js.config.resourceBudget = 1;
    assert.equal(js.policyAdaptiveTarget(messages), 8);
    if (fs.existsSync(wasmPath)) {
        const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
        js.nativeCore = instance.exports;
        for (const budget of [1, 4000, 100000]) {
            js.config.resourceBudget = budget;
            assert.equal(js.policyAdaptiveTarget(messages),
                Math.min(50, Math.max(8, Math.floor(budget / 200))));
        }
    }
});

test('resource sampling counts nodes and text lengths without reading contents', () => {
    const instance = optimizer();
    const original = global.document;
    const root = { nodeType: 1, localName: 'article' };
    const textNode = { nodeType: 3, length: 129 };
    Object.defineProperty(textNode, 'textContent', {
        get() { throw new Error('Profiler must not copy text'); }
    });
    const descendants = [textNode, { nodeType: 1, localName: 'img' },
        { nodeType: 1, localName: 'video' }, { nodeType: 1, localName: 'canvas' }];
    try {
        global.document = { createTreeWalker() {
            let i = 0;
            return { nextNode: () => descendants[i++] || null };
        } };
        const sample = instance.sampleResources([root]);
        assert.equal(sample.nodes, 5);
        assert.equal(sample.textChars, 129);
        assert.equal(sample.images, 1);
        assert.equal(sample.media, 1);
        assert.equal(sample.surfaces, 1);
        assert.equal(sample.units, 295);
        assert.equal(sample.truncatedTurns, 0);
    } finally {
        if (original === undefined) delete global.document;
        else global.document = original;
    }
});

test('resource sampling stays bounded for very large turns', () => {
    const instance = optimizer();
    const original = global.document;
    const root = { nodeType: 1, localName: 'article' };
    try {
        global.document = { createTreeWalker() {
            return { nextNode: () => ({ nodeType: 1, localName: 'span' }) };
        } };
        const sample = instance.sampleResources(Array.from({ length: 100 }, () => root));
        assert.equal(sample.sampledTurns, 32);
        assert.equal(sample.nodes, 32 * 512);
        assert.equal(sample.truncatedTurns, 32);
    } finally {
        if (original === undefined) delete global.document;
        else global.document = original;
    }
});

test('adaptive window honors manual expansion and defers unsafe shrink', () => {
    const instance = optimizer();
    instance.config.enabled = true;
    instance.config.adaptiveBudget = true;
    instance.state = { visibleCount: 0, manualVisibleCount: 0, perf: {} };
    instance.policyAdaptiveTarget = () => 8;
    instance.canShrinkAdaptiveWindow = () => true;
    instance.sortMessagesByPosition = messages => messages;
    instance.hideMessage = () => {};
    instance.showMessage = () => {};
    instance.ensureBanner = () => {};
    instance.updateBanner = () => {};
    instance.setupAutoScroll = () => {};
    const turns = Array.from({ length: 100 }, () => ({ classList: { remove() {} } }));
    instance.getMessageNodes = () => turns;
    instance.applyWindowing(turns);
    assert.equal(instance.state.visibleCount, 8);
    instance.showOlderMessages();
    assert.equal(instance.state.visibleCount, 33);
    instance.applyWindowing(turns);
    assert.equal(instance.state.visibleCount, 33);
    instance.state.manualVisibleCount = 0;
    instance.canShrinkAdaptiveWindow = () => false;
    instance.applyWindowing(turns);
    assert.equal(instance.state.visibleCount, 33);
    instance.canShrinkAdaptiveWindow = () => true;
    instance.applyWindowing(turns);
    assert.equal(instance.state.visibleCount, 8);
});

function mockMedia(attributes = {}, props = {}) {
    const attrs = new Map(Object.entries(attributes));
    return {
        hasAttribute: name => attrs.has(name),
        getAttribute: name => attrs.get(name) ?? null,
        setAttribute: (name, value) => attrs.set(name, value),
        removeAttribute: name => attrs.delete(name),
        querySelectorAll: () => [],
        ...props
    };
}

function mediaOptimizer() {
    const instance = optimizer();
    instance.mediaOriginals = new WeakMap();
    instance.mediaStats = { imagesEvicted: 0, playbackEvicted: 0, restored: 0, estimatedImageBytes: 0 };
    return instance;
}

test('responsive image eviction preserves exact sources and estimates surfaces', () => {
    const instance = mediaOptimizer();
    const source = mockMedia({ srcset: 'a.jpg 1x, b.jpg 2x' });
    const picture = { querySelectorAll: () => [source] };
    const image = mockMedia({ src: 'small.jpg', srcset: 'large.jpg 2x' }, {
        naturalWidth: 100, naturalHeight: 50, closest: () => picture
    });
    const root = { querySelectorAll: () => [image], contains: () => true };
    instance.preventImageLoading(root);
    assert.equal(source.hasAttribute('srcset'), false);
    assert.equal(image.hasAttribute('src'), false);
    assert.equal(image.hasAttribute('srcset'), false);
    assert.equal(instance.mediaStats.estimatedImageBytes, 20000);
    instance.restoreImages(root);
    assert.equal(image.getAttribute('src'), 'small.jpg');
    assert.equal(image.getAttribute('srcset'), 'large.jpg 2x');
    assert.equal(source.getAttribute('srcset'), 'a.jpg 1x, b.jpg 2x');
});

test('media eviction avoids protected sources and newer application values', () => {
    const instance = mediaOptimizer();
    const image = mockMedia({ src: 'old.jpg' });
    assert.equal(instance.stashSources(image, ['src']), true);
    image.setAttribute('src', 'new.jpg');
    assert.equal(instance.restoreSources(image), false);
    assert.equal(image.getAttribute('src'), 'new.jpg');
    const protectedImage = mockMedia({ srcset: 'normal.jpg 1x, blob:protected 2x' });
    assert.equal(instance.stashSources(protectedImage, ['srcset']), false);
    assert.equal(protectedImage.hasAttribute('srcset'), true);
});

test('paused playback eviction is reversible and leaves active and seeked media alone', () => {
    const instance = mediaOptimizer();
    let loads = 0;
    const paused = mockMedia({ src: 'clip.mp4' }, { paused: true, currentTime: 0, load() { loads++; } });
    const active = mockMedia({ src: 'active.mp4' }, { paused: false, currentTime: 0 });
    const seeked = mockMedia({ src: 'seeked.mp4' }, { paused: true, currentTime: 4 });
    const stream = mockMedia({ src: 'stream.mp4' }, { paused: true, currentTime: 0, srcObject: {} });
    const root = { querySelectorAll: () => [paused, active, seeked, stream] };
    instance.evictPlayback(root);
    assert.equal(paused.hasAttribute('src'), false);
    assert.equal(active.hasAttribute('src'), true);
    assert.equal(seeked.hasAttribute('src'), true);
    assert.equal(stream.hasAttribute('src'), true);
    assert.equal(instance.mediaStats.playbackEvicted, 1);
    instance.restorePlayback(root);
    assert.equal(paused.getAttribute('src'), 'clip.mp4');
    assert.equal(loads, 2);
});

test('explicit cache cleanup drops retained DOM references and timers', () => {
    const instance = optimizer();
    instance._cachedMessages = [{}];
    instance._cacheTimestamp = Date.now();
    instance._messageCacheTimer = setTimeout(() => {}, 10000);
    instance.clearMessageCache();
    assert.equal(instance._cachedMessages, null);
    assert.equal(instance._cacheTimestamp, null);
    assert.equal(instance._messageCacheTimer, null);
});
