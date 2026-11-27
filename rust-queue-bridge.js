(() => {
    'use strict';
    let core = null;
    let loading = null;
    let status = 'not loaded';
    const phases = ['','terminal','waiting','retry-wait','rollover-in-progress'];
    const delivery = ['','confirmed-submission','active-response','terminal-awaiting-bookkeeping'];
    const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
    function install(exports) {
        const names = ['cpo_queue_abi','cpo_fingerprint_buffer','cpo_fingerprint_capacity',
            'cpo_fingerprint_reset','cpo_fingerprint_update','cpo_fingerprint_hash','cpo_fingerprint_len',
            'cpo_queue_next','cpo_queue_retry_action','cpo_queue_confirmed','cpo_queue_remaining',
            'cpo_queue_total','cpo_queue_can_retry','cpo_queue_backoff',
            'cpo_submission_ack','cpo_submission_poll','cpo_submission_stage','cpo_delivery_recovery',
            'cpo_restore_action','cpo_restore_eligible','cpo_restore_command_number','cpo_persist_action',
            'cpo_schedule_action','cpo_schedule_compare','cpo_schedule_identity'];
        if (!names.every(name => typeof exports[name] === 'function') ||
            exports.cpo_queue_abi() !== 2 || !(exports.memory instanceof WebAssembly.Memory)) throw new Error('Queue WASM ABI mismatch');
        core = exports;
        status = 'Rust/WASM';
    }
    function fail(error) {
        core = null;
        status = 'unavailable';
        console.warn('CPO: native queue engine unavailable; using compatible JS execution.', error);
    }
    function load() {
        if (core || status === 'unavailable') return Promise.resolve(!!core);
        if (loading) return loading;
        if (typeof chrome === 'undefined' || typeof chrome.runtime?.getURL !== 'function' ||
            typeof WebAssembly === 'undefined' || typeof fetch !== 'function') return Promise.resolve(false);
        status = 'loading';
        loading = (async () => {
            try {
                const response = await fetch(chrome.runtime.getURL('optimizer_queue.wasm'));
                if (!response.ok) throw new Error('Queue WASM resource unavailable');
                const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
                install(result.instance.exports);
                return true;
            } catch (error) {
                fail(error);
                return false;
            } finally { loading = null; }
        })();
        return loading;
    }
    function call(name, args) {
        if (!core || args.some(value => count(value) === null)) return null;
        try { return core[name](...args) >>> 0; }
        catch (error) { fail(error); return null; }
    }
    // Timestamp-bearing exports accept f64 to preserve epoch milliseconds.
    function numeric(name, args) {
        if (!core || args.some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
        try { return core[name](...args) >>> 0; }
        catch (error) { fail(error); return null; }
    }
    function schedule(action, item, now = Date.now()) {
        const state = Math.max(0, ['', 'pending', 'firing', 'completed', 'failed', 'cancelled'].indexOf(item?.status));
        const due = Number(item?.dueTs || 0);
        return numeric('cpo_schedule_action', [action, state, Number.isFinite(due) ? due : 0, now]);
    }
    function scheduleIdentity(stored, current) {
        const type = value => {
            const index = ['unknown','existing','new','unsupported'].indexOf(value.conversationType || value.type || 'unknown');
            return index < 0 ? 4 : index;
        };
        const a = stored.targetKey || stored.key || '';
        const b = current.targetKey || current.key || '';
        const flags = Number(!!(stored.provider && current.provider && current.provider !== 'unknown' && stored.provider !== current.provider)) |
            (Number(!!stored.conversationId) << 1) |
            (Number(stored.conversationId === current.conversationId) << 2) |
            (Number(!!(a && b && a === b)) << 3);
        return call('cpo_schedule_identity', [type(stored), type(current), flags]);
    }
    function restoreAction(job, confirmed) {
        const phase = job.currentPhase === 'waiting' ? 1 :
            ['sending','awaiting-submission-ack'].includes(job.currentPhase) ? 2 :
            job.currentPhase === 'terminal' ? 3 : 0;
        const flags = Number(!!confirmed) | (Number(job.deliveryState === 'terminal-awaiting-bookkeeping') << 1) |
            (Number(['pre-click','unknown-acceptance'].includes(job.deliveryState)) << 2) |
            (Number(!!job.currentMessage) << 3);
        return call('cpo_restore_action', [phase, flags]);
    }
    function fingerprint(text) {
        if (!core) return null;
        const value = String(text || '');
        let input;
        const engine = core;
        try {
            const capacity = engine.cpo_fingerprint_capacity() >>> 0;
            if (!capacity || capacity > 4096) throw new Error('Invalid fingerprint capacity');
            input = new Uint16Array(engine.memory.buffer, engine.cpo_fingerprint_buffer() >>> 0, capacity);
            engine.cpo_fingerprint_reset();
            for (let start = 0; start < value.length; start += capacity) {
                const length = Math.min(capacity, value.length - start);
                for (let i = 0; i < length; i++) input[i] = value.charCodeAt(start + i);
                if (engine.cpo_fingerprint_update(length) !== 1) throw new Error('Fingerprint update failed');
            }
            const hash = engine.cpo_fingerprint_hash() >>> 0;
            const length = engine.cpo_fingerprint_len() >>> 0;
            return 'fnv1a:' + hash.toString(16) + ':len:' + length;
        } catch (error) { fail(error); return null; }
        finally {
            if (input) input.fill(0);
            try { engine.cpo_fingerprint_reset(); } catch {}
        }
    }
    function confirmed(job) {
        return call('cpo_queue_confirmed', [Number(!!job?.submittedUserTurnId), Math.max(0, delivery.indexOf(String(job?.deliveryState || '')))]);
    }
    function next(job, confirmedSubmission) {
        const phase = ['waiting','awaiting-response','active-response'].includes(job.currentPhase) ? 2 :
            Math.max(0, phases.indexOf(job.currentPhase));
        const flags = Number(!!job.isRunning) | (Number(!!job.isPaused) << 1) |
            (Number(!!job.isStopped) << 2) | (Number(!!job.currentMessage) << 3) |
            (Number(!!confirmedSubmission) << 4) | (Number(!!job.rolloverInProgress) << 5) |
            (Number(!!job.waitForIdleBeforeSend) << 6);
        return call('cpo_queue_next', [flags, phase, job.queue.length]);
    }
    const api = { load, fingerprint, confirmed, next, call, numeric, schedule, scheduleIdentity, restoreAction, install, get status() { return status; } };
    globalThis.CpoQueueEngine = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
