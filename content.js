(() => {
  'use strict';

  class ChatGPTOptimizer {
    constructor() {
      this.config = {
        enabled: true,
        windowSize: 50,
        batchSize: 25,
        autoScroll: true
      };

      this.state = {
        container: null,
        moreBanner: null,
        hiddenCount: 0,
        visibleCount: 0,
        observer: null,
        mutationObserver: null,
        isInitialized: false,
        lastMessageCount: 0,
        _autoArmed: true,
        _autoWasIntersecting: false,
        _autoLoadInProgress: false,
        enterQueueListenerAttached: false,
        submissionObserverAttached: false,
        inlineQueueInFlight: false,
        lastQueuedAt: 0,
        lastQueuedText: '',
        enterDiagnostics: []
      };

      this._cachedMessages = null;
      this._cacheTimestamp = null;
      this._loggedSelector = null;
      this._isRefreshing = false;
      this._lastNoMessageLog = 0;
      this.refreshTimeout = null;

      this.provider = this.resolveProvider();

      this.init();
    }

    resolveProvider() {
      let registry = typeof globalThis !== 'undefined' ? globalThis.ProviderAdapterRegistry : null;
      if (!registry && typeof require === 'function') {
        try {
          registry = require('./provider-adapter.js');
        } catch {}
      }

      const currentUrl = typeof location !== 'undefined' ? location.href : (typeof window !== 'undefined' ? window.location?.href : '');
      if (typeof getProviderForUrl === 'function') {
        const found = getProviderForUrl(currentUrl);
        if (found) return found;
      }
      if (registry && typeof registry.getProviderForUrl === 'function') {
        const found = registry.getProviderForUrl(currentUrl);
        if (found) return found;
      }
      if (typeof getProvider === 'function') {
        return getProvider('chatgpt');
      }
      if (registry && typeof registry.getProvider === 'function') {
        return registry.getProvider('chatgpt');
      }
      if (typeof globalThis !== 'undefined' && globalThis.ProviderAdapters?.chatgpt) {
        return globalThis.ProviderAdapters.chatgpt;
      }
      return null;
    }

    async init() {
      this.setupComposerQueueShortcut();
      await this.loadConfig();

      if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.bootstrap());
      } else {
        this.bootstrap();
      }

      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          this.handleMessage(message, sender, sendResponse);
          return true;
        });
      }
    }

    async loadConfig() {
      try {
        const stored = await storageSyncGet(this.config);
        this.config = { ...this.config, ...stored };
      } catch (error) {
        console.warn('CPO: Could not load config, using defaults', error);
      }
    }

    async saveConfig() {
      try {
        await storageSyncSet(this.config);
      } catch (error) {
        console.warn('CPO: Could not save config', error);
      }
    }

    handleMessage(message, sender, sendResponse) {
      switch (message.type) {
        case 'TOGGLE_OPTIMIZER':
          this.toggle();
          sendResponse({ success: true, enabled: this.config.enabled });
          break;

        case 'UPDATE_CONFIG':
          this.config = { ...this.config, ...message.config };
          this.saveConfig();

          if (this.config.enabled) {
            this.refresh();
          }

          sendResponse({ success: true, enabled: this.config.enabled });
          break;

        case 'GET_STATUS': {
          const messages = this.getMessageNodes();

          sendResponse({
            enabled: this.config.enabled,
            messageCount: messages.length,
            hiddenCount: this.state.hiddenCount,
            visibleCount: this.state.visibleCount,
            debugInfo: {
              containerFound: !!this.state.container,
              bannerExists: !!this.state.moreBanner,
              initialized: this.state.isInitialized,
              selector: this._loggedSelector || 'none',
              enterDiagnostics: this.state.enterDiagnostics || []
            }
          });

          break;
        }

        case 'GET_CONVERSATION_IDENTITY': {
          const locationOrUrl = typeof window !== 'undefined' ? window.location : (typeof location !== 'undefined' ? location : '');
          const identity = this.provider && typeof this.provider.getConversationIdentity === 'function'
            ? this.provider.getConversationIdentity(locationOrUrl)
            : { provider: 'chatgpt', type: 'unknown', conversationId: null, key: 'chatgpt:unknown' };
          sendResponse({ ok: true, identity });
          break;
        }

        case 'CHECK_GENERATION_STATE': {
          const state = this.getGenerationState();
          sendResponse({ state });
          break;
        }

        case 'INSPECT_GENERATION_STATE': {
          const state = this.getGenerationState();
          const lastAssistant = this.provider && typeof this.provider.getLastAssistantTurn === 'function'
            ? this.provider.getLastAssistantTurn(document)
            : null;
          sendResponse({ ok: true, state, lastAssistant });
          break;
        }

        case 'CLICK_RETRY_BUTTON': {
          const clicked = this.provider && typeof this.provider.clickRetryButton === 'function'
            ? this.provider.clickRetryButton(document)
            : false;
          sendResponse({ ok: clicked });
          break;
        }

        case 'RELOAD_PAGE': {
          sendResponse({ ok: true });
          setTimeout(() => {
            try {
              if (typeof window !== 'undefined' && window.location) {
                window.location.reload();
              }
            } catch (err) {
              console.warn('CPO: Failed to reload page', err);
            }
          }, 50);
          break;
        }

        case 'GET_ENTER_DIAGNOSTICS': {
          sendResponse({
            diagnostics: this.state.enterDiagnostics || []
          });
          break;
        }

        case 'DEBUG_MESSAGES': {
          const debugMessages = this.getMessageNodes();

          if (this.config.debug) {
            console.log('CPO Debug: Found messages:', debugMessages.length);
            console.log('CPO Debug Selectors:');
            console.log('- [data-testid^="conversation-turn"]:', document.querySelectorAll('[data-testid^="conversation-turn"]').length);
            console.log('- [data-testid*="conversation-turn"]:', document.querySelectorAll('[data-testid*="conversation-turn"]').length);
            console.log('- article:', document.querySelectorAll('article').length);
            console.log('- [data-message-author-role]:', document.querySelectorAll('[data-message-author-role]').length);
            console.log('- [data-message-id]:', document.querySelectorAll('[data-message-id]').length);
            console.log('- main:', document.querySelectorAll('main').length);

            debugMessages.forEach((msg, i) => {
              if (i < 10) {
                console.log(`CPO Debug Message ${i + 1}:`, msg, 'Text preview:', msg.textContent.trim().substring(0, 160));
              }
            });
          }

          sendResponse({ count: debugMessages.length });
          break;
        }

        default:
          sendResponse({ error: 'Unknown message type' });
      }
    }

    bootstrap() {
      this.setupComposerQueueShortcut();

      this.waitForMessages().then(() => {
        this.setupContainer();
        this.setupObservers();

        if (this.config.enabled) {
          document.documentElement.classList.add('cpo-active');
          this.refresh();
        } else {
          document.documentElement.classList.remove('cpo-active');
        }

        this.state.isInitialized = true;
        console.log('CPO: Initialized successfully');
      });
    }

    setupComposerQueueShortcut() {
      if (this.state.enterQueueListenerAttached) return;

      const target = typeof window !== 'undefined' ? window : (typeof document !== 'undefined' ? document : null);
      if (!target) return;

      target.addEventListener('keydown', (event) => {
        this.handleComposerKeydown(event);
      }, true);

      this.setupNativeSubmissionObserver(target);

      this.state.enterQueueListenerAttached = true;
    }

    setupNativeSubmissionObserver(target) {
      if (this.state.submissionObserverAttached) return;

      const markSubmission = () => {
        const diags = this.state.enterDiagnostics;
        if (diags && diags.length > 0) {
          const lastDiag = diags[diags.length - 1];
          if (Date.now() - lastDiag.timestamp < 1000) {
            lastDiag.nativeSubmissionObserved = true;
          }
        }
      };

      target.addEventListener('submit', markSubmission, true);
      target.addEventListener('click', (event) => {
        const sendButtonSelectors = this.provider?.selectors?.sendButton
          ? this.provider.selectors.sendButton.join(', ')
          : 'button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]';
        const button = event.target?.closest?.(sendButtonSelectors);
        if (button) {
          markSubmission();
        }
      }, true);

      this.state.submissionObserverAttached = true;
    }

    recordEnterDiagnostic(diagnostic) {
      if (!this.state.enterDiagnostics) {
        this.state.enterDiagnostics = [];
      }
      this.state.enterDiagnostics.push(diagnostic);
      if (this.state.enterDiagnostics.length > 50) {
        this.state.enterDiagnostics.shift();
      }

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        try {
          chrome.runtime.sendMessage({
            action: 'logAutomationEvent',
            source: 'composer-enter',
            level: diagnostic.interception ? 'info' : 'debug',
            message: diagnostic.interception
              ? 'Composer Enter intercepted for queue'
              : 'Composer Enter not intercepted',
            details: { ...diagnostic }
          }, () => {
            if (chrome.runtime?.lastError) {}
          });
        } catch {
          // ignore error if sendMessage throws
        }
      }
    }

    handleComposerKeydown(event) {
      if (event.key !== 'Enter') {
        return;
      }

      if (
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }

      const composer = this.getComposerFromEventTarget(event.target);
      if (!composer) return;

      const text = this.getComposerText(composer).trim();
      if (!text) return;

      const genState = this.getGenerationState();
      const isGenerating = !!genState.generating;

      const eventPhase = event.eventPhase || 0;
      const defaultPrevented = !!event.defaultPrevented;
      const diagnostic = {
        timestamp: Date.now(),
        key: 'Enter',
        composerMatch: {
          matched: true,
          tagName: (composer.tagName || '').toLowerCase(),
          id: composer.id || '',
          testId: composer.getAttribute?.('data-testid') || '',
          isContentEditable: composer.getAttribute?.('contenteditable') === 'true'
        },
        eventPhase,
        defaultPrevented,
        modifiers: {
          shift: !!event.shiftKey,
          alt: !!event.altKey,
          ctrl: !!event.ctrlKey,
          meta: !!event.metaKey
        },
        isComposing: false,
        textLength: text.length,
        hasText: true,
        matchedGenerationSignals: {
          generating: isGenerating,
          hasActiveStopButton: !!genState.hasActiveStopButton,
          hasResultStreaming: !!genState.hasResultStreaming,
          hasActiveToolOrResearch: !!genState.hasActiveToolOrResearch,
          deepResearchActive: !!genState.deepResearchActive,
          matchedResearchMarker: genState.matchedResearchMarker || null,
          researchStatusPreview: genState.researchStatusPreview || null,
          hasError: !!genState.hasError,
          hasTryAgainButton: !!genState.hasTryAgainButton
        },
        interception: false,
        enqueueResult: 'none',
        nativeSubmissionObserved: false
      };

      if (!isGenerating) {
        this.recordEnterDiagnostic(diagnostic);
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }

      diagnostic.interception = true;

      const now = Date.now();

      if (this.state.inlineQueueInFlight) {
        diagnostic.enqueueResult = 'suppressed-inflight';
        this.recordEnterDiagnostic(diagnostic);
        return;
      }

      if (this.state.lastQueuedText === text && (now - this.state.lastQueuedAt < 1200)) {
        diagnostic.enqueueResult = 'suppressed-duplicate';
        this.recordEnterDiagnostic(diagnostic);
        return;
      }

      diagnostic.enqueueResult = 'pending';
      this.recordEnterDiagnostic(diagnostic);
      this.queueComposerMessage(text, composer, diagnostic);
    }

    getComposerFromEventTarget(target) {
      if (this.provider && typeof this.provider.getComposerFromEventTarget === 'function') {
        return this.provider.getComposerFromEventTarget(target, '#cpo-root');
      }

      const element = target && (target.nodeType === 1 || target.nodeType === (typeof Node !== 'undefined' ? Node.ELEMENT_NODE : 1))
        ? target
        : target?.parentElement;

      if (!element || element.closest('#cpo-root')) return null;

      const composer = element.closest(
        'textarea, #prompt-textarea, [data-testid="prompt-textarea"], div[contenteditable="true"], [contenteditable="true"]'
      );

      if (!composer) return null;

      const tagName = composer.tagName ? composer.tagName.toLowerCase() : '';
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

      if (this.provider && typeof this.provider.getComposerText === 'function') {
        return this.provider.getComposerText(composer);
      }

      if (composer.tagName && composer.tagName.toLowerCase() === 'textarea') {
        return composer.value || '';
      }

      return composer.innerText || composer.textContent || '';
    }

    clearComposer(composer) {
      if (!composer) return;

      if (this.provider && typeof this.provider.clearComposer === 'function') {
        this.provider.clearComposer(composer);
        return;
      }

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

    isChatGPTGenerating() {
      const state = this.getGenerationState();
      return state.generating;
    }

    getGenerationState() {
      if (this.provider && typeof this.provider.getGenerationState === 'function') {
        return this.provider.getGenerationState(document);
      }

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
        url: typeof location !== 'undefined' ? location.href : '',
        title: typeof document !== 'undefined' ? document.title : ''
      };
    }

    queueComposerMessage(text, composer, diagnostic = null) {
      this.state.inlineQueueInFlight = true;
      this.state.lastQueuedAt = Date.now();
      this.state.lastQueuedText = text;

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        try {
          const locationOrUrl = typeof window !== 'undefined' ? window.location : (typeof location !== 'undefined' ? location : '');
          const conversationIdentity = this.provider && typeof this.provider.getConversationIdentity === 'function'
            ? this.provider.getConversationIdentity(locationOrUrl)
            : null;

          chrome.runtime.sendMessage({
            action: 'enqueueMessage',
            message: text,
            source: 'composer-enter',
            position: 'end',
            waitForIdleBeforeStart: true,
            conversationIdentity
          }, (response) => {
            const error = chrome.runtime?.lastError;
            this.state.inlineQueueInFlight = false;

            if (error || !response || !response.ok) {
              const errMsg = error?.message || response?.error || 'Could not add message to queue.';
              if (diagnostic) {
                diagnostic.enqueueResult = `error: ${errMsg}`;
              }
              this.showInlineQueueToast(errMsg, 'error');
              return;
            }

            if (diagnostic) {
              diagnostic.enqueueResult = 'success';
            }
            this.clearComposer(composer);
            this.showInlineQueueToast('Queued to send after the current response.');
          });
        } catch (err) {
          this.state.inlineQueueInFlight = false;
          if (diagnostic) {
            diagnostic.enqueueResult = `error: ${err.message || 'runtime sendMessage failed'}`;
          }
          this.showInlineQueueToast(err.message || 'Could not add message to queue.', 'error');
        }
      } else {
        this.state.inlineQueueInFlight = false;
        if (diagnostic) {
          diagnostic.enqueueResult = 'error: chrome.runtime unavailable';
        }
      }
    }

    showInlineQueueToast(message, type = 'success') {
      const existing = document.querySelector('.cpo-inline-queue-toast');
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }

      const toast = document.createElement('div');
      toast.className = `cpo-inline-queue-toast cpo-inline-queue-toast-${type}`;
      toast.textContent = message;
      document.body.appendChild(toast);

      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          toast.classList.add('cpo-inline-queue-toast-visible');
        });
      } else {
        toast.classList.add('cpo-inline-queue-toast-visible');
      }

      setTimeout(() => {
        toast.classList.remove('cpo-inline-queue-toast-visible');
        setTimeout(() => {
          if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
          }
        }, 180);
      }, 2200);
    }

    async waitForMessages() {
      return new Promise((resolve) => {
        let attempts = 0;
        const isTestEnv = typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test';
        const maxAttempts = isTestEnv ? 1 : 120;

        const check = () => {
          const messages = this.getMessageNodes();

          if (messages.length > 0 || attempts >= maxAttempts) {
            resolve();
            return;
          }

          attempts++;
          setTimeout(check, isTestEnv ? 10 : 250);
        };

        check();
      });
    }

    getMainRoot() {
      if (this.provider && typeof this.provider.getMainRoot === 'function') {
        return this.provider.getMainRoot(document);
      }

      return (
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.querySelector('#__next') ||
        document.body
      );
    }

    getMessageNodes() {
      if (
        this._cachedMessages &&
        this._cacheTimestamp &&
        Date.now() - this._cacheTimestamp < 800
      ) {
        return this._cachedMessages;
      }

      const mainRoot = this.getMainRoot();
      let messages = [];

      if (this.provider && typeof this.provider.getMessageNodes === 'function') {
        messages = this.provider.getMessageNodes(document, mainRoot);
      } else {
        messages = this.getFallbackMessages(mainRoot);
      }

      if (messages && messages.length > 0) {
        if (!this._loggedSelector) {
          this._loggedSelector = 'provider-adapter-messages';
          console.log(`CPO: Found ${messages.length} messages using ${this.provider?.name || 'ChatGPT'} adapter`);
        }

        this._cachedMessages = messages;
        this._cacheTimestamp = Date.now();

        return messages;
      }

      const now = Date.now();
      if (now - this._lastNoMessageLog > 5000) {
        console.warn(`CPO: No ${this.provider?.name || 'ChatGPT'} messages found. Open a conversation with visible messages, then refresh the tab.`);
        this._lastNoMessageLog = now;
      }

      return [];
    }

    normalizeMessageNode(node, mainRoot) {
      if (this.provider && typeof this.provider.normalizeMessageNode === 'function') {
        return this.provider.normalizeMessageNode(node, mainRoot);
      }

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
      if (this.provider && typeof this.provider.isValidMessageNode === 'function') {
        return this.provider.isValidMessageNode(node, mainRoot);
      }

      if (!node || !mainRoot.contains(node)) return false;
      if (node.closest('#cpo-root')) return false;
      if (node.classList && node.classList.contains('cpo-more-banner')) return false;

      const tag = node.tagName ? node.tagName.toLowerCase() : '';

      if (['script', 'style', 'nav', 'aside', 'header', 'footer'].includes(tag)) {
        return false;
      }

      if (node.querySelector('textarea, input[type="text"], input:not([type]), form')) {
        const text = node.textContent.trim();
        if (text.length < 80) return false;
      }

      const text = node.textContent.trim();

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

    getFallbackMessages(mainRoot = this.getMainRoot()) {
      if (this.provider && typeof this.provider.getFallbackMessages === 'function') {
        return this.provider.getFallbackMessages(document, mainRoot);
      }

      return [];
    }

    isValidFallbackNode(node, mainRoot) {
      if (this.provider && typeof this.provider.isValidFallbackNode === 'function') {
        return this.provider.isValidFallbackNode(node, mainRoot);
      }

      if (!node || !mainRoot.contains(node)) return false;
      if (node.closest('#cpo-root')) return false;
      if (node.classList && node.classList.contains('cpo-more-banner')) return false;

      const text = node.textContent.trim();
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

          if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
            return -1;
          }

          if (position & Node.DOCUMENT_POSITION_PRECEDING) {
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

          const otherTextLength = otherMsg.textContent.trim().length;
          const msgTextLength = msg.textContent.trim().length;

          return (
            otherMsg.contains(msg) &&
            otherTextLength > msgTextLength * 1.25
          );
        });
      });
    }

    setupContainer() {
      const messages = this.getMessageNodes();

      if (messages.length === 0) {
        this.state.container = this.getMainRoot();
        return;
      }

      let container = messages[0].parentElement;
      let containsAll = messages.every((msg) => container && container.contains(msg));

      while (!containsAll && container && container.parentElement) {
        container = container.parentElement;
        containsAll = messages.every((msg) => container && container.contains(msg));

        if (container === document.body || container === document.documentElement) {
          break;
        }
      }

      if (!containsAll || !container) {
        const candidates = [
          this.getMainRoot(),
          document.querySelector('main'),
          document.querySelector('[role="main"]'),
          messages[0].closest('main'),
          messages[0].closest('[role="main"]'),
          messages[0].parentElement
        ].filter(Boolean);

        for (const candidate of candidates) {
          if (messages.every((msg) => candidate.contains(msg))) {
            container = candidate;
            break;
          }
        }
      }

      this.state.container = container || this.getMainRoot();

      console.log(
        'CPO: Selected container:',
        this.state.container?.tagName,
        'Messages:',
        messages.length
      );
    }

    setupObservers() {
      if (!this.state.container) {
        this.state.container = this.getMainRoot();
      }

      if (this.state.mutationObserver) {
        this.state.mutationObserver.disconnect();
      }

      if (this.state.observer) {
        this.state.observer.disconnect();
      }

      this.state.mutationObserver = new MutationObserver((mutations) => {
        this.handleMutations(mutations);
      });

      this.state.mutationObserver.observe(this.state.container, {
        childList: true,
        subtree: true,
        attributes: false
      });
    }

    handleMutations(mutations) {
      if (!this.config.enabled) return;

      let hasPotentialMessageChange = false;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          hasPotentialMessageChange = true;
          break;
        }
      }

      if (!hasPotentialMessageChange) return;

      this._cachedMessages = null;
      this._cacheTimestamp = null;

      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = setTimeout(() => {
        const currentMessageCount = this.getMessageNodes().length;

        if (currentMessageCount >= this.state.lastMessageCount || currentMessageCount > 0) {
          this.state.lastMessageCount = currentMessageCount;
          this.refresh();
        }
      }, 700);
    }

    createMoreBanner() {
      const banner = document.createElement('div');
      banner.className = 'cpo-more-banner';

      const bannerContent = document.createElement('div');
      bannerContent.className = 'cpo-banner-content';

      const bannerText = document.createElement('span');
      bannerText.className = 'cpo-banner-text';
      bannerText.textContent = 'Show older messages';

      const bannerButton = document.createElement('button');
      bannerButton.className = 'cpo-banner-button';
      bannerButton.type = 'button';
      bannerButton.textContent = 'Load More';

      bannerContent.appendChild(bannerText);
      bannerContent.appendChild(bannerButton);
      banner.appendChild(bannerContent);

      bannerButton.addEventListener('click', () => {
        this.showOlderMessages();
      });

      return banner;
    }

    updateBanner() {
      if (!this.state.moreBanner) return;

      const button = this.state.moreBanner.querySelector('.cpo-banner-button');
      const text = this.state.moreBanner.querySelector('.cpo-banner-text');

      if (this.state.hiddenCount > 0) {
        const toShow = Math.min(this.config.batchSize, this.state.hiddenCount);
        button.textContent = `Load ${toShow} More`;
        text.textContent = `${this.state.hiddenCount} older messages hidden`;
        this.state.moreBanner.style.display = 'block';
      } else {
        this.state.moreBanner.style.display = 'none';
      }
    }

    showOlderMessages() {
      const messages = this.getMessageNodes();

      if (this.state.observer) {
        this.state.observer.disconnect();
      }

      const currentVisible = this.state.visibleCount;
      const toShow = Math.min(this.config.batchSize, this.state.hiddenCount);

      this.state.visibleCount = Math.min(messages.length, currentVisible + toShow);
      this.applyWindowing(messages);
    }

    applyWindowing(messages = null) {
      if (!this.config.enabled) return;

      messages = messages || this.getMessageNodes();
      if (messages.length === 0) return;

      messages = this.sortMessagesByPosition(messages);

      const totalMessages = messages.length;

      const minimumRecentVisible = 8;
      const desiredVisible = Math.max(
        Number(this.config.windowSize || 50),
        minimumRecentVisible
      );

      const targetVisible = Math.min(totalMessages, desiredVisible);
      const startIndex = Math.max(0, totalMessages - targetVisible);

      this.state.hiddenCount = startIndex;
      this.state.visibleCount = targetVisible;

      messages.forEach((message, index) => {
        if (index < startIndex) {
          this.hideMessage(message);
        } else {
          this.showMessage(message);
        }
      });

      this.ensureBanner(messages);
      this.updateBanner();

      if (this.state.moreBanner && this.state.moreBanner.parentNode) {
        this.setupAutoScroll();
      }
    }

    hideMessage(message) {
      if (message.classList.contains('cpo-hidden')) return;

      message.classList.add('cpo-hidden');
      this.preventImageLoading(message);
    }

    showMessage(message) {
      if (!message.classList.contains('cpo-hidden')) {
        this.applyLazyLoading(message);
        return;
      }

      message.classList.remove('cpo-hidden');
      this.restoreImages(message);
      this.applyLazyLoading(message);
    }

    preventImageLoading(element) {
      const images = element.querySelectorAll('img[src]');

      images.forEach((img) => {
        if (!img.dataset.cpoOriginalSrc) {
          img.dataset.cpoOriginalSrc = img.src;
          img.removeAttribute('src');
          img.setAttribute('loading', 'lazy');
        }
      });
    }

    restoreImages(element) {
      const images = element.querySelectorAll('img[data-cpo-original-src]:not([src])');

      images.forEach((img) => {
        const originalSrc = img.dataset.cpoOriginalSrc;

        if (originalSrc) {
          img.src = originalSrc;
        }
      });
    }

    applyLazyLoading(element) {
      const images = element.querySelectorAll('img');

      images.forEach((img) => {
        if (!img.hasAttribute('loading')) {
          img.setAttribute('loading', 'lazy');
        }
      });
    }

    ensureBanner(messages) {
      if (!this.state.container || !messages.length) return;

      if (!this.state.moreBanner) {
        this.state.moreBanner = this.createMoreBanner();
      }

      const firstVisibleMessage = messages.find((m) => {
        return !m.classList.contains('cpo-hidden') && this.state.container.contains(m);
      });

      try {
        if (firstVisibleMessage) {
          this.state.container.insertBefore(this.state.moreBanner, firstVisibleMessage);
        } else if (!this.state.moreBanner.parentNode) {
          this.state.container.appendChild(this.state.moreBanner);
        }
      } catch {
        try {
          this.state.container.appendChild(this.state.moreBanner);
        } catch {}
      }
    }

    setupAutoScroll() {
      if (!this.config.autoScroll || !this.state.moreBanner) return;

      if (this.state.observer) {
        this.state.observer.disconnect();
      }

      this.state._autoArmed = true;
      this.state._autoWasIntersecting = false;
      this.state._autoLoadInProgress = false;

      this.state.observer = new IntersectionObserver(([entry]) => {
        const now = entry && entry.isIntersecting;

        if (!now && this.state._autoWasIntersecting) {
          this.state._autoArmed = true;
        }

        if (
          now &&
          !this.state._autoWasIntersecting &&
          this.state._autoArmed &&
          !this.state._autoLoadInProgress &&
          this.state.hiddenCount > 0
        ) {
          this.state._autoArmed = false;
          this.state._autoLoadInProgress = true;

          try {
            this.showOlderMessages();
          } finally {
            requestAnimationFrame(() => {
              this.state._autoLoadInProgress = false;
            });
          }
        }

        this.state._autoWasIntersecting = !!now;
      }, {
        root: null,
        rootMargin: '0px 0px -45% 0px',
        threshold: 0
      });

      this.state.observer.observe(this.state.moreBanner);
    }

    refresh() {
      if (!this.config.enabled) return;
      if (this._isRefreshing) return;

      this._isRefreshing = true;

      try {
        this.setupContainer();

        this._cachedMessages = null;
        this._cacheTimestamp = null;

        const messages = this.getMessageNodes();

        this._cachedMessages = null;
        this._cacheTimestamp = null;

        this.state.lastMessageCount = messages.length;

        if (messages.length === 0) return;

        const desired = Math.min(
          messages.length,
          Math.max(Number(this.config.windowSize || 50), 8)
        );

        if (!this.state.visibleCount || this.state.visibleCount < desired) {
          this.state.visibleCount = desired;
        }

        this.applyWindowing(messages);
      } finally {
        this._isRefreshing = false;
      }
    }

    toggle() {
      this.config.enabled = !this.config.enabled;
      this.saveConfig();

      if (this.config.enabled) {
        document.documentElement.classList.add('cpo-active');
        this.refresh();
      } else {
        this.disable();
        document.documentElement.classList.remove('cpo-active');
      }
    }

    disable() {
      const messages = this.getMessageNodes();

      messages.forEach((message) => {
        message.classList.remove('cpo-hidden');
        this.restoreImages(message);
      });

      if (this.state.moreBanner) {
        try {
          if (this.state.moreBanner.parentNode) {
            this.state.moreBanner.parentNode.removeChild(this.state.moreBanner);
          }
        } catch (error) {
          console.warn('CPO: Error removing banner:', error);
        }

        this.state.moreBanner = null;
      }

      if (this.state.observer) {
        this.state.observer.disconnect();
        this.state.observer = null;
      }

      if (this.state.mutationObserver) {
        this.state.mutationObserver.disconnect();
        this.state.mutationObserver = null;
      }

      this.state.hiddenCount = 0;
      this.state.visibleCount = 0;
      this._cachedMessages = null;
      this._cacheTimestamp = null;
    }
  }

  if (typeof window !== 'undefined') {
    if (!window.ChatGPTOptimizerInstance && typeof window.document !== 'undefined') {
      window.ChatGPTOptimizerInstance = new ChatGPTOptimizer();
    }
  }

  function storageSyncGet(defaults) {
    return extensionApiPromise(
      (done) => chrome.storage.sync.get(defaults, done),
      () => chrome.storage.sync.get(defaults)
    );
  }

  function storageSyncSet(items) {
    return extensionApiPromise(
      (done) => chrome.storage.sync.set(items, done),
      () => chrome.storage.sync.set(items)
    );
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ChatGPTOptimizer
    };
  }
})();
