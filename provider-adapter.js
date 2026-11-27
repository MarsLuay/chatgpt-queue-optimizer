(() => {
    'use strict';

    const PROVIDER_CODES = { chatgpt: 1, gemini: 2, claude: 3 };
    const nativeContains = (text, marker) => requireNative(globalThis.CpoQueueEngine?.contains(text,marker));
    function nativeRoute(provider, pathname) {
        const engine=globalThis.CpoQueueEngine;
        const route=engine?.providerRoute(PROVIDER_CODES[provider],pathname);
        if(!route)return null;
        const key=engine.identityKey?.(provider,route.type,route.conversationId);
        return {...route,key:requireNative(key)};
    }
    function nativeGeneration(stop, streaming, tool, error, retry, deep = false, capacity = false) {
        const flags = Number(!!stop) | (Number(!!streaming)<<1) | (Number(!!tool)<<2) |
            (Number(!!error)<<3) | (Number(!!retry)<<4) | (Number(!!deep)<<5) | (Number(!!capacity)<<6);
        const result = globalThis.CpoQueueEngine?.call('cpo_generation_state', [flags]);
        if (result == null) return null;
        return { generating: !!(result&1), deepResearchActive: !!(result&2),
            statusUnknown: !!(result&4), compatibilityState: result&24 ? 'error' : result&32 ? 'active' : 'unknown' };
    }
    function nativeResponse(generation, assistant, waiting = false, interrupted = false) {
        const flags = [generation.conversationCapacityReached || generation.requiresNewConversation,
            assistant?.hasErrorStop, generation.hasError, generation.hasDeliveryTimedOut,
            generation.hasTryAgainButton, assistant?.errorSignal, waiting, interrupted,
            assistant?.hasCompletedText, generation.generating, generation.deepResearchActive,
            assistant?.streaming, assistant?.hasIncompleteToolTurn].reduce((mask,value,i) => mask | (Number(!!value)<<i),0);
        return globalThis.CpoQueueEngine?.call('cpo_response_class', [flags]) ?? null;
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
        if(native!=null)return ['','user','assistant'][native]||'';
        if (attr === 'user' || attr === 'assistant') {
            return attr;
        }
        if (node?.querySelector?.('[data-message-author-role="user"]')) {
            return 'user';
        }
        if (node?.querySelector?.('[data-message-author-role="assistant"]')) {
            return 'assistant';
        }
        return '';
    }

    function getNodeText(node) {
        return normalizeCommandText(node?.innerText || node?.textContent || '');
    }

    const ASSISTANT_ERROR_STATUS_ATTRIBUTES = [
        'data-message-status',
        'data-message-state',
        'data-stop-reason',
        'data-finish-reason',
        'data-status',
        'data-state',
        'data-error'
    ];
    const ASSISTANT_ERROR_STATUS_VALUES = new Set([
        'error',
        'failed',
        'failure',
        'assistant-error',
        'assistant_error',
        'error-stop',
        'error_stop'
    ]);

    function hasAssistantErrorStop(node, engine = null) {
        const native=engine?.assistantError(node,ASSISTANT_ERROR_STATUS_ATTRIBUTES,ASSISTANT_ERROR_STATUS_VALUES);
        if(native!=null)return native;
        if (!node || typeof node.getAttribute !== 'function') {
            return false;
        }

        const candidates = [node];
        try {
            candidates.push(...Array.from(node.querySelectorAll?.(
                ASSISTANT_ERROR_STATUS_ATTRIBUTES.map(attribute => `[${attribute}]`).join(',')
            ) || []));
        } catch {
            // A provider DOM can change while it is being inspected.
        }

        return candidates.some(candidate => ASSISTANT_ERROR_STATUS_ATTRIBUTES.some(attribute => {
            const value = String(candidate.getAttribute?.(attribute) || '').trim().toLowerCase();
            if (!value) {
                return false;
            }
            if (attribute === 'data-error') {
                return value === 'true' || value === '1' || value === 'yes' || ASSISTANT_ERROR_STATUS_VALUES.has(value);
            }
            return ASSISTANT_ERROR_STATUS_VALUES.has(value);
        }));
    }

    const TOOL_TURN_SELECTORS = [
        '[data-tool-call]',
        '[data-tool-result]',
        '[data-tool-state]',
        '[data-tool-status]',
        '[data-testid*="tool-call"]',
        '[data-testid*="tool-result"]'
    ];
    const INCOMPLETE_TOOL_STATES = new Set(['active', 'incomplete', 'pending', 'running', 'waiting']);

    function hasIncompleteToolTurn(node, engine = null) {
        const native=engine?.incompleteTool(node,TOOL_TURN_SELECTORS,INCOMPLETE_TOOL_STATES,normalizeCommandText);
        if(native!=null)return native;
        if (!node || typeof node.getAttribute !== 'function') {
            return false;
        }

        const candidates = [node];
        try {
            candidates.push(...Array.from(node.querySelectorAll?.(TOOL_TURN_SELECTORS.join(',')) || []));
        } catch {
            // A provider DOM can change while it is being inspected.
        }

        const toolNode = candidates.find(candidate => TOOL_TURN_SELECTORS.some(selector => {
            try {
                return candidate.matches?.(selector);
            } catch {
                return false;
            }
        }));
        if (!toolNode) {
            return false;
        }

        const explicitState = candidates
            .map(candidate => TOOL_TURN_SELECTORS
                .flatMap(selector => selector.match(/\[([^=\]]+)/g) || [])
                .map(attribute => attribute.slice(1))
                .map(attribute => String(candidate.getAttribute?.(attribute) || '').trim().toLowerCase())
                .find(Boolean))
            .find(value => INCOMPLETE_TOOL_STATES.has(value));
        if (explicitState) {
            return true;
        }

        const turnText = getNodeText(node);
        const toolText = getNodeText(toolNode);
        return !turnText || turnText === toolText;
    }

    function getTurnId(node, index, role, fingerprint) {
        return node?.getAttribute?.('data-message-id') ||
            node?.getAttribute?.('data-testid') ||
            `turn:${index}:${role || 'unknown'}:${fingerprint || '0'}`;
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
            const matches = [];
            const seen = new Set();

            if (!root || selectors.length === 0) return matches;
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
            let element = target && target.nodeType === 1
                ? target
                : target?.parentElement;

            while (element) {
                if (excludeSelector && element.closest?.(excludeSelector)) return null;
                const match = this.getSelectorNodes(element, 'composer', (candidate, selector) => this.isComposerElement(candidate, {
                    selector,
                    source: 'event'
                }))[0];
                if (match?.element === element) return match;
                element = element.parentElement;
            }

            return null;
        }

        getComposerFromEventTarget(target, excludeSelector = '#cpo-root') {
            return this.getComposerMatchFromEventTarget(target, excludeSelector)?.element || null;
        }

        getSendActionFromEventTarget(target) {
            let element = target && target.nodeType === 1
                ? target
                : target?.parentElement;

            while (element) {
                const match = this.getSelectorNodes(element, 'sendButton', (candidate, selector) => this.isSendActionElement(candidate, {
                    selector,
                    source: 'event'
                }))[0];
                if (match?.element === element) return match;
                element = element.parentElement;
            }

            return null;
        }

        getCompatibilityDiagnostics(doc = (typeof document !== 'undefined' ? document : null)) {
            const root = this.getSelectorMatch(doc, 'mainRoot');
            const composer = this.getComposerMatch(doc);
            const sendAction = this.getSendActionMatch(doc);
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
        getCommandResponseState(doc, binding = {}) {
            const generation = this.getGenerationState(doc);
            const native = nativeResponse(generation, null);
            if (native == null ? (generation.hasError || generation.hasTryAgainButton || generation.hasDeliveryTimedOut) : [1,2,3,4,5,6].includes(native)) {
                return {
                    phase: 'error',
                    userTurnId: binding.userTurnId || null,
                    assistantTurnId: null,
                    conversationId: binding.conversationId || null,
                    generating: false,
                    deepResearchActive: !!generation.deepResearchActive,
                    hasCompletedAssistant: false,
                    source: generation.hasDeliveryTimedOut ? 'delivery-timeout' : (generation.hasTryAgainButton ? 'retry-visible' : 'generation-error')
                };
            }
            if (native == null ? (generation.generating || generation.deepResearchActive) : [10,12].includes(native)) {
                return {
                    phase: 'active',
                    userTurnId: binding.userTurnId || null,
                    assistantTurnId: null,
                    conversationId: binding.conversationId || null,
                    generating: !!generation.generating,
                    deepResearchActive: !!generation.deepResearchActive,
                    hasCompletedAssistant: false,
                    source: generation.deepResearchActive ? 'deep-research' : 'generating'
                };
            }
            const lastAssistant = typeof this.getLastAssistantTurn === 'function'
                ? this.getLastAssistantTurn(doc)
                : null;
            if ((nativeResponse(generation, {hasCompletedText: !!(lastAssistant?.isAssistant && lastAssistant?.hasCompletedText)}) ?? (lastAssistant?.isAssistant && lastAssistant?.hasCompletedText ? 13 : 0)) === 13) {
                return {
                    phase: 'terminal',
                    userTurnId: binding.userTurnId || null,
                    assistantTurnId: binding.assistantTurnId || null,
                    conversationId: binding.conversationId || null,
                    generating: false,
                    deepResearchActive: false,
                    hasCompletedAssistant: true,
                    source: 'assistant-turn-completed'
                };
            }
            return {
                phase: 'transient-idle',
                userTurnId: binding.userTurnId || null,
                assistantTurnId: null,
                conversationId: binding.conversationId || null,
                generating: false,
                deepResearchActive: false,
                hasCompletedAssistant: false,
                source: 'unknown-idle'
            };
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

    class ChatGPTAdapter extends ProviderAdapter {
        constructor() {
            super('chatgpt', 'ChatGPT', {
                supportsOptimizer: true,
                supportsCommandTurnAck: true,
                selectors: CHATGPT_SELECTORS
            });
            this.compatibilitySignals = CHATGPT_COMPATIBILITY_SIGNALS;
            this._turnScanCacheEnabled = false;
            this._turnScanCache = new WeakMap();
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

        clearTurnListCache() {
            clearTimeout(this._turnListCacheTimer);
            this._turnListCacheTimer = null;
            this._turnListCache = null;
        }

        setTurnScanCacheEnabled(enabled) {
            this._turnScanCacheEnabled = enabled === true;
            this._turnScanCache = new WeakMap();
            this.clearTurnListCache();
        }

        invalidateTurnScanCache(mutations) {
            if (!this._turnScanCacheEnabled) return;
            const nativeStructural = this._nativeLifecycle?.mutations(mutations, 1, false, this);
            if (nativeStructural != null) {
                if (nativeStructural) this.clearTurnListCache();
                return;
            }
            const turnSelector = '[data-testid*="conversation-turn"], [data-message-author-role], [data-message-id], article';
            let structureChanged = false;
            // Deduplicate changed ancestors across large streaming mutation batches.
            const dirtyNodes = new Set();
            for (const mutation of mutations) {
                let node = mutation.target?.nodeType === 3
                    ? mutation.target.parentElement
                    : mutation.target;
                for (; node; node = node.parentElement) dirtyNodes.add(node);

                if (mutation.type === 'attributes' &&
                    ['data-testid', 'data-message-author-role', 'data-message-id'].includes(mutation.attributeName)) {
                    structureChanged = true;
                }
                const added = mutation.addedNodes || [];
                const removed = mutation.removedNodes || [];
                if (added.length || removed.length) {
                    const affected = [...added, ...removed];
                    if (!mutation.target?.closest?.(turnSelector) ||
                        affected.some(child => child.nodeType === 1 &&
                            (child.matches?.(turnSelector) || child.querySelector?.(turnSelector)))) {
                        structureChanged = true;
                    }
                }
            }
            for (const node of dirtyNodes) this._turnScanCache.delete(node);
            if (structureChanged) this.clearTurnListCache();
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
            const native = this._nativeSelectorEngine?.candidate(0,flags);
            return requireNative(native);
        }

        isSendActionElement(element, { selector = '' } = {}) {
            const flags=Number(super.isSendActionElement(element)) |
                (Number(this.compatibilitySignals.weakSendButtonSelectors.includes(selector))<<3) |
                (Number(!!element?.closest?.(this.compatibilitySignals.composerContext.join(',')))<<4);
            const native=this._nativeSelectorEngine?.candidate(1,flags);
            return requireNative(native);
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
                (this._nativeLifecycle?.cacheNodesValid(1, cache.createdAt, cache.nodes, now) ??
                 (now >= cache.createdAt && now - cache.createdAt < 8000 &&
                    cache.nodes.every(node => node.isConnected !== false)))) {
                return cache.nodes;
            }
            this.clearTurnListCache();
            // One DOM-ordered query instead of a separate full traversal for
            // every selector. Preserve the independent-selector fallback.
            let nodes;
            try {
                nodes = /** @type {HTMLElement[]} */ (Array.from(doc.querySelectorAll(selectors.join(','))));
            } catch {
                nodes = [];
                const seen = new Set();
                for (const selector of selectors) {
                    try {
                        for (const element of Array.from(doc.querySelectorAll(selector))) {
                            if (!seen.has(element)) {
                                seen.add(element);
                                nodes.push(/** @type {HTMLElement} */ (element));
                            }
                        }
                    } catch {
                        // An unsupported selector must not stop queue processing.
                    }
                }
            }
            if (this._turnScanCacheEnabled) {
                this._turnListCache = { doc, nodes, createdAt: now };
                this._turnListCacheTimer = setTimeout(() => this.clearTurnListCache(), this._nativeLifecycle?.cacheTtl(1) ?? 8000);
                if (typeof this._turnListCacheTimer?.unref === 'function') this._turnListCacheTimer.unref();
            }
            return nodes;
        }

        getAssistantTurnErrorSignal(text) {
            const normalized = normalizeCommandText(text).toLowerCase();
            if (!normalized) return '';

            const markers = Array.isArray(this.compatibilitySignals?.errorMarkers)
                ? this.compatibilitySignals.errorMarkers
                : [];
            return markers.find((marker) => {
                const normalizedMarker = normalizeCommandText(marker).toLowerCase();
                return normalized === normalizedMarker ||
                    normalized.startsWith(`${normalizedMarker}.`) ||
                    normalized.startsWith(`${normalizedMarker}!`) ||
                    normalized.startsWith(`${normalizedMarker}?`) ||
                    normalized.startsWith(`${normalizedMarker} `);
            }) || '';
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

            const expectedText = normalizeCommandText(options.expectedText || '');
            const expectedTextFingerprint = expectedText ? fingerprintCommandText(expectedText) : '';
            const expectedFingerprint = options.expectedFingerprint || expectedTextFingerprint;
            const turns = this.getConversationTurns(doc);
            const userTurns = [];
            const assistantTurns = [];

            turns.forEach((node, index) => {
                const role = getNodeRole(node, this._nativeSelectorEngine);
                // Cache only the completed history, never the last two turns.
                // Store fingerprints, not the potentially multi-megabyte text.
                const cacheable = this._turnScanCacheEnabled && index < turns.length - 2;
                const existing = cacheable ? this._turnScanCache.get(node) : null;
                const memo = existing?.role === role ? existing : null;
                let text = null;
                let fingerprint;
                let hasText;
                let errorSignal;
                if (memo) {
                    fingerprint = memo.fingerprint;
                    hasText = memo.hasText;
                    errorSignal = memo.errorSignal;
                } else {
                    text = getNodeText(node);
                    fingerprint = fingerprintCommandText(text);
                    hasText = text.length > 0;
                    errorSignal = role === 'assistant'
                        ? this.getAssistantTurnErrorSignal(text)
                        : '';
                    if (cacheable) this._turnScanCache.set(node, { role, fingerprint, hasText, errorSignal });
                }
                const turnId = getTurnId(node, index, role, fingerprint);
                // A fingerprint alone is insufficient for delivery confirmation.
                const matchedExpected = !!expectedText && fingerprint === expectedTextFingerprint &&
                    (text === null ? getNodeText(node) : text) === expectedText;

                if (role === 'user' || (!role && matchedExpected)) {
                    userTurns.push({
                        turnId,
                        index,
                        fingerprint,
                        matchedExpected
                    });
                    if (matchedExpected) {
                        snapshot.matchedUserTurnId = turnId;
                    }
                }

                if (role === 'assistant') {
                    const streaming = !!(node.querySelector?.('[data-message-streaming="true"], [data-is-streaming="true"], .result-streaming'));
                    const errorStop = hasAssistantErrorStop(node, this._nativeSelectorEngine);
                    assistantTurns.push({
                        turnId,
                        index,
                        followingUserTurnId: userTurns.length > 0 ? userTurns[userTurns.length - 1].turnId : null,
                        fingerprint,
                        streaming,
                        hasErrorStop: errorStop,
                        hasIncompleteToolTurn: hasIncompleteToolTurn(node, this._nativeSelectorEngine),
                        hasCompletedText: !streaming && !errorStop && hasText,
                        errorSignal
                    });
                }
            });

            snapshot.userTurns = userTurns;
            snapshot.assistantTurns = assistantTurns;
            snapshot.latestUserTurnId = userTurns.length > 0 ? userTurns[userTurns.length - 1].turnId : null;
            snapshot.latestAssistantTurnId = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1].turnId : null;
            if (!snapshot.matchedUserTurnId && expectedFingerprint) {
                const fingerprintMatch = userTurns.find(turn => turn.fingerprint === expectedFingerprint);
                if (fingerprintMatch) {
                    snapshot.matchedUserTurnId = fingerprintMatch.turnId;
                    fingerprintMatch.matchedExpected = true;
                }
            }
            return snapshot;
        }

        getCommandResponseState(doc = (typeof document !== 'undefined' ? document : null), binding = {}, generationState = null) {
            const generation = generationState || this.getGenerationState(doc);
            const snapshot = this.getCommandTurnSnapshot(doc, {
                expectedFingerprint: binding.commandFingerprint || ''
            });
            const userTurnId = binding.userTurnId || snapshot.matchedUserTurnId || snapshot.latestUserTurnId || null;
            const boundUser = snapshot.userTurns.find(turn => turn.turnId === userTurnId) || null;
            const followingAssistant = snapshot.assistantTurns.find(turn => turn.followingUserTurnId === userTurnId) ||
                (boundUser
                    ? snapshot.assistantTurns.find(turn => turn.index > boundUser.index)
                    : null) ||
                null;
            const conversationId = binding.conversationId || snapshot.conversationId || null;
            const statusText = String(generation.researchStatusPreview || '').toLowerCase();
            const waitingForUser = (this.compatibilitySignals.waitingForUserMarkers || []).some(marker => nativeContains(statusText, marker));
            const interrupted = (this.compatibilitySignals.interruptedMarkers || []).some(marker => nativeContains(statusText, marker));
            const incompleteToolTurn = followingAssistant?.hasIncompleteToolTurn === true;
            const native = nativeResponse(generation, followingAssistant, waitingForUser, interrupted);

            if (native == null ? (generation.conversationCapacityReached || generation.requiresNewConversation) : native === 1) {
                return {
                    phase: 'error',
                    userTurnId,
                    assistantTurnId: followingAssistant?.turnId || null,
                    conversationId,
                    generating: false,
                    deepResearchActive: false,
                    hasCompletedAssistant: false,
                    source: 'conversation-max-length'
                };
            }

            if (native == null ? (followingAssistant?.hasErrorStop) : native === 2) {
                return {
                    phase: 'error',
                    userTurnId,
                    assistantTurnId: followingAssistant.turnId,
                    conversationId,
                    generating: false,
                    deepResearchActive: false,
                    hasCompletedAssistant: false,
                    source: 'assistant-error-stop'
                };
            }

            if (native == null ? (generation.hasError || generation.hasTryAgainButton || generation.hasDeliveryTimedOut) : [3,4,5].includes(native)) {
                return {
                    phase: 'error',
                    userTurnId,
                    assistantTurnId: followingAssistant?.turnId || null,
                    conversationId,
                    generating: false,
                    deepResearchActive: !!generation.deepResearchActive,
                    hasCompletedAssistant: false,
                    source: generation.hasDeliveryTimedOut ? 'delivery-timeout' : (generation.hasTryAgainButton ? 'retry-visible' : 'generation-error')
                };
            }

            if (native == null ? (followingAssistant?.errorSignal) : native === 6) {
                return {
                    phase: 'error',
                    userTurnId,
                    assistantTurnId: followingAssistant.turnId,
                    conversationId,
                    generating: false,
                    deepResearchActive: false,
                    hasCompletedAssistant: false,
                    source: 'assistant-error-stop',
                    errorSignal: followingAssistant.errorSignal
                };
            }

            if (native == null ? (waitingForUser) : native === 7) {
                return {
                    phase: 'waiting-for-user',
                    userTurnId,
                    assistantTurnId: followingAssistant?.turnId || null,
                    conversationId,
                    generating: false,
                    deepResearchActive: false,
                    hasCompletedAssistant: false,
                    source: 'waiting-for-user'
                };
            }

            if (native == null ? (interrupted && !(followingAssistant?.hasCompletedText)) : native === 8) {
                return {
                    phase: 'interrupted',
                    userTurnId,
                    assistantTurnId: followingAssistant?.turnId || null,
                    conversationId,
                    generating: false,
                    deepResearchActive: false,
                    hasCompletedAssistant: false,
                    source: 'interrupted'
                };
            }

            const boundActivity = !!(generation.generating || generation.deepResearchActive || followingAssistant?.streaming || incompleteToolTurn);
            if (native == null ? (boundActivity) : [9,10,11,12].includes(native)) {
                return {
                    phase: 'active',
                    userTurnId,
                    assistantTurnId: followingAssistant?.turnId || null,
                    conversationId,
                    generating: !!generation.generating,
                    deepResearchActive: !!generation.deepResearchActive,
                    hasCompletedAssistant: false,
                    toolTurnIncomplete: incompleteToolTurn,
                    source: incompleteToolTurn
                        ? 'incomplete-tool-turn'
                        : (generation.deepResearchActive ? 'deep-research' : (followingAssistant?.streaming ? 'streaming' : 'generating'))
                };
            }

            if (native == null ? (followingAssistant && followingAssistant.hasCompletedText && !followingAssistant.streaming) : native === 13) {
                return {
                    phase: 'terminal',
                    userTurnId,
                    assistantTurnId: followingAssistant.turnId,
                    conversationId,
                    generating: false,
                    deepResearchActive: false,
                    hasCompletedAssistant: true,
                    source: 'bound-assistant-turn'
                };
            }

            return {
                phase: 'transient-idle',
                userTurnId,
                assistantTurnId: followingAssistant?.turnId || null,
                conversationId,
                generating: false,
                deepResearchActive: false,
                hasCompletedAssistant: false,
                source: 'transient-idle'
            };
        }

        findMatchingSelector(node, selectorKey) {
            const selectors = this.selectors?.[selectorKey] || [];
            const native=this._nativeSelectorEngine?.firstMatchingSelector?.(node,selectors);
            if(native!=null)return native||null;
            return selectors.find((selector) => {
                try {
                    return node.matches?.(selector);
                } catch {
                    return false;
                }
            }) || null;
        }

        getCompatibilityDiagnostics(doc = (typeof document !== 'undefined' ? document : null)) {
            const root = this.getSelectorMatch(doc, 'mainRoot');
            const composer = this.getComposerMatch(doc);
            const sendAction = this.getSendActionMatch(doc);
            const discovery = this.getMessageDiscovery(doc, root.element);
            const conversation = this.getConversationIdentity(
                doc?.defaultView?.location || (typeof location !== 'undefined' ? location : '')
            );
            const isEmptyConversation = discovery.nodes.length === 0 &&
                !!root.element &&
                !!composer.element &&
                ['new', 'existing'].includes(conversation.type);
            const requiredFailures = [];
            if (!root.element) requiredFailures.push('mainRoot');
            if (!composer.element) requiredFailures.push('composer');
            if (!sendAction.element) requiredFailures.push('sendButton');

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
                    state: requiredFailures.length > 0
                        ? 'required-signals-missing'
                        : (isEmptyConversation ? 'empty-conversation' : (discovery.nodes.length > 0 ? 'matched' : 'not-found'))
                },
                requiredFailures
            };
        }

        isSupportedUrl(url) {
            if (typeof url !== 'string') {
                return false;
            }

            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'https:') return false;
                const native = globalThis.CpoQueueEngine?.providerHost(parsed.hostname.toLowerCase());
                return native === PROVIDER_CODES.chatgpt;
            } catch {
                return false;
            }
        }

        classifyChatGPTSurface(locationOrUrl) {
            const unsupported = {
                provider: this.id,
                type: 'unsupported',
                conversationId: null,
                key: `${this.id}:unsupported`,
                surface: 'unsupported',
                optimizerEligible: false,
                allowFallbackDiscovery: false,
                pathname: ''
            };

            const urlStr = typeof locationOrUrl === 'string'
                ? locationOrUrl
                : (locationOrUrl?.href || String(locationOrUrl || ''));

            if (!urlStr || urlStr === 'undefined' || urlStr === 'null') {
                return {
                    provider: this.id,
                    type: 'unsupported',
                    conversationId: null,
                    key: `${this.id}:unsupported`,
                    surface: 'unclassified',
                    optimizerEligible: true,
                    allowFallbackDiscovery: false,
                    pathname: ''
                };
            }

            if (!this.isSupportedUrl(urlStr)) {
                return unsupported;
            }

            try {
                const parsed = new URL(urlStr);
                const pathname = parsed.pathname || '/';
                const native = nativeRoute(this.id, pathname);
                if (native) {
                    const existing = native.type === 'existing';
                    const fresh = native.type === 'new';
                    return { ...unsupported, ...native, key: native.key,
                        surface: existing ? 'conversation' : fresh ? 'composer' : 'unsupported',
                        optimizerEligible: existing || fresh, allowFallbackDiscovery: existing, pathname };
                }
                return unsupported;
            } catch {
                return unsupported;
            }
        }

        getConversationIdentity(locationOrUrl) {
            const surface = this.classifyChatGPTSurface(locationOrUrl);
            return {
                provider: surface.provider,
                type: surface.type,
                conversationId: surface.conversationId,
                key: surface.key
            };
        }

        getNewConversationUrl() {
            return 'https://chatgpt.com/';
        }

        startNewConversation() {
            return {
                ok: true,
                url: this.getNewConversationUrl(),
                method: 'route'
            };
        }

        isFreshConversationIdentity(identity, previousConversationId = null) {
            const kind = identity?.type === 'existing' ? 1 : identity?.type === 'new' ? 2 : 0;
            const flags = Number(identity?.provider === 'chatgpt') | (Number(!!identity?.conversationId)<<1) |
                (Number(identity?.conversationId !== previousConversationId)<<2) | (Number(!!previousConversationId)<<3);
            const native = globalThis.CpoQueueEngine?.call('cpo_rollover_fresh',[kind,flags]);
            return requireNative(native)===1;
        }

        matchConversationCapacity(text) {
            const haystack = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (!haystack) {
                return '';
            }
            return (this.compatibilitySignals.conversationCapacityMarkers || []).find(marker => nativeContains(haystack, marker)) || '';
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

        getComposerFromEventTarget(target, excludeSelector = '#cpo-root') {
            return this.getComposerMatchFromEventTarget(target, excludeSelector)?.element || null;
        }

        getComposerText(composer) {
            return requireNative(this._nativeSelectorEngine?.composerRead(1,composer));
        }

        clearComposer(composer) {
            if(this._nativeSelectorEngine?.composerWrite(1,composer,'',0)!==true)throw new Error('Native composer clear unavailable.');
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

            const turns = this.getConversationTurns(doc);
            const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
            const assistantErrorStop = getNodeRole(latestTurn, this._nativeSelectorEngine) === 'assistant' && hasAssistantErrorStop(latestTurn, this._nativeSelectorEngine);
            const turnSet = new Set(turns);
            const inActiveSurface = (node) => this.isActiveResponseNode(node, turns, latestTurn, turnSet);

            const buttons = Array.from(doc.querySelectorAll('button')).filter(inActiveSurface);
            const stopSelectorMatch = this.getSelectorMatch(doc, 'stopButton', (button) => {
                return inActiveSurface(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
            });
            const semanticStopButton = buttons.find(button => {
                if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
                    return false;
                }
                const testId = (
                    button.getAttribute('data-testid') ||
                    button.getAttribute('data-test-id') ||
                    ''
                ).toLowerCase();
                const label = (
                    button.getAttribute('aria-label') ||
                    button.innerText ||
                    button.textContent ||
                    ''
                ).toLowerCase().trim();
                return this.compatibilitySignals.stopLabels.some(marker =>
                    label === marker || nativeContains(label, marker) || nativeContains(testId, marker.replace(/ /g, '-'))
                );
            });
            const stopButton = stopSelectorMatch.element || semanticStopButton;
            const hasActiveStopButton = !!stopButton;

            const streamingMatches = this.getSelectorNodes(doc, 'streaming', inActiveSurface);
            const streamingMatch = streamingMatches[0] || { element: null, selector: '' };
            const hasResultStreaming = !!streamingMatch.element;

            const statusMatches = this.getSelectorNodes(doc, 'status', (node) => {
                return inActiveSurface(node) && node.getAttribute('aria-live') !== 'off';
            });
            const visibleActiveNodes = statusMatches
                .map(match => match.element)
                .filter(node => !node.hidden && node.getAttribute('aria-hidden') !== 'true');

            const spinnerMatches = this.getSelectorNodes(doc, 'spinner', (node) => {
                return inActiveSurface(node) && !node.hidden && node.getAttribute('aria-hidden') !== 'true';
            });
            const hasActiveSpinner = spinnerMatches.length > 0;

            const statusText = visibleActiveNodes
                .map(node => node.innerText || node.textContent || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 1200);
            const activeTextLower = statusText.toLowerCase();

            const matchedResearchMarker = this.compatibilitySignals.researchMarkers.find(marker => nativeContains(activeTextLower, marker)) || '';
            const hasActiveToolOrResearch = !!matchedResearchMarker || hasActiveSpinner;
            const isDeepResearch = matchedResearchMarker === 'deep research' ||
                nativeContains(activeTextLower, 'deep research') ||
                nativeContains(activeTextLower, 'researching');

            const alertMatches = this.getSelectorNodes(doc, 'errorAlerts', inActiveSurface);
            const errorSearchText = alertMatches
                .map(match => match.element.innerText || match.element.textContent || '')
                .join(' ')
                .toLowerCase()
                .replace(/\s+/g, ' ')
                .trim();

            const matchedDeliveryTimeout = this.compatibilitySignals.deliveryTimeoutMarkers.find(marker => nativeContains(errorSearchText, marker)) || '';
            const hasDeliveryTimedOut = !!matchedDeliveryTimeout;
            const matchedCapacity = this.matchConversationCapacity(`${errorSearchText} ${activeTextLower}`);
            const conversationCapacityReached = !!matchedCapacity;
            const matchedGeneralError = conversationCapacityReached
                ? ''
                : (this.compatibilitySignals.errorMarkers.find(marker => nativeContains(errorSearchText, marker)) || '');
            const matchedError = conversationCapacityReached
                ? 'conversation-max-length'
                : (matchedDeliveryTimeout
                    ? 'Message delivery timed out. Please try again.'
                    : (assistantErrorStop ? 'assistant-error-stop' : matchedGeneralError));
            const errorSnippet = matchedError || '';

            const retryMatch = this.getRetryButtonMatch(doc);
            const hasTryAgainButton = conversationCapacityReached ? false : !!retryMatch.element;

            const hasKnownError = !!matchedError || hasDeliveryTimedOut || conversationCapacityReached || assistantErrorStop;
            const isWorking = hasActiveStopButton || hasResultStreaming || hasActiveToolOrResearch;
            const native = nativeGeneration(hasActiveStopButton,hasResultStreaming,hasActiveToolOrResearch,hasKnownError,hasTryAgainButton,isDeepResearch,conversationCapacityReached);
            const generating = requireNative(native).generating;
            const deepResearchActive = native.deepResearchActive;
            const statusUnknown = native.statusUnknown;
            const compatibilityState = native.compatibilityState;

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
                    stopButton: stopSelectorMatch.selector || (semanticStopButton ? 'stopButton.semantic' : null),
                    streaming: streamingMatch.selector || null,
                    status: statusMatches[0]?.selector || null,
                    spinner: spinnerMatches[0]?.selector || null,
                    research: matchedResearchMarker ? `researchMarkers:${matchedResearchMarker}` : null,
                    error: conversationCapacityReached
                        ? (alertMatches[0]?.selector || statusMatches[0]?.selector || 'conversationCapacityMarkers')
                        : (assistantErrorStop
                            ? 'assistant-error-stop'
                            : (alertMatches[0]?.selector || (hasTryAgainButton ? retryMatch.selector || retryMatch.signalKey : null))),
                    retry: hasTryAgainButton ? (retryMatch.selector || retryMatch.signalKey) : null,
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

            const isRetryOrRegenerate = (btn) => {
                if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
                    return false;
                }
                const testId = (
                    btn.getAttribute('data-testid') ||
                    btn.getAttribute('data-test-id') ||
                    ''
                ).toLowerCase();
                if (testId === 'retry-button' || testId.includes('retry') || testId.includes('regenerate')) {
                    return true;
                }
                const label = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
                const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
                return this.compatibilitySignals.retryLabels.some(marker =>
                    label === marker || nativeContains(label, marker) || text === marker || nativeContains(text, marker)
                );
            };

            const turns = this.getConversationTurns(doc);
            const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;

            if (latestTurn) {
                const turnButtons = Array.from(latestTurn.querySelectorAll('button'));
                const foundInTurn = turnButtons.reverse().find(isRetryOrRegenerate);
                if (foundInTurn) {
                    return {
                        element: foundInTurn,
                        selector: 'retryButton.latestTurn',
                        signalKey: 'retryButton'
                    };
                }
            }

            const alertMatches = this.getSelectorNodes(doc, 'errorAlerts');
            for (const alertMatch of alertMatches) {
                const alertButtons = Array.from(alertMatch.element.querySelectorAll('button'));
                const foundInAlert = alertButtons.reverse().find(isRetryOrRegenerate);
                if (foundInAlert) {
                    return {
                        element: foundInAlert,
                        selector: alertMatch.selector,
                        signalKey: 'retryButton'
                    };
                }
            }

            const allButtons = Array.from(doc.querySelectorAll('button'));
            const fallback = allButtons.reverse().find(btn => {
                return isRetryOrRegenerate(btn) && this.isActiveResponseNode(btn, turns, latestTurn);
            });
            return fallback
                ? { element: fallback, selector: 'retryButton.semantic', signalKey: 'retryButton' }
                : empty;
        }

        /** @param {Document | Element | null} [doc] */
        getRetryButton(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getRetryButtonMatch(doc).element;
        }

        clickRetryButton(doc = (typeof document !== 'undefined' ? document : null)) {
            const btn = this.getRetryButton(doc);
            if (!btn) return false;
            const native=this._nativeSelectorEngine?.click(btn);
            if(this._nativeSelectorEngine)return native===true;
            try {
                btn.click();
                return true;
            } catch {
                return false;
            }
        }

        getLastAssistantTurn(doc = (typeof document !== 'undefined' ? document : null)) {
            if (!doc) return null;

            const turns = this.getConversationTurns(doc);
            if (turns.length === 0) return null;

            const latestTurn = turns[turns.length - 1];
            const isAssistant = !!(
                latestTurn.querySelector('[data-message-author-role="assistant"]') ||
                latestTurn.getAttribute('data-message-author-role') === 'assistant' ||
                (
                    !latestTurn.querySelector('[data-message-author-role="user"]') &&
                    latestTurn.getAttribute('data-message-author-role') !== 'user' &&
                    (latestTurn.querySelector(this.compatibilitySignals.assistantContentSelectors.join(',')) || turns.length >= 2)
                )
            );

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
            const alertText = alertMatches
                .map(match => match.element.innerText || match.element.textContent || '')
                .join(' ')
                .toLowerCase()
                .replace(/\s+/g, ' ')
                .trim();

            const hasDeliveryTimeout = this.compatibilitySignals.deliveryTimeoutMarkers.some(marker => nativeContains(alertText, marker));
            const hasGeneralError = this.compatibilitySignals.errorMarkers.some(marker => nativeContains(alertText, marker));
            const hasErrorStop = hasAssistantErrorStop(latestTurn, this._nativeSelectorEngine);
            const errorSignal = this.getAssistantTurnErrorSignal(text);
            const hasError = hasDeliveryTimeout || hasGeneralError || hasErrorStop || !!errorSignal;

            const retryBtn = this.getRetryButton(latestTurn);
            const hasRetry = !!retryBtn;

            return {
                isAssistant: true,
                text,
                hasError,
                hasErrorStop,
                hasDeliveryTimeout,
                hasRetry,
                errorSignal,
                hasCompletedText: isAssistant && !hasError && !hasRetry && text.length > 0
            };
        }

        getMainRoot(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getSelectorMatch(doc, 'mainRoot').element || null;
        }

        getMessageNodes(doc = (typeof document !== 'undefined' ? document : null), mainRoot = null) {
            return this.getMessageDiscovery(doc, mainRoot).nodes;
        }

        normalizeMessageNode(node, mainRoot) {
            if (!node || !mainRoot.contains(node)) return null;
            if (node.closest('#cpo-root')) return null;
            if (node.classList && node.classList.contains('cpo-more-banner')) return null;

            const turn = (this.compatibilitySignals.turnContext || [])
                .map(selector => node.closest?.(selector))
                .find(candidate => candidate && mainRoot.contains(candidate));

            if (turn && mainRoot.contains(turn)) {
                return turn;
            }

            return node;
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

    class GeminiAdapter extends ProviderAdapter {
        constructor() {
            super('gemini', 'Gemini', {
                supportsOptimizer: false,
                selectors: GEMINI_SELECTORS
            });
        }

        isSupportedUrl(url) {
            if (typeof url !== 'string') {
                return false;
            }

            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'https:') return false;
                const native = globalThis.CpoQueueEngine?.providerHost(parsed.hostname.toLowerCase());
                return native === PROVIDER_CODES.gemini;
            } catch {
                return false;
            }
        }

        getConversationIdentity(locationOrUrl) {
            const urlStr = typeof locationOrUrl === 'string'
                ? locationOrUrl
                : (locationOrUrl?.href || String(locationOrUrl || ''));

            if (!this.isSupportedUrl(urlStr)) {
                return {
                    provider: this.id,
                    type: 'unsupported',
                    conversationId: null,
                    key: `${this.id}:unsupported`
                };
            }

            try {
                const parsed = new URL(urlStr);
                const pathname = parsed.pathname || '/';

                const native = nativeRoute(this.id, pathname);
                if (native) return { provider: this.id, ...native,
                    key: native.key };

                return {provider:this.id,type:'unsupported',conversationId:null,key:this.id+':unsupported'};
            } catch {
                return {
                    provider: this.id,
                    type: 'unsupported',
                    conversationId: null,
                    key: `${this.id}:unsupported`
                };
            }
        }

        getComposerFromEventTarget(target, excludeSelector = '#cpo-root') {
            const element = target && target.nodeType === 1
                ? target
                : target?.parentElement;

            if (!element) return null;
            if (excludeSelector && element.closest(excludeSelector)) return null;

            const composerSelector = this.selectors.composer.join(',');
            const composer = element.closest(composerSelector);

            if (!composer) return null;

            const flags=Number((composer.tagName||'').toLowerCase()==='textarea') |
                (Number(composer.getAttribute('contenteditable')==='true')<<1) |
                (Number(!!composer.classList?.contains?.('ql-editor'))<<3) |
                (Number(false)<<4) |
                (Number(!!composer.closest('model-response, .model-response, .response-container, message-content'))<<5);
            const native=providerPredicate(this.id,2,flags);
            if(requireNative(native)!==1)return null;

            return composer;
        }

        getComposerText(composer) {
            return requireNative(this._nativeSelectorEngine?.composerRead(2,composer));
        }

        clearComposer(composer) {
            if(this._nativeSelectorEngine?.composerWrite(2,composer,'',0)!==true)throw new Error('Native composer clear unavailable.');
        }
        getGenerationState(doc = (typeof document !== 'undefined' ? document : null)) {
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
                    hasTryAgainButton: false,
                    errorSnippet: '',
                    matchedError: '',
                    url: '',
                    title: ''
                };
            }

            const buttons = Array.from(doc.querySelectorAll('button') || []);
            const stopButton = buttons.find(button => {
                if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
                    return false;
                }
                const testId = (
                    button.getAttribute('data-testid') ||
                    button.getAttribute('data-test-id') ||
                    ''
                ).toLowerCase();
                if (nativeContains(testId, 'stop')) {
                    return true;
                }
                const label = (
                    button.getAttribute('aria-label') ||
                    button.innerText ||
                    button.textContent ||
                    ''
                ).toLowerCase().trim();
                const className = typeof button.className === 'string'
                    ? button.className.toLowerCase()
                    : '';

                return (
                    label === 'stop' ||
                    label === 'stop response' ||
                    nativeContains(label, 'stop response') ||
                    nativeContains(label, 'stop generating') ||
                    nativeContains(label, 'stop streaming') ||
                    nativeContains(className, 'stop-button')
                );
            });
            const hasActiveStopButton = !!stopButton;

            const streamingSelector = this.selectors.streaming.join(',');
            let hasResultStreaming = false;
            try {
                hasResultStreaming = !!doc.querySelector(streamingSelector);
            } catch {
                hasResultStreaming = false;
            }

            const statusSelector = this.selectors.status.join(',');
            let statusNodes = [];
            try {
                statusNodes = Array.from(doc.querySelectorAll(statusSelector))
                    .filter(node => node.getAttribute?.('aria-live') !== 'off');
            } catch {
                statusNodes = [];
            }

            const visibleActiveNodes = statusNodes.filter(node => !node.hidden && node.getAttribute?.('aria-hidden') !== 'true');
            const statusText = visibleActiveNodes
                .map(node => node.innerText || node.textContent || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 1200);
            const activeTextLower = statusText.toLowerCase();

            const progressMarkers = [
                'thinking',
                'working',
                'generating',
                'searching',
                'researching',
                'loading'
            ];
            const matchedResearchMarker = progressMarkers.find(marker => nativeContains(activeTextLower, marker)) || '';
            const hasActiveToolOrResearch = !!matchedResearchMarker;

            const alertSelector = this.selectors.errorAlerts.join(',');
            let alertNodes = [];
            try {
                alertNodes = Array.from(doc.querySelectorAll(alertSelector));
            } catch {
                alertNodes = [];
            }
            const alertText = alertNodes.map(node => node.innerText || node.textContent || '').join(' ').toLowerCase();
            const errorMarkers = [
                'something went wrong',
                'there was an error',
                'failed to generate',
                'try again later',
                'unable to'
            ];
            const matchedError = errorMarkers.find(marker => nativeContains(alertText, marker)) || '';
            const errorSnippet = matchedError
                ? alertText
                    .slice(Math.max(0, alertText.indexOf(matchedError) - 60), alertText.indexOf(matchedError) + 160)
                    .replace(/\s+/g, ' ')
                    .trim()
                : '';

            const hasTryAgainButton = buttons.some(btn => {
                if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
                const text = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase().trim();
                return text === 'retry' || text === 'try again';
            });

            const hasKnownError = !!matchedError;
            const isWorking = hasActiveStopButton || hasResultStreaming || hasActiveToolOrResearch;
            const generating = requireNative(nativeGeneration(hasActiveStopButton,hasResultStreaming,hasActiveToolOrResearch,hasKnownError,hasTryAgainButton)).generating;

            const url = typeof location !== 'undefined' ? location.href : (doc.defaultView?.location?.href || '');
            const title = typeof document !== 'undefined' ? document.title : (doc.title || '');

            return {
                generating,
                hasActiveStopButton,
                hasResultStreaming,
                hasActiveToolOrResearch,
                deepResearchActive: false,
                matchedResearchMarker,
                researchStatusPreview: statusText,
                hasError: hasKnownError,
                hasTryAgainButton: !!hasTryAgainButton,
                errorSnippet,
                matchedError,
                url,
                title
            };
        }

        getMainRoot() {
            // Optimizer is unsupported on Gemini; fail closed.
            return null;
        }

        getMessageNodes() {
            return [];
        }

        getFallbackMessages() {
            return [];
        }
    }

    const CLAUDE_SELECTORS = catalogView(3);

    class ClaudeAdapter extends ProviderAdapter {
        constructor() {
            super('claude', 'Claude', {
                supportsOptimizer: false,
                selectors: CLAUDE_SELECTORS
            });
        }

        isSupportedUrl(url) {
            if (typeof url !== 'string') {
                return false;
            }

            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'https:') return false;
                const native = globalThis.CpoQueueEngine?.providerHost(parsed.hostname.toLowerCase());
                return native === PROVIDER_CODES.claude;
            } catch {
                return false;
            }
        }

        getConversationIdentity(locationOrUrl) {
            const urlStr = typeof locationOrUrl === 'string'
                ? locationOrUrl
                : (locationOrUrl?.href || String(locationOrUrl || ''));

            if (!this.isSupportedUrl(urlStr)) {
                return {
                    provider: this.id,
                    type: 'unsupported',
                    conversationId: null,
                    key: `${this.id}:unsupported`
                };
            }

            try {
                const parsed = new URL(urlStr);
                const pathname = parsed.pathname || '/';

                const native = nativeRoute(this.id, pathname);
                if (native) return { provider: this.id, ...native,
                    key: native.key };

                return {provider:this.id,type:'unsupported',conversationId:null,key:this.id+':unsupported'};
            } catch {
                return {
                    provider: this.id,
                    type: 'unsupported',
                    conversationId: null,
                    key: `${this.id}:unsupported`
                };
            }
        }

        getComposerFromEventTarget(target, excludeSelector = '#cpo-root') {
            const element = target && target.nodeType === 1
                ? target
                : target?.parentElement;

            if (!element) return null;
            if (excludeSelector && element.closest(excludeSelector)) return null;

            const composerSelector = this.selectors.composer.join(',');
            const composer = element.closest(composerSelector);

            if (!composer) return null;

            const flags=Number((composer.tagName||'').toLowerCase()==='textarea') |
                (Number(composer.getAttribute('contenteditable')==='true')<<1) |
                (Number(!!composer.classList?.contains?.('ProseMirror'))<<3) |
                (Number(composer.getAttribute('data-testid') === 'chat-input')<<4) |
                (Number(!!composer.closest('[data-testid="user-message"], .font-claude-response, .font-user-message'))<<5);
            const native=providerPredicate(this.id,2,flags);
            undefined

            return composer;
        }

        getComposerText(composer) {
            return requireNative(this._nativeSelectorEngine?.composerRead(3,composer));
        }

        clearComposer(composer) {
            if(this._nativeSelectorEngine?.composerWrite(3,composer,'',0)!==true)throw new Error('Native composer clear unavailable.');
        }
        getGenerationState(doc = (typeof document !== 'undefined' ? document : null)) {
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
                    hasTryAgainButton: false,
                    errorSnippet: '',
                    matchedError: '',
                    url: '',
                    title: ''
                };
            }

            const buttons = Array.from(doc.querySelectorAll('button') || []);
            const stopButton = buttons.find(button => {
                if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
                    return false;
                }
                const testId = (
                    button.getAttribute('data-testid') ||
                    button.getAttribute('data-test-id') ||
                    ''
                ).toLowerCase();
                if (nativeContains(testId, 'stop')) {
                    return true;
                }
                const label = (
                    button.getAttribute('aria-label') ||
                    button.innerText ||
                    button.textContent ||
                    ''
                ).toLowerCase().trim();
                const className = typeof button.className === 'string'
                    ? button.className.toLowerCase()
                    : '';

                return (
                    label === 'stop' ||
                    label === 'stop response' ||
                    label === 'stop generating' ||
                    nativeContains(label, 'stop response') ||
                    nativeContains(label, 'stop generating') ||
                    nativeContains(label, 'stop streaming') ||
                    nativeContains(className, 'stop-button')
                );
            });
            const hasActiveStopButton = !!stopButton;

            const streamingSelector = this.selectors.streaming.join(',');
            let hasResultStreaming = false;
            try {
                hasResultStreaming = !!doc.querySelector(streamingSelector);
            } catch {
                hasResultStreaming = false;
            }

            const statusSelector = this.selectors.status.join(',');
            let statusNodes = [];
            try {
                statusNodes = Array.from(doc.querySelectorAll(statusSelector))
                    .filter(node => node.getAttribute?.('aria-live') !== 'off');
            } catch {
                statusNodes = [];
            }

            const visibleActiveNodes = statusNodes.filter(node => !node.hidden && node.getAttribute?.('aria-hidden') !== 'true');
            const statusText = visibleActiveNodes
                .map(node => node.innerText || node.textContent || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 1200);
            const activeTextLower = statusText.toLowerCase();

            const progressMarkers = [
                'thinking',
                'working',
                'generating',
                'searching',
                'researching',
                'loading'
            ];
            const matchedResearchMarker = progressMarkers.find(marker => nativeContains(activeTextLower, marker)) || '';
            const hasActiveToolOrResearch = !!matchedResearchMarker;

            const alertSelector = this.selectors.errorAlerts.join(',');
            let alertNodes = [];
            try {
                alertNodes = Array.from(doc.querySelectorAll(alertSelector));
            } catch {
                alertNodes = [];
            }
            const alertText = alertNodes.map(node => node.innerText || node.textContent || '').join(' ').toLowerCase();
            const errorMarkers = [
                'something went wrong',
                'there was an error',
                'failed to generate',
                'try again later',
                'unable to'
            ];
            const matchedError = errorMarkers.find(marker => nativeContains(alertText, marker)) || '';
            const errorSnippet = matchedError
                ? alertText
                    .slice(Math.max(0, alertText.indexOf(matchedError) - 60), alertText.indexOf(matchedError) + 160)
                    .replace(/\s+/g, ' ')
                    .trim()
                : '';

            const hasTryAgainButton = buttons.some(btn => {
                if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
                const text = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase().trim();
                return text === 'retry' || text === 'try again';
            });

            const hasKnownError = !!matchedError;
            const isWorking = hasActiveStopButton || hasResultStreaming || hasActiveToolOrResearch;
            const generating = requireNative(nativeGeneration(hasActiveStopButton,hasResultStreaming,hasActiveToolOrResearch,hasKnownError,hasTryAgainButton)).generating;

            const url = typeof location !== 'undefined' ? location.href : (doc.defaultView?.location?.href || '');
            const title = typeof document !== 'undefined' ? document.title : (doc.title || '');

            return {
                generating,
                hasActiveStopButton,
                hasResultStreaming,
                hasActiveToolOrResearch,
                deepResearchActive: false,
                matchedResearchMarker,
                researchStatusPreview: statusText,
                hasError: hasKnownError,
                hasTryAgainButton: !!hasTryAgainButton,
                errorSnippet,
                matchedError,
                url,
                title
            };
        }

        getMainRoot() {
            // Optimizer is unsupported on Claude; fail closed.
            return null;
        }

        getMessageNodes() {
            return [];
        }

        getFallbackMessages() {
            return [];
        }
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
        module.exports = ProviderAdapterRegistry;
    }
})();
