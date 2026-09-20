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
    getPopupQueueStatusLabel
} = require('../popup.js');

delete global.document;

const popupSource = fs.readFileSync(require.resolve('../popup.js'), 'utf8');
const popupHtml = fs.readFileSync(require.resolve('../popup.html'), 'utf8');

test('popup queue status labels cover exposed queue phases', () => {
    assert.equal(getPopupQueueStatusLabel({ status: 'running', currentPhase: 'sending' }), 'Sending');
    assert.equal(getPopupQueueStatusLabel({ status: 'running', currentPhase: 'waiting' }), 'Waiting');
    assert.equal(getPopupQueueStatusLabel({ status: 'running', currentPhase: 'waiting-for-idle' }), 'Waiting for idle');
    assert.equal(getPopupQueueStatusLabel({ status: 'running', currentPhase: 'retry-wait' }), 'Retrying');
    assert.equal(getPopupQueueStatusLabel({ status: 'paused', isPaused: true }), 'Paused');
    assert.equal(getPopupQueueStatusLabel({ status: 'failed' }), 'Failed');
    assert.equal(getPopupQueueStatusLabel({ status: 'complete' }), 'Complete');
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
        pausedReason: 'Waiting for the current response'
    });

    assert.equal(
        text,
        'Research tab | Waiting for idle | Done: 1/4 | Command: 2/4 | Remaining: 3 | Next: next prompt | Error: Waiting for the current response'
    );
});

test('popup status uses one inline renderer and has no blocking alert paths', () => {
    assert.equal((popupSource.match(/function showPopupStatus\s*\(/g) || []).length, 1);
    assert.doesNotMatch(popupSource, /\balert\s*\(/);
    assert.doesNotMatch(popupSource, /statusIndicator\.style\./);
    assert.match(popupHtml, /id="status-indicator"[^>]*role="status"/);
    assert.match(popupHtml, /id="status-indicator"[^>]*aria-live="polite"/);
    assert.match(popupHtml, /popup-status-dismiss/);
});
