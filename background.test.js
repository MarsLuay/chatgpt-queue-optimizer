// Mock chrome API before requiring background.js
global.chrome = {
    runtime: {
        onMessage: { addListener: jest.fn() },
        onInstalled: { addListener: jest.fn() }
    },
    browserAction: { onClicked: { addListener: jest.fn() } },
    commands: { onCommand: { addListener: jest.fn() } },
    tabs: { onRemoved: { addListener: jest.fn() } },
    alarms: {
        onAlarm: { addListener: jest.fn() },
        clear: jest.fn()
    },
    storage: {
        sync: { get: jest.fn((keys, cb) => cb({})) },
        local: { get: jest.fn((keys, cb) => cb({})) }
    }
};

const { isChatGPTUrl } = require('./background.js');

describe('isChatGPTUrl', () => {
    it('should return true for valid ChatGPT URLs', () => {
        expect(isChatGPTUrl('https://chatgpt.com/c/1234')).toBe(true);
        expect(isChatGPTUrl('https://chat.openai.com/')).toBe(true);
        expect(isChatGPTUrl('https://CHATGPT.COM')).toBe(true);
        expect(isChatGPTUrl('https://CHAT.OPENAI.COM')).toBe(true);
    });

    it('should return false for http protocols', () => {
        expect(isChatGPTUrl('http://chatgpt.com')).toBe(false);
        expect(isChatGPTUrl('http://chat.openai.com')).toBe(false);
    });

    it('should return false for other domains', () => {
        expect(isChatGPTUrl('https://google.com')).toBe(false);
        expect(isChatGPTUrl('https://chat.openai.com.evil.com')).toBe(false);
        expect(isChatGPTUrl('https://openai.com')).toBe(false);
    });

    it('should return false for invalid URLs', () => {
        expect(isChatGPTUrl('not a url')).toBe(false);
        expect(isChatGPTUrl('')).toBe(false);
    });

    it('should return false for non-string inputs', () => {
        expect(isChatGPTUrl(null)).toBe(false);
        expect(isChatGPTUrl(undefined)).toBe(false);
        expect(isChatGPTUrl(123)).toBe(false);
        expect(isChatGPTUrl({})).toBe(false);
    });
});
