(() => {
    'use strict';

    // This object is a browser binding, not an optimizer. The Rust module
    // drives every operation synchronously through opaque, call-local handles.
    class CpoRustBrowserBridge {
        constructor(owner) {
            this.owner = owner;
            this.context = null;
            this.exports = null;
            this.status = 'not loaded';
            this.memoryBytes = 0;
        }

        async load() {
            this.status = 'loading';
            try {
                const response = await fetch(chrome.runtime.getURL('optimizer_browser.wasm'));
                if (!response.ok) throw new Error('Browser WASM resource unavailable');
                const result = await WebAssembly.instantiate(await response.arrayBuffer(), {
                    cpo: { host: (op, a, b, c) => this.host(op >>> 0, a >>> 0, b >>> 0, c >>> 0) >>> 0 }
                });
                const core = result.instance.exports;
                if (typeof core.cpo_browser_abi !== 'function' || core.cpo_browser_abi() !== 1 ||
                    !['cpo_collect_resources', 'cpo_discover_messages', 'cpo_execute_media'].every(name => typeof core[name] === 'function')) {
                    throw new Error('Browser WASM ABI mismatch');
                }
                this.exports = core;
                this.memoryBytes = core.memory instanceof WebAssembly.Memory ? core.memory.buffer.byteLength : 0;
                this.status = 'Rust/WASM';
                return true;
            } catch (error) {
                this.fail(error);
                return false;
            }
        }

        fail(error) {
            this.exports = null;
            this.memoryBytes = 0;
            this.status = 'unavailable';
            console.warn('CPO: Rust browser engine unavailable; using compatibility bridge.', error);
        }

        invoke(context, operation) {
            if (!this.exports || this.context) return null;
            this.context = context;
            try {
                return operation(this.exports, context);
            } catch (error) {
                this.fail(error);
                return null;
            } finally {
                // Never retain temporary DOM handles after a synchronous call.
                this.context = null;
            }
        }

        sample(messages) {
            if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return null;
            return this.invoke({ messages, output: [] }, (core, ctx) => {
                if (core.cpo_collect_resources(messages.length) !== 1) throw new Error('Resource scan failed');
                const [sampledTurns, nodes, textChars, images, media, surfaces, truncatedTurns, units] = ctx.output;
                return { time: Date.now(), totalTurns: messages.length, sampledTurns, nodes,
                    textChars, images, media, surfaces, truncatedTurns, units, available: true };
            });
        }

        discover(adapter, doc, root) {
            const selectors = adapter.compatibilitySignals.turnContext || [];
            const context = { adapter, doc, root, selectors, handles: [null],
                ids: new Map(), flags: new Map(), accepted: [], acceptedSet: new Set(),
                redundant: new Set(), order: new Map(), selector: null, fallback: false };
            return this.invoke(context, (core, ctx) => {
                const allowFallback = typeof adapter.allowsFallbackMessageDiscovery !== 'function' ||
                    adapter.allowsFallbackMessageDiscovery(doc);
                const count = core.cpo_discover_messages(selectors.length, Number(allowFallback));
                if (count !== ctx.accepted.length) throw new Error('Discovery result mismatch');
                const nodes = ctx.accepted.map(id => ctx.handles[id]);
                return { nodes, selector: nodes.length ? (ctx.fallback ? 'fallbackMessages' : ctx.selector) : null,
                    signalKey: ctx.fallback ? 'fallbackMessages' : 'messages', fallback: ctx.fallback };
            });
        }

        media(root, mode) {
            return this.invoke({ root }, core => core.cpo_execute_media(mode) >>> 0);
        }

        handle(node) {
            if (!node) return 0;
            const ctx = this.context;
            if (ctx.ids.has(node)) return ctx.ids.get(node);
            const id = ctx.handles.length;
            ctx.handles.push(node);
            ctx.ids.set(node, id);
            return id;
        }

        nodeFlags(id) {
            const ctx = this.context;
            if (ctx.flags.has(id)) return ctx.flags.get(id);
            const node = ctx.handles[id];
            const adapter = ctx.adapter;
            let flags = 0;
            if (ctx.root.contains(node)) flags |= 1;
            if (node.closest('#cpo-root') || node.classList?.contains('cpo-more-banner')) flags |= 2;
            if (['script','style','nav','aside','header','footer'].includes((node.tagName || '').toLowerCase())) flags |= 4;
            const markers = adapter.compatibilitySignals.messageContext || [];
            const marker = markers.some(selector => node.matches?.(selector)) ||
                !!(markers.length && node.querySelector(markers.join(',')));
            if (marker) flags |= 8;
            const composer = adapter.selectors.composer.join(',');
            if (node.querySelector(composer + ', form')) flags |= 16;
            if (node.querySelector(composer + ', input, form')) flags |= 32;
            if (node.id?.includes('thread-bottom')) flags |= 64;
            if (marker || node.querySelector('p, pre, code, ul, ol, h1, h2, h3, h4, h5, h6, [data-message-author-role]')) flags |= 128;
            ctx.flags.set(id, flags);
            return flags;
        }

        textLength(node, limit) {
            // Stop once the existing trimmed-text threshold is proven.
            // No full message textContent copy on normal browser paths.
            const doc = this.context.doc;
            if (typeof doc.createTreeWalker !== 'function') return Math.min(limit, (node.textContent || '').trim().length);
            const walker = doc.createTreeWalker(node, 4);
            let count = 0;
            let pending = 0;
            let started = false;
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                for (let offset = 0; offset < text.length; offset += 256) {
                    const chunk = text.substringData(offset, Math.min(256, text.length - offset));
                    for (let i = 0; i < chunk.length; i++) {
                        if (/\s/.test(chunk[i])) {
                            if (started) pending = Math.min(limit, pending + 1);
                        } else {
                            started = true;
                            count = Math.min(limit, count + pending + 1);
                            pending = 0;
                            if (count >= limit) return limit;
                        }
                    }
                }
            }
            return count;
        }

        host(op, a, b) {
            const ctx = this.context;
            if (!ctx) throw new Error('Browser operation outside scoped call');
            const owner = this.owner;
            switch (op) {
                case 1: {
                    const root = ctx.messages[a];
                    if (!root || root.isConnected === false) return 0;
                    ctx.walker = document.createTreeWalker(root, 0xffffffff);
                    ctx.node = root;
                    return 1;
                }
                case 2: {
                    const node = ctx.node;
                    if (node.nodeType === 3) return 1;
                    if (node.nodeType !== 1) return 0;
                    if (node.localName === 'img') return 2;
                    if (node.localName === 'video' || node.localName === 'audio') return 3;
                    if (node.localName === 'canvas' || node.localName === 'iframe') return 4;
                    return 0;
                }
                case 3: return Math.min(0xffffffff, ctx.node.length || 0);
                case 4: ctx.node = ctx.walker.nextNode(); return Number(!!ctx.node);
                case 5: ctx.output[a] = b; return 1;
                case 10: {
                    ctx.fallback = !!a;
                    ctx.selector = null;
                    ctx.handles = [null];
                    ctx.ids.clear(); ctx.flags.clear(); ctx.acceptedSet.clear(); ctx.redundant.clear(); ctx.order.clear();
                    ctx.accepted = [];
                    const selectors = a ? ctx.adapter.selectors.fallbackMessages : ctx.adapter.selectors.messages;
                    try { ctx.candidates = ctx.doc.querySelectorAll(selectors.join(',')); }
                    catch { ctx.candidates = []; }
                    return ctx.candidates.length;
                }
                case 11: return this.handle(ctx.candidates[a]);
                case 12: {
                    const turn = ctx.handles[a].closest?.(ctx.selectors[b]);
                    return turn && ctx.root.contains(turn) ? this.handle(turn) : 0;
                }
                case 13: return this.nodeFlags(a);
                case 14: return this.textLength(ctx.handles[a], b);
                case 15:
                    if (!ctx.acceptedSet.has(a)) {
                        ctx.order.set(a, ctx.accepted.length);
                        ctx.acceptedSet.add(a);
                        ctx.accepted.push(a);
                    }
                    if (!ctx.fallback && !ctx.selector) ctx.selector = ctx.adapter.findMatchingSelector(ctx.handles[b], 'messages');
                    return 1;
                case 16: return ctx.accepted.length;
                case 17: return ctx.accepted[a] || 0;
                case 18:
                    for (let parent = ctx.handles[a].parentElement; parent; parent = parent.parentElement) {
                        const id = ctx.ids.get(parent);
                        if (id && ctx.acceptedSet.has(id)) return id;
                    }
                    return 0;
                case 19: {
                    const node = ctx.handles[a];
                    return Number(node.tagName?.toLowerCase() === 'article' ||
                        (node.getAttribute?.('data-testid') || '').startsWith('conversation-turn') ||
                        !!node.getAttribute?.('data-message-author-role') || !!node.getAttribute?.('data-message-id'));
                }
                case 20: ctx.redundant.add(a); return 1;
                case 21: ctx.accepted = ctx.accepted.filter(id => !ctx.redundant.has(id)); return ctx.accepted.length;
                case 22: {
                    const left = ctx.accepted[a], right = ctx.accepted[b];
                    const position = ctx.handles[left].compareDocumentPosition(ctx.handles[right]);
                    if (position & 4) return 0;
                    if (position & 2) return 1;
                    return Number(ctx.order.get(left) > ctx.order.get(right));
                }
                case 23: [ctx.accepted[a], ctx.accepted[b]] = [ctx.accepted[b], ctx.accepted[a]]; return 1;
                case 30: ctx.targets = ctx.root.querySelectorAll(a >= 2 ? 'video, audio' : 'img'); return ctx.targets.length;
                case 31: {
                    const target = ctx.targets[a];
                    if (!target) return 0;
                    let sources = [];
                    if (b >= 2) sources = Array.from(target.querySelectorAll('source'));
                    else {
                        const picture = target.closest?.('picture');
                        if (picture && ctx.root.contains(picture)) sources = Array.from(picture.querySelectorAll('source'));
                    }
                    ctx.group = [target, ...sources];
                    return ctx.group.length;
                }
                case 32: {
                    const node = ctx.group[a];
                    return Number(['src', 'srcset'].some(name => owner.isProtectedMediaSource(node.getAttribute(name))) ||
                        (b >= 2 && a === 0 && owner.isProtectedMediaSource(node.currentSrc || '')));
                }
                case 33: return Number(owner.stashSources(ctx.group[a], b >= 2 ? ['src'] : a === 0 ? ['srcset', 'src'] : ['srcset']));
                case 34: return Number(owner.restoreSources(ctx.group[a]));
                case 35: return Number(owner.mediaOriginals.has(ctx.group[a]) &&
                    ['src','srcset'].some(name => ctx.group[a].hasAttribute(name)));
                case 36: owner.mediaOriginals.delete(ctx.group[a]); return 1;
                case 37: return Number(owner.canEvictPlayback(ctx.group[0]));
                case 38: return owner.policyCount(a === 0 ? ctx.group[0].naturalWidth : ctx.group[0].naturalHeight);
                case 39: try { ctx.group[0].load(); } catch {} return 1;
                case 40:
                    if (a >= 2) owner.mediaStats.playbackEvicted++;
                    else {
                        owner.mediaStats.imagesEvicted++;
                        owner.mediaStats.estimatedImageBytes = Math.min(Number.MAX_SAFE_INTEGER, owner.mediaStats.estimatedImageBytes + b);
                    }
                    return 1;
                case 41: {
                    const img = ctx.group[0];
                    if (img.hasAttribute('data-cpo-original-src')) {
                        const original = img.getAttribute('data-cpo-original-src');
                        if (original && !img.hasAttribute('src') && !img.hasAttribute('srcset')) img.setAttribute('src', original);
                        img.removeAttribute('data-cpo-original-src');
                    }
                    return 1;
                }
                default: throw new Error('Unknown Rust browser host operation: ' + op);
            }
        }
    }

    globalThis.CpoRustBrowserBridge = CpoRustBrowserBridge;
    if (typeof module !== 'undefined' && module.exports) module.exports = { CpoRustBrowserBridge };
})();
