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
                const bindings=globalThis.CpoBrowserWasmBindings||(typeof require==='function'?require('./rust-browser-bindings.js'):null);
                if(!bindings)throw new Error('Generated browser WASM bindings unavailable; rebuild the extension.');
                const core=await bindings.instantiate(await response.arrayBuffer(),(op,a,b,c)=>this.host(op,a,b,c));
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
            console.warn('CPO: Rust browser engine unavailable; native effects suspended.', error);
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
            const markers=adapter.compatibilitySignals.messageContext||[];
            const composer=adapter.selectors.composer.join(',');
            const context = { adapter, doc, root, selectors, markers, markerQuery:markers.join(','),
                composerForm:composer+', form', composerInput:composer+', input, form', handles: [null],
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

        windowVisible(total, target, manual, previous, allowShrink) {
            return this.invoke({}, core => core.cpo_window_visible(total, target, manual,
                previous, Number(!!allowShrink)) >>> 0);
        }

        applyWindow(messages, visible, offscreen, evictPlayback) {
            return this.invoke({ messages }, core =>
                core.cpo_apply_window(messages.length, visible, Number(!!offscreen) | (Number(!!evictPlayback) << 1)) === 1);
        }

        restoreWindow(messages) {
            return this.invoke({messages},core=>core.cpo_restore_window(messages.length)===1);
        }

        restoreJournal(entries) {
            return this.invoke({entries},core=>core.cpo_restore_journal(entries.length)===1);
        }

        captureHistory(messages, offset) {
            if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return null;
            return this.invoke({ messages, records: [] }, (core, ctx) => {
                if (core.cpo_capture_history(messages.length, offset) !== 1) {
                    return { ok: false, error: 'Conversation DOM changed during capture.' };
                }
                return { ok: true, records: ctx.records, next: offset + ctx.records.length };
            });
        }

        cacheTtl(kind) {
            return this.invoke({}, core => core.cpo_cache_ttl(kind) >>> 0);
        }

        cacheValid(kind, created, present, connected, now = Date.now()) {
            const elapsed = now - created;
            const age = Number.isFinite(elapsed) && elapsed >= 0 ? Math.min(0xffffffff, Math.floor(elapsed)) : 0xffffffff;
            return this.invoke({}, core => core.cpo_cache_valid(kind, age,
                Number(!!present) | (Number(!!connected) << 1)) === 1);
        }

        cacheNodesValid(kind, created, nodes, now = Date.now()) {
            if (!nodes || !Number.isFinite(created)) return false;
            const elapsed = now - created;
            const age = Number.isFinite(elapsed) && elapsed >= 0 ? Math.min(0xffffffff, Math.floor(elapsed)) : 0xffffffff;
            return this.invoke({ nodes }, core => core.cpo_cache_nodes_valid(kind, age, nodes.length) === 1);
        }

        mutationDelay() {
            return this.invoke({}, core => core.cpo_mutation_delay() >>> 0);
        }

        mutations(mutations, mode, empty = false, adapter = null) {
            return this.invoke({ mutations, adapter, dirty: new WeakSet() }, core =>
                core.cpo_process_mutations(mutations.length, mode, Number(!!empty)) === 1);
        }

        providerSelectors(root, selectors, signalKey, predicate, firstOnly = false) {
            return this.invoke({ root, selectors, signalKey, predicate, seen: new Set(), matches: [] }, (core,ctx) => {
                const count = core.cpo_provider_selectors(selectors.length, Number(firstOnly));
                if (count !== ctx.matches.length) throw new Error('Provider selector result mismatch');
                return ctx.matches;
            });
        }

        providerTurns(root,selectors){
            return this.invoke({root,selectors,seen:new Set(),nodes:[]},(core,ctx)=>{
                if(core.cpo_provider_turns(selectors.length)!==ctx.nodes.length)throw new Error('Native turn discovery count mismatch');
                return ctx.nodes;
            });
        }
        deduplicateTurns(nodes){
            const handles=[null],ids=new Map(),accepted=[],acceptedSet=new Set();
            for(const node of nodes){
                if(!node||ids.has(node))continue;
                const id=handles.length;handles.push(node);ids.set(node,id);accepted.push(id);acceptedSet.add(id);
            }
            return this.invoke({handles,ids,accepted,acceptedSet,redundant:new Set()},(core,ctx)=>{
                const count=core.cpo_provider_deduplicate(accepted.length);
                if(count!==ctx.accepted.length)throw new Error('Native deduplication count mismatch');
                return ctx.accepted.map(id=>ctx.handles[id]);
            });
        }
        providerRetry(adapter,doc,turns){
            const latest=turns.at(-1)||null;
            return this.invoke({adapter,doc,turns,latest,members:new Set(turns),matches:[],alerts:[],result:null,selector:''},(core,ctx)=>{
                const found=core.cpo_provider_retry()===1;
                if(found!==!!ctx.result)throw new Error('Native retry selection mismatch');
                return ctx.result||{element:null,selector:'',signalKey:'retryButton'};
            });
        }
        providerDiagnostics(adapter,doc,optimizer){
            return this.invoke({adapter,doc,diagnostics:{}},(core,ctx)=>{
                const flags=core.cpo_provider_diagnostics(Number(optimizer))>>>0;
                return {...ctx.diagnostics,flags:flags&7,valid:!!(flags&8)};
            });
        }
        providerObserveGeneration(adapter,doc,turns=[]){
            const provider={chatgpt:1,gemini:2,claude:3}[adapter.id];
            const latest=turns.at(-1)||null;
            const ctx={adapter,doc,turns,latest,members:new Set(turns),signals:{},statusRaw:'',alerts:'',buttons:null};
            return this.invoke(ctx,(core,state)=>{
                const flags=core.cpo_provider_observe_generation(provider)>>>0;
                if(flags===0xffffffff)throw new Error('Unsupported native generation provider');
                return {flags,statusRaw:state.statusRaw,alerts:state.alerts,signals:state.signals};
            });
        }
        providerExactText(left,right){
            return this.invoke({rawText:String(left??''),expectedText:String(right??'')},core=>core.cpo_provider_exact_text()===1);
        }
        providerScanTurns(adapter,turns,expectedText,expectedTextFingerprint,exactRequired){
            return this.invoke({adapter,turns,expectedText,expectedTextFingerprint,rows:[]},(core,ctx)=>{
                if(core.cpo_provider_scan_turns(turns.length,Number(adapter._turnScanCacheEnabled),Number(exactRequired))!==1)throw new Error('Native turn observation failed');
                return ctx.rows;
            });
        }
        eventAncestor(target,selectors,exclude,predicate,signalKey){
            const node=target?.nodeType===1?target:target?.parentElement;
            if(!node)return null;
            return this.invoke({node,selectors,exclude,predicate},(core,ctx)=>{
                const index=core.cpo_dom_event_ancestor(selectors.length)>>>0;
                return index?{element:ctx.node,selector:selectors[index-1],signalKey}:false;
            });
        }
        normalizeTurn(node,root,selectors){
            if(!node||!root)return null;
            // May execute from a native message-discovery host callback.
            const outer=this.context;
            if(!this.exports)return null;
            const ctx={node,root,selectors,normalized:null};
            this.context=ctx;
            try{const result=this.exports.cpo_dom_normalize_turn(selectors.length)>>>0;return result===0?null:result===1?node:ctx.normalized;}
            finally{this.context=outer;}
        }
        lastAssistant(flags){return this.exports?this.exports.cpo_dom_last_assistant(flags)===1:null;}
        composerRead(provider, element) {
            const flags = Number(!!element) | (Number(element?.tagName?.toLowerCase()==='textarea')<<1);
            return this.invoke({ element, text: [] },(core,ctx)=>{
                core.cpo_dom_composer_read(provider,flags);
                return ctx.text.join('');
            });
        }
        composerWrite(provider, element, text, mode=0) {
            const flags=Number(!!element)|(Number(element?.tagName?.toLowerCase()==='textarea')<<1)|(Number(!!text)<<2);
            return this.invoke({element,value:String(text||'')},core=>core.cpo_dom_composer_write(provider,mode,flags)===1);
        }
        click(element) {
            const flags=Number(!!element)|(Number(!!element&&!element.disabled&&element.getAttribute?.('aria-disabled')!=='true')<<1)|
                (Number(!!element&&element.isConnected!==false)<<2);
            return this.invoke({element},core=>core.cpo_dom_click(flags)===1);
        }
        submitStage(stage, flags) { return this.invoke({},core=>core.cpo_dom_submit_stage(stage,flags)>>>0); }
        activeSurface(node, members, latest) {
            if(!node)return false;
            // The selector walker may call this pure ancestry walker through
            // its host predicate. Preserve the outer call-local context.
            if(!this.exports)return null;
            const outer=this.context;
            this.context={node,members,latest};
            try{return this.exports.cpo_dom_active_surface()===1;}
            catch(error){this.fail(error);return null;}
            finally{this.context=outer;}
        }
        nodeRole(flags) { return this.invoke({},core=>core.cpo_dom_role(flags)>>>0); }
        candidate(mode,flags) {
            // Pure native exports can run inside a selector host predicate
            // without replacing the outer invocation's DOM context.
            if(!this.exports)return null;
            try{return this.exports.cpo_dom_candidate(mode,flags)===1;}catch(error){this.fail(error);return null;}
        }
        assistantError(node,attrs) {
            if(!node||typeof node.getAttribute!=='function')return false;
            return this.invoke({node,attrs},(core,ctx)=>{
                ctx.candidates=[node];
                try{for(const candidate of node.querySelectorAll?.(attrs.map(attr=>'['+attr+']').join(','))||[])ctx.candidates.push(candidate);}catch{}
                return core.cpo_dom_error_stop(ctx.candidates.length,attrs.length)===1;
            });
        }
        incompleteTool(node,selectors,attrs) {
            if(!node||typeof node.getAttribute!=='function')return false;
            return this.invoke({node,selectors,attrs},(core,ctx)=>{
                ctx.candidates=[node];
                try{for(const candidate of node.querySelectorAll?.(selectors.join(','))||[])ctx.candidates.push(candidate);}catch{}
                return core.cpo_dom_incomplete_tool(ctx.candidates.length,selectors.length,attrs.length)===1;
            });
        }

        renderUI(kind,root,rows,limit=rows.length,onAction=()=>{}) {
            if(!root||!Array.isArray(rows))return false;
            const doc=root.ownerDocument||document;
            return this.invoke({root,doc,rows,onAction,uiNodes:[doc.createDocumentFragment()],decoder:new TextDecoder()},(core)=>
                core.cpo_ui_render(kind,rows.length,limit)===1);
        }
        sequenceEdit(messages,action,index=0,text='') {
            return this.invoke({messages,value:text},core=>
                core.cpo_ui_sequence_edit(action,index,messages.length,Number(!!text))===1);
        }
        eventReady(kind,queueReady) {
            return this.invoke({},core=>core.cpo_event_ready(kind,Number(!!this.exports)|(Number(!!queueReady)<<1))===1);
        }
        importSequence(value) {
            if(typeof value!=='string'||value.length>8*1024*1024)return null;
            return this.invoke({value,values:[null],result:{name:'',messages:[]}},(core,ctx)=>
                core.cpo_sequence_import(value.length)===1?ctx.result:null);
        }
        substitute(value,name,replacement) {
            const needle='{{'+name+'}}';
            return this.invoke({value,needle,replacement,parts:[]},(core,ctx)=>
                core.cpo_sequence_substitute(value.length,needle.length)===1?ctx.parts.join(''):null);
        }
        variables(value) {
            return this.invoke({value,spans:[]},(core,ctx)=>core.cpo_ui_variables(value.length)===1?ctx.spans:null);
        }
        savedSequence(action,sequences,name,messages) {
            const valid=globalThis.CpoQueueEngine?.validSequenceName?.(name)===true;
            const flags=Number(valid)|(Number(Object.hasOwn(sequences,name)&&Array.isArray(sequences[name]))<<1);
            return this.invoke({sequences,name,messages,result:null},(core,ctx)=>core.cpo_ui_saved_sequence(action,flags)===1?{ok:true,messages:ctx.result}:{ok:false});
        }
        nextLimit(total,shown) { return this.invoke({},core=>core.cpo_ui_next_limit(total,shown)>>>0); }
        sequenceSelection(flags,count) { return this.invoke({},core=>core.cpo_ui_sequence_select(flags,count)>>>0); }

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
            const marker = ctx.markers.some(selector => node.matches?.(selector)) ||
                !!(ctx.markers.length && node.querySelector(ctx.markerQuery));
            if (marker) flags |= 8;
            if (node.querySelector(ctx.composerForm)) flags |= 16;
            if (node.querySelector(ctx.composerInput)) flags |= 32;
            if (node.id?.includes('thread-bottom')) flags |= 64;
            if (node.querySelector('p, pre, code, ul, ol, h1, h2, h3, h4, h5, h6, [data-message-author-role]')) flags |= 128;
            ctx.flags.set(id, flags);
            return flags;
        }

        firstMatchingSelector(node,selectors) {
            if(!this.exports)return null;
            const outer=this.context;
            this.context={node,selectors};
            try{return selectors[(this.exports.cpo_first_matching_selector(selectors.length)>>>0)-1]||'';}
            finally{this.context=outer;}
        }
        messagePredicate(mode,node,root,adapter) {
            const markers=adapter.compatibilitySignals.messageContext||[];
            const composer=adapter.selectors.composer.join(',');
            return this.invoke({handles:[null,node],flags:new Map(),adapter,root,markers,markerQuery:markers.join(','),
                composerForm:composer+', form',composerInput:composer+', input, form'},core=>{
                const flags=core.cpo_dom_message_flags(1);
                if(!core.cpo_message_predicate(mode,flags,mode===1?15:80))return false;
                const text=(node.textContent||'').trim().length;
                return core.cpo_message_predicate(mode,flags,Math.min(0xffffffff,text))===1;
            });
        }
        intersection(flags) {
            return this.invoke({},core=>core.cpo_intersection_transition(flags)>>>0);
        }

        copyDomFact(value,pointer){
            const text=String(value??'');
            const target=new Uint16Array(this.exports.memory.buffer,pointer,128);
            const count=Math.min(text.length,target.length);
            for(let i=0;i<count;i++)target[i]=text.charCodeAt(i);
            return text.length;
        }
        host(op, a, b, c) {
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
                case 2:return ctx.node.nodeType||0;
                case 3: return Math.min(0xffffffff, ctx.node.length || 0);
                case 4: ctx.node = ctx.walker.nextNode(); return Number(!!ctx.node);
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
                case 15:
                    if (!ctx.acceptedSet.has(a)) {
                        ctx.order.set(a, ctx.accepted.length);
                        ctx.acceptedSet.add(a);
                        ctx.accepted.push(a);
                    }
                    if (!ctx.fallback && !ctx.selector) ctx.selector = ctx.adapter.findMatchingSelector(ctx.handles[b], 'messages');
                    return 1;
                case 19: {
                    const node = ctx.handles[a];
                    return Number(!!node.getAttribute?.('data-message-author-role')||!!node.getAttribute?.('data-message-id'));
                }
                case 21: ctx.accepted = ctx.accepted.filter(id => !ctx.redundant.has(id)); return ctx.accepted.length;
                case 22: {
                    const left = ctx.accepted[a], right = ctx.accepted[b];
                    const position = ctx.handles[left].compareDocumentPosition(ctx.handles[right]);
                    if (position & 4) return 0;
                    if (position & 2) return 1;
                    return Number(ctx.order.get(left) > ctx.order.get(right));
                }
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
                case 35: {
                    const node=ctx.group[a],original=owner.mediaOriginals.get(node);
                    return Number(!!original&&['src','srcset'].some(name=>node.hasAttribute(name)&&node.getAttribute(name)!==original[name]));
                }
                case 36: owner.forgetSources(ctx.group[a]); return 1;
                case 37: {
                    const media = ctx.group[0];
                    return (media.paused === true ? 1 : 0) |
                        (media.currentTime === 0 ? 2 : 0) |
                        (media.srcObject ? 4 : 0) |
                        (media.mediaKeys || media.autoplay ? 8 : 0);
                }
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
                case 50: {
                    ctx.root = ctx.messages[a];
                    return Number(ctx.root.classList.contains('cpo-hidden'));
                }
                case 51: {
                    const classes = ctx.root.classList;
                    if (a === 1) classes.add('cpo-hidden');
                    else classes.remove('cpo-hidden');
                    if (a === 2) classes.add('cpo-offscreen');
                    else classes.remove('cpo-offscreen');
                    return 1;
                }
                case 52: ctx.lazyImages = ctx.root.querySelectorAll('img'); return ctx.lazyImages.length;
                case 53: {
                    const image = ctx.lazyImages[a];
                    if (!image.hasAttribute('loading')) image.setAttribute('loading', 'lazy');
                    return 1;
                }
                case 60: {
                    const node = ctx.messages[a];
                    if (!node?.isConnected) return 0;
                    const roleNode = node.matches?.('[data-message-author-role]') ? node :
                        node.querySelector?.('[data-message-author-role]');
                    const role = roleNode?.getAttribute('data-message-author-role');
                    ctx.walker = document.createTreeWalker(node, 4);
                    ctx.parts = [];
                    return role === 'user' ? 1 : role === 'assistant' ? 2 : 3;
                }
                case 61: ctx.node = ctx.walker.nextNode(); return Number(!!ctx.node);
                case 62: return Number(!!ctx.node.parentElement?.closest(
                    'button,script,style,noscript,textarea,input,select,[aria-hidden="true"],[contenteditable="true"]'));
                case 63: return Math.min(0xffffffff, ctx.node.length || 0);
                case 64: ctx.parts.push(ctx.node.substringData(0, a)); return 1;
                case 65:
                    ctx.records.push({ index: a, role: ['','user','assistant','message'][b],
                        text: ctx.parts.join(' '), truncated: c === 1 });
                    ctx.parts = null;
                    return 1;
                case 70: {
                    const mutation = ctx.mutations[a];
                    ctx.added = mutation.addedNodes || [];
                    ctx.removed = mutation.removedNodes || [];
                    ctx.dirtyNode = mutation.target?.nodeType === 3 ? mutation.target.parentElement : mutation.target;
                    const selector = b === 1
                        ? '[data-testid*="conversation-turn"], [data-message-author-role], [data-message-id], article'
                        : '[data-testid^="conversation-turn"], [data-message-author-role]';
                    ctx.turnSelector = selector;
                    return (mutation.type === 'attributes' &&
                        ['data-testid','data-message-author-role','data-message-id'].includes(mutation.attributeName) ? 1 : 0) |
                        (mutation.target?.closest?.(selector) ? 2 : 0) |
                        (ctx.added.length || ctx.removed.length ? 4 : 0);
                }
                case 71: return ctx.added.length + ctx.removed.length;
                case 72: {
                    const node = a < ctx.added.length ? ctx.added[a] : ctx.removed[a - ctx.added.length];
                    if (node?.nodeType !== 1) return 0;
                    return ((node.classList?.contains('cpo-more-banner') || node.closest?.('.cpo-more-banner')) ? 1 : 0) |
                        ((node.matches?.(ctx.turnSelector) || node.querySelector?.(ctx.turnSelector)) ? 2 : 0);
                }
                case 73: {
                    const node = ctx.dirtyNode;
                    if (!node || ctx.dirty.has(node)) return 0;
                    ctx.dirty.add(node);
                    ctx.adapter.invalidateNativeTurn(node);
                    ctx.dirtyNode = node.parentElement;
                    return 1;
                }
                case 74: return Number(!!ctx.nodes[a] && ctx.nodes[a].isConnected !== false);
                case 160:
                    try{return Number(!!ctx.node.matches?.(ctx.selectors[a]));}catch{return 0;}
                case 161:return Number(!!ctx.node);
                case 162:return Number(!!ctx.exclude&&!!ctx.node.closest?.(ctx.exclude));
                case 163:{
                    const selector=ctx.selectors[a];
                    try{return Number(!!(ctx.node.matches?.(selector)||ctx.node.closest?.(selector)===ctx.node)&&(!ctx.predicate||ctx.predicate(ctx.node,selector)));}catch{return 0;}
                }
                case 164:ctx.node=ctx.node.parentElement;return 1;
                case 165:return Number(!!ctx.node&&ctx.root.contains(ctx.node)&&!ctx.node.closest?.('#cpo-root')&&!ctx.node.classList?.contains('cpo-more-banner'));
                case 166:{
                    const candidate=ctx.node.closest?.(ctx.selectors[a]);
                    if(candidate&&ctx.root.contains(candidate)){ctx.normalized=candidate;return 1;}
                    return 0;
                }
                case 167:
                    try{ctx.candidates=ctx.root.querySelectorAll(ctx.selectors.join(','));return ctx.candidates.length;}catch{return 0xffffffff;}
                case 168:
                    try{ctx.candidates=ctx.root.querySelectorAll(ctx.selectors[a]);return ctx.candidates.length;}catch{return 0;}
                case 169:{
                    const node=ctx.candidates[a];
                    if(!node||ctx.seen.has(node))return 0;
                    ctx.seen.add(node);ctx.nodes.push(node);return 1;
                }
                case 170:{
                    const node=ctx.turns[a];
                    ctx.node=node;ctx.rawText=null;ctx.metadata=null;
                    const attr=String(node?.getAttribute?.('data-message-author-role')||'').toLowerCase();
                    return Number(attr==='user')|(Number(attr==='assistant')<<1)|
                        (Number(!!node?.querySelector?.('[data-message-author-role="user"]'))<<2)|
                        (Number(!!node?.querySelector?.('[data-message-author-role="assistant"]'))<<3);
                }
                case 171:{
                    const token=b?ctx.adapter.turnCacheToken(ctx.node):0;
                    const readText=()=>ctx.rawText??(ctx.rawText=String(ctx.node?.innerText||ctx.node?.textContent||''));
                    ctx.metadata=requireNative(globalThis.CpoQueueEngine?.providerTurnMetadata(b?ctx.adapter._turnCacheScope:0,token,a,readText));
                    return Number(ctx.metadata.hasText)|(Number(ctx.metadata.fingerprint===ctx.expectedTextFingerprint)<<1);
                }
                case 173:{
                    const text=a===1?ctx.expectedText:(ctx.rawText??(ctx.rawText=String(ctx.node?.innerText||ctx.node?.textContent||'')));
                    const count=Math.min(1024,Math.max(0,text.length-b));
                    const input=new Uint16Array(this.exports.memory.buffer,c,1024);
                    for(let i=0;i<count;i++)input[i]=text.charCodeAt(b+i);
                    return count;
                }
                case 174:{
                    const node=ctx.node;
                    const streaming=!!node.querySelector?.('[data-message-streaming="true"], [data-is-streaming="true"], .result-streaming');
                    // These nested synchronous observations use their own
                    // call-local contexts. Restore the outer scan even on error.
                    const outer=this.context;
                    this.context=null;
                    try{
                        const error=hasAssistantErrorStop(node,this);
                        const incomplete=hasIncompleteToolTurn(node,this);
                        return (Number(streaming)<<1)|(Number(error)<<2)|(Number(incomplete)<<3);
                    }finally{this.context=outer;}
                }
                case 175:{
                    ctx.rows.push([b,ctx.node?.getAttribute?.('data-message-id')||'',ctx.node?.getAttribute?.('data-testid')||'',ctx.metadata.fingerprint,c,ctx.metadata.errorSignal]);
                    ctx.node=null;ctx.rawText=null;ctx.metadata=null;
                    return 1;
                }
                case 176:{
                    const {adapter,doc,turns,latest,members,signals}=ctx;
                    const chat=adapter.id==='chatgpt';
                    const active=node=>!chat||adapter.isActiveResponseNode(node,turns,latest,members);
                    const visible=node=>!node.hidden&&node.getAttribute?.('aria-hidden')!=='true';
                    const outer=this.context;
                    this.context=null;
                    try{
                        const buttons=()=>ctx.buttons??(ctx.buttons=Array.from(doc.querySelectorAll('button')||[]).filter(active));
                        switch(a){
                            case 0:{
                                const error=getNodeRole(latest,this)==='assistant'&&hasAssistantErrorStop(latest,this);
                                signals.assistantErrorStop=error;return Number(error);
                            }
                            case 1:{
                                const match=adapter.getSelectorMatch(doc,'stopButton',node=>active(node)&&!node.disabled&&node.getAttribute?.('aria-disabled')!=='true');
                                signals.stopButton=match.selector||null;return Number(!!match.element);
                            }
                            case 2:{
                                const match=requireNative(globalThis.CpoQueueEngine?.providerButtons(b,0,buttons()))[0];
                                if(match)signals.stopButton='stopButton.semantic';
                                return Number(!!match);
                            }
                            case 3:{
                                if(chat){
                                    const match=adapter.getSelectorMatch(doc,'streaming',active);
                                    signals.streaming=match.selector||null;return Number(!!match.element);
                                }
                                try{return Number(!!doc.querySelector(adapter.selectors.streaming.join(',')));}catch{return 0;}
                            }
                            case 4:{
                                let nodes=[];
                                if(chat){
                                    const matches=adapter.getSelectorNodes(doc,'status',node=>active(node)&&node.getAttribute?.('aria-live')!=='off');
                                    signals.status=matches[0]?.selector||null;
                                    nodes=matches.map(match=>match.element);
                                }else{
                                    try{nodes=Array.from(doc.querySelectorAll(adapter.selectors.status.join(','))).filter(node=>node.getAttribute?.('aria-live')!=='off');}catch{}
                                }
                                ctx.statusRaw=nodes.filter(visible).map(node=>node.innerText||node.textContent||'').join(' ');
                                return 1;
                            }
                            case 5:{
                                const match=adapter.getSelectorMatch(doc,'spinner',node=>active(node)&&visible(node));
                                signals.spinner=match.selector||null;return Number(!!match.element);
                            }
                            case 6:{
                                const matches=adapter.getSelectorNodes(doc,'errorAlerts',chat?active:null);
                                signals.alert=matches[0]?.selector||null;
                                ctx.alerts=matches.map(match=>match.element.innerText||match.element.textContent||'').join(' ');
                                return 1;
                            }
                            case 7:{
                                if(chat){
                                    const match=adapter.getRetryButtonMatch(doc);
                                    signals.retry=match.selector||match.signalKey||null;return Number(!!match.element);
                                }
                                return Number(requireNative(globalThis.CpoQueueEngine?.providerButtons(b,1,buttons())).length>0);
                            }
                            default:return 0;
                        }
                    }finally{this.context=outer;}
                }
                case 177:{
                    const {adapter,doc,latest}=ctx;
                    const outer=this.context;
                    this.context=null;
                    try{
                        if(a===1){ctx.alerts=adapter.getSelectorNodes(doc,'errorAlerts');return ctx.alerts.length;}
                        const root=a===0?latest:a===2?ctx.alerts[b]?.element:doc;
                        ctx.selector=a===0?'retryButton.latestTurn':a===2?ctx.alerts[b]?.selector||'':'retryButton.semantic';
                        ctx.matches=root?requireNative(globalThis.CpoQueueEngine?.providerButtons(1,1,Array.from(root.querySelectorAll?.('button')||[]))):[];
                        return ctx.matches.length;
                    }finally{this.context=outer;}
                }
                case 178:{
                    const element=ctx.matches[a];
                    if(!element)return 0;
                    if(b&&!ctx.adapter.isActiveResponseNode(element,ctx.turns,ctx.latest,ctx.members))return 0;
                    ctx.result={element,selector:ctx.selector,signalKey:'retryButton'};
                    return 1;
                }
                case 179:{
                    const {adapter,doc,diagnostics}=ctx;
                    const outer=this.context;
                    this.context=null;
                    try{
                        switch(a){
                            case 0:diagnostics.root=adapter.getSelectorMatch(doc,'mainRoot');return Number(!!diagnostics.root.element);
                            case 1:diagnostics.composer=adapter.getComposerMatch(doc);return Number(!!diagnostics.composer.element);
                            case 2:diagnostics.sendAction=adapter.getSendActionMatch(doc);return Number(!!diagnostics.sendAction.element);
                            case 3:diagnostics.discovery=adapter.getMessageDiscovery(doc,diagnostics.root.element);return 1;
                            case 4:{
                                const identity=adapter.getConversationIdentity(doc?.defaultView?.location||(typeof location!=='undefined'?location:''));
                                return Number(identity.type==='new'||identity.type==='existing');
                            }
                            default:return 0;
                        }
                    }finally{this.context=outer;}
                }
                case 80: {
                    const selector = ctx.selectors[a];
                    try {
                        ctx.candidates = [];
                        if (ctx.root.matches?.(selector) || ctx.root.closest?.(selector) === ctx.root) ctx.candidates.push(ctx.root);
                        if (typeof ctx.root.querySelectorAll === 'function') {
                            for (const node of ctx.root.querySelectorAll(selector)) ctx.candidates.push(node);
                        }
                    } catch { ctx.candidates = []; }
                    return ctx.candidates.length;
                }
                case 81: {
                    const element = ctx.candidates[a];
                    if (ctx.seen.has(element)) return 1;
                    return !ctx.predicate || ctx.predicate(element,ctx.selectors[b]) ? 2 : 0;
                }
                case 82: {
                    const element = ctx.candidates[a];
                    ctx.seen.add(element);
                    ctx.matches.push({element, selector: ctx.selectors[b], signalKey: ctx.signalKey});
                    return 1;
                }
                case 90: ctx.element.focus?.(); return 1;
                case 91: ctx.element.value=ctx.value; return 1;
                case 92:
                    if(typeof ctx.element.replaceChildren==='function')ctx.element.replaceChildren();
                    else if(Array.isArray(ctx.element.children))ctx.element.children.length=0;
                    return 1;
                case 93:
                    if(a)ctx.element.innerText='';
                    ctx.element.textContent='';
                    return 1;
                case 94:
                    if(a)ctx.element.classList?.add?.('ql-blank');
                    else ctx.element.classList?.remove?.('ql-blank');
                    return 1;
                case 95: {
                    const paragraph=(ctx.element.ownerDocument||document).createElement('p');
                    paragraph.innerText=ctx.value;paragraph.textContent=ctx.value;
                    ctx.element.appendChild(paragraph);return 1;
                }
                case 96:
                    if(typeof InputEvent==='function')ctx.element.dispatchEvent(new InputEvent('input',{
                        bubbles:true,inputType:ctx.value?'insertText':'deleteContentBackward',data:ctx.value||null
                    }));
                    return 1;
                case 97: {
                    const node=a===2?ctx.element.children[b]:ctx.element;
                    const text=String((a===0?node?.value:node?.innerText||node?.textContent)||'');
                    ctx.text.push(text);
                    return Number(!!text);
                }
                case 98: return ctx.element.children?.length||0;
                case 99:
                    try{ctx.element.click();return 1;}catch{return 0;}
                case 100: return !ctx.node?0:ctx.node===ctx.latest?1:ctx.members.has(ctx.node)?2:3;
                case 101: ctx.node=ctx.node.parentElement||ctx.node.parentNode||null;return 1;
                case 102:
                case 104:{
                    const value=String(ctx.candidates[a].getAttribute?.(ctx.attrs[b])||'').trim();
                    return this.copyDomFact(value,c);
                }
                case 103:
                    try{return Number(!!ctx.candidates[a].matches?.(ctx.selectors[b]));}catch{return 0;}
                case 105:{
                    ctx.rawText=String(ctx.node.innerText||ctx.node.textContent||'');
                    const tool=ctx.candidates[a];
                    ctx.expectedText=String(tool.innerText||tool.textContent||'');
                    return 1;
                }
                case 110: {
                    const tag=['div','span','article','h2','button','option','br','strong','p'][a];
                    if(!tag)throw new Error('Invalid native UI tag');
                    const node=ctx.doc.createElement(tag);
                    if(tag==='button')node.type='button';
                    ctx.uiNodes.push(node);
                    return ctx.uiNodes.length-1;
                }
                case 111: case 112: case 113: case 120: {
                    const value=ctx.decoder.decode(new Uint8Array(this.exports.memory.buffer,b,c));
                    const node=ctx.uiNodes[a];
                    if(op===111)node.className=value;
                    else if(op===112)node.textContent=value;
                    else if(op===113)node.style.cssText=value;
                    else node.value=value;
                    return 1;
                }
                case 114: {
                    const value=ctx.rows[b]?.fields?.[c]??(c===1?ctx.rows[b]?.more:'')??'';
                    ctx.uiNodes[a].textContent=String(value);
                    return 1;
                }
                case 116: return ctx.rows[a]?.flags||0;
                case 117: {
                    const dispatch=ctx.onAction;
                    ctx.uiNodes[a].addEventListener('click',()=>dispatch(c,b));
                    return 1;
                }
                case 118: ctx.uiNodes[a].value=String(ctx.rows[b]?.fields?.[c]??'');return 1;
                case 119: ctx.uiNodes[a].disabled=!!(b&1);ctx.uiNodes[a].selected=!!(b&2);return 1;
                case 121:ctx.uiNodes[a].classList.add(ctx.classToken);ctx.classToken='';return 1;
                case 181:ctx.classToken=String(ctx.rows[a]?.fields?.[b]??'');return ctx.classToken.length;
                case 182:return ctx.classToken.charCodeAt(a)||0;
                case 183:{
                    const node=a===0?ctx.node:ctx.handles[b];
                    return this.copyDomFact(a===0?node?.localName:a===1?node?.tagName:node?.getAttribute?.('data-testid'),c);
                }
                case 123:
                    if(a===0)ctx.messages.push(ctx.value);
                    else if(a===1)ctx.messages[b]=ctx.value;
                    else if(a===2)ctx.messages.splice(b,1);
                    else if(a===3)ctx.messages.length=0;
                    else return 0;
                    return 1;
                case 126:
                    if(a===0)Object.defineProperty(ctx.sequences,ctx.name,{value:ctx.messages.slice(),writable:true,enumerable:true,configurable:true});
                    else if(a===1)ctx.result=ctx.sequences[ctx.name].slice();
                    else if(a===2)delete ctx.sequences[ctx.name];
                    else return 0;
                    return 1;
                case 131:ctx.values.push([]);return ctx.values.length-1;
                case 132:ctx.values[a].push(ctx.value.slice(b,c));return 1;
                case 133:ctx.values[a].push(String.fromCharCode(b));return 1;
                case 134:ctx.values[a]=ctx.values[a].join('');return a;
                case 135:ctx.values.push(a===1?[]:a===2?Object.create(null):a===3?null:a===4);return ctx.values.length-1;
                case 136:ctx.values.push(Number(ctx.value.slice(a,b)));return ctx.values.length-1;
                case 137:{
                    const target=ctx.values[a];
                    if(Array.isArray(target))target.push(ctx.values[c]);
                    else Object.defineProperty(target,ctx.values[b],{value:ctx.values[c],enumerable:true,writable:true,configurable:true});
                    return 1;
                }
                case 138:{
                    const v=ctx.values[a];
                    return v==null?0:typeof v==='string'?1:Array.isArray(v)?2:typeof v==='object'?3:4;
                }
                case 139:{
                    const key=['name','messages','message','text','prompt'][b];
                    const obj=ctx.values[a];
                    if(!obj||!Object.hasOwn(obj,key))return 0;
                    ctx.values.push(obj[key]);return ctx.values.length-1;
                }
                case 141:ctx.values.push(ctx.values[a][b]);return ctx.values.length-1;
                case 142:{
                    const raw=ctx.values[a];
                    const value=globalThis.CpoQueueEngine.trim(raw&&typeof raw==='object'&&!Array.isArray(raw)?'[object Object]':String(raw??''));
                    if(value==null)throw new Error('Native sequence trim unavailable');
                    if(b===1)ctx.result.name=value||'Imported sequence';
                    else if(value)ctx.result.messages.push(value);
                    return 1;
                }
                case 143:return Number(!!ctx.values[a]);
                case 144:ctx.values.length=1;ctx.result={name:'',messages:[]};return 1;
                case 145:ctx.result.messages.push(ctx.value.slice(a,b));return 1;
                case 147:return ctx.value.indexOf(ctx.needle,a)>>>0;
                case 148:ctx.parts.push(ctx.value.slice(a,b));return 1;
                case 150: {
                    ctx.journalNode=ctx.entries[a]?.deref();
                    const node=ctx.journalNode;
                    const original=node&&owner.mediaOriginals.get(node);
                    return !original?0:1|(Number(['src','srcset'].some(name=>node.hasAttribute(name)&&node.getAttribute(name)!==original[name]))<<1);
                }
                case 151: {
                    if(b)owner.restoreSources(ctx.journalNode);
                    else owner.forgetSources(ctx.journalNode);
                    ctx.journalNode=null;return 1;
                }
                case 152: {
                    ctx.textWalker=ctx.doc.createTreeWalker(ctx.handles[a],4);
                    ctx.textNode=null;ctx.textOffset=0;return 1;
                }
                case 153: {
                    // Only marshal a bounded slice of the current text node.
                    while(!ctx.textNode||ctx.textOffset>=ctx.textNode.length){
                        ctx.textNode=ctx.textWalker.nextNode();ctx.textOffset=0;
                        if(!ctx.textNode)return 0;
                    }
                    const len=Math.min(b,ctx.textNode.length-ctx.textOffset);
                    const chunk=ctx.textNode.substringData(ctx.textOffset,len);
                    const target=new Uint16Array(this.exports.memory.buffer,a,len);
                    for(let i=0;i<len;i++)target[i]=chunk.charCodeAt(i);
                    ctx.textOffset+=len;return len;
                }
                case 154: ctx.textWalker=null;ctx.textNode=null;ctx.textOffset=0;return 1;
                case 155: ctx.parentCursor=ctx.handles[a].parentElement;return 1;
                case 156: {
                    const parent=ctx.parentCursor;
                    if(!parent)return 0;
                    ctx.parentCursor=parent.parentElement;
                    const id=ctx.ids.get(parent);
                    return id&&ctx.acceptedSet.has(id)?id:0xffffffff;
                }
                default:{
                    const bindings=globalThis.CpoBrowserWasmBindings;
                    if(!bindings)throw new Error('Generated DOM primitives unavailable');
                    return bindings.dispatchHostPrimitive(op,a,b,c,ctx);
                }
            }
        }
    }

    globalThis.CpoRustBrowserBridge = CpoRustBrowserBridge;
    if (typeof module !== 'undefined' && module.exports) module.exports = { CpoRustBrowserBridge };

