(() => {
    'use strict';

    const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
    const GEMINI_HOSTS = new Set(['gemini.google.com']);
    const CLAUDE_HOSTS = new Set(['claude.ai']);

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
            '.border-red-500',
            '.text-token-text-error',
            '[class*="error-message"]'
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
            const errorSearchText = `${alertText} ${latestTurnText}`.trim();

            const deliveryTimeoutMarkers = [
                'message delivery timed out',
                'delivery timed out',
                'message delivery timeout',
                'delivery timeout',
                'timed out. please try again'
            ];
            const matchedDeliveryTimeout = deliveryTimeoutMarkers.find(marker => errorSearchText.includes(marker)) || '';
            const hasDeliveryTimedOut = !!matchedDeliveryTimeout;

            const generalErrorMarkers = [
                'something went wrong',
                'there was an error',
                'error generating a response',
                'network error',
                'failed to generate',
                'try again later'
            ];
            const matchedGeneralError = generalErrorMarkers.find(marker => errorSearchText.includes(marker)) || '';

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

            const retryBtn = this.getRetryButton(doc);
            const hasTryAgainButton = !!retryBtn;

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
                url,
                title
            };
        }

        getRetryButton(doc = (typeof document !== 'undefined' ? document : null)) {
            if (!doc) return null;

            const isRetryOrRegenerate = (btn) => {
                if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
                    return false;
                }
                const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
                if (testId === 'retry-button' || testId.includes('retry') || testId.includes('regenerate')) {
                    return true;
                }
                const label = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
                if (label === 'retry' || label === 'try again' || label === 'regenerate' || label === 'regenerate response' ||
                    label.includes('try again') || label.includes('regenerate') || label.includes('retry')) {
                    return true;
                }
                const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
                return text === 'retry' || text === 'try again' || text === 'regenerate' || text === 'regenerate response' ||
                    text.includes('try again') || text.includes('regenerate') || text.includes('retry');
            };

            const turns = Array.from(doc.querySelectorAll('[data-testid^="conversation-turn"], article'));
            const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;

            if (latestTurn) {
                const turnButtons = Array.from(latestTurn.querySelectorAll('button'));
                const foundInTurn = turnButtons.reverse().find(isRetryOrRegenerate);
                if (foundInTurn) return foundInTurn;
            }

            const alertSelector = this.selectors.errorAlerts.join(',');
            const alertNodes = Array.from(doc.querySelectorAll(alertSelector));
            for (const alertNode of alertNodes) {
                const alertButtons = Array.from(alertNode.querySelectorAll('button'));
                const foundInAlert = alertButtons.reverse().find(isRetryOrRegenerate);
                if (foundInAlert) return foundInAlert;
            }

            const allButtons = Array.from(doc.querySelectorAll('button'));
            return allButtons.reverse().find(isRetryOrRegenerate) || null;
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

            const turns = Array.from(doc.querySelectorAll('[data-testid^="conversation-turn"], article'));
            if (turns.length === 0) return null;

            const latestTurn = turns[turns.length - 1];
            const isAssistant = !!(
                latestTurn.querySelector('[data-message-author-role="assistant"]') ||
                latestTurn.getAttribute('data-message-author-role') === 'assistant' ||
                (
                    !latestTurn.querySelector('[data-message-author-role="user"]') &&
                    latestTurn.getAttribute('data-message-author-role') !== 'user' &&
                    (latestTurn.querySelector('.markdown, [data-testid*="copy"], [aria-label*="Copy"]') || turns.length >= 2)
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

            const deliveryTimeoutMarkers = [
                'message delivery timed out',
                'delivery timed out',
                'message delivery timeout',
                'delivery timeout',
                'timed out. please try again'
            ];
            const hasDeliveryTimeout = deliveryTimeoutMarkers.some(marker => textLower.includes(marker));

            const generalErrorMarkers = [
                'something went wrong',
                'there was an error',
                'error generating a response',
                'network error',
                'failed to generate',
                'try again later'
            ];
            const hasGeneralError = generalErrorMarkers.some(marker => textLower.includes(marker));
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
