// Mock chrome API before requiring background.js
global.chrome = {
    runtime: {
        onMessage: {
            addListener: jest.fn()
        },
        onInstalled: {
            addListener: jest.fn()
        },
        getURL: jest.fn()
    },
    browserAction: {
        onClicked: {
            addListener: jest.fn()
        }
    },
    commands: {
        onCommand: {
            addListener: jest.fn()
        }
    },
    storage: {
        sync: {
            get: jest.fn(),
            set: jest.fn()
        },
        local: {
            get: jest.fn((keys, cb) => cb && cb({})),
            set: jest.fn((keys, cb) => cb && cb({}))
        }
    },
    tabs: {
        onRemoved: {
            addListener: jest.fn()
        },
        query: jest.fn(),
        sendMessage: jest.fn(),
        create: jest.fn(),
        executeScript: jest.fn()
    },
    alarms: {
        onAlarm: {
            addListener: jest.fn()
        },
        create: jest.fn(),
        clear: jest.fn()
    },
    scripting: {
        executeScript: jest.fn()
    }
};

const { serializeError, previewText } = require('../background.js');

describe('serializeError', () => {
    it('returns an empty object for falsy inputs', () => {
        expect(serializeError(null)).toEqual({});
        expect(serializeError(undefined)).toEqual({});
        expect(serializeError(false)).toEqual({});
        expect(serializeError(0)).toEqual({});
        expect(serializeError('')).toEqual({});
    });

    it('serializes a standard Error object correctly', () => {
        const error = new Error('Something went wrong');
        error.name = 'CustomError';
        const serialized = serializeError(error);

        expect(serialized).toHaveProperty('name', 'CustomError');
        expect(serialized).toHaveProperty('message', 'Something went wrong');
        expect(typeof serialized.stack).toBe('string');
        expect(serialized.stack.length).toBeGreaterThan(0);
        expect(serialized.stack).toContain('Error: Something went wrong');
    });

    it('handles Error objects without a stack trace', () => {
        const error = new Error('No stack here');
        delete error.stack;

        const serialized = serializeError(error);
        expect(serialized).toHaveProperty('name', 'Error');
        expect(serialized).toHaveProperty('message', 'No stack here');
        expect(serialized).toHaveProperty('stack', '');
    });

    it('gracefully handles string input', () => {
        const serialized = serializeError('Just a string error');

        // Strings don't have .name, .message, or .stack
        expect(serialized).toHaveProperty('name', 'Error');
        expect(serialized).toHaveProperty('message', 'Just a string error');
        expect(serialized).toHaveProperty('stack', '');
    });

    it('gracefully handles arbitrary object input', () => {
        const customObj = {
            message: 'Custom message',
            code: 500
        };
        const serialized = serializeError(customObj);

        expect(serialized).toHaveProperty('name', 'Error');
        expect(serialized).toHaveProperty('message', 'Custom message');
        expect(serialized).toHaveProperty('stack', '');
    });

    it('truncates very long stack traces using previewText', () => {
        const error = new Error('Long stack error');
        // Create an artificially long stack trace
        error.stack = 'A'.repeat(1000);

        const serialized = serializeError(error);
        expect(serialized.stack.length).toBeLessThan(750);
        expect(serialized.stack.endsWith('…')).toBe(true);
    });
});
