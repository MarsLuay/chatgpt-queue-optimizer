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
        inlineQueueInFlight: false,
        lastQueuedAt: 0,
        lastQueuedText: ''
      };

      this._cachedMessages = null;
      this._cacheTimestamp = null;
      this._loggedSelector = null;
      this._isRefreshing = false;
      this._lastNoMessageLog = 0;
      this.refreshTimeout = null;

      this.init();
    }

    async init() {
      await this.loadConfig();

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.bootstrap());
      } else {
        this.bootstrap();
      }

      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        this.handleMessage(message, sender, sendResponse);
        return true;
      });
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
              selector: this._loggedSelector || 'none'
            }
          });

          break;
        }

        case 'DEBUG_MESSAGES': {
          const debugMessages = this.getMessageNodes();

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

      document.addEventListener('keydown', (event) => {
        this.handleComposerKeydown(event);
      }, true);

      this.state.enterQueueListenerAttached = true;
    }

    handleComposerKeydown(event) {
      if (
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented
      ) {
        return;
      }

      const composer = this.getComposerFromEventTarget(event.target);
      if (!composer) return;

      const text = this.getComposerText(composer).trim();
      if (!text) return;
      if (!this.isChatGPTGenerating()) return;

      event.preventDefault();
      event.stopPropagation();

      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }

      const now = Date.now();

      if (
        this.state.inlineQueueInFlight ||
        (this.state.lastQueuedText === text && now - this.state.lastQueuedAt < 1200)
      ) {
        return;
      }

      this.queueComposerMessage(text, composer);
    }

    getComposerFromEventTarget(target) {
      const element = target && target.nodeType === Node.ELEMENT_NODE
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

      if (composer.tagName && composer.tagName.toLowerCase() === 'textarea') {
        return composer.value || '';
      }

      return composer.innerText || composer.textContent || '';
    }

    clearComposer(composer) {
      if (!composer) return;

      composer.focus();

      if (composer.tagName && composer.tagName.toLowerCase() === 'textarea') {
        composer.value = '';
      } else {
        composer.innerHTML = '';
      }

      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'deleteContentBackward',
        data: null
      }));
    }

    isChatGPTGenerating() {
      const stopButton =
        document.querySelector('button[data-testid="stop-button"]') ||
        Array.from(document.querySelectorAll('button')).find((button) => {
          const label = (
            button.getAttribute('aria-label') ||
            button.innerText ||
            button.textContent ||
            ''
          ).toLowerCase();

          return (
            label.includes('stop generating') ||
            label.includes('stop streaming') ||
            label.includes('stop response') ||
            label.includes('interrupt')
          );
        });

      const resultStreaming =
        document.querySelector('.result-streaming') ||
        document.querySelector('[data-testid*="conversation-turn"] .result-streaming') ||
        document.querySelector('[data-message-streaming="true"]') ||
        document.querySelector('[data-testid*="streaming"]');

      return !!(stopButton || resultStreaming);
    }

    queueComposerMessage(text, composer) {
      this.state.inlineQueueInFlight = true;
      this.state.lastQueuedAt = Date.now();
      this.state.lastQueuedText = text;

      chrome.runtime.sendMessage({
        action: 'enqueueMessage',
        message: text,
        source: 'composer-enter',
        position: 'end',
        waitForIdleBeforeStart: true
      }, (response) => {
        const error = chrome.runtime.lastError;
        this.state.inlineQueueInFlight = false;

        if (error || !response || !response.ok) {
          this.showInlineQueueToast(
            error?.message || response?.error || 'Could not add message to queue.',
            'error'
          );
          return;
        }

        this.clearComposer(composer);
        this.showInlineQueueToast('Queued to send after the current response.');
      });
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

      requestAnimationFrame(() => {
        toast.classList.add('cpo-inline-queue-toast-visible');
      });

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
        const maxAttempts = 120;

        const check = () => {
          const messages = this.getMessageNodes();

          if (messages.length > 0 || attempts >= maxAttempts) {
            resolve();
            return;
          }

          attempts++;
          setTimeout(check, 250);
        };

        check();
      });
    }

    getMainRoot() {
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
      const collected = [];

      const selectors = [
        '[data-testid^="conversation-turn"]',
        '[data-testid*="conversation-turn"]',
        'article[data-testid]',
        'article',
        '[data-message-author-role]',
        '[data-message-id]',
        '[data-testid="conversation-turn"]'
      ];

      for (const selector of selectors) {
        try {
          const nodes = Array.from(document.querySelectorAll(selector));

          for (const node of nodes) {
            if (!mainRoot.contains(node)) continue;

            const normalized = this.normalizeMessageNode(node, mainRoot);

            if (normalized && this.isValidMessageNode(normalized, mainRoot)) {
              collected.push(normalized);
            }
          }
        } catch (error) {
          console.warn(`CPO: Selector failed: ${selector}`, error);
        }
      }

      let messages = this.sortMessagesByPosition(this.removeDuplicates(collected));

      if (messages.length > 0) {
        if (!this._loggedSelector) {
          this._loggedSelector = 'combined-chatgpt-selectors';
          console.log(`CPO: Found ${messages.length} messages using combined selectors`);
        }

        this._cachedMessages = messages;
        this._cacheTimestamp = Date.now();

        return messages;
      }

      messages = this.getFallbackMessages(mainRoot);

      this._cachedMessages = messages;
      this._cacheTimestamp = Date.now();

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
        node.matches('[data-testid^="conversation-turn"]') ||
        node.matches('[data-testid*="conversation-turn"]') ||
        node.matches('article') ||
        node.matches('[data-message-id]') ||
        !!node.querySelector('[data-message-author-role], [data-message-id]');

      if (!hasMessageMarker) return false;

      return true;
    }

    getFallbackMessages(mainRoot = this.getMainRoot()) {
      const fallbackSelectors = [
        'main article',
        'main [data-message-author-role]',
        'main [data-message-id]',
        'main div[class*="group"]',
        '[role="main"] article',
        '[role="main"] [data-message-author-role]',
        '[role="main"] div[class*="group"]'
      ];

      const collected = [];

      for (const selector of fallbackSelectors) {
        try {
          const nodes = Array.from(document.querySelectorAll(selector));

          for (const node of nodes) {
            if (!mainRoot.contains(node)) continue;
            if (node.closest('#cpo-root')) continue;
            if (node.id && node.id.includes('thread-bottom')) continue;
            if (node.querySelector('textarea, input[type="text"], form')) continue;

            const text = node.textContent.trim();
            if (text.length < 15) continue;

            const normalized = this.normalizeMessageNode(node, mainRoot);
            if (normalized && this.isValidFallbackNode(normalized, mainRoot)) {
              collected.push(normalized);
            }
          }
        } catch {
          // Try the next fallback selector.
        }
      }

      const result = this.sortMessagesByPosition(this.removeDuplicates(collected));

      if (result.length > 0) {
        if (!this._loggedSelector) {
          this._loggedSelector = 'fallback-selectors';
          console.log(`CPO: Fallback selectors found ${result.length} messages`);
        }
        return result;
      }

      const now = Date.now();
      if (now - this._lastNoMessageLog > 5000) {
        console.warn('CPO: No ChatGPT messages found. Open a conversation with visible messages, then refresh the tab.');
        this._lastNoMessageLog = now;
      }

      return [];
    }

    isValidFallbackNode(node, mainRoot) {
      if (!node || !mainRoot.contains(node)) return false;
      if (node.closest('#cpo-root')) return false;
      if (node.classList && node.classList.contains('cpo-more-banner')) return false;

      const text = node.textContent.trim();
      if (text.length < 15) return false;

      if (node.querySelector('textarea, input, form')) return false;

      const hasContent =
        node.querySelector('p, pre, code, ul, ol, h1, h2, h3, h4, h5, h6, [data-message-author-role]') ||
        node.matches('article') ||
        node.matches('[data-message-id]') ||
        node.matches('[data-testid*="conversation-turn"]');

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
      banner.innerHTML = `
        <div class="cpo-banner-content">
          <span class="cpo-banner-text">Show older messages</span>
          <button class="cpo-banner-button" type="button">Load More</button>
        </div>
      `;

      banner.querySelector('.cpo-banner-button').addEventListener('click', () => {
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

  if (!window.ChatGPTOptimizerInstance) {
    window.ChatGPTOptimizerInstance = new ChatGPTOptimizer();
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
})();
