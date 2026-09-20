const assert = require('assert');
const test = require('node:test');

const localStorageData = {};
const localSetCalls = [];
const deferredLocalWrites = [];
let deferLocalWrites = false;

function clone(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function getLocalStorage(keys, callback) {
  const result = {};
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (Object.prototype.hasOwnProperty.call(localStorageData, key)) {
      result[key] = clone(localStorageData[key]);
    }
  }
  callback(result);
}

function applyLocalWrite(items) {
  for (const [key, value] of Object.entries(items)) {
    localStorageData[key] = clone(value);
  }
}

function setLocalStorage(items, callback) {
  localSetCalls.push(clone(items));
  if (deferLocalWrites) {
    deferredLocalWrites.push({ items: clone(items), callback });
    return;
  }

  applyLocalWrite(items);
  if (callback) callback();
}

function releaseDeferredLocalWrites() {
  const writes = deferredLocalWrites.splice(0);
  for (const write of writes) {
    applyLocalWrite(write.items);
    if (write.callback) write.callback();
  }
}

global.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: (_message, callback) => callback?.()
  },
  browserAction: {
    onClicked: { addListener: () => {} }
  },
  commands: {
    onCommand: { addListener: () => {} }
  },
  tabs: {
    onRemoved: { addListener: () => {} },
    sendMessage: (_tabId, _message, callback) => callback?.()
  },
  alarms: {
    onAlarm: { addListener: () => {} },
    create: () => {},
    clear: () => {}
  },
  storage: {
    sync: {
      get: (defaults, callback) => callback({ ...defaults }),
      set: () => {}
    },
    local: {
      get: getLocalStorage,
      set: setLocalStorage
    }
  }
};

const {
  sanitizeLogValue,
  logQueueEvent,
  jobs,
  updateRunningJobsStorage,
  flushQueueState,
  flushQueueDebugLogs,
  handleGetQueueDebugLogs,
  handleClearQueueDebugLogs,
  resumeDurableQueues,
  restoreDurableJobs,
  getDurableJobsState,
  MAX_QUEUE_DEBUG_LOG_ENTRIES
} = require('./background.js');

function invokeHandler(handler) {
  return new Promise((resolve) => {
    handler(resolve);
  });
}

async function resetQueueFixture() {
  jobs.clear();
  await updateRunningJobsStorage({ force: true });
  await flushQueueState();
  await flushQueueDebugLogs();
  for (const key of Object.keys(localStorageData)) {
    delete localStorageData[key];
  }
  localSetCalls.length = 0;
  deferLocalWrites = false;
  deferredLocalWrites.length = 0;
}

function queueStateWrites() {
  return localSetCalls.filter((items) => Object.prototype.hasOwnProperty.call(items, 'queueDurableJobs'));
}

function queueLogWrites() {
  return localSetCalls.filter((items) => Object.prototype.hasOwnProperty.call(items, 'queueDebugLogs'));
}

function createFixtureJob() {
  return {
    tabId: 41,
    provider: 'chatgpt',
    conversationId: 'fixture',
    conversationType: 'existing',
    targetKey: 'chatgpt:c:fixture',
    queue: ['one', 'two', 'three'],
    currentMessage: null,
    isRunning: true,
    isPaused: false,
    isStopped: false,
    currentPhase: 'queued',
    totalMessages: 3,
    completedCount: 0,
    currentCommandNumber: 0,
    startedAt: 1,
    updatedAt: 1
  };
}

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

test('queue snapshots coalesce and skip unchanged state', async () => {
  await resetQueueFixture();
  const job = createFixtureJob();
  jobs.set(job.tabId, job);

  job.currentPhase = 'sending';
  updateRunningJobsStorage();
  job.currentPhase = 'waiting';
  updateRunningJobsStorage();
  await flushQueueState();

  assert.strictEqual(queueStateWrites().length, 1);
  assert.strictEqual(localStorageData.queueDurableJobs[job.tabId].currentPhase, 'waiting');

  updateRunningJobsStorage();
  await flushQueueState();
  assert.strictEqual(queueStateWrites().length, 1);
});

test('forced queue snapshot flush persists recovery boundary immediately', async () => {
  await resetQueueFixture();
  const job = createFixtureJob();
  jobs.set(job.tabId, job);
  job.currentPhase = 'sending';

  await updateRunningJobsStorage({ force: true });

  assert.strictEqual(queueStateWrites().length, 1);
  assert.strictEqual(localStorageData.queueDurableJobs[job.tabId].currentPhase, 'sending');
});

test('durable recovery still rewrites an unconfirmed command safely', async () => {
  await resetQueueFixture();
  localStorageData.queueDurableJobs = {
    7: {
      tabId: 7,
      provider: 'chatgpt',
      conversationId: 'recovery',
      conversationType: 'existing',
      targetKey: 'chatgpt:c:recovery',
      queue: [],
      currentMessage: 'recover-me',
      isRunning: true,
      isPaused: true,
      currentPhase: 'sending',
      totalMessages: 1,
      completedCount: 0,
      currentCommandNumber: 1,
      startedAt: 1,
      updatedAt: 1
    }
  };

  const restoredCount = await resumeDurableQueues('test');
  await flushQueueDebugLogs();

  assert.strictEqual(restoredCount, 1);
  assert.deepStrictEqual(jobs.get(7).queue, ['recover-me']);
  assert.strictEqual(jobs.get(7).currentMessage, null);
  assert.strictEqual(localStorageData.queueDurableJobs[7].currentPhase, 'queued');
  assert.deepStrictEqual(localStorageData.queueDurableJobs[7].queue, ['recover-me']);
});

