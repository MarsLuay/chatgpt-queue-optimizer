(() => {
    'use strict';
    const PAGE = 16;
    const MAX_BYTES = 8 * 1024 * 1024;
    const MAX_TURNS = 4096;
    const HEADER = 16;
    const ROLES = ['', 'user', 'assistant', 'message'];
    const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Local database request failed.'));
    });

    // Browser transaction transport for the required native history engine.
    class CpoHistoryStore {
        constructor(db) {
            this.db = db;
            this.core = null;
            this.encoder = new TextEncoder();
            this.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        }

        async load() {
            try {
                const response = await fetch(chrome.runtime.getURL('optimizer_history.wasm'));
                if (!response.ok) throw new Error('History module unavailable');
                const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
                const core = result.instance.exports;
                const required = ['cpo_history_abi','cpo_history_buffer','cpo_history_capacity',
                    'cpo_history_encode','cpo_history_decode','cpo_history_wipe',
                    'cpo_history_compress','cpo_history_decompress','cpo_history_output','cpo_history_wipe_output',
                    'cpo_history_row_decision','cpo_history_meta_valid','cpo_history_next',
                    'cpo_history_page_start','cpo_history_page_size','cpo_reader_buttons','cpo_reader_move',
                    'cpo_reader_batch','cpo_reader_continue','cpo_reader_partial',
                    'cpo_reader_state','cpo_reader_capture','cpo_reader_guard'];
                if (!required.every(name => typeof core[name] === 'function') ||
                    core.cpo_history_abi() !== 4 || !(core.memory instanceof WebAssembly.Memory)) {
                    throw new Error('History module ABI mismatch');
                }
                this.core = core;
            } catch (error) {
                this.core = null;
                throw new Error('Required Rust history engine unavailable: '+(error?.message||String(error)));
            }
        }

        transaction(mode, operation) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(['meta', 'turns'], mode);
                let result;
                tx.oncomplete = () => resolve(result);
                tx.onabort = () => reject(tx.error || new Error('Local database transaction aborted.'));
                tx.onerror = () => reject(tx.error || new Error('Local database transaction failed.'));
                Promise.resolve().then(() => operation(tx.objectStore('meta'), tx.objectStore('turns')))
                    .then(value => { result = value; })
                    .catch(error => {
                        try { tx.abort(); } catch {}
                        reject(error);
                    });
            });
        }

        metaValid(kind, existing, options) {
            const updated = options.updated || {};
            const rows = options.records || [];
            const same = !!existing && typeof options.id === 'string' && !!options.id && existing.id === options.id;
            const flags = Number(!!existing) | (Number(same) << 1) |
                (Number(!!existing?.complete) << 2) | (Number(!!updated.complete) << 3);
            const nums = [existing?.count ?? 0, updated.count ?? 0, existing?.bytes ?? 0,
                updated.bytes ?? 0, rows.length, rows[0]?.index ?? 0];
            if (nums.some(n => !Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)) return false;
            return this.requireCore().cpo_history_meta_valid(kind, flags, ...nums) === 1;
        }

        requireCore() {
            if(!this.core)throw new Error('Required Rust history engine is unavailable.');
            return this.core;
        }

        pageStart(total, requested) {
            return this.requireCore().cpo_history_page_start(total,requested)>>>0;
        }

        pageSize(total, start) {
            return this.requireCore().cpo_history_page_size(total,start)>>>0;
        }

        prepareRow(row, expected, used) {
            if (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX_TURNS ||
                !Number.isSafeInteger(used) || used < 0 || used > MAX_BYTES ||
                !row || !Number.isSafeInteger(row.index) || row.index < 0 || row.index > 0xffffffff ||
                typeof row.text !== 'string' || row.text.length > 37000 || !ROLES.includes(row.role) || !row.role) {
                throw new Error('Invalid snapshot row.');
            }
            const role = ROLES.indexOf(row.role);
            let binary = null;
            let size;
            const core = this.requireCore();
            {
                const ptr = core.cpo_history_buffer() >>> 0;
                const capacity = core.cpo_history_capacity() >>> 0;
                const buffer = new Uint8Array(core.memory.buffer, ptr, capacity);
                let written = 0;
                let wipeSize = capacity;
                try {
                    const result = this.encoder.encodeInto(row.text, buffer.subarray(HEADER));
                    written = result.written;
                    wipeSize = HEADER + written;
                    if (result.read !== row.text.length) throw new Error('Snapshot row exceeds codec capacity.');
                    size = written + 128;
                    const decision = core.cpo_history_row_decision(row.index, expected, role, row.text.length, used, written);
                    if (decision === 0) throw new Error('Invalid snapshot row.');
                    if (decision === 2) return null;
                    const length = core.cpo_history_encode(row.index, role, Number(row.truncated === true), written) >>> 0;
                    if (length !== HEADER + written) throw new Error('Rust snapshot codec rejected row.');
                    const compressed = core.cpo_history_compress(length) >>> 0;
                    binary = compressed ? new Uint8Array(core.memory.buffer, core.cpo_history_output() >>> 0, compressed).slice() : buffer.slice(0, length);
                } finally {
                    core.cpo_history_wipe(wipeSize);
                    core.cpo_history_wipe_output(wipeSize);
                }
            }
            const stored = binary;
            return { index: row.index, stored, size, truncated: row.truncated === true };
        }

        decodeRow(value, index) {
            if (!(value instanceof Uint8Array)) {
                // Pre-migration IndexedDB rows are readable without data migration.
                if (value?.index !== index || typeof value.text !== 'string' || !ROLES.includes(value.role) || !value.role)
                    throw new Error('Invalid saved snapshot row.');
                return value;
            }
            if (value.length < HEADER || value.length > 111016) throw new Error('Corrupt snapshot row.');
            let flags;
            let textBytes = value.subarray(HEADER);
            const compressed = value[0] === 67 && value[1] === 80 && value[2] === 79 && value[3] === 50;
            const core = this.core;
            if (core) {
                const ptr = core.cpo_history_buffer() >>> 0;
                const buffer = new Uint8Array(core.memory.buffer, ptr, value.length);
                try {
                    buffer.set(value);
                    if (compressed) {
                        const length = core.cpo_history_decompress(index, value.length) >>> 0;
                        if (!length || length > 111016) throw new Error('Corrupt compressed snapshot row.');
                        const decoded = new Uint8Array(core.memory.buffer, core.cpo_history_output() >>> 0, length);
                        flags = decoded[8] | (decoded[9] << 8);
                        textBytes = decoded.slice(HEADER);
                    } else {
                        flags = core.cpo_history_decode(index, value.length) >>> 0;
                        if (!flags) throw new Error('Corrupt snapshot row.');
                    }
                } finally {
                    core.cpo_history_wipe(value.length);
                    if (compressed) core.cpo_history_wipe_output(core.cpo_history_capacity());
                }
            }
            return { index, role: ROLES[flags & 255], truncated: !!(flags & 256),
                text: this.decoder.decode(textBytes) };
        }

        execute(kind, options = {}) {
            const mode = kind === 0 || kind === 4 ? 'readonly' : 'readwrite';
            return this.transaction(mode, async (meta, turns) => {
                let previous = 0;
                let existing;
                let start = 0;
                let result = [];
                let rowIndex = 0;
                const rows = options.records || [];
                let remaining = rows.length;
                let valid = kind === 1 && this.metaValid(kind, null, options);
                for (let step = 0; step < PAGE + 8; step++) {
                    const command = this.requireCore().cpo_history_next(kind, previous, Number(valid), remaining);
                    switch (command) {
                        case 1:
                            existing = await request(meta.get('current'));
                            if (kind === 4) {
                                valid = !!existing?.complete;
                                if (valid && (!Number.isSafeInteger(existing.count) || existing.count < 0 ||
                                    existing.count > MAX_TURNS)) throw new Error('Invalid snapshot metadata.');
                                start = valid ? this.pageStart(existing.count, options.start || 0) : 0;
                                remaining = valid ? this.pageSize(existing.count, start) : 0;
                            } else valid = this.metaValid(kind, existing, options);
                            break;
                        case 2: await request(turns.clear()); break;
                        case 3: {
                            const row = rows[rowIndex++];
                            await request(turns.put(row.stored, row.index));
                            remaining--;
                            break;
                        }
                        case 4: await request(meta.put(options.updated, 'current')); break;
                        case 5: await request(meta.clear()); break;
                        case 6:
                            result = await request(turns.getAll(IDBKeyRange.bound(start, start + remaining - 1), remaining));
                            if (result.length !== remaining) throw new Error('Snapshot page is incomplete.');
                            break;
                        case 7:
                            if (kind === 0) return existing;
                            if (kind === 4) return { current: existing, start, records: result };
                            return true;
                        default: throw new Error('Snapshot transaction rejected; source metadata changed or is invalid.');
                    }
                    previous = command;
                }
                throw new Error('Snapshot transaction exceeded its command bound.');
            });
        }

        readMeta() { return this.execute(0); }
        replace(updated) { return this.execute(1, { updated }); }
        append(id, records, updated) { return this.execute(2, { id, records, updated }); }
        finalize(id, updated) { return this.execute(3, { id, updated }); }
        async page(start) {
            const result = await this.execute(4, { start });
            return { ...result, records: result.records.map((row, index) => this.decodeRow(row, result.start + index)) };
        }
        delete(id) { return this.execute(5, { id }); }
    }

    globalThis.CpoHistoryStore = CpoHistoryStore;
    if (typeof module !== 'undefined' && module.exports) module.exports = { CpoHistoryStore };
})();
