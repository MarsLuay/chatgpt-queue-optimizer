const test = require('node:test');
const assert = require('node:assert');

// Mock chrome API before requiring background.js
global.chrome = {
    runtime: {
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} }
    },
    storage: {
        local: { get: () => {}, set: () => {} },
        onChanged: { addListener: () => {} }
    },
    tabs: {
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
        sendMessage: () => {}
    },
    alarms: {
        onAlarm: { addListener: () => {} },
        create: () => {},
        get: () => {},
        clear: () => {}
    },
    action: {
        setBadgeText: () => {},
        setBadgeBackgroundColor: () => {}
    },
    commands: {
        onCommand: { addListener: () => {} }
    },
    contextMenus: {
        create: () => {},
        onClicked: { addListener: () => {} }
    },
    windows: {
        create: () => {},
        update: () => {},
        get: () => {}
    }
};

const { previewText } = require('../background.js');

test('previewText - returns empty string for null or undefined', () => {
    assert.strictEqual(previewText(null), '');
    assert.strictEqual(previewText(undefined), '');
});

test('previewText - trims whitespace and normalizes internal spaces', () => {
    assert.strictEqual(previewText('  hello   world  '), 'hello world');
});

test('previewText - returns the string as is if shorter than maxLength', () => {
    assert.strictEqual(previewText('hello world', 20), 'hello world');
});

test('previewText - returns exact string if length equals maxLength', () => {
    assert.strictEqual(previewText('hello world', 11), 'hello world');
});

test('previewText - truncates string and adds ellipsis if longer than maxLength', () => {
    assert.strictEqual(previewText('hello world', 5), 'hell…');
});

test('previewText - uses default maxLength of 70', () => {
    const longStr = 'a'.repeat(80);
    const expected = 'a'.repeat(69) + '…';
    assert.strictEqual(previewText(longStr), expected);
});
