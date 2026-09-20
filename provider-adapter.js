(() => {
    'use strict';

    const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
    const GEMINI_HOSTS = new Set(['gemini.google.com']);
    const CLAUDE_HOSTS = new Set(['claude.ai']);

    const CHATGPT_MESSAGE_CONTEXT_SELECTORS = [
        '[data-testid^="conversation-turn"]',
        '[data-testid*="conversation-turn"]',
        'article',
        '[data-message-author-role]',
        '[data-message-id]'
    ];

    const CHATGPT_COMPATIBILITY_SIGNALS = {
        composerContext: [
            '[data-testid*="composer"]',
            '[data-testid*="prompt"]',
            '[id*="prompt"]',
            '[role="textbox"]',
            'form'
        ],
        messageContext: CHATGPT_MESSAGE_CONTEXT_SELECTORS,
        turnContext: CHATGPT_MESSAGE_CONTEXT_SELECTORS.slice(0, 3),
        assistantContentSelectors: [
            '.markdown',
            '[data-testid*="copy"]',
            '[aria-label*="Copy"]'
        ],
        weakComposerSelectors: [
            'div[contenteditable="true"]',
            '[contenteditable="true"]'
        ],
        weakSendButtonSelectors: [
            'button[type="submit"]'
        ],
        stopLabels: [
            'stop generating',
            'stop streaming',
            'stop response',
            'interrupt',
            'stop'
        ],
        retryLabels: [
            'retry',
            'try again',
            'regenerate',
            'regenerate response'
        ],
        researchMarkers: [
            'deep research',
            'researching',
            'searching the web',
            'searching sources',
            'reading sources',
            'analyzing sources',
            'gathering sources',
            'checking sources',
            'synthesizing',
            'creating report',
            'writing report',
            'thinking',
            'working'
        ],
        deliveryTimeoutMarkers: [
            'message delivery timed out',
            'delivery timed out',
            'message delivery timeout',
            'delivery timeout',
            'timed out. please try again'
        ],
        errorMarkers: [
            'something went wrong',
            'there was an error',
            'error generating a response',
            'network error',
            'failed to generate',
            'try again later'
        ]
    };

    const CHATGPT_SELECTORS = {
        composer: [
            '#prompt-textarea',
            '[data-testid="prompt-textarea"]',
            'textarea',
            '[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]',
            '[contenteditable="true"]'
        ],
        sendButton: [
            'button[data-testid="send-button"]',
            'button[data-testid="fruitjuice-send-button"]',
            'button[aria-label="Send prompt"]',
            'button[aria-label="Send message"]',
            'button[type="submit"]'
        ],
        stopButton: [
            'button[data-testid="stop-button"]',
            'button[data-testid*="stop"]',
            'button[aria-label*="stop"]',
            'button[aria-label*="Stop"]'
        ],
        streaming: [
            '.result-streaming',
            '[data-testid*="conversation-turn"] .result-streaming',
            '[data-message-streaming="true"]',
            '[data-is-streaming="true"]',
            '[data-testid*="streaming"]'
        ],
        status: [
            '[role="status"]',
            '[aria-live]',
            '[data-testid*="status"]',
            '[data-testid*="progress"]',
            '[data-testid*="research"]',
            '[data-testid*="thinking"]',
            '[data-testid*="reasoning"]',
            '[data-testid*="thought"]',
            '[data-testid*="tool-progress"]',
            '.result-thinking'
        ],
        spinner: [
            'svg.animate-spin',
            '[class*="animate-spin"]',
            '[data-testid*="loading-spinner"]'
        ],
        errorAlerts: [
            '[role="alert"]',
            '[data-testid*="error"]',
            '.text-red-500',
            '.border-red-500',
            '.text-token-text-error',
            '[class*="error-message"]'
        ],
        messages: [
            ...CHATGPT_MESSAGE_CONTEXT_SELECTORS,
            '[data-testid="conversation-turn"]'
        ],
        fallbackMessages: [
            'main article',
            'main [data-message-author-role]',
            'main [data-message-id]',
            'main div[class*="group"]',
            '[role="main"] article',
            '[role="main"] [data-message-author-role]',
            '[role="main"] div[class*="group"]'
        ],
        mainRoot: [
            'main',
            '[role="main"]',
            '#__next',
            'body'
        ]
    };

    function cloneCompatibilityValue(value) {
        if (Array.isArray(value)) {
            return value.map(cloneCompatibilityValue);
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneCompatibilityValue(child)]));
        }
        return value;
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
                this.selectors = idOrOptions.selectors || {};
            } else {
                this.id = idOrOptions;
                this.name = maybeName;
                this.supportsOptimizer = !!options.supportsOptimizer;
                this.selectors = options.selectors || {};
            }
        }

        getCompatibilityContract() {
            return {
                provider: this.id,
                version: 1,
                selectors: cloneCompatibilityValue(this.selectors),
                signals: {}
            };
        }

        getSelectorNodes(root, selectorKey, predicate = null) {
            const selectors = Array.isArray(this.selectors?.[selectorKey])
                ? this.selectors[selectorKey]
                : [];
            const matches = [];
            const seen = new Set();

            if (!root || selectors.length === 0) return matches;

            for (const selector of selectors) {
                let nodes = [];
                try {
                    if (
                        (typeof root.matches === 'function' && root.matches(selector)) ||
                        (typeof root.closest === 'function' && root.closest(selector) === root)
                    ) {
                        nodes.push(root);
                    }
                    if (typeof root.querySelectorAll === 'function') {
                        nodes.push(...Array.from(root.querySelectorAll(selector)));
                    }
                } catch {
                    nodes = [];
                }

                for (const element of nodes) {
                    if (seen.has(element)) continue;
                    if (predicate && !predicate(element, selector)) continue;
                    seen.add(element);
                    matches.push({ element, selector, signalKey: selectorKey });
                }
            }

            return matches;
        }

        getSelectorMatch(root, selectorKey, predicate = null) {
            return this.getSelectorNodes(root, selectorKey, predicate)[0] || {
                element: null,
                selector: '',
                signalKey: selectorKey
            };
        }

        isComposerElement(element) {
            const tagName = (element?.tagName || '').toLowerCase();
            return tagName === 'textarea' || element?.getAttribute?.('contenteditable') === 'true';
        }

        getComposerMatch(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getSelectorMatch(doc, 'composer', (element, selector) => this.isComposerElement(element, {
                selector,
                source: 'document'
            }));
        }

        isSendActionElement(element) {
            const tagName = (element?.tagName || '').toLowerCase();
            return tagName === 'button' || typeof element?.click === 'function';
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

        getComposerFromEventTarget(target, excludeSelector = '#cpo-root') {
            return null;
        }

        getComposerText(composer) {
            return '';
        }

        clearComposer(composer) {
        }

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
                url: '',
                title: ''
            };
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
                selectors: CHATGPT_SELECTORS
            });
            this.compatibilitySignals = CHATGPT_COMPATIBILITY_SIGNALS;
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
            if (!super.isComposerElement(element)) return false;
            if (element.closest?.('#cpo-root')) return false;

            const messageContext = this.compatibilitySignals.messageContext.join(',');
            if (element.closest?.(messageContext)) return false;

            if (!this.compatibilitySignals.weakComposerSelectors.includes(selector)) {
                return true;
            }

            const composerContext = this.compatibilitySignals.composerContext.join(',');
            if (element.closest?.(composerContext)) return true;

            // Weak editable fallbacks are only valid inside a known composer context.
            // This keeps Enter and queued sends on the same canonical contract.
        }

        isSendActionElement(element, { selector = '' } = {}) {
            if (!super.isSendActionElement(element)) return false;
            if (!this.compatibilitySignals.weakSendButtonSelectors.includes(selector)) return true;

            const composerContext = this.compatibilitySignals.composerContext.join(',');
            return !!element.closest?.(composerContext);
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

            mainRoot = mainRoot || this.getMainRoot(doc);
            if (!mainRoot) {
                return {
                    nodes: [],
                    selector: null,
                    signalKey: 'messages',
                    fallback: false
                };
            }

            const collected = [];
            let matchedSelector = null;
            const combinedSelector = this.selectors.messages.join(',');

            try {
                const nodes = Array.from(doc.querySelectorAll(combinedSelector));
                for (const node of nodes) {
                    if (!mainRoot.contains(node)) continue;

                    const normalized = this.normalizeMessageNode(node, mainRoot);
                    if (normalized && this.isValidMessageNode(normalized, mainRoot)) {
                        collected.push(normalized);
                        matchedSelector = matchedSelector || this.findMatchingSelector(node, 'messages');
                    }
                }
            } catch (error) {
                console.warn('CPO: Combined selector failed', error);
            }

            let messages = this.sortMessagesByPosition(this.removeDuplicates(collected));
            if (messages.length > 0) {
                return {
                    nodes: messages,
                    selector: matchedSelector,
                    signalKey: 'messages',
                    fallback: false
                };
            }

            messages = this.getFallbackMessages(doc, mainRoot);
            return {
                nodes: messages,
                selector: messages.length > 0 ? 'fallbackMessages' : null,
                signalKey: 'fallbackMessages',
                fallback: true
            };
        }

        getConversationTurns(doc = (typeof document !== 'undefined' ? document : null)) {
            const selectors = this.compatibilitySignals.turnContext || [];
            const matches = [];
            const seen = new Set();

            for (const selector of selectors) {
                let nodes = [];
                try {
                    nodes = Array.from(doc?.querySelectorAll?.(selector) || []);
                } catch {
                    nodes = [];
                }
                for (const element of nodes) {
                    if (!seen.has(element)) {
                        seen.add(element);
                        matches.push(element);
                    }
                }
            }

            return matches;
        }

        findMatchingSelector(node, selectorKey) {
            const selectors = this.selectors?.[selectorKey] || [];
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
                    state: isEmptyConversation ? 'empty-conversation' : (discovery.nodes.length > 0 ? 'matched' : 'not-found')
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
                return parsed.protocol === 'https:' && CHATGPT_HOSTS.has(parsed.hostname.toLowerCase());
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

                // Match existing conversation /c/:id or /g/:gptId/c/:id
                const existingMatch = pathname.match(/(?:^|\/)c\/([a-zA-Z0-9_-]+)/);
                if (existingMatch && existingMatch[1]) {
                    const conversationId = existingMatch[1];
                    return {
                        provider: this.id,
                        type: 'existing',
                        conversationId,
                        key: `${this.id}:c:${conversationId}`
                    };
                }

                // Explicit non-conversation routes on ChatGPT
                const nonConversationRegex = /^\/(?:settings|admin|auth|login|logout|pricing|api|help|account|privacy|terms)(?:\/|$)/i;
                if (nonConversationRegex.test(pathname)) {
                    return {
                        provider: this.id,
                        type: 'unsupported',
                        conversationId: null,
                        key: `${this.id}:unsupported`
                    };
                }

                // Root / or custom GPT route /g/:gptId or /g/:gptId/ (without /c/)
                if (pathname === '/' || pathname === '' || /^\/g\/[a-zA-Z0-9_-]+\/?$/.test(pathname)) {
                    return {
                        provider: this.id,
                        type: 'new',
                        conversationId: null,
                        key: `${this.id}:new`
                    };
                }

                return {
                    provider: this.id,
                    type: 'unsupported',
                    conversationId: null,
                    key: `${this.id}:unsupported`
                };
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
            return this.getComposerMatchFromEventTarget(target, excludeSelector)?.element || null;
        }

        getComposerText(composer) {
            if (!composer) return '';

            if (composer.tagName && composer.tagName.toLowerCase() === 'textarea') {
                return composer.value || '';
            }

            return composer.innerText || composer.textContent || '';
        }

        clearComposer(composer) {
            if (!composer) return;

            if (typeof composer.focus === 'function') {
                composer.focus();
            }

            if (composer.tagName && composer.tagName.toLowerCase() === 'textarea') {
                composer.value = '';
            } else {
                composer.textContent = '';
            }

            if (typeof InputEvent !== 'undefined') {
                composer.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'deleteContentBackward',
                    data: null
                }));
            }
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

            const buttons = Array.from(doc.querySelectorAll('button'));
            const stopSelectorMatch = this.getSelectorMatch(doc, 'stopButton', (button) => {
                return !button.disabled && button.getAttribute('aria-disabled') !== 'true';
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
                    label === marker || label.includes(marker) || testId.includes(marker.replace(/ /g, '-'))
                );
            });
            const stopButton = stopSelectorMatch.element || semanticStopButton;
            const hasActiveStopButton = !!stopButton;

            const streamingMatch = this.getSelectorMatch(doc, 'streaming');
            const resultStreaming = streamingMatch.element;
            const hasResultStreaming = !!resultStreaming;

            const statusMatches = this.getSelectorNodes(doc, 'status', (node) => node.getAttribute('aria-live') !== 'off');
            const statusNodes = statusMatches.map(match => match.element);

            const turns = this.getConversationTurns(doc);
            const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;

            const latestTurnActiveMatch = latestTurn
                ? this.getSelectorNodes(latestTurn, 'status', (node) => node.getAttribute('aria-live') !== 'off')[0] ||
                    this.getSelectorNodes(latestTurn, 'spinner')[0]
                : null;
            const latestTurnActiveElement = latestTurnActiveMatch?.element || null;

            const activeNodes = [...statusNodes];
            if (latestTurnActiveElement && !activeNodes.includes(latestTurnActiveElement)) {
                activeNodes.push(latestTurnActiveElement);
            }

            const visibleActiveNodes = activeNodes.filter(node => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
            const spinnerNodes = this.getSelectorNodes(doc, 'spinner', (node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
            const latestTurnSpinner = latestTurn
                ? this.getSelectorNodes(latestTurn, 'spinner', (node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true')
                : [];
            const hasActiveSpinner = spinnerNodes.length > 0 || latestTurnSpinner.length > 0;

            const statusText = visibleActiveNodes
                .map(node => node.innerText || node.textContent || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 1200);
            const activeTextLower = statusText.toLowerCase();

            const matchedResearchMarker = this.compatibilitySignals.researchMarkers.find(marker => activeTextLower.includes(marker)) || '';
            const hasActiveToolOrResearch = !!matchedResearchMarker || hasActiveSpinner;
            const isDeepResearch = matchedResearchMarker === 'deep research' ||
                activeTextLower.includes('deep research') ||
                activeTextLower.includes('researching');

            const alertMatches = this.getSelectorNodes(doc, 'errorAlerts');
            const alertNodes = alertMatches.map(match => match.element);
            const alertText = alertNodes.map(node => node.innerText || node.textContent || '').join(' ').toLowerCase();
            const latestTurnText = latestTurn ? (latestTurn.innerText || latestTurn.textContent || '').toLowerCase() : '';
            const errorSearchText = `${alertText} ${latestTurnText}`.trim();

            const matchedDeliveryTimeout = this.compatibilitySignals.deliveryTimeoutMarkers.find(marker => errorSearchText.includes(marker)) || '';
            const hasDeliveryTimedOut = !!matchedDeliveryTimeout;

            const matchedGeneralError = this.compatibilitySignals.errorMarkers.find(marker => errorSearchText.includes(marker)) || '';

            const matchedError = matchedDeliveryTimeout
                ? 'Message delivery timed out. Please try again.'
                : matchedGeneralError;

            const errorSnippetTarget = matchedDeliveryTimeout || matchedGeneralError;
            const errorSnippet = errorSnippetTarget
                ? errorSearchText
                    .slice(Math.max(0, errorSearchText.indexOf(errorSnippetTarget) - 60), errorSearchText.indexOf(errorSnippetTarget) + 160)
                    .replace(/\s+/g, ' ')
                    .trim()
                : '';

            const retryMatch = this.getRetryButtonMatch(doc);
            const hasTryAgainButton = !!retryMatch.element;

            const hasKnownError = !!matchedError || hasDeliveryTimedOut;
            const isWorking = hasActiveStopButton || hasResultStreaming || hasActiveToolOrResearch;
            const generating = !hasKnownError && isWorking;
            const deepResearchActive = !hasKnownError && isWorking && isDeepResearch;

            const url = typeof location !== 'undefined' ? location.href : (doc.defaultView?.location?.href || '');
            const title = typeof document !== 'undefined' ? document.title : (doc.title || '');

            return {
                generating,
                hasActiveStopButton,
                hasResultStreaming,
                hasActiveToolOrResearch,
                deepResearchActive,
                matchedResearchMarker,
                researchStatusPreview: statusText,
                hasError: hasKnownError,
                hasDeliveryTimedOut,
                hasTryAgainButton,
                errorSnippet,
                matchedError,
                matchedSignals: {
                    stopButton: stopSelectorMatch.selector || (semanticStopButton ? 'stopButton.semantic' : null),
                    streaming: streamingMatch.selector || null,
                    status: statusMatches[0]?.selector || null,
                    spinner: spinnerNodes[0]?.selector || latestTurnSpinner[0]?.selector || null,
                    research: matchedResearchMarker ? `researchMarkers:${matchedResearchMarker}` : null,
                    error: alertMatches[0]?.selector || null,
                    retry: retryMatch.signalKey || null
                },
                url,
                title
            };
        }

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
                    label === marker || label.includes(marker) || text === marker || text.includes(marker)
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
            const fallback = allButtons.reverse().find(isRetryOrRegenerate);
            return fallback
                ? { element: fallback, selector: 'retryButton.semantic', signalKey: 'retryButton' }
                : empty;
        }

        getRetryButton(doc = (typeof document !== 'undefined' ? document : null)) {
            return this.getRetryButtonMatch(doc).element;
        }

        clickRetryButton(doc = (typeof document !== 'undefined' ? document : null)) {
            const btn = this.getRetryButton(doc);
            if (!btn) return false;
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
            const textLower = text.toLowerCase();

            const hasDeliveryTimeout = this.compatibilitySignals.deliveryTimeoutMarkers.some(marker => textLower.includes(marker));
            const hasGeneralError = this.compatibilitySignals.errorMarkers.some(marker => textLower.includes(marker));
            const hasError = hasDeliveryTimeout || hasGeneralError;

            const retryBtn = this.getRetryButton(latestTurn);
            const hasRetry = !!retryBtn;

            return {
                isAssistant: true,
                text,
                hasError,
                hasDeliveryTimeout,
                hasRetry,
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
            if (node.closest('#cpo-root')) return false;
            if (node.classList && node.classList.contains('cpo-more-banner')) return false;

            const tag = (node.tagName || '').toLowerCase();
            if (['script', 'style', 'nav', 'aside', 'header', 'footer'].includes(tag)) {
                return false;
            }

            const composerOrFormSelector = `${this.selectors.composer.join(',')}, form`;
            if (node.querySelector(composerOrFormSelector)) {
                const text = (node.textContent || '').trim();
                if (text.length < 80) return false;
            }

            const text = (node.textContent || '').trim();
            if (text.length < 1) return false;

            const hasMessageMarker =
                (typeof node.matches === 'function' && (this.compatibilitySignals.messageContext || [])
                    .some(selector => node.matches(selector))) ||
                !!node.querySelector((this.compatibilitySignals.messageContext || []).join(','));

            if (!hasMessageMarker) return false;

            return true;
        }

        getFallbackMessages(doc, mainRoot) {
            const fallbackSelector = this.selectors.fallbackMessages.join(', ');
            const collected = [];

            try {
                const nodes = Array.from(doc.querySelectorAll(fallbackSelector));
                for (const node of nodes) {
                    if (!mainRoot.contains(node)) continue;
                    if (node.closest('#cpo-root')) continue;
                    if (node.id && node.id.includes('thread-bottom')) continue;
                    if (node.querySelector(`${this.selectors.composer.join(',')}, input, form`)) continue;

                    const text = (node.textContent || '').trim();
                    if (text.length < 15) continue;

                    const normalized = this.normalizeMessageNode(node, mainRoot);
                    if (normalized && this.isValidFallbackNode(normalized, mainRoot)) {
                        collected.push(normalized);
                    }
                }
            } catch (e) {
                console.warn('CPO: Fallback querySelectorAll failed', e);
            }

            return this.sortMessagesByPosition(this.removeDuplicates(collected));
        }

        isValidFallbackNode(node, mainRoot) {
            if (!node || !mainRoot.contains(node)) return false;
            if (node.closest('#cpo-root')) return false;
            if (node.classList && node.classList.contains('cpo-more-banner')) return false;

            const text = (node.textContent || '').trim();
            if (text.length < 15) return false;

            if (node.querySelector(`${this.selectors.composer.join(',')}, input, form`)) return false;

            const hasContent =
                node.querySelector('p, pre, code, ul, ol, h1, h2, h3, h4, h5, h6, [data-message-author-role]') ||
                (typeof node.matches === 'function' && (this.compatibilitySignals.messageContext || [])
                    .some(selector => node.matches(selector)));

            return !!hasContent;
        }

        sortMessagesByPosition(messages) {
            return messages
                .toSorted((a, b) => {
                    if (a === b) return 0;

                    const position = a.compareDocumentPosition(b);
                    if (position & 4) { // Node.DOCUMENT_POSITION_FOLLOWING = 4
                        return -1;
                    }
                    if (position & 2) { // Node.DOCUMENT_POSITION_PRECEDING = 2
                        return 1;
                    }
                    return 0;
                })
                .slice(0, 1200);
        }

        removeDuplicates(messages) {
            const unique = Array.from(new Set(messages));

            return unique.filter((msg) => {
                return !unique.some((otherMsg) => {
                    if (otherMsg === msg) return false;

                    const otherTextLength = (otherMsg.textContent || '').trim().length;
                    const msgTextLength = (msg.textContent || '').trim().length;

                    return (
                        otherMsg.contains(msg) &&
                        otherTextLength > msgTextLength * 1.25
                    );
                });
            });
        }
    }

    const GEMINI_SELECTORS = {
        composer: [
            '.ql-editor[contenteditable="true"]',
            'rich-textarea .ql-editor',
            '.ql-editor',
            '[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]'
        ],
        sendButton: [
            'button.send-button[aria-label="Send message"]',
            'button.send-button',
            'button[aria-label="Send message"]',
            'button[aria-label*="Send"]'
        ],
        stopButton: [
            'button[aria-label="Stop response"]',
            'button[aria-label*="Stop"]',
            'button.stop-button',
            'button[data-test-id*="stop"]'
        ],
        streaming: [
            '[class*="response-streaming"]',
            '[data-is-streaming="true"]',
            '.model-response-text[aria-busy="true"]'
        ],
        status: [
            '[role="status"]',
            '[aria-live]',
            '[class*="thinking"]',
            '[class*="loading"]',
            '[data-test-id*="loading"]',
            '[data-test-id*="progress"]'
        ],
        spinner: [
            '[class*="loading"]',
            '[class*="spinner"]',
            'mat-progress-spinner',
            'circular-progress'
        ],
        errorAlerts: [
            '[role="alert"]',
            '[matsnackbarlabel]',
            '.mat-mdc-snack-bar-label',
            '.mdc-snackbar__label',
            '[class*="error"]'
        ],
        messages: [],
        fallbackMessages: [],
        mainRoot: [
            'main',
            '[role="main"]',
            'chat-window',
            'body'
        ]
    };

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
                return parsed.protocol === 'https:' && GEMINI_HOSTS.has(parsed.hostname.toLowerCase());
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

                // /app/:id or /u/:n/app/:id
                const existingMatch = pathname.match(/(?:^|\/)(?:u\/\d+\/)?app\/([a-zA-Z0-9_-]+)\/?$/);
                if (existingMatch && existingMatch[1] && existingMatch[1].toLowerCase() !== 'app') {
                    const conversationId = existingMatch[1];
                    return {
                        provider: this.id,
                        type: 'existing',
                        conversationId,
                        key: `${this.id}:c:${conversationId}`
                    };
                }

                // New chat: /, /app, /u/:n/app
                if (
                    pathname === '/' ||
                    pathname === '' ||
                    /^\/(?:u\/\d+\/)?app\/?$/.test(pathname)
                ) {
                    return {
                        provider: this.id,
                        type: 'new',
                        conversationId: null,
                        key: `${this.id}:new`
                    };
                }

                return {
                    provider: this.id,
                    type: 'unsupported',
                    conversationId: null,
                    key: `${this.id}:unsupported`
                };
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

            const tagName = (composer.tagName || '').toLowerCase();
            const isTextArea = tagName === 'textarea';
            const isEditable = composer.getAttribute('contenteditable') === 'true' ||
                composer.classList?.contains?.('ql-editor');

            if (!isTextArea && !isEditable) return null;

            // Avoid treating response message editors as the composer
            if (composer.closest('model-response, .model-response, .response-container, message-content')) {
                return null;
            }

            return composer;
        }

        getComposerText(composer) {
            if (!composer) return '';

            if (composer.tagName && composer.tagName.toLowerCase() === 'textarea') {
                return composer.value || '';
            }

            return composer.innerText || composer.textContent || '';
        }

        clearComposer(composer) {
            if (!composer) return;

            if (typeof composer.focus === 'function') {
                composer.focus();
            }

            if (composer.tagName && composer.tagName.toLowerCase() === 'textarea') {
                composer.value = '';
            } else {
                composer.textContent = '';
                if (composer.classList) {
                    if (typeof composer.classList.add === 'function') {
                        composer.classList.add('ql-blank');
                    }
                }
            }

            if (typeof InputEvent !== 'undefined') {
                composer.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'deleteContentBackward',
                    data: null
                }));
            }
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
                if (testId.includes('stop')) {
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
                    label.includes('stop response') ||
                    label.includes('stop generating') ||
                    label.includes('stop streaming') ||
                    className.includes('stop-button')
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
            const matchedResearchMarker = progressMarkers.find(marker => activeTextLower.includes(marker)) || '';
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
            const matchedError = errorMarkers.find(marker => alertText.includes(marker)) || '';
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
            const generating = !hasKnownError && isWorking;

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

    const CLAUDE_SELECTORS = {
        composer: [
            '[data-testid="chat-input"]',
            'div.ProseMirror[contenteditable="true"]',
            'div.ProseMirror',
            '[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]',
            'fieldset textarea',
            'textarea'
        ],
        sendButton: [
            'button[aria-label="Send Message"]',
            'button[aria-label="Send message"]',
            'button[data-testid="send-button"]',
            'button[aria-label*="Send"]',
            'button[type="submit"]'
        ],
        stopButton: [
            'button[aria-label="Stop generating"]',
            'button[aria-label*="Stop"]',
            'button[aria-label*="stop"]',
            'button[data-testid*="stop"]'
        ],
        streaming: [
            '[data-is-streaming="true"]',
            '[data-is-streaming]',
            '.font-claude-response[data-is-streaming]'
        ],
        status: [
            '[role="status"]',
            '[aria-live]',
            '[class*="thinking"]',
            '[class*="loading"]',
            '[data-testid*="thinking"]',
            '[data-testid*="progress"]',
            '[data-testid*="status"]'
        ],
        spinner: [
            '[class*="loading"]',
            '[class*="spinner"]',
            '[class*="animate-spin"]',
            'svg.animate-spin'
        ],
        errorAlerts: [
            '[role="alert"]',
            '[data-testid*="error"]',
            '[class*="error"]'
        ],
        messages: [],
        fallbackMessages: [],
        mainRoot: [
            'main',
            '[role="main"]',
            'body'
        ]
    };

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
                return parsed.protocol === 'https:' && CLAUDE_HOSTS.has(parsed.hostname.toLowerCase());
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

                // Existing chat: /chat/:id
                const existingMatch = pathname.match(/^\/chat\/([a-zA-Z0-9_-]+)\/?$/);
                if (existingMatch && existingMatch[1]) {
                    const conversationId = existingMatch[1];
                    return {
                        provider: this.id,
                        type: 'existing',
                        conversationId,
                        key: `${this.id}:c:${conversationId}`
                    };
                }

                // New chat: /, /new, /chat
                if (
                    pathname === '/' ||
                    pathname === '' ||
                    pathname === '/new' ||
                    pathname === '/new/' ||
                    pathname === '/chat' ||
                    pathname === '/chat/'
                ) {
                    return {
                        provider: this.id,
                        type: 'new',
                        conversationId: null,
                        key: `${this.id}:new`
                    };
                }

                return {
                    provider: this.id,
                    type: 'unsupported',
                    conversationId: null,
                    key: `${this.id}:unsupported`
                };
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

            const tagName = (composer.tagName || '').toLowerCase();
            const isTextArea = tagName === 'textarea';
            const isEditable = composer.getAttribute('contenteditable') === 'true' ||
                composer.classList?.contains?.('ProseMirror') ||
                composer.getAttribute('data-testid') === 'chat-input';

            if (!isTextArea && !isEditable) return null;

            // Avoid treating response/message bodies as the composer
            if (composer.closest('[data-testid="user-message"], .font-claude-response, .font-user-message')) {
                return null;
            }

            return composer;
        }

        getComposerText(composer) {
            if (!composer) return '';

            if (composer.tagName && composer.tagName.toLowerCase() === 'textarea') {
                return composer.value || '';
            }

            return composer.innerText || composer.textContent || '';
        }

        clearComposer(composer) {
            if (!composer) return;

            if (typeof composer.focus === 'function') {
                composer.focus();
            }

            if (composer.tagName && composer.tagName.toLowerCase() === 'textarea') {
                composer.value = '';
            } else {
                composer.textContent = '';
            }

            if (typeof InputEvent !== 'undefined') {
                composer.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'deleteContentBackward',
                    data: null
                }));
            }
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
                if (testId.includes('stop')) {
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
                    label.includes('stop response') ||
                    label.includes('stop generating') ||
                    label.includes('stop streaming') ||
                    className.includes('stop-button')
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
            const matchedResearchMarker = progressMarkers.find(marker => activeTextLower.includes(marker)) || '';
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
            const matchedError = errorMarkers.find(marker => alertText.includes(marker)) || '';
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
            const generating = !hasKnownError && isWorking;

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
        for (const provider of Object.values(PROVIDERS)) {
            if (provider.isSupportedUrl(urlStr)) {
                return provider;
            }
        }
        return null;
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
        getConversationIdentity
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
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ProviderAdapterRegistry;
    }
})();