// Provider host bindings share the bridge's lexical scope. Native host
// callbacks use these helpers synchronously; no globals are required.

    const PROVIDER_CODES = { chatgpt: 1, gemini: 2, claude: 3 };
    function providerSurface(adapter,locationOrUrl){
        return requireNative(globalThis.CpoQueueEngine?.providerSurface(PROVIDER_CODES[adapter.id],locationOrUrl));
    }
    function providerIdentity(adapter,locationOrUrl){
        const {type,conversationId,key}=providerSurface(adapter,locationOrUrl);
        return {provider:adapter.id,type,conversationId,key};
    }
    function requireNative(value){
        if(value==null)throw new Error('Required native provider policy unavailable.');
        return value;
    }
    function catalogView(id) {
        const current=()=>requireNative(globalThis.CpoQueueEngine?.providerCatalog?.(id));
        return new Proxy({},{
            get(_target,key){return current()[key];},
            ownKeys(){return Reflect.ownKeys(current());},
            getOwnPropertyDescriptor(_target,key){
                if(Object.hasOwn(current(),key))return {configurable:true,enumerable:true,value:current()[key]};
            },
            has(_target,key){return key in current();}
        });
    }
    function providerPredicate(provider,mode,flags) {
        return globalThis.CpoQueueEngine?.call('cpo_provider_predicate',[PROVIDER_CODES[provider],mode,flags]);
    }
    const CHATGPT_COMPATIBILITY_SIGNALS = catalogView(4);
    const CHATGPT_SELECTORS = catalogView(1);

    function cloneCompatibilityValue(value) {
        if (Array.isArray(value)) {
            return value.map(cloneCompatibilityValue);
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneCompatibilityValue(child)]));
        }
        return value;
    }

    function normalizeCommandText(text) {
        const value=String(text||'');
        // Large conversation text should not grow WASM linear memory merely
        // to normalize a browser-owned string.
        const native=value.length<=65536?globalThis.CpoQueueEngine?.textBatch?.(14,[value]):null;
        return value.length>65536?value.replace(/\s+/g,' ').trim():requireNative(native);
    }

    function fingerprintCommandText(text) {
        return requireNative(globalThis.CpoQueueEngine?.fingerprint(text));
    }

    function emptyCommandTurnSnapshot(adapter) {
        return {
            conversationId: null,
            conversationKey: '',
            userTurns: [],
            assistantTurns: [],
            latestUserTurnId: null,
            latestAssistantTurnId: null,
            matchedUserTurnId: null,
            supportsCommandTurnAck: adapter?.supportsCommandTurnAck === true
        };
    }

    function getNodeRole(node, engine = null) {
        const attr = String(node?.getAttribute?.('data-message-author-role') || '').toLowerCase();
        const flags=Number(attr==='user')|(Number(attr==='assistant')<<1)|
            (Number(!!node?.querySelector?.('[data-message-author-role="user"]'))<<2)|
            (Number(!!node?.querySelector?.('[data-message-author-role="assistant"]'))<<3);
        const native=engine?.nodeRole(flags);
        return ['','user','assistant'][requireNative(native)]||'';
    }

    function providerFacts(){
        return requireNative(globalThis.CpoQueueEngine?.providerCatalog(5));
    }
    function hasAssistantErrorStop(node,engine=null){
        const facts=providerFacts();
        return requireNative(engine?.assistantError(node,facts.assistantErrorAttributes));
    }
    function hasIncompleteToolTurn(node,engine=null){
        const facts=providerFacts();
        return requireNative(engine?.incompleteTool(node,facts.toolTurnSelectors,facts.toolAttributes));
    }

    function summarizeSelectorMatch(match) {
        return {
            matched: !!match?.element,
            selector: match?.selector || null,
            signalKey: match?.signalKey || null
        };
    }

    class ProviderAdapter {
        constructor(idOrOptions, maybeName, options = {}) {
            if (idOrOptions && typeof idOrOptions === 'object') {
                this.id = idOrOptions.id;
                this.name = idOrOptions.name;
                this.supportsOptimizer = !!idOrOptions.supportsOptimizer;
                this.supportsCommandTurnAck = !!idOrOptions.supportsCommandTurnAck;
                this.selectors = idOrOptions.selectors || {};
            } else {
                this.id = idOrOptions;
                this.name = maybeName;
                this.supportsOptimizer = !!options.supportsOptimizer;
                this.supportsCommandTurnAck = !!options.supportsCommandTurnAck;
                this.selectors = options.selectors || {};
            }
        }

        setNativeSelectorEngine(engine) {
            this._nativeSelectorEngine = engine || null;
        }

        normalizeCommandText(text) {
            return normalizeCommandText(text);
        }

        fingerprintCommandText(text) {
            return fingerprintCommandText(text);
        }

        getCompatibilityContract() {
            return {
                provider: this.id,
                version: 1,
                selectors: cloneCompatibilityValue(this.selectors),
                signals: {}
            };
        }

        /**
         * @param {any} root
         * @param {string} selectorKey
         * @param {((element: any, selector: string) => boolean)|null} [predicate]
         * @returns {SelectorMatch[]}
         */
        getSelectorNodes(root, selectorKey, predicate = null) {
            const selectors = Array.isArray(this.selectors?.[selectorKey])
                ? this.selectors[selectorKey]
                : [];
            if (!root || selectors.length === 0) return [];
            const native = this._nativeSelectorEngine?.providerSelectors(root, selectors, selectorKey, predicate);
            return requireNative(native);
        }

        getSelectorMatch(root, selectorKey, predicate = null) {
            const selectors = Array.isArray(this.selectors?.[selectorKey]) ? this.selectors[selectorKey] : [];
            const native = root && selectors.length ? this._nativeSelectorEngine?.providerSelectors(root, selectors, selectorKey, predicate, true) : null;
            return (root && selectors.length ? requireNative(native) : [])[0] || {
                element: null,
                selector: '',
                signalKey: selectorKey
            };
        }

        nodeContains(ancestor, node) {
            if (!ancestor || !node) {
                return false;
            }
            if (ancestor === node) {
                return true;
            }
            let current = node;
            while (current) {
                if (current === ancestor) {
                    return true;
                }
                current = current.parentElement || current.parentNode || null;
            }
            return false;
        }

        isActiveResponseNode(node, turns, latestTurn, turnSet = null) {
            if (!node) return false;
            // Checking all historical turns for every button/spinner is O(N*M).
            // Walk the node's ancestor chain and use a constant-time membership set.
            const members = turnSet || new Set(turns);
            const native = this._nativeSelectorEngine?.activeSurface(node,members,latestTurn);
            return requireNative(native);
        }

        isComposerElement(element, _details = {}) {
            const tagName = (element?.tagName || '').toLowerCase();
            const flags=Number(tagName==='textarea') | (Number(element?.getAttribute?.('contenteditable')==='true')<<1);
            const native=providerPredicate(this.id,0,flags);
            return requireNative(native)===1;
        }

        getComposerMatch(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getSelectorMatch(doc, 'composer', (element, selector) => this.isComposerElement(element, {
                selector,
                source: 'document'
            }));
        }

        isSendActionElement(element, _details = {}) {
            const tagName = (element?.tagName || '').toLowerCase();
            const action=tagName==='button'||typeof element?.click==='function';
            const native=providerPredicate(this.id,1,Number(action)<<2);
            return requireNative(native)===1;
        }

        getSendActionMatch(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getSelectorMatch(doc, 'sendButton', (element, selector) => this.isSendActionElement(element, {
                selector,
                source: 'document'
            }));
        }

        getComposerMatchFromEventTarget(target, excludeSelector = '#cpo-root') {
            const match=this._nativeSelectorEngine?.eventAncestor(target,this.selectors.composer||[],excludeSelector,(node,selector)=>this.isComposerElement(node,{selector,source:'event'}),'composer');
            return match||null;
        }

        getComposerFromEventTarget(target, excludeSelector = '#cpo-root') {
            return this.getComposerMatchFromEventTarget(target, excludeSelector)?.element || null;
        }

        getSendActionFromEventTarget(target) {
            const match=this._nativeSelectorEngine?.eventAncestor(target,this.selectors.sendButton||[],'',(node,selector)=>this.isSendActionElement(node,{selector,source:'event'}),'sendButton');
            return match||null;
        }

        getCompatibilityDiagnostics(doc = (typeof document !== 'undefined' ? document : null)) {
            const empty={element:null,selector:''};
            const {root,composer,sendAction}=doc&&this._nativeSelectorEngine
                ? requireNative(this._nativeSelectorEngine.providerDiagnostics(this,doc,false))
                : {root:empty,composer:empty,sendAction:empty};
            return {
                provider: this.id,
                root: summarizeSelectorMatch({ ...root, signalKey: 'mainRoot' }),
                composer: summarizeSelectorMatch({ ...composer, signalKey: 'composer' }),
                sendAction: summarizeSelectorMatch({ ...sendAction, signalKey: 'sendButton' }),
                messages: {
                    matched: false,
                    count: 0,
                    selector: null,
                    signalKey: 'messages',
                    state: 'unsupported'
                },
                requiredFailures: []
            };
        }

        isSupportedUrl(url) {
            return false;
        }

        getConversationIdentity(locationOrUrl) {
            return {
                provider: this.id,
                type: 'unsupported',
                conversationId: null,
                key: `${this.id}:unsupported`
            };
        }

        getComposerText(composer) {
            return '';
        }

        clearComposer(composer) {
        }

        /** @returns {GenerationState} */
        getGenerationState(doc) {
            return {
                generating: false,
                hasActiveStopButton: false,
                hasResultStreaming: false,
                hasActiveToolOrResearch: false,
                deepResearchActive: false,
                matchedResearchMarker: null,
                researchStatusPreview: null,
                hasError: false,
                hasDeliveryTimedOut: false,
                hasTryAgainButton: false,
                errorSnippet: '',
                matchedError: '',
                conversationCapacityReached: false,
                requiresNewConversation: false,
                url: '',
                title: ''
            };
        }

        getNewConversationUrl() {
            return '';
        }

        startNewConversation() {
            const url = this.getNewConversationUrl();
            return {
                ok: !!url,
                url,
                method: url ? 'route' : 'unsupported'
            };
        }

        isFreshConversationIdentity(identity, previousConversationId = null) {
            return false;
        }

        matchConversationCapacity(text) {
            return '';
        }

        buildContinuationHandoffMessage(context = {}) {
            return '';
        }

        getRetryButton(doc) {
            return null;
        }

        clickRetryButton(doc) {
            return false;
        }

        getLastAssistantTurn(doc) {
            return null;
        }

        getCommandTurnSnapshot(doc, options = {}) {
            return emptyCommandTurnSnapshot(this);
        }

        /**
         * @param {any} doc
         * @param {{ userTurnId?: string|null, assistantTurnId?: string|null, commandFingerprint?: string, conversationId?: string|null }} [binding]
         * @returns {{ phase: string, userTurnId: string|null, assistantTurnId: string|null, conversationId: string|null, generating: boolean, deepResearchActive: boolean, hasCompletedAssistant: boolean, toolTurnIncomplete?: boolean, source: string }}
         */
        getCommandResponseState(doc,binding={},generationState=null){
            const generation=generationState||this.getGenerationState(doc);
            const queue=globalThis.CpoQueueEngine;
            const initial=requireNative(queue?.genericProviderResponse(binding,generation));
            if(!initial.needsAssistant)return initial.state;
            const assistant=this.getLastAssistantTurn(doc);
            return requireNative(queue?.genericProviderResponse(binding,generation,true,!!(assistant?.isAssistant&&assistant?.hasCompletedText))).state;
        }

        getMainRoot(doc) {
            return null;
        }

        getMessageNodes(doc, mainRoot) {
            return [];
        }

        normalizeMessageNode(node, mainRoot) {
            return node;
        }

        isValidMessageNode(node, mainRoot) {
            return false;
        }

        getFallbackMessages(doc, mainRoot) {
            return [];
        }

        isValidFallbackNode(node, mainRoot) {
            return false;
        }
    }

    // Common browser projection for all supported native providers.
    class NativeProviderAdapter extends ProviderAdapter {
        isSupportedUrl(url){return typeof url==='string'&&providerSurface(this,url).supported;}
        getConversationIdentity(locationOrUrl){return providerIdentity(this,locationOrUrl);}
        getComposerText(composer){return requireNative(this._nativeSelectorEngine?.composerRead(PROVIDER_CODES[this.id],composer));}
        clearComposer(composer){
            if(this._nativeSelectorEngine?.composerWrite(PROVIDER_CODES[this.id],composer,'',0)!==true)throw new Error('Native composer clear unavailable.');
        }
        getNewConversationUrl(){return requireNative(globalThis.CpoQueueEngine?.providerNavigation(PROVIDER_CODES[this.id])).url;}
        startNewConversation(){return requireNative(globalThis.CpoQueueEngine?.providerNavigation(PROVIDER_CODES[this.id]));}
    }

    let nextTurnCacheScope=1;
    class ChatGPTAdapter extends NativeProviderAdapter {
        constructor() {
            super('chatgpt', 'ChatGPT', {
                supportsOptimizer: true,
                supportsCommandTurnAck: true,
                selectors: CHATGPT_SELECTORS
            });
            this.compatibilitySignals = CHATGPT_COMPATIBILITY_SIGNALS;
            this._turnScanCacheEnabled = false;
            this._turnCacheScope=nextTurnCacheScope++;
            this._turnCacheTokens=new WeakMap();
            this._nextTurnCacheToken=1;
            this._turnListCache = null;
            this._turnListCacheTimer = null;
            this._nativeMessageDiscovery = null;
            this._nativeLifecycle = null;
        }

        setNativeMessageDiscovery(discover) {
            this._nativeMessageDiscovery = typeof discover === 'function' ? discover : null;
        }

        setNativeLifecycle(engine) {
            this._nativeLifecycle = engine || null;
        }

        clearNativeTurnMetadata(){
            if(this._turnCacheScope)globalThis.CpoQueueEngine?.invalidateProviderTurn(this._turnCacheScope);
            this._turnCacheTokens=new WeakMap();
            this._nextTurnCacheToken=1;
        }
        invalidateNativeTurn(node){
            const token=this._turnCacheTokens.get(node);
            if(token){
                globalThis.CpoQueueEngine?.invalidateProviderTurn(this._turnCacheScope,token);
                this._turnCacheTokens.delete(node);
            }
        }
        turnCacheToken(node){
            let token=this._turnCacheTokens.get(node);
            if(token)return token;
            if(this._nextTurnCacheToken>0xffffffff)this.clearNativeTurnMetadata();
            token=this._nextTurnCacheToken++;
            this._turnCacheTokens.set(node,token);
            return token;
        }
        clearTurnListCache() {
            clearTimeout(this._turnListCacheTimer);
            this._turnListCacheTimer = null;
            if(this._turnListCache)this.clearNativeTurnMetadata();
            this._turnListCache = null;
        }
        setTurnScanCacheEnabled(enabled) {
            this._turnScanCacheEnabled = enabled === true;
            this.clearNativeTurnMetadata();
            this.clearTurnListCache();
        }

        invalidateTurnScanCache(mutations) {
            if (!this._turnScanCacheEnabled) return;
            const structural=requireNative(this._nativeLifecycle?.mutations(mutations,1,false,this));
            if(structural)this.clearTurnListCache();
        }

        getCompatibilityContract() {
            return {
                provider: this.id,
                version: 1,
                selectors: cloneCompatibilityValue(this.selectors),
                signals: cloneCompatibilityValue(this.compatibilitySignals),
                requiredSignals: ['composer', 'sendButton']
            };
        }

        isComposerElement(element, { selector = '', source = 'document' } = {}) {
            const weak = this.compatibilitySignals.weakComposerSelectors.includes(selector);
            const flags = Number(super.isComposerElement(element)) |
                (Number(!!element?.closest?.('#cpo-root'))<<1) |
                (Number(!!element?.closest?.(this.compatibilitySignals.messageContext.join(',')))<<2) |
                (Number(weak)<<3) | (Number(!!element?.closest?.(this.compatibilitySignals.composerContext.join(',')))<<4);
            return requireNative(providerPredicate(this.id,3,flags))===1;
        }

        isSendActionElement(element, { selector = '' } = {}) {
            const flags=Number(super.isSendActionElement(element)) |
                (Number(this.compatibilitySignals.weakSendButtonSelectors.includes(selector))<<3) |
                (Number(!!element?.closest?.(this.compatibilitySignals.composerContext.join(',')))<<4);
            return requireNative(providerPredicate(this.id,4,flags))===1;
        }

        getMessageDiscovery(doc = (typeof document !== 'undefined' ? document : null), mainRoot = null) {
            if (!doc) {
                return {
                    nodes: [],
                    selector: null,
                    signalKey: 'messages',
                    fallback: false
                };
            }

            if (typeof this.shouldDiscoverConversationMessages === 'function' && !this.shouldDiscoverConversationMessages(doc)) {
                return {
                    nodes: [],
                    selector: null,
                    signalKey: 'messages',
                    fallback: false
                };
            }

            mainRoot = mainRoot || this.getMainRoot(doc);
            if (!mainRoot) {
                return {
                    nodes: [],
                    selector: null,
                    signalKey: 'messages',
                    fallback: false
                };
            }

            return requireNative(this._nativeMessageDiscovery?.(this,doc,mainRoot));
        }

        /**
         * @param {Document | Element | null} [doc]
         * @returns {HTMLElement[]}
         */
        getConversationTurns(doc = (typeof document !== 'undefined' ? document : null)) {
            const selectors = this.compatibilitySignals.turnContext || [];
            if (!doc || selectors.length === 0) return [];
            // Reconcile periodically as a safety net for DOM changes outside our
            // observer. Only the cache-enabled optimizer uses this fast path.
            const now = Date.now();
            const cache = this._turnListCache;
            if (this._turnScanCacheEnabled && cache?.doc === doc &&
                requireNative(this._nativeLifecycle?.cacheNodesValid(1,cache.createdAt,cache.nodes,now))) {
                return cache.nodes;
            }
            this.clearTurnListCache();
            const nodes=requireNative(this._nativeLifecycle?.providerTurns(doc,selectors));
            if (this._turnScanCacheEnabled) {
                this._turnListCache = { doc, nodes, createdAt: now };
                this._turnListCacheTimer = setTimeout(() => this.clearTurnListCache(), requireNative(this._nativeLifecycle?.cacheTtl(1)));
                if (typeof this._turnListCacheTimer?.unref === 'function') this._turnListCacheTimer.unref();
            }
            return nodes;
        }

        getAssistantTurnErrorSignal(text) {
            return requireNative(globalThis.CpoQueueEngine?.providerTurnMetadata(0,0,2,()=>String(text||''))).errorSignal;
        }

        getCommandTurnSnapshot(doc = (typeof document !== 'undefined' ? document : null), options = {}) {
            const snapshot = emptyCommandTurnSnapshot(this);
            if (!doc) {
                return snapshot;
            }

            const identity = typeof this.getConversationIdentity === 'function'
                ? this.getConversationIdentity(doc.defaultView?.location || (typeof location !== 'undefined' ? location : ''))
                : null;
            snapshot.conversationId = identity?.conversationId || null;
            snapshot.conversationKey = identity?.key || '';

            const expectedText=String(options.expectedText||'');
            const expected=expectedText?requireNative(globalThis.CpoQueueEngine?.providerTurnMetadata(0,0,1,()=>expectedText)):null;
            const exactRequired=!!expected?.hasText;
            const expectedTextFingerprint=exactRequired?expected.fingerprint:'';
            const expectedFingerprint=options.expectedFingerprint||expectedTextFingerprint;
            const turns=this.getConversationTurns(doc);
            const rows=requireNative(this._nativeLifecycle?.providerScanTurns(this,turns,expectedText,expectedTextFingerprint,exactRequired));
            return {...snapshot,...requireNative(globalThis.CpoQueueEngine?.providerTurnSnapshot(rows,expectedFingerprint,exactRequired))};
        }

        getCommandResponseState(doc = (typeof document !== 'undefined' ? document : null), binding = {}, generationState = null) {
            const generation = generationState || this.getGenerationState(doc);
            const snapshot = this.getCommandTurnSnapshot(doc, {
                expectedFingerprint: binding.commandFingerprint || ''
            });
            return requireNative(globalThis.CpoQueueEngine?.providerBoundResponse(snapshot,binding,generation));
        }

        findMatchingSelector(node, selectorKey) {
            const selectors=this.selectors?.[selectorKey]||[];
            return requireNative(this._nativeSelectorEngine?.firstMatchingSelector(node,selectors))||null;
        }

        getCompatibilityDiagnostics(doc = (typeof document !== 'undefined' ? document : null)) {
            const {root,composer,sendAction,discovery,flags,valid}=requireNative(this._nativeSelectorEngine?.providerDiagnostics(this,doc,true));
            const [state,...requiredFailures]=requireNative(globalThis.CpoQueueEngine?.providerDiagnostics(flags,discovery.nodes.length,valid));

            return {
                provider: this.id,
                root: summarizeSelectorMatch({ ...root, signalKey: 'mainRoot' }),
                composer: summarizeSelectorMatch({ ...composer, signalKey: 'composer' }),
                sendAction: summarizeSelectorMatch({ ...sendAction, signalKey: 'sendButton' }),
                messages: {
                    matched: discovery.nodes.length > 0,
                    count: discovery.nodes.length,
                    selector: discovery.selector,
                    signalKey: discovery.signalKey,
                    state
                },
                requiredFailures
            };
        }

        classifyChatGPTSurface(locationOrUrl) {
            const {supported,...surface}=providerSurface(this,locationOrUrl);
            return {provider:this.id,...surface};
        }

        isFreshConversationIdentity(identity, previousConversationId = null) {
            const kind = identity?.type === 'existing' ? 1 : identity?.type === 'new' ? 2 : 0;
            const flags = Number(identity?.provider === 'chatgpt') | (Number(!!identity?.conversationId)<<1) |
                (Number(identity?.conversationId !== previousConversationId)<<2) | (Number(!!previousConversationId)<<3);
            const native = globalThis.CpoQueueEngine?.call('cpo_rollover_fresh',[kind,flags]);
            return requireNative(native)===1;
        }

        matchConversationCapacity(text) {
            return requireNative(globalThis.CpoQueueEngine?.providerMarker(1,String(text||'')));
        }

        buildContinuationHandoffMessage(context = {}) {
            return requireNative(globalThis.CpoQueueEngine?.continuationHandoff?.(context));
        }

        getCurrentSurface(doc = (typeof document !== 'undefined' ? document : null), locationOrUrl = null) {
            const loc = locationOrUrl ||
                doc?.defaultView?.location ||
                (typeof location !== 'undefined' ? location : '');
            return this.classifyChatGPTSurface(loc);
        }

        shouldDiscoverConversationMessages(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getCurrentSurface(doc).optimizerEligible;
        }

        allowsFallbackMessageDiscovery(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getCurrentSurface(doc).allowFallbackDiscovery;
        }

        getGenerationState(doc = (typeof document !== 'undefined' ? document : null)) {
            const emptySignals = {
                stopButton: null,
                streaming: null,
                status: null,
                spinner: null,
                research: null,
                error: null,
                retry: null,
                scope: 'active-response',
                compatibility: 'unknown'
            };
            if (!doc) {
                return {
                    generating: false,
                    hasActiveStopButton: false,
                    hasResultStreaming: false,
                    hasActiveToolOrResearch: false,
                    deepResearchActive: false,
                    matchedResearchMarker: null,
                    researchStatusPreview: null,
                    hasError: false,
                    hasDeliveryTimedOut: false,
                    hasTryAgainButton: false,
                    errorSnippet: '',
                    matchedError: '',
                    conversationCapacityReached: false,
                    requiresNewConversation: false,
                    statusUnknown: true,
                    compatibilityState: 'unknown',
                    matchedSignals: emptySignals,
                    url: '',
                    title: ''
                };
            }

            const turns=this.getConversationTurns(doc);
            const {flags,statusRaw,alerts,signals}=requireNative(this._nativeSelectorEngine?.providerObserveGeneration(this,doc,turns));
            const hasActiveStopButton=!!(flags&1),hasResultStreaming=!!(flags&2);
            const {statusText,research:matchedResearchMarker,error:matchedError,snippet:errorSnippet,timeout:hasDeliveryTimedOut,capacity:conversationCapacityReached,generating,deepResearchActive,statusUnknown,compatibilityState,hasActiveToolOrResearch,hasKnownError,hasTryAgainButton}=requireNative(globalThis.CpoQueueEngine?.providerGenerationState(1,statusRaw,alerts,flags));

            const url = typeof location !== 'undefined' ? location.href : (doc.defaultView?.location?.href || '');
            const title = typeof document !== 'undefined' ? document.title : (doc.title || '');

            return {
                generating,
                hasActiveStopButton,
                hasResultStreaming,
                hasActiveToolOrResearch,
                deepResearchActive,
                matchedResearchMarker: matchedResearchMarker || null,
                researchStatusPreview: statusText || null,
                hasError: hasKnownError,
                hasDeliveryTimedOut,
                hasTryAgainButton,
                conversationCapacityReached,
                requiresNewConversation: conversationCapacityReached,
                errorSnippet,
                matchedError,
                statusUnknown,
                compatibilityState,
                matchedSignals: {
                    stopButton: signals.stopButton||null,
                    streaming: signals.streaming||null,
                    status: signals.status||null,
                    spinner: signals.spinner||null,
                    research: matchedResearchMarker ? `researchMarkers:${matchedResearchMarker}` : null,
                    error: conversationCapacityReached
                        ? (signals.alert||signals.status||'conversationCapacityMarkers')
                        : (signals.assistantErrorStop?'assistant-error-stop':(signals.alert||(hasTryAgainButton?signals.retry:null))),
                    retry: hasTryAgainButton?signals.retry:null,
                    scope: 'active-response',
                    compatibility: compatibilityState
                },
                url,
                title
            };
        }

        /** @param {Document | Element | null} [doc] */
        getRetryButtonMatch(doc = (typeof document !== 'undefined' ? document : null)) {
            const empty = {
                element: null,
                selector: '',
                signalKey: 'retryButton'
            };
            if (!doc) return empty;

            const turns=this.getConversationTurns(doc);
            return requireNative(this._nativeSelectorEngine?.providerRetry(this,doc,turns));
        }

        /** @param {Document | Element | null} [doc] */
        getRetryButton(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getRetryButtonMatch(doc).element;
        }

        clickRetryButton(doc = (typeof document !== 'undefined' ? document : null)) {
            const btn = this.getRetryButton(doc);
            if (!btn) return false;
            const native=this._nativeSelectorEngine?.click(btn);
            return native===true;
        }

        getLastAssistantTurn(doc = (typeof document !== 'undefined' ? document : null)) {
            if (!doc) return null;

            const turns = this.getConversationTurns(doc);
            if (turns.length === 0) return null;

            const latestTurn = turns[turns.length - 1];
            const flags=Number(!!latestTurn.querySelector('[data-message-author-role="assistant"]')||latestTurn.getAttribute('data-message-author-role')==='assistant')|
                (Number(!!latestTurn.querySelector('[data-message-author-role="user"]')||latestTurn.getAttribute('data-message-author-role')==='user')<<1)|
                (Number(!!latestTurn.querySelector(this.compatibilitySignals.assistantContentSelectors.join(',')))<<2)|(Number(turns.length>=2)<<3);
            const isAssistant=requireNative(this._nativeSelectorEngine?.lastAssistant(flags));

            if (!isAssistant) {
                return {
                    isAssistant: false,
                    text: '',
                    hasError: false,
                    hasDeliveryTimeout: false,
                    hasRetry: false,
                    hasCompletedText: false
                };
            }

            const text = (latestTurn.innerText || latestTurn.textContent || '').trim();
            const alertMatches = this.getSelectorNodes(latestTurn, 'errorAlerts');
            const alertText=alertMatches.map(match=>match.element.innerText||match.element.textContent||'').join(' ');
            const hasErrorStop=hasAssistantErrorStop(latestTurn,this._nativeSelectorEngine);
            const hasRetry=!!this.getRetryButton(latestTurn);
            const settlementFlags=Number(hasErrorStop)|(Number(hasRetry)<<1)|(Number(text.length>0)<<2);
            const errorSignal=this.getAssistantTurnErrorSignal(text);
            const state=requireNative(globalThis.CpoQueueEngine?.providerLastAssistant(settlementFlags,alertText,errorSignal));
            return {isAssistant:true,text,hasErrorStop,hasRetry,...state};
        }

        getMainRoot(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getSelectorMatch(doc, 'mainRoot').element || null;
        }

        removeDuplicates(nodes){
            return requireNative(this._nativeSelectorEngine?.deduplicateTurns(nodes));
        }

        getMessageNodes(doc = (typeof document !== 'undefined' ? document : null), mainRoot = null) {
            return this.getMessageDiscovery(doc, mainRoot).nodes;
        }

        normalizeMessageNode(node, mainRoot) {
            return this._nativeSelectorEngine?.normalizeTurn(node,mainRoot,this.compatibilitySignals.turnContext||[])||null;
        }

        isValidMessageNode(node, mainRoot) {
            if (!node || !mainRoot.contains(node)) return false;
            const native=this._nativeSelectorEngine?.messagePredicate?.(0,node,mainRoot,this);
            return requireNative(native);
        }

        getFallbackMessages(doc, mainRoot) {
            const result=this.getMessageDiscovery(doc,mainRoot);
            return result.fallback?result.nodes:[];
        }

        isValidFallbackNode(node, mainRoot) {
            if (!node || !mainRoot.contains(node)) return false;
            const native=this._nativeSelectorEngine?.messagePredicate?.(1,node,mainRoot,this);
            return requireNative(native);
        }

    }

    const GEMINI_SELECTORS = catalogView(2);

    function externalGeneration(adapter,doc){
        if(!doc)return {generating:false,hasActiveStopButton:false,hasResultStreaming:false,hasActiveToolOrResearch:false,deepResearchActive:false,matchedResearchMarker:null,researchStatusPreview:null,hasError:false,hasTryAgainButton:false,errorSnippet:'',matchedError:'',url:'',title:''};
        const {flags,statusRaw,alerts}=requireNative(adapter._nativeSelectorEngine?.providerObserveGeneration(adapter,doc));
        const {statusText,research:matchedResearchMarker,error:matchedError,snippet:errorSnippet,hasActiveToolOrResearch,hasKnownError,hasTryAgainButton,generating}=requireNative(globalThis.CpoQueueEngine?.providerGenerationState(PROVIDER_CODES[adapter.id],statusRaw,alerts,flags));
        return {generating,hasActiveStopButton:!!(flags&1),hasResultStreaming:!!(flags&2),hasActiveToolOrResearch,deepResearchActive:false,matchedResearchMarker,researchStatusPreview:statusText,hasError:hasKnownError,hasTryAgainButton,errorSnippet,matchedError,url:typeof location!=='undefined'?location.href:(doc.defaultView?.location?.href||''),title:typeof document!=='undefined'?document.title:(doc.title||'')};
    }

    const CLAUDE_SELECTORS=catalogView(3);
    class ExternalProviderAdapter extends NativeProviderAdapter {
        getComposerFromEventTarget(target,excludeSelector='#cpo-root'){
            const match=this._nativeSelectorEngine?.eventAncestor(target,this.selectors.composer,excludeSelector,null,'composer');
            const composer=match?.element;
            if(!composer)return null;
            const facts=providerFacts();
            const classes=facts[this.id+'EditorClasses'];
            const excluded=facts[this.id+'ExcludedAncestors'];
            const flags=Number((composer.tagName||'').toLowerCase()==='textarea')|
                (Number(composer.getAttribute?.('contenteditable')==='true')<<1)|
                (Number(classes.some(name=>composer.classList?.contains?.(name)))<<3)|
                (Number((facts[this.id+'InputIds']||[]).includes(composer.getAttribute?.('data-testid')))<<4)|
                (Number(!!composer.closest?.(excluded.join(',')))<<5);
            return requireNative(providerPredicate(this.id,2,flags))===1?composer:null;
        }
        getGenerationState(doc=(typeof document!=='undefined'?document:null)){return externalGeneration(this,doc);}
        getMainRoot(){return null;}
    }
    // Preserve constructor names and instanceof compatibility, without
    // maintaining separate Gemini and Claude implementations.
    class GeminiAdapter extends ExternalProviderAdapter {
        constructor(){super('gemini','Gemini',{supportsOptimizer:false,selectors:GEMINI_SELECTORS});}
    }
    class ClaudeAdapter extends ExternalProviderAdapter {
        constructor(){super('claude','Claude',{supportsOptimizer:false,selectors:CLAUDE_SELECTORS});}
    }

    const chatGPTAdapterInstance = new ChatGPTAdapter();
    const geminiAdapterInstance = new GeminiAdapter();
    const claudeAdapterInstance = new ClaudeAdapter();

    const PROVIDERS = {
        chatgpt: chatGPTAdapterInstance,
        gemini: geminiAdapterInstance,
        claude: claudeAdapterInstance
    };

    function getProvider(id) {
        return PROVIDERS[id] || null;
    }

    function getProviderForUrl(url) {
        if (typeof url !== 'string' && (!url || typeof url.href !== 'string')) {
            return null;
        }
        const urlStr = typeof url === 'string' ? url : url.href;
        try {
            const parsed = new URL(urlStr);
            if (parsed.protocol !== 'https:') return null;
            const native = globalThis.CpoQueueEngine?.providerHost(parsed.hostname.toLowerCase());
            return PROVIDERS[['','chatgpt','gemini','claude'][native]] || null;
        } catch { return null; }
    }

    function getConversationIdentity(locationOrUrl) {
        const provider = getProviderForUrl(locationOrUrl);
        if (provider) {
            return provider.getConversationIdentity(locationOrUrl);
        }
        return {
            provider: 'unknown',
            type: 'unsupported',
            conversationId: null,
            key: 'unknown:unsupported'
        };
    }

    const ProviderAdapterRegistry = {
        ProviderAdapter,
        ChatGPTAdapter,
        GeminiAdapter,
        ClaudeAdapter,
        CHATGPT_SELECTORS,
        GEMINI_SELECTORS,
        CLAUDE_SELECTORS,
        PROVIDERS,
        getProvider,
        getProviderForUrl,
        getConversationIdentity,
        normalizeCommandText,
        fingerprintCommandText
    };

    if (typeof globalThis !== 'undefined') {
        globalThis.ProviderAdapter = ProviderAdapter;
        globalThis.ChatGPTAdapter = ChatGPTAdapter;
        globalThis.GeminiAdapter = GeminiAdapter;
        globalThis.ClaudeAdapter = ClaudeAdapter;
        globalThis.CHATGPT_SELECTORS = CHATGPT_SELECTORS;
        globalThis.GEMINI_SELECTORS = GEMINI_SELECTORS;
        globalThis.CLAUDE_SELECTORS = CLAUDE_SELECTORS;
        globalThis.ProviderAdapters = PROVIDERS;
        globalThis.ProviderAdapterRegistry = ProviderAdapterRegistry;
        globalThis.getProvider = getProvider;
        globalThis.getProviderForUrl = getProviderForUrl;
        globalThis.getConversationIdentity = getConversationIdentity;
        globalThis.normalizeCommandText = normalizeCommandText;
        globalThis.fingerprintCommandText = fingerprintCommandText;
    }

    if (typeof module !== 'undefined' && module.exports) {
        Object.assign(module.exports,ProviderAdapterRegistry);
    }
})();
