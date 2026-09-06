const { sanitizeLogValue } = require('./background.js');

describe('sanitizeLogValue', () => {
    it('returns null and undefined as is', () => {
        expect(sanitizeLogValue(null)).toBeNull();
        expect(sanitizeLogValue(undefined)).toBeUndefined();
    });

    it('returns primitive values as is (number, boolean)', () => {
        expect(sanitizeLogValue(123)).toBe(123);
        expect(sanitizeLogValue(0)).toBe(0);
        expect(sanitizeLogValue(true)).toBe(true);
        expect(sanitizeLogValue(false)).toBe(false);
    });

    it('truncates long strings', () => {
        const shortString = 'hello world';
        expect(sanitizeLogValue(shortString)).toBe(shortString);

        const longString = 'a'.repeat(800);
        const expected = 'a'.repeat(697) + '...';
        expect(sanitizeLogValue(longString)).toBe(expected);
    });

    it('serializes Error objects', () => {
        const err = new Error('test error');
        err.name = 'TestError';
        const sanitized = sanitizeLogValue(err);

        expect(sanitized.name).toBe('TestError');
        expect(sanitized.message).toBe('test error');
        expect(typeof sanitized.stack).toBe('string');
        expect(sanitized.stack.length).toBeGreaterThan(0);
    });

    it('handles arrays, limiting length and depth', () => {
        const arr = [1, 2, 3];
        expect(sanitizeLogValue(arr)).toEqual([1, 2, 3]);

        const longArr = Array.from({ length: 20 }, (_, i) => i);
        const sanitizedLongArr = sanitizeLogValue(longArr);
        expect(sanitizedLongArr.length).toBe(12);
        expect(sanitizedLongArr).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

        const deepArr = [[[['too deep']]]];
        expect(sanitizeLogValue(deepArr)).toEqual([['[1 items]']]); // Array depth 0 -> 1 -> 2
    });

    it('handles objects, skipping functions and undefined, limiting entries and depth', () => {
        const obj = { a: 1, b: 'test', c: true };
        expect(sanitizeLogValue(obj)).toEqual({ a: 1, b: 'test', c: true });

        const withFunc = { a: 1, b: () => {}, c: undefined, d: 2 };
        expect(sanitizeLogValue(withFunc)).toEqual({ a: 1, d: 2 });

        const longObj = {};
        for (let i = 0; i < 40; i++) {
            longObj[`key${i}`] = i;
        }
        const sanitizedLongObj = sanitizeLogValue(longObj);
        expect(Object.keys(sanitizedLongObj).length).toBe(30);

        const deepObj = { a: { b: { c: { d: 'too deep' } } } };
        expect(sanitizeLogValue(deepObj)).toEqual({ a: { b: { c: '[object]' } } }); // Object depth 0 -> 1 -> 2 -> 3
    });

    it('stringifies other types', () => {
        const symbol = Symbol('test');
        expect(sanitizeLogValue(symbol)).toBe('Symbol(test)');
    });
});
