(() => {
  'use strict';

  let cpoHistoryPatched = false;

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
        enterDiagnostics: [],
        routeKey: null,
        routeWatcherAttached: false,
        optimizerBound: false,
        rootObserver: null
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

    /**
     * @param {ContentScriptMessage} message
     * @param {chrome.runtime.MessageSender} sender
     * @param {(response?: ContentScriptResponse) => void} sendResponse
     */
    handleMessage(message, sender, sendResponse) {
      switch (message.type) {
        case 'TOGGLE_OPTIMIZER':
          if (!this.provider?.supportsOptimizer) {
            sendResponse({ success: false, enabled: false, unsupported: true, provider: this.provider?.id || null });
            break;
          }
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
              compatibility: this.getCompatibilityDiagnostics(),
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
          let responseState = null;
          if (this.provider && typeof this.provider.getCommandResponseState === 'function') {
            responseState = this.provider.getCommandResponseState(document, message.commandBinding || {});
          }
          sendResponse({ state, responseState });
          break;
        }

        case 'GET_COMMAND_TURN_SNAPSHOT': {
          if (this.provider && typeof this.provider.getCommandTurnSnapshot === 'function') {
            const snapshot = this.provider.getCommandTurnSnapshot(document, {
              expectedText: message.expectedText,
              expectedFingerprint: message.expectedFingerprint
            });
            sendResponse({ ok: true, snapshot });
            break;
          }
          sendResponse({ ok: false, error: 'Turn snapshot is unavailable.' });
          break;
        }

        case 'GET_COMMAND_RESPONSE_STATE': {
          if (this.provider && typeof this.provider.getCommandResponseState === 'function') {
            const responseState = this.provider.getCommandResponseState(document, message.commandBinding || {});
            sendResponse({ ok: true, responseState });
            break;
          }
          sendResponse({ ok: false, error: 'Command response state is unavailable.' });
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
          const compatibility = this.getCompatibilityDiagnostics();

          if (this.config.debug) {
            console.log('CPO Debug: Found messages:', debugMessages.length);
            console.log('CPO Debug compatibility:', compatibility);
            debugMessages.slice(0, 10).forEach((msg, i) => {
              console.log(`CPO Debug Message ${i + 1}:`, {
                tagName: msg.tagName || '',
                id: msg.id || '',
                testId: msg.getAttribute?.('data-testid') || '',
                role: msg.getAttribute?.('data-message-author-role') || ''
              });
            });
          }

          sendResponse({ count: debugMessages.length, diagnostics: compatibility });
          break;
        }

        default:
          sendResponse({ error: 'Unknown message type' });
      }
    }

    bootstrap() {
      this.setupComposerQueueShortcut();
      this.setupRouteWatcher();

      if (!this.provider?.supportsOptimizer) {
        this.state.isInitialized = true;
        console.log(`CPO: Queue shortcut ready on ${this.provider?.name || 'unsupported provider'}; optimizer unsupported.`);
        return;
      }

      const surface = this.getCurrentSurface();
      this.state.routeKey = surface.key;
      if (!surface.optimizerEligible) {
        this.state.isInitialized = true;
        console.log('CPO: Optimizer idle on unsupported ChatGPT route.');
        return;
      }

      this.waitForMessages().then(() => {
        this.bindOptimizer();
        this.state.isInitialized = true;
        console.log('CPO: Initialized successfully');
      });
    }

    getCurrentSurface() {
      if (this.provider && typeof this.provider.getCurrentSurface === 'function') {
        return this.provider.getCurrentSurface(typeof document !== 'undefined' ? document : null);
      }
      if (this.provider && typeof this.provider.classifyChatGPTSurface === 'function') {
        const loc = typeof window !== 'undefined' ? window.location : (typeof location !== 'undefined' ? location : '');
        return this.provider.classifyChatGPTSurface(loc);
      }
      return {
        provider: this.provider?.id || 'chatgpt',
        type: 'unsupported',
        conversationId: null,
        key: `${this.provider?.id || 'chatgpt'}:unsupported`,
        surface: 'unsupported',
        optimizerEligible: false,
        allowFallbackDiscovery: false,
        pathname: ''
      };
    }

    setupRouteWatcher() {
      if (this.state.routeWatcherAttached) return;
      const win = typeof window !== 'undefined' ? window : null;
      if (!win) return;

      const notify = () => this.handleRouteChange();
      win.addEventListener('popstate', notify);
      win.addEventListener('hashchange', notify);

      if (win.history && !cpoHistoryPatched) {
        const wrap = (method) => {
          const original = win.history[method];
          if (typeof original !== 'function') return;
          win.history[method] = function patchedHistoryState(...args) {
            const result = original.apply(this, args);
            notify();
            return result;
          };
        };
        wrap('pushState');
        wrap('replaceState');
        cpoHistoryPatched = true;
      }

      if (!this.state.rootObserver && typeof MutationObserver !== 'undefined') {
        this.state.rootObserver = new MutationObserver(() => {
          if (!this.state.optimizerBound || !this.state.container) return;
          const attached = typeof document !== 'undefined' && typeof document.contains === 'function'
            ? document.contains(this.state.container)
            : true;
          if (!attached) {
            this.handleRouteChange(true);
          }
        });
        const root = typeof document !== 'undefined'
          ? (document.documentElement || document.body)
          : null;
        if (root) {
          this.state.rootObserver.observe(root, { childList: true, subtree: true });
        }
      }

      this.state.routeWatcherAttached = true;
    }

    handleRouteChange(force = false) {
      if (!this.provider?.supportsOptimizer) return;

      const surface = this.getCurrentSurface();
      const nextKey = surface.key;
      const containerDetached = !!(this.state.container && typeof document !== 'undefined' && typeof document.contains === 'function' && !document.contains(this.state.container));
      if (!force && nextKey === this.state.routeKey && !containerDetached) {
        return;
      }

      this.state.routeKey = nextKey;
      this.unbindOptimizer();
      if (surface.optimizerEligible && this.config.enabled) {
        this.bindOptimizer();
      }
    }

    bindOptimizer() {
      if (!this.provider?.supportsOptimizer) return;
      const surface = this.getCurrentSurface();
      if (!surface.optimizerEligible || !this.config.enabled) {
        this.unbindOptimizer();
        return;
      }

      this.setupContainer();
      this.markConversationRoot();
      this.setupObservers();
      this.refresh();
      this.state.optimizerBound = true;
    }

    unbindOptimizer() {
      this.disable();
      this.clearConversationRoot();
      this.state.optimizerBound = false;
      this.state.container = null;
    }

    markConversationRoot() {
      this.clearConversationRoot();
      const root = this.state.container;
      if (root?.classList) {
        root.classList.add('cpo-conversation-root');
        if (this.config.enabled) {
          root.classList.add('cpo-active');
        }
      }
    }

    clearConversationRoot() {
      const marked = [];
      if (this.state.container) {
        marked.push(this.state.container);
      }
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        marked.push(...Array.from(document.querySelectorAll('.cpo-conversation-root')));
      }
      for (const el of new Set(marked)) {
        el.classList?.remove('cpo-conversation-root');
        el.classList?.remove('cpo-active');
      }
      if (typeof document !== 'undefined') {
        document.documentElement?.classList?.remove('cpo-active');
      }
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
        const sendAction = this.provider && typeof this.provider.getSendActionFromEventTarget === 'function'
          ? this.provider.getSendActionFromEventTarget(event.target)
          : null;
        if (sendAction?.element) {
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

      const composerMatch = this.provider && typeof this.provider.getComposerMatchFromEventTarget === 'function'
        ? this.provider.getComposerMatchFromEventTarget(event.target, '#cpo-root')
        : null;
      const composer = composerMatch?.element || this.getComposerFromEventTarget(event.target);
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
          selector: composerMatch?.selector || null,
          signalKey: composerMatch?.signalKey || 'composer',
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

      return null;
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
        statusUnknown: true,
        compatibilityState: 'unknown',
        url: typeof location !== 'undefined' ? location.href : '',
        title: typeof document !== 'undefined' ? document.title : ''
      };
    }

    getCompatibilityDiagnostics() {
      if (this.provider && typeof this.provider.getCompatibilityDiagnostics === 'function') {
        return this.provider.getCompatibilityDiagnostics(document);
      }

      return {
        provider: this.provider?.id || null,
        root: { matched: false, selector: null, signalKey: 'mainRoot' },
        composer: { matched: false, selector: null, signalKey: 'composer' },
        sendAction: { matched: false, selector: null, signalKey: 'sendButton' },
        messages: { matched: false, count: 0, selector: null, signalKey: 'messages', state: 'unsupported' },
        requiredFailures: []
      };
    }

    queueComposerMessage(text, composer, diagnostic = null) {
      this.state.inlineQueueInFlight = true;
      this.state.lastQueuedAt = Date.now();
      this.state.lastQueuedText = text;
      const queuedText = text;

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

            // Only clear the text that was captured for this enqueue. If the
            // user edited the composer while the background acknowledged the
            // queue request, keep the newer draft instead of clearing it.
            const currentText = this.getComposerText(composer);
            if (currentText === queuedText) {
              this.clearComposer(composer);
            } else if (diagnostic) {
              diagnostic.composerDraftPreserved = true;
            }

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

      return document.body || null;
    }

    getMessageNodes() {
      if (
        this._cachedMessages &&
        this._cacheTimestamp &&
        Date.now() - this._cacheTimestamp < 800
      ) {
        return this._cachedMessages;
      }

      const surface = this.getCurrentSurface();
      if (this.provider?.supportsOptimizer && !surface.optimizerEligible) {
        return [];
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
          const compatibility = this.getCompatibilityDiagnostics();
          this._loggedSelector = compatibility.messages.selector || compatibility.messages.signalKey || 'none';
          console.log(`CPO: Found ${messages.length} messages using ${this.provider?.name || 'ChatGPT'} adapter (${this._loggedSelector})`);
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

      return null;
    }

    isValidMessageNode(node, mainRoot) {
      if (this.provider && typeof this.provider.isValidMessageNode === 'function') {
        return this.provider.isValidMessageNode(node, mainRoot);
      }

      return false;
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

      return false;
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
      if (this.provider?.supportsOptimizer && !this.getCurrentSurface().optimizerEligible) {
        this.unbindOptimizer();
        return;
      }

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
        this.bindOptimizer();
      } else {
        this.unbindOptimizer();
      }
    }

    disable() {
      const fromDocument = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll('.cpo-hidden'))
        : [];
      const fromContainer = this.state.container && typeof this.state.container.querySelectorAll === 'function'
        ? Array.from(this.state.container.querySelectorAll('.cpo-hidden'))
        : [];
      const fromCache = Array.isArray(this._cachedMessages) ? this._cachedMessages : [];
      const messages = [...new Set([...fromDocument, ...fromContainer, ...fromCache])];

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
