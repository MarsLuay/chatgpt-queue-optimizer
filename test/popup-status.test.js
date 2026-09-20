const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// popup.js registers its UI initializer at load time. Keep the initializer dormant
// so these tests can exercise its pure queue-status formatting helpers in Node.
global.document = {
    addEventListener() {}
};

const {
    formatPopupRunningInstanceText,
    getPopupQueueStatusLabel,
    parseScheduledLocalDateTime,
    getScheduledStatusLabel,
    formatScheduledItemText
} = require('../popup.js');

delete global.document;

const popupSource = fs.readFileSync(require.resolve('../popup.js'), 'utf8');
const popupHtml = fs.readFileSync(require.resolve('../popup.html'), 'utf8');

test('popup queue status labels cover exposed queue phases', () => {
    assert.equal(getPopupQueueStatusLabel({ status: 'running', currentPhase: 'sending' }), 'Sending');
    assert.equal(getPopupQueueStatusLabel({ status: 'running', currentPhase: 'waiting' }), 'Waiting');
    assert.equal(getPopupQueueStatusLabel({ status: 'running', currentPhase: 'waiting-for-idle' }), 'Waiting for idle');
    assert.equal(getPopupQueueStatusLabel({ status: 'running', currentPhase: 'retry-wait' }), 'Retrying');
    assert.equal(getPopupQueueStatusLabel({ status: 'running', currentPhase: 'rollover-in-progress' }), 'New conversation');
    assert.equal(getPopupQueueStatusLabel({ status: 'running', rolloverInProgress: true }), 'New conversation');
    assert.equal(getPopupQueueStatusLabel({ status: 'paused', isPaused: true }), 'Paused');
    assert.equal(getPopupQueueStatusLabel({ status: 'failed' }), 'Failed');
    assert.equal(getPopupQueueStatusLabel({ status: 'complete' }), 'Complete');
});

test('popup-started queue entry points request the canonical wait-for-idle contract', () => {
    assert.match(
        popupSource,
        /action:\s*'startSequence',[\s\S]{0,180}waitForIdleBeforeStart:\s*true/
    );
    assert.match(
        popupSource,
        /action:\s*'enqueueMessage',[\s\S]{0,180}waitForIdleBeforeStart:\s*true/
    );
});

test('running instance text keeps queue progress and failure details inspectable', () => {
    const text = formatPopupRunningInstanceText('Research tab', {
        status: 'running',
        currentPhase: 'waiting-for-idle',
        totalMessages: 4,
        completedCount: 1,
        currentCommandNumber: 2,
        remaining: 3,
        nextMessagePreview: 'next prompt',
        nextMessageLength: 11,
        pausedReason: 'Waiting for the current response'
    });

    assert.equal(
        text,
        'Research tab | Waiting for idle | Done: 1/4 | Command: 2/4 | Remaining: 3 | Next length: 11 | Error: Waiting for the current response'
    );
});

test('popup status uses one inline renderer and has no blocking alert paths', () => {
    assert.equal((popupSource.match(/function showPopupStatus\s*\(/g) || []).length, 1);
    assert.doesNotMatch(popupSource, /\balert\s*\(/);
    assert.match(popupHtml, /id="status-indicator"[^>]*role="status"/);
    assert.match(popupHtml, /id="status-indicator"[^>]*aria-live="polite"/);
    assert.match(popupHtml, /popup-status-dismiss/);
});

test('scheduled popup helpers preserve local time and actionable status text', () => {
    const dueTs = parseScheduledLocalDateTime('2030-01-02T03:04');
    assert.equal(typeof dueTs, 'number');
    assert.equal(parseScheduledLocalDateTime('2030-02-30T03:04'), null);
    assert.equal(getScheduledStatusLabel('failed'), 'Failed');
    assert.match(
        formatScheduledItemText({ tabId: 7, status: 'failed', dueTs, text: '  send  this  ', failureReason: 'Target mismatch' }, 'Research'),
        /^Research \| Failed \| .* \| send this \| Target mismatch$/
    );
});

test('scheduled popup tab and form are ordered between queue and optimizer', () => {
    assert.ok(popupHtml.indexOf('id="queue-tool-tab"') < popupHtml.indexOf('id="scheduled-tool-tab"'));
    assert.ok(popupHtml.indexOf('id="scheduled-tool-tab"') < popupHtml.indexOf('id="optimizer-tool-tab"'));
    assert.match(popupHtml, /id="scheduled-message"/);
    assert.match(popupHtml, /id="scheduled-due-at"/);
    assert.match(popupHtml, /id="scheduled-target-tab-select"/);
    assert.doesNotMatch(popupSource, /\balert\s*\(/);
});
