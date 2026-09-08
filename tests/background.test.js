const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Mock Chrome API
const sandbox = {
    chrome: {
        runtime: {
            onMessage: { addListener: () => {} },
            onConnect: { addListener: () => {} },
            onStartup: { addListener: () => {} },
            onInstalled: { addListener: () => {} },
            onUpdateAvailable: { addListener: () => {} },
        },
        tabs: {
            onRemoved: { addListener: () => {} },
            onUpdated: { addListener: () => {} },
        },
        alarms: {
            onAlarm: { addListener: () => {} },
        },
        commands: {
            onCommand: { addListener: () => {} },
        },
        storage: {
            local: {
                get: () => {},
                set: () => {},
            }
        },
        contextMenus: {
            onClicked: { addListener: () => {} },
            create: () => {},
            removeAll: () => {}
        }
    },
    console: console,
    setInterval: setInterval,
    clearInterval: clearInterval,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    URL: URL,
    Math: Math,
    Number: Number,
    String: String
};

vm.createContext(sandbox);

// Load background.js into the sandbox
const backgroundCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
vm.runInContext(backgroundCode, sandbox);

const { getTotalMessages } = sandbox;

describe('getTotalMessages', () => {
    test('returns 0 when job is null', () => {
        assert.strictEqual(getTotalMessages(null), 0);
    });

    test('returns 0 when job is undefined', () => {
        assert.strictEqual(getTotalMessages(undefined), 0);
    });

    test('returns totalMessages when it is larger than calculated total', () => {
        const job = {
            totalMessages: 10,
            completedCount: 2,
            queue: [1, 2],
            currentMessage: 'msg'
        };
        assert.strictEqual(getTotalMessages(job), 10);
    });

    test('returns calculated total when totalMessages is smaller', () => {
        const job = {
            totalMessages: 3,
            completedCount: 2,
            queue: [1, 2, 3],
            currentMessage: 'msg'
        };
        assert.strictEqual(getTotalMessages(job), 6);
    });

    test('handles missing totalMessages correctly (calculates total)', () => {
        const job = {
            completedCount: 2,
            queue: [1, 2],
            currentMessage: 'msg'
        };
        assert.strictEqual(getTotalMessages(job), 5);
    });

    test('handles missing completedCount correctly', () => {
        const job = {
            totalMessages: 2,
            queue: [1, 2],
            currentMessage: 'msg'
        };
        assert.strictEqual(getTotalMessages(job), 3);
    });

    test('handles missing currentMessage correctly', () => {
        const job = {
            totalMessages: 2,
            completedCount: 1,
            queue: [1, 2],
            currentMessage: null
        };
        assert.strictEqual(getTotalMessages(job), 3);
    });

    test('handles empty queue correctly', () => {
        const job = {
            totalMessages: 2,
            completedCount: 1,
            queue: [],
            currentMessage: 'msg'
        };
        assert.strictEqual(getTotalMessages(job), 2);
    });

    test('string numbers in totalMessages are coerced', () => {
        const job = {
            totalMessages: "10",
            completedCount: 2,
            queue: [1, 2],
            currentMessage: 'msg'
        };
        assert.strictEqual(getTotalMessages(job), 10);
    });

    test('string numbers in completedCount are coerced', () => {
        const job = {
            totalMessages: 3,
            completedCount: "5",
            queue: [1, 2],
            currentMessage: 'msg'
        };
        assert.strictEqual(getTotalMessages(job), 8);
    });
});