test('durable recovery preserves retry budget and does not duplicate a retry-wait command', async () => {
  await resetQueueFixture();
  localStorageData.queueDurableJobs = {
    29: {
      tabId: 29,
      provider: 'chatgpt',
      conversationId: 'retry-wait',
      conversationType: 'existing',
      targetKey: 'chatgpt:c:retry-wait',
      queue: ['later'],
      currentMessage: 'current-command',
      isRunning: true,
      isPaused: false,
      currentPhase: 'retry-wait',
      totalMessages: 2,
      completedCount: 0,
      currentCommandNumber: 1,
      retryAttemptCount: 2,
      lastRetryableReason: 'Timed out waiting for ChatGPT response.',
      retryClass: 'timeout',
      retryMode: 'finite',
      nextRetryDelayMs: 4000,
      nextRetryAt: Date.now() + 8000,
      waitStartedAt: 42,
      lastResearchProgressAt: 84,
      sawDeepResearch: true,
      startedAt: 1,
      updatedAt: 1
    }
  };

  const restored = restoreDurableJobs(localStorageData.queueDurableJobs);
  const job = restored[0];
  assert.strictEqual(job.currentMessage, 'current-command');
  assert.strictEqual(job.currentPhase, 'retry-wait');
  assert.strictEqual(job.retryAttemptCount, 2);
  assert.strictEqual(job.waitStartedAt, 42);
  assert.strictEqual(job.sawDeepResearch, true);
  assert.deepStrictEqual(job.queue, ['later']);

  jobs.set(29, job);
  const durable = getDurableJobsState();
  assert.strictEqual(durable[29].retryAttemptCount, 2);
  assert.strictEqual(durable[29].currentMessage, 'current-command');
  assert.deepStrictEqual(durable[29].queue, ['later']);
});

test('batched logs expose pending entries and preserve order and trimming', async () => {
  await resetQueueFixture();
  const clearResponse = await invokeHandler(handleClearQueueDebugLogs);
  assert.deepStrictEqual(clearResponse, { ok: true });
  localSetCalls.length = 0;

  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    for (let index = 0; index < MAX_QUEUE_DEBUG_LOG_ENTRIES + 5; index += 1) {
      logQueueEvent('logs', 'info', `event-${index}`);
    }
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }

  const response = await invokeHandler(handleGetQueueDebugLogs);
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.logs.length, MAX_QUEUE_DEBUG_LOG_ENTRIES);
  assert.strictEqual(response.logs[0].message, 'event-5');
  assert.strictEqual(response.logs.at(-1).message, 'event-304');
  assert.strictEqual(queueLogWrites().length, 1);
});

test('clear log is a barrier against an older pending batch', async () => {
  await resetQueueFixture();
  const clearResponse = await invokeHandler(handleClearQueueDebugLogs);
  assert.deepStrictEqual(clearResponse, { ok: true });
  localSetCalls.length = 0;
  deferLocalWrites = true;

  const originalLog = console.log;
  console.log = () => {};
  try {
    logQueueEvent('race', 'info', 'old-entry');
  } finally {
    console.log = originalLog;
  }

  flushQueueDebugLogs();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.strictEqual(queueLogWrites().length, 1);

  const pendingClear = invokeHandler(handleClearQueueDebugLogs);
  deferLocalWrites = false;
  releaseDeferredLocalWrites();
  assert.deepStrictEqual(await pendingClear, { ok: true });
  assert.deepStrictEqual(localStorageData.queueDebugLogs, []);

  const afterClearLog = console.log;
  console.log = () => {};
  try {
    logQueueEvent('race', 'info', 'new-entry');
  } finally {
    console.log = afterClearLog;
  }
  const response = await invokeHandler(handleGetQueueDebugLogs);
  assert.deepStrictEqual(response.logs.map((entry) => entry.message), ['new-entry']);
});

test('deterministic multi-prompt fixture cuts storage writes by more than half', async () => {
  await resetQueueFixture();
  const clearResponse = await invokeHandler(handleClearQueueDebugLogs);
  assert.deepStrictEqual(clearResponse, { ok: true });
  localSetCalls.length = 0;

  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    const job = createFixtureJob();
    jobs.set(job.tabId, job);
    const promptCount = 12;
    const logsPerPrompt = 8;

    await updateRunningJobsStorage({ force: true });
    for (let prompt = 0; prompt < promptCount; prompt += 1) {
      job.currentPhase = 'sending';
      await updateRunningJobsStorage({ force: true });
      job.currentPhase = 'waiting';
      await updateRunningJobsStorage({ force: true });
      job.currentPhase = 'queued';
      updateRunningJobsStorage();
      for (let event = 0; event < logsPerPrompt; event += 1) {
        logQueueEvent(job.tabId, 'info', `prompt-${prompt}-event-${event}`);
      }
      job.completedCount += 1;
      await updateRunningJobsStorage({ force: true });
    }
    jobs.clear();
    await updateRunningJobsStorage({ force: true });

    const response = await invokeHandler(handleGetQueueDebugLogs);
    assert.strictEqual(response.ok, true);

    const immediateWriteBaseline = 2 + promptCount * (4 + logsPerPrompt);
    const actualWrites = localSetCalls.length;
    assert.strictEqual(actualWrites, 39);
    assert.ok(
      actualWrites <= immediateWriteBaseline / 2,
      `expected ${actualWrites} writes, at most ${immediateWriteBaseline / 2} from ${immediateWriteBaseline} baseline writes`
    );
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
});
