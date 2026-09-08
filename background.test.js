const assert = require('assert');
const test = require('node:test');

// Mock chrome before requiring background.js
global.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} }
  },
  browserAction: {
    onClicked: { addListener: () => {} }
  },
  commands: {
    onCommand: { addListener: () => {} }
  },
  tabs: {
    onRemoved: { addListener: () => {} }
  },
  alarms: {
    onAlarm: { addListener: () => {} }
  },
  storage: {
    sync: {
      get: () => {},
      set: () => {}
    },
    local: {
      get: () => {},
      set: () => {}
    }
  }
};

const { sanitizeLogValue } = require('./background.js');

test('sanitizeLogValue - basic types', (t) => {
  assert.strictEqual(sanitizeLogValue(null), null);
  assert.strictEqual(sanitizeLogValue(undefined), undefined);
  assert.strictEqual(sanitizeLogValue(123), 123);
  assert.strictEqual(sanitizeLogValue(true), true);
  assert.strictEqual(sanitizeLogValue('hello'), 'hello');
});

test('sanitizeLogValue - string truncation', (t) => {
  const shortString = 'a'.repeat(700);
  assert.strictEqual(sanitizeLogValue(shortString), shortString);

  const longString = 'a'.repeat(701);
  const expectedLongString = 'a'.repeat(697) + '...';
  assert.strictEqual(sanitizeLogValue(longString), expectedLongString);
});

test('sanitizeLogValue - Error objects', (t) => {
  const err = new Error('test error');
  const sanitizedErr = sanitizeLogValue(err);
  assert.strictEqual(sanitizedErr.name, 'Error');
  assert.strictEqual(sanitizedErr.message, 'test error');
  assert.ok(sanitizedErr.stack.includes('test error'));
});

test('sanitizeLogValue - Array with depth limiting', (t) => {
  const arr = [1, 2, 3];
  assert.deepStrictEqual(sanitizeLogValue(arr), [1, 2, 3]);

  const longArr = Array(15).fill(1);
  assert.deepStrictEqual(sanitizeLogValue(longArr), Array(12).fill(1));

  const nestedArr = [[1]];
  assert.deepStrictEqual(sanitizeLogValue(nestedArr), [[1]]);

  const deeplyNestedArr = [[[1]]];
  assert.strictEqual(sanitizeLogValue(deeplyNestedArr)[0][0], '[1 items]');
});

test('sanitizeLogValue - Object with depth limiting and cleanup', (t) => {
  const obj = { a: 1, b: 2 };
  assert.deepStrictEqual(sanitizeLogValue(obj), { a: 1, b: 2 });

  const withFunc = { a: 1, fn: () => {} };
  assert.deepStrictEqual(sanitizeLogValue(withFunc), { a: 1 });

  const withUndef = { a: 1, b: undefined };
  assert.deepStrictEqual(sanitizeLogValue(withUndef), { a: 1 });

  const deeplyNestedObj = { a: { b: { c: { d: 1 } } } };
  assert.deepStrictEqual(sanitizeLogValue(deeplyNestedObj), { a: { b: { c: '[object]' } } });

  const largeObj = {};
  for (let i = 0; i < 35; i++) {
    largeObj[`k${i}`] = i;
  }
  const sanitizedLargeObj = sanitizeLogValue(largeObj);
  assert.strictEqual(Object.keys(sanitizedLargeObj).length, 30);
});

test('sanitizeLogValue - fallback', (t) => {
  const symbol = Symbol('test');
  assert.strictEqual(sanitizeLogValue(symbol), 'Symbol(test)');
});
