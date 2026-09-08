const test = require('node:test');
const assert = require('node:assert');

// Mock chrome API before requiring background.js
global.chrome = {
    runtime: {
        onMessage: {
            addListener: () => {}
        },
        onInstalled: {
            addListener: () => {}
        },
        getURL: () => ''
    },
    browserAction: {
        onClicked: {
            addListener: () => {}
        }
    },
    commands: {
        onCommand: {
            addListener: () => {}
        }
    },
    storage: {
        sync: {
            get: () => {},
            set: () => {}
        },
        local: {
            get: (keys, cb) => cb && cb({}),
            set: (keys, cb) => cb && cb({})
        }
    },
    tabs: {
        onRemoved: {
            addListener: () => {}
        },
        query: () => {},
        sendMessage: () => {},
        create: () => {},
        executeScript: () => {}
    },
    alarms: {
        onAlarm: {
            addListener: () => {}
        },
        create: () => {},
        clear: () => {}
    },
    scripting: {
        executeScript: () => {}
    }
};

const { serializeError, previewText } = require('../background.js');

test('serializeError - returns an empty object for falsy inputs', () => {
    assert.deepStrictEqual(serializeError(null), {});
    assert.deepStrictEqual(serializeError(undefined), {});
    assert.deepStrictEqual(serializeError(false), {});
    assert.deepStrictEqual(serializeError(0), {});
    assert.deepStrictEqual(serializeError(''), {});
});

test('serializeError - serializes a standard Error object correctly', () => {
    const error = new Error('Something went wrong');
    error.name = 'CustomError';
    const serialized = serializeError(error);

    assert.strictEqual(serialized.name, 'CustomError');
    assert.strictEqual(serialized.message, 'Something went wrong');
    assert.strictEqual(typeof serialized.stack, 'string');
    assert.ok(serialized.stack.length > 0);
    assert.ok(serialized.stack.includes('Error: Something went wrong'));
});

test('serializeError - handles Error objects without a stack trace', () => {
    const error = new Error('No stack here');
    delete error.stack;

    const serialized = serializeError(error);
    assert.strictEqual(serialized.name, 'Error');
    assert.strictEqual(serialized.message, 'No stack here');
    assert.strictEqual(serialized.stack, '');
});

test('serializeError - gracefully handles string input', () => {
    const serialized = serializeError('Just a string error');

    assert.strictEqual(serialized.name, 'Error');
    assert.strictEqual(serialized.message, 'Just a string error');
    assert.strictEqual(serialized.stack, '');
});

test('serializeError - gracefully handles arbitrary object input', () => {
    const customObj = {
        message: 'Custom message',
        code: 500
    };
    const serialized = serializeError(customObj);

    assert.strictEqual(serialized.name, 'Error');
    assert.strictEqual(serialized.message, 'Custom message');
    assert.strictEqual(serialized.stack, '');
});

test('serializeError - truncates very long stack traces using previewText', () => {
    const error = new Error('Long stack error');
    error.stack = 'A'.repeat(1000);

    const serialized = serializeError(error);
    assert.ok(serialized.stack.length < 750);
    assert.strictEqual(serialized.stack.endsWith('…'), true);
});
