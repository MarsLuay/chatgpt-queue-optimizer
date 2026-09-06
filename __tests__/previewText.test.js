global.chrome = {
    runtime: {
        onMessage: { addListener: jest.fn() },
        onInstalled: { addListener: jest.fn() },
        onStartup: { addListener: jest.fn() }
    },
    storage: {
        local: { get: jest.fn(), set: jest.fn() },
        onChanged: { addListener: jest.fn() }
    },
    tabs: {
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() },
        sendMessage: jest.fn()
    },
    alarms: {
        onAlarm: { addListener: jest.fn() },
        create: jest.fn(),
        get: jest.fn(),
        clear: jest.fn()
    },
    action: {
        setBadgeText: jest.fn(),
        setBadgeBackgroundColor: jest.fn()
    },
    commands: {
        onCommand: { addListener: jest.fn() }
    },
    contextMenus: {
        create: jest.fn(),
        onClicked: { addListener: jest.fn() }
    },
    windows: {
        create: jest.fn(),
        update: jest.fn(),
        get: jest.fn()
    }
};

const { previewText } = require('../background.js');

describe('previewText', () => {
    it('returns empty string for null or undefined', () => {
        expect(previewText(null)).toBe('');
        expect(previewText(undefined)).toBe('');
    });

    it('trims whitespace and normalizes internal spaces', () => {
        expect(previewText('  hello   world  ')).toBe('hello world');
    });

    it('returns the string as is if shorter than maxLength', () => {
        expect(previewText('hello world', 20)).toBe('hello world');
    });

    it('returns exact string if length equals maxLength', () => {
        expect(previewText('hello world', 11)).toBe('hello world');
    });

    it('truncates string and adds ellipsis if longer than maxLength', () => {
        // max length is 5. 'hello' is 5. 5-1 = 4. 0-4 is 'hell'. so 'hell…'
        expect(previewText('hello world', 5)).toBe('hell…');
    });

    it('uses default maxLength of 70', () => {
        const longStr = 'a'.repeat(80);
        const expected = 'a'.repeat(69) + '…';
        expect(previewText(longStr)).toBe(expected);
    });
});
