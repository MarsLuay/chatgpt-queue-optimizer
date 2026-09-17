(() => {
    'use strict';

    const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

    const CHATGPT_SELECTORS = {
        composer: [
            'textarea',
            '#prompt-textarea',
            '[data-testid="prompt-textarea"]',
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
            '.border-red-500'
        ],
        messages: [
            '[data-testid^="conversation-turn"]',
            '[data-testid*="conversation-turn"]',
            'article[data-testid]',
            'article',
            '[data-message-author-role]',
            '[data-message-id]',
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
                hasTryAgainButton: false,
                errorSnippet: '',
                matchedError: '',
                url: '',
                title: ''
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
                selectors: CHATGPT_SELECTORS
            });
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
            const isEditable = composer.getAttribute('contenteditable') === 'true';

            if (!isTextArea && !isEditable) return null;

            if (composer.closest('[data-message-author-role], [data-message-id], [data-testid^="conversation-turn"]')) {
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

            const buttons = Array.from(doc.querySelectorAll('button'));
            const stopButton = buttons.find(button => {
                if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
                    return false;
                }
                const testId = (button.getAttribute('data-testid') || '').toLowerCase();
                if (testId === 'stop-button' || testId.includes('stop')) {
                    return true;
                }
                const label = (
                    button.getAttribute('aria-label') ||
                    button.innerText ||
                    button.textContent ||
                    ''
                ).toLowerCase().trim();

                return (
                    label === 'stop generating' ||
                    label === 'stop streaming' ||
                    label === 'stop response' ||
                    label.includes('stop generating') ||
                    label.includes('stop streaming') ||
                    label.includes('stop response') ||
                    label.includes('interrupt') ||
                    (label === 'stop' && (button.closest?.('form, [data-testid*="composer"], [data-testid*="action"]') || testId.includes('stop')))
                );
            });
            const hasActiveStopButton = !!stopButton;

            const streamingSelector = this.selectors.streaming.join(',');
            const resultStreaming = doc.querySelector(streamingSelector);
            const hasResultStreaming = !!resultStreaming;

            const statusSelector = this.selectors.status.join(',');
            const statusNodes = Array.from(doc.querySelectorAll(statusSelector))
                .filter(node => node.getAttribute('aria-live') !== 'off');

            const turns = Array.from(doc.querySelectorAll('[data-testid^="conversation-turn"], article'));
            const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;

            const latestTurnActiveElement = latestTurn
                ? latestTurn.querySelector(
                    '[role="status"], [aria-live], [data-testid*="status"], [data-testid*="progress"], [data-testid*="research"], [data-testid*="thinking"], [data-testid*="reasoning"], [data-testid*="thought"], [data-testid*="tool-progress"], .result-thinking, svg.animate-spin, [class*="animate-spin"], [data-testid*="loading-spinner"]'
                )
                : null;

            const activeNodes = [...statusNodes];
            if (latestTurnActiveElement && !activeNodes.includes(latestTurnActiveElement)) {
                activeNodes.push(latestTurnActiveElement);
            }

            const visibleActiveNodes = activeNodes.filter(node => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
            const hasActiveSpinner = visibleActiveNodes.some(node => node.querySelector?.('svg.animate-spin, [class*="animate-spin"]') || node.classList?.contains('animate-spin')) ||
                !!latestTurn?.querySelector?.('svg.animate-spin, [class*="animate-spin"], [data-testid*="loading-spinner"]');

            const statusText = visibleActiveNodes
                .map(node => node.innerText || node.textContent || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 1200);
            const activeTextLower = statusText.toLowerCase();

            const researchProgressMarkers = [
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
            ];

            const matchedResearchMarker = researchProgressMarkers.find(marker => activeTextLower.includes(marker)) || '';
            const hasActiveToolOrResearch = !!matchedResearchMarker || hasActiveSpinner;
            const isDeepResearch = matchedResearchMarker === 'deep research' ||
                activeTextLower.includes('deep research') ||
                activeTextLower.includes('researching');

            const alertSelector = this.selectors.errorAlerts.join(',');
            const alertNodes = Array.from(doc.querySelectorAll(alertSelector));
            const alertText = alertNodes.map(node => node.innerText || node.textContent || '').join(' ').toLowerCase();
            const latestTurnText = latestTurn ? (latestTurn.innerText || latestTurn.textContent || '').toLowerCase() : '';
            const errorSearchText = alertText || latestTurnText;

            const errorMarkers = [
                'something went wrong',
                'there was an error',
                'error generating a response',
                'network error',
                'failed to generate',
                'try again later'
            ];
            const matchedError = errorMarkers.find(marker => errorSearchText.includes(marker)) || '';
            const errorSnippet = matchedError
                ? errorSearchText
                    .slice(Math.max(0, errorSearchText.indexOf(matchedError) - 60), errorSearchText.indexOf(matchedError) + 160)
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
                hasTryAgainButton: !!hasTryAgainButton,
                errorSnippet,
                matchedError,
                url,
                title
            };
        }

        getMainRoot(doc = (typeof document !== 'undefined' ? document : null)) {
            if (!doc) return null;
            return (
                doc.querySelector('main') ||
                doc.querySelector('[role="main"]') ||
                doc.querySelector('#__next') ||
                doc.body
            );
        }

        getMessageNodes(doc = (typeof document !== 'undefined' ? document : null), mainRoot = null) {
            if (!doc) return [];
            mainRoot = mainRoot || this.getMainRoot(doc);
            if (!mainRoot) return [];

            const collected = [];
            const combinedSelector = this.selectors.messages.join(',');

            try {
                const nodes = Array.from(doc.querySelectorAll(combinedSelector));
                for (const node of nodes) {
                    if (!mainRoot.contains(node)) continue;

                    const normalized = this.normalizeMessageNode(node, mainRoot);
                    if (normalized && this.isValidMessageNode(normalized, mainRoot)) {
                        collected.push(normalized);
                    }
                }
            } catch (error) {
                console.warn('CPO: Combined selector failed', error);
            }

            let messages = this.sortMessagesByPosition(this.removeDuplicates(collected));
            if (messages.length > 0) {
                return messages;
            }

            messages = this.getFallbackMessages(doc, mainRoot);
            return messages;
        }

        normalizeMessageNode(node, mainRoot) {
            if (!node || !mainRoot.contains(node)) return null;
            if (node.closest('#cpo-root')) return null;
            if (node.classList && node.classList.contains('cpo-more-banner')) return null;

            const turn =
                node.closest('[data-testid^="conversation-turn"]') ||
                node.closest('[data-testid*="conversation-turn"]') ||
                node.closest('article') ||
                node.closest('[data-message-id]');

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

            if (node.querySelector('textarea, input[type="text"], input:not([type]), form')) {
                const text = (node.textContent || '').trim();
                if (text.length < 80) return false;
            }

            const text = (node.textContent || '').trim();
            if (text.length < 1) return false;

            const hasMessageMarker =
                (typeof node.matches === 'function' && (
                    node.matches('[data-testid^="conversation-turn"]') ||
                    node.matches('[data-testid*="conversation-turn"]') ||
                    node.matches('article') ||
                    node.matches('[data-message-id]')
                )) ||
                !!node.querySelector('[data-message-author-role], [data-message-id]');

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
                    if (node.querySelector('textarea, input[type="text"], form')) continue;

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

            if (node.querySelector('textarea, input, form')) return false;

            const hasContent =
                node.querySelector('p, pre, code, ul, ol, h1, h2, h3, h4, h5, h6, [data-message-author-role]') ||
                (typeof node.matches === 'function' && (
                    node.matches('article') ||
                    node.matches('[data-message-id]') ||
                    node.matches('[data-testid*="conversation-turn"]')
                ));

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

    const chatGPTAdapterInstance = new ChatGPTAdapter();

    const PROVIDERS = {
        chatgpt: chatGPTAdapterInstance
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
        CHATGPT_SELECTORS,
        PROVIDERS,
        getProvider,
        getProviderForUrl,
        getConversationIdentity
    };

    if (typeof globalThis !== 'undefined') {
        globalThis.ProviderAdapter = ProviderAdapter;
        globalThis.ChatGPTAdapter = ChatGPTAdapter;
        globalThis.CHATGPT_SELECTORS = CHATGPT_SELECTORS;
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
