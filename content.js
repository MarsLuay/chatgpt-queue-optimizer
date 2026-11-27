(() => {
  'use strict';

  let cpoHistoryPatched = false;

  class ChatGPTOptimizer {
    constructor() {
      this.config = {
        enabled: true,
        windowSize: 50,
        batchSize: 25,
        autoScroll: true,
        offscreenRendering: false,
        adaptiveBudget: false,
        resourceBudget: 8000,
        evictPausedMedia: false
      };

      this.state = {
        container: null,
        moreBanner: null,
        hiddenCount: 0,
        visibleCount: 0,
        manualVisibleCount: 0,
        adaptiveTarget: 0,
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
        rootObserver: null,
        perf: { scans: 0, lastScanMs: 0, lastWindowMs: 0, mutationSkips: 0, mutationRefreshes: 0 }
      };

      this._cachedMessages = null;
      this._cacheTimestamp = null;
      this._messageCacheTimer = null;
      /** @type {WeakMap<Element, Record<string, string>>} */
      this.mediaOriginals = new WeakMap();
      this.mediaStats = { imagesEvicted: 0, playbackEvicted: 0, restored: 0, estimatedImageBytes: 0 };
      this._loggedSelector = null;
      this._isRefreshing = false;
      this._lastNoMessageLog = 0;
      this.refreshTimeout = null;
      /** @type {Record<string, (...args: number[]) => number> | null} */
      this.nativeCore = null;
      this.nativeCoreState = 'not loaded';
      this.browserEngine = null;
      this.nativeMemoryBytes = 0;
      /** @type {ReturnType<ChatGPTOptimizer['sampleResources']> | null} */
      this.resourceSample = null;
      /** @type {Promise<void> | null} */
      this.nativeCoreLoading = null;

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
      // Lazy native loading never blocks composer or generation detection.
      globalThis.CpoQueueEngine?.load();
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
      // Queue-only providers load browser execution only on demand.
      if (['CHECK_GENERATION_STATE','GET_COMMAND_TURN_SNAPSHOT','GET_COMMAND_RESPONSE_STATE','INSPECT_GENERATION_STATE','CLICK_RETRY_BUTTON'].includes(message.type)) {
        this.loadRustBrowserEngine();
      }
      switch (message.type) {
        case 'TOGGLE_OPTIMIZER':
          if (!this.provider?.supportsOptimizer) {
            sendResponse({ success: false, enabled: false, unsupported: true, provider: this.provider?.id || null });
            break;
          }
          this.toggle();
          sendResponse({ success: true, enabled: this.config.enabled });
          break;

        case 'UPDATE_CONFIG': {
          if (['windowSize', 'adaptiveBudget', 'resourceBudget'].some(key =>
              Object.prototype.hasOwnProperty.call(message.config || {}, key) &&
              message.config[key] !== this.config[key])) {
            this.state.visibleCount = 0;
            this.state.manualVisibleCount = 0;
            this.resourceSample = null;
          }
          const mediaChanged = Object.prototype.hasOwnProperty.call(message.config || {}, 'evictPausedMedia') &&
            message.config.evictPausedMedia !== this.config.evictPausedMedia;
          this.config = { ...this.config, ...message.config };
          if (mediaChanged && this.state.container) {
            for (const message of this.state.container.querySelectorAll('.cpo-hidden')) {
              if (this.config.evictPausedMedia) this.evictPlayback(message);
              else this.restorePlayback(message);
            }
          }
          this.saveConfig();

          if (this.config.enabled) {
            this.refresh();
          }

          sendResponse({ success: true, enabled: this.config.enabled });
          break;
        }

        case 'CPO_HISTORY_BATCH':
          try { sendResponse(this.captureHistoryBatch(message)); }
          catch { sendResponse({ ok: false, error: 'History capture failed.' }); }
          break;

        case 'CAN_DISCARD_INACTIVE_TAB':
          sendResponse({ safe: this.canDiscardInactiveTab() });
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
              enterDiagnostics: this.state.enterDiagnostics || [],
              browserEngine: this.browserEngine?.status || 'not loaded',
              optimizerEngine: this.nativeCoreState === 'Rust/WASM' ? 'Rust/WASM' : 'JavaScript fallback (' + (this.nativeCoreState || 'not loaded') + ')',
              resources: this.getResourceDiagnostics(messages),
              performance: { ...this.state.perf }
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
            // One generation-state inspection per poll. The adapter may reuse it.
            responseState = this.provider.getCommandResponseState(document, message.commandBinding || {}, state);
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

    // Explicit snapshot requests only. No HTML, attachments, source attributes,
    // or React state are serialized; visible message text may be sensitive.
    captureHistoryBatch(request) {
      if (!this.provider?.supportsOptimizer || !this.canDiscardInactiveTab()) {
        return { ok: false, error: 'Chat must be inactive, idle and free of drafts or uploads.' };
      }
      const surface = this.getCurrentSurface();
      if (!surface.conversationId || !surface.optimizerEligible) {
        return { ok: false, error: 'Open a saved ChatGPT conversation first.' };
      }
      const messages = this.sortMessagesByPosition(this.getMessageNodes());
      const total = messages.length;
      const offset = Number(request.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) return { ok: false, error: 'Invalid history offset.' };
      // A route or count change aborts the snapshot rather than mixing chats.
      const identity = surface.key;
      if (typeof identity !== 'string' || !identity) return { ok: false, error: 'Unknown conversation identity.' };
      if (request.identity != null && (request.identity !== identity || request.total !== total)) {
        return { ok: false, error: 'Conversation changed during capture. Start again.' };
      }
      const native = this.browserEngine?.captureHistory(messages, offset);
      if (native != null) return native.ok ? { ...native, identity, total } : native;
      const end = Math.min(total, offset + 16);
      const records = [];
      for (let index = offset; index < end; index++) {
        const node = messages[index];
        if (!node?.isConnected) return { ok: false, error: 'Conversation DOM changed during capture.' };
        const roleNode = node.matches?.('[data-message-author-role]') ? node :
          node.querySelector?.('[data-message-author-role]');
        const rawRole = roleNode?.getAttribute('data-message-author-role');
        const role = rawRole === 'user' || rawRole === 'assistant' ? rawRole : 'message';
        // Walk text nodes, never serialize a full subtree or allocate its
        // complete textContent. Skip controls, hidden tool markup and scripts.
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const parts = [];
        let chars = 0;
        let visited = 0;
        let textNode;
        let truncated = false;
        while ((textNode = walker.nextNode())) {
          if (++visited > 4096 || chars >= 32768) { truncated = true; break; }
          if (textNode.parentElement?.closest('button,script,style,noscript,textarea,input,select,[aria-hidden="true"],[contenteditable="true"]')) continue;
          const text = /** @type {Text} */ (textNode);
          const remaining = 32768 - chars;
          const take = Math.min(text.length, remaining);
          if (take) {
            parts.push(text.substringData(0, take));
            chars += take;
          }
          if (take < text.length) { truncated = true; break; }
        }
        records.push({ index, role, text: parts.join(' '), truncated });
      }
      return { ok: true, identity, total, next: end, records };
    }

    canDiscardInactiveTab() {
      // Fail closed for active responses, drafts, uploads, media and unknown state.
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden' ||
          !this.provider?.supportsOptimizer || !this.getCurrentSurface().optimizerEligible ||
          this.state.inlineQueueInFlight) return false;
      try {
        const composer = this.provider.getComposerMatch?.(document)?.element;
        if (!composer || String(this.provider.getComposerText(composer) || '').trim()) return false;
        const state = this.provider.getGenerationState?.(document);
        if (!state || state.generating || state.deepResearchActive ||
            state.hasActiveStopButton || state.hasResultStreaming ||
            state.hasActiveToolOrResearch) return false;
        if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return false;
        if (Array.from(document.querySelectorAll('input[type="file"]')).some(input =>
          /** @type {HTMLInputElement} */ (input).files?.length)) return false;
        if (Array.from(document.querySelectorAll('audio,video')).some(media =>
          /** @type {HTMLMediaElement} */ (media).paused === false)) return false;
        if (document.querySelector('[data-state="uploading"], [data-testid*="upload-progress"], [aria-label*="Uploading"]')) return false;
        return true;
      } catch {
        return false;
      }
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

    // Only scalar counts cross the WASM boundary. Never pass DOM nodes or
    // conversation text into linear memory, and never run WASM for queue-only sites.
    loadRustCore() {
      if (this.nativeCore || this.nativeCoreLoading || this.nativeCoreState === 'unavailable') return;
      if (typeof WebAssembly === 'undefined' || typeof chrome === 'undefined' ||
          typeof chrome.runtime?.getURL !== 'function' || typeof fetch !== 'function') {
        this.nativeCoreState = 'unavailable';
        return;
      }
      this.nativeCoreState = 'loading';
      this.nativeCoreLoading = (async () => {
        try {
          const response = await fetch(chrome.runtime.getURL('optimizer_core.wasm'));
          if (!response.ok) throw new Error('WASM resource unavailable: ' + response.status);
          const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
          const core = /** @type {Record<string, (...args: number[]) => number>} */ (
            /** @type {unknown} */ (result.instance.exports)
          );
          const required = ['cpo_abi_version', 'cpo_visible_count', 'cpo_expand_count',
            'cpo_hidden_count', 'cpo_offscreen_end', 'cpo_batch_count',
            'cpo_resource_units', 'cpo_adaptive_window', 'cpo_image_surface_bytes', 'cpo_can_evict_playback'];
          if (!required.every(name => typeof core[name] === 'function') ||
              core.cpo_abi_version() !== 4) {
            throw new Error('Rust optimizer ABI mismatch');
          }
          const memory = result.instance.exports.memory;
          this.nativeMemoryBytes = memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0;
          this.nativeCore = core;
          this.nativeCoreState = 'Rust/WASM';
        } catch (error) {
          this.nativeCoreState = 'unavailable';
          console.warn('CPO: Rust optimizer unavailable; using compatible JS policy.', error);
        } finally {
          this.nativeCoreLoading = null;
        }
      })();
    }

    policyCount(value, fallback = 0) {
      const number = Number(value);
      return Number.isFinite(number) && number > 0
        ? Math.min(0xffffffff, Math.floor(number))
        : fallback;
    }

    policyCall(name, args, fallback) {
      if (this.nativeCore) {
        try {
          return this.nativeCore[name](...args) >>> 0;
        } catch (error) {
          this.nativeCore = null;
          this.nativeMemoryBytes = 0;
          this.nativeCoreState = 'unavailable';
          console.warn('CPO: Rust optimizer failed; reverting to JS policy.', error);
        }
      }
      return fallback();
    }

    policyVisible(total, expanded = 0) {
      const count = this.policyCount(total);
      const configured = this.policyCount(this.config.windowSize, 50);
      const requested = this.policyCount(expanded);
      return this.policyCall('cpo_visible_count', [count, configured, requested],
        () => Math.min(count, Math.max(configured, requested, 8)));
    }

    policyBatch(hidden) {
      const count = this.policyCount(hidden);
      const batch = this.policyCount(this.config.batchSize, 25);
      return this.policyCall('cpo_batch_count', [count, batch], () => Math.min(count, batch));
    }

    // A bounded, on-demand scan of recent turns. Counts only, no retained DOM
    // references or copied message strings. Never call during token mutations.
    sampleResources(messages) {
      const nativeSample = this.browserEngine?.sample(messages);
      if (nativeSample) return nativeSample;
      const sample = {
        time: Date.now(), totalTurns: messages.length, sampledTurns: 0,
        nodes: 0, textChars: 0, images: 0, media: 0, surfaces: 0,
        truncatedTurns: 0, units: 0, available: false
      };
      if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return sample;
      sample.available = true;
      const start = Math.max(0, messages.length - 32);
      for (let i = messages.length - 1; i >= start; i--) {
        const root = messages[i];
        if (!root || root.isConnected === false) continue;
        // SHOW_ALL includes text nodes; reading Text.length does not copy text.
        const walker = document.createTreeWalker(root, 0xffffffff);
        let node = /** @type {Node | null} */ (root);
        let visited = 0;
        while (node && visited < 512) {
          visited++;
          sample.nodes++;
          if (node.nodeType === 3) {
            sample.textChars = Math.min(0xffffffff, sample.textChars + (/** @type {Text} */ (node)).length);
          } else if (node.nodeType === 1) {
            const tag = (/** @type {Element} */ (node)).localName;
            if (tag === 'img') sample.images++;
            else if (tag === 'video' || tag === 'audio') sample.media++;
            else if (tag === 'canvas' || tag === 'iframe') sample.surfaces++;
          }
          node = walker.nextNode();
        }
        if (node) sample.truncatedTurns++;
        sample.sampledTurns++;
      }
      const args = [sample.nodes, sample.textChars, sample.images, sample.media,
        sample.surfaces, sample.truncatedTurns];
      sample.units = this.policyCall('cpo_resource_units', args, () =>
        Math.min(0xffffffff, sample.nodes + Math.ceil(sample.textChars / 128) +
          sample.images * 32 + sample.media * 128 + sample.surfaces * 128 + sample.truncatedTurns * 512));
      return sample;
    }

    getResourceSample(messages) {
      const current = this.resourceSample;
      if (current && current.totalTurns === messages.length &&
          (this.browserEngine?.cacheValid(2, current.time, true, true) ??
            (Date.now() >= current.time && Date.now() - current.time < 8000))) return current;
      this.resourceSample = this.sampleResources(messages);
      return this.resourceSample;
    }

    getResourceDiagnostics(messages) {
      const sample = this.getResourceSample(messages);
      // Chromium-only, implementation-specific heap metric; not tab RSS.
      const memory = typeof performance !== 'undefined' ?
        (/** @type {Performance & {memory?: {usedJSHeapSize?: number}}} */ (performance)).memory : null;
      const used = memory?.usedJSHeapSize;
      return {
        ...sample,
        usedJsHeapBytes: typeof used === 'number' && Number.isFinite(used) ? used : null,
        wasmLinearBytes: (this.nativeMemoryBytes || 0) + (this.browserEngine?.memoryBytes || 0),
        cachedMessageRefs: this._cachedMessages?.length || 0,
        mediaEviction: { ...this.mediaStats },
        adaptiveEnabled: this.config.adaptiveBudget === true,
        budget: this.policyCount(this.config.resourceBudget, 8000),
        adaptiveTarget: this.state.adaptiveTarget || 0,
        manuallyExpanded: (this.state.manualVisibleCount || 0) > 0
      };
    }

    policyAdaptiveTarget(messages) {
      const total = messages.length;
      const configured = this.policyCount(this.config.windowSize, 50);
      const sample = this.getResourceSample(messages);
      const budget = this.policyCount(this.config.resourceBudget, 8000);
      const cap = this.policyVisible(total);
      const args = [total, configured, sample.sampledTurns, sample.units, budget];
      return this.policyCall('cpo_adaptive_window', args, () =>
        !sample.sampledTurns || !sample.units ? cap :
          Math.min(cap, Math.max(8, Math.floor(budget * sample.sampledTurns / sample.units))));
    }

    // Do not shrink an already displayed history window over an edit,
    // selection, or active response. Unknown activity state is conservative.
    canShrinkAdaptiveWindow(messages) {
      if (typeof document === 'undefined') return false;
      try {
        const focus = document.activeElement;
        const selection = document.getSelection?.();
        const selected = selection && !selection.isCollapsed;
        if (messages.some(message =>
          (focus && message.contains?.(focus)) ||
          (selected && (message.contains?.(selection.anchorNode) || message.contains?.(selection.focusNode))))) return false;
        const state = this.provider?.getGenerationState?.(document);
        return !!state && !state.generating && !state.deepResearchActive &&
          !state.hasActiveStopButton && !state.hasResultStreaming && !state.hasActiveToolOrResearch;
      } catch { return false; }
    }

    loadRustBrowserEngine() {
      if (this.browserEngine || typeof globalThis.CpoRustBrowserBridge !== 'function') return;
      const engine = new globalThis.CpoRustBrowserBridge(this);
      this.browserEngine = engine;
      engine.load().then(ready => {
        if (!ready) return;
        this.provider?.setNativeMessageDiscovery?.((adapter, doc, root) =>
          engine.discover(adapter, doc, root));
        this.provider?.setNativeLifecycle?.(engine);
        this.provider?.setNativeSelectorEngine?.(engine);
        this.clearMessageCache();
        this.resourceSample = null;
        if (this.state.optimizerBound && this.config.enabled) this.refresh();
      }).catch(error => engine.fail(error));
    }

    bindOptimizer() {
      if (!this.provider?.supportsOptimizer) return;
      const surface = this.getCurrentSurface();
      if (!surface.optimizerEligible || !this.config.enabled) {
        this.unbindOptimizer();
        return;
      }

      this.loadRustCore();
      this.loadRustBrowserEngine();
      this.setupContainer();
      this.markConversationRoot();
      this.provider?.setTurnScanCacheEnabled?.(true);
      this.setupObservers();
      this.refresh();
      this.state.optimizerBound = true;
    }

    unbindOptimizer() {
      this.provider?.setTurnScanCacheEnabled?.(false);
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

    clearMessageCache() {
      clearTimeout(this._messageCacheTimer);
      this._messageCacheTimer = null;
      this._cachedMessages = null;
      this._cacheTimestamp = null;
    }

    getMessageNodes() {
      const cached = this._cachedMessages;
      if (cached && (this.browserEngine?.cacheNodesValid(0, this._cacheTimestamp, cached) ??
          (!!this._cacheTimestamp && Date.now() >= this._cacheTimestamp &&
            Date.now() - this._cacheTimestamp < 800 && cached.every(node => node.isConnected !== false)))) {
        return cached;
      }

      this.clearMessageCache();
      const surface = this.getCurrentSurface();
      if (this.provider?.supportsOptimizer && !surface.optimizerEligible) {
        return [];
      }

      const started = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const mainRoot = this.getMainRoot();
      let messages = [];

      if (this.provider && typeof this.provider.getMessageNodes === 'function') {
        messages = this.provider.getMessageNodes(document, mainRoot);
      } else {
        messages = this.getFallbackMessages(mainRoot);
      }

      this.state.perf.scans++;
      this.state.perf.lastScanMs = Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - started) * 10) / 10;
      if (messages && messages.length > 0) {
        if (!this._loggedSelector) {
          const compatibility = this.getCompatibilityDiagnostics();
          this._loggedSelector = compatibility.messages.selector || compatibility.messages.signalKey || 'none';
          console.log(`CPO: Found ${messages.length} messages using ${this.provider?.name || 'ChatGPT'} adapter (${this._loggedSelector})`);
        }

        this._cachedMessages = messages;
        this._cacheTimestamp = Date.now();
        this._messageCacheTimer = setTimeout(() => this.clearMessageCache(), this.browserEngine?.cacheTtl(0) ?? 800);
        // Avoid keeping a Node test process alive; browsers return a number.
        if (typeof this._messageCacheTimer?.unref === 'function') this._messageCacheTimer.unref();

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
        });
    }

    removeDuplicates(messages) {
      const unique = Array.from(new Set(messages));
      const candidates = new Set(unique);
      const redundant = new Set();
      const isTurn = node => {
        const testId = node.getAttribute?.('data-testid') || '';
        return node.tagName?.toLowerCase() === 'article' ||
          testId.startsWith('conversation-turn') ||
          !!node.getAttribute?.('data-message-author-role') ||
          !!node.getAttribute?.('data-message-id');
      };
      for (const node of unique) {
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (!candidates.has(parent)) continue;
          if (isTurn(node) && !isTurn(parent)) {
            redundant.add(parent);
          } else {
            redundant.add(node);
          }
        }
      }
      return unique.filter(node => !redundant.has(node));
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
        this.state.observer = null;
      }

      this.state.mutationObserver = new MutationObserver((mutations) => {
        this.provider?.invalidateTurnScanCache?.(mutations);
        this.handleMutations(mutations);
      });

      this.state.mutationObserver.observe(this.state.container, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-message-author-role', 'data-message-id', 'data-testid']
      });
    }

    handleMutations(mutations) {
      if (!this.config.enabled || !this.state.optimizerBound) return;

      // A normal streaming token changes the contents of an existing turn,
      // but not the number or order of turns. Do not rescan the entire chat.
      const turnSelector = '[data-testid^="conversation-turn"], [data-message-author-role]';
      const nativeStructural = this.browserEngine?.mutations(mutations, 0, this.state.lastMessageCount === 0);
      let structuralChange = nativeStructural ?? false;
      if (nativeStructural == null) for (const mutation of mutations) {
        if (mutation.type === 'attributes' && ['data-testid', 'data-message-author-role', 'data-message-id'].includes(mutation.attributeName)) {
          structuralChange = true;
          break;
        }
        if (!mutation.addedNodes?.length && !mutation.removedNodes?.length) continue;
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        const bannerOnly = nodes.every(node => node?.nodeType === 1 &&
          (node.classList?.contains('cpo-more-banner') || node.closest?.('.cpo-more-banner')));
        if (bannerOnly) continue;
        const changedTurns = nodes.some(node => node?.nodeType === 1 &&
          (node.matches?.(turnSelector) || node.querySelector?.(turnSelector)));
        if (changedTurns || !mutation.target?.closest?.(turnSelector) ||
            this.state.lastMessageCount === 0) {
          structuralChange = true;
          break;
        }
      }

      if (!structuralChange) {
        this.state.perf.mutationSkips++;
        return;
      }
      this.state.perf.mutationRefreshes++;
      this.resourceSample = null;
      this.clearMessageCache();
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = setTimeout(() => {
        if (!this.config.enabled || !this.state.optimizerBound) return;
        const count = this.getMessageNodes().length;
        if (count !== this.state.lastMessageCount || count > 0) {
          this.state.lastMessageCount = count;
          this.refresh();
        }
      }, this.browserEngine?.mutationDelay() ?? 700);
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
      const resetButton = document.createElement('button');
      resetButton.className = 'cpo-banner-button cpo-reset-budget';
      resetButton.type = 'button';
      resetButton.textContent = 'Return to budget';
      resetButton.style.display = 'none';
      resetButton.addEventListener('click', () => {
        this.state.manualVisibleCount = 0;
        this.applyWindowing();
      });
      bannerContent.appendChild(bannerButton);
      bannerContent.appendChild(resetButton);
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

      const reset = this.state.moreBanner.querySelector('.cpo-reset-budget');
      const expanded = this.config.adaptiveBudget === true &&
        (this.state.manualVisibleCount || 0) > (this.state.adaptiveTarget || 0);
      if (reset) reset.style.display = expanded ? '' : 'none';
      if (button) button.style.display = this.state.hiddenCount > 0 ? '' : 'none';
      if (this.state.hiddenCount > 0 || expanded) {
        const toShow = this.policyBatch(this.state.hiddenCount);
        button.textContent = `Load ${toShow} More`;
        text.textContent = `${this.state.hiddenCount} older messages hidden`;
        this.state.moreBanner.style.display = 'block';
      } else {
        this.state.moreBanner.style.display = 'none';
      }
    }

    showOlderMessages() {
      const messages = this.getMessageNodes();

      const currentVisible = this.state.visibleCount;
      const toShow = this.policyBatch(this.state.hiddenCount);

      const total = this.policyCount(messages.length);
      const current = this.policyCount(currentVisible);
      this.state.visibleCount = toShow === 0 ? Math.min(total, current) :
        this.policyCall('cpo_expand_count', [total, current, toShow],
          () => Math.min(total, current + toShow));
      if (this.config.adaptiveBudget) this.state.manualVisibleCount = this.state.visibleCount;
      this.applyWindowing(messages);
    }

    applyWindowing(messages = null) {
      if (!this.config.enabled) return;

      messages = messages || this.getMessageNodes();
      if (messages.length === 0) return;

      const started = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      messages = this.sortMessagesByPosition(messages);

      const totalMessages = messages.length;

      let targetVisible;
      if (this.config.adaptiveBudget === true) {
        this.state.adaptiveTarget = this.policyAdaptiveTarget(messages);
        const manual = this.state.manualVisibleCount || 0;
        const previous = this.state.visibleCount || 0;
        targetVisible = this.browserEngine?.windowVisible(totalMessages, this.state.adaptiveTarget, manual, previous, true) ??
          Math.min(totalMessages, Math.max(this.state.adaptiveTarget, manual));
        if (targetVisible < previous && !this.canShrinkAdaptiveWindow(messages)) {
          targetVisible = this.browserEngine?.windowVisible(totalMessages, this.state.adaptiveTarget, manual, previous, false) ??
            Math.min(totalMessages, previous);
        }
      } else {
        this.state.adaptiveTarget = 0;
        targetVisible = this.policyVisible(totalMessages, this.state.visibleCount);
      }
      const startIndex = this.policyCall('cpo_hidden_count', [totalMessages, targetVisible],
        () => Math.max(0, totalMessages - targetVisible));
      const offscreenEnd = this.policyCall('cpo_offscreen_end', [totalMessages],
        () => Math.max(0, totalMessages - 8));

      this.state.hiddenCount = startIndex;
      this.state.visibleCount = targetVisible;

      const executed = this.browserEngine?.applyWindow(messages, targetVisible,
        this.config.offscreenRendering, this.config.evictPausedMedia);
      if (executed !== true) messages.forEach((message, index) => {
        if (index < startIndex) {
          this.hideMessage(message);
        } else {
          this.showMessage(message);
        }
        if (this.config.offscreenRendering && index >= startIndex && index < offscreenEnd) {
          message.classList.add('cpo-offscreen');
        } else {
          message.classList.remove('cpo-offscreen');
        }
      });
      this.state.perf.lastWindowMs = Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - started) * 10) / 10;

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
      if (this.config.evictPausedMedia) this.evictPlayback(message);
    }

    showMessage(message) {
      if (message.classList.contains('cpo-hidden')) {
        message.classList.remove('cpo-hidden');
        this.restoreImages(message);
        this.restorePlayback(message);
      }
      this.applyLazyLoading(message);
    }

    // The WeakMap is deliberately the only owner of removed attributes. Its
    // keys never keep a detached DOM node alive, and no URLs enter telemetry.
    isProtectedMediaSource(value) {
      return typeof value === 'string' && (/(?:^|[\s,])(?:blob:|data:|mediasource:)/i.test(value) || value.length > 8192);
    }

    stashSources(element, names) {
      const originals = this.mediaOriginals.get(element) || {};
      let changed = false;
      for (const name of names) {
        if (!element.hasAttribute(name)) continue;
        const value = element.getAttribute(name);
        // Never replace application-owned object URLs, nor retain enormous
        // inline payloads solely for the purpose of evicting them.
        if (!value || this.isProtectedMediaSource(value)) continue;
        originals[name] = value;
        changed = true;
      }
      if (!changed) return false;
      this.mediaOriginals.set(element, originals);
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(originals, name) &&
            element.getAttribute(name) === originals[name]) element.removeAttribute(name);
      }
      return true;
    }

    restoreSources(element) {
      const originals = this.mediaOriginals.get(element);
      if (!originals) return false;
      // Site changes win over cached attributes. Never overwrite new values.
      this.mediaOriginals.delete(element);
      if (['src', 'srcset'].some(name => element.hasAttribute(name))) return false;
      for (const [name, value] of Object.entries(originals)) element.setAttribute(name, value);
      this.mediaStats.restored++;
      return true;
    }

    preventImageLoading(element) {
      if (this.browserEngine?.media(element, 0) != null) return;
      for (const img of element.querySelectorAll('img')) {
        const width = this.policyCount(img.naturalWidth);
        const height = this.policyCount(img.naturalHeight);
        let changed = false;
        const picture = img.closest?.('picture');
        const sources = picture && element.contains(picture) ? Array.from(picture.querySelectorAll('source[srcset]')) : [];
        // Treat responsive image candidates as a group: leave the whole
        // group alone if any candidate uses an application-owned payload.
        if ([img, ...sources].some(node => ['src', 'srcset'].some(name =>
          this.isProtectedMediaSource(node.getAttribute(name))))) continue;
        for (const source of sources) changed = this.stashSources(source, ['srcset']) || changed;
        changed = this.stashSources(img, ['srcset', 'src']) || changed;
        if (changed) {
          const bytes = this.policyCall('cpo_image_surface_bytes', [width, height],
            () => Math.min(0xffffffff, width * height * 4));
          this.mediaStats.imagesEvicted++;
          this.mediaStats.estimatedImageBytes = Math.min(Number.MAX_SAFE_INTEGER,
            this.mediaStats.estimatedImageBytes + bytes);
        }
      }
    }

    restoreImages(element) {
      if (this.browserEngine?.media(element, 1) != null) return;
      for (const img of element.querySelectorAll('img')) {
        const picture = img.closest?.('picture');
        const sources = picture && element.contains(picture) ? Array.from(picture.querySelectorAll('source')) : [];
        const group = [img, ...sources];
        const replaced = group.some(node => this.mediaOriginals.has(node) &&
          ['src', 'srcset'].some(name => node.hasAttribute(name)));
        if (replaced) {
          for (const node of group) this.mediaOriginals.delete(node);
        } else {
          for (const source of sources) this.restoreSources(source);
          this.restoreSources(img);
        }
        // Recover any markup left by the previous optimizer implementation.
        if (img.hasAttribute('data-cpo-original-src')) {
          const original = img.getAttribute('data-cpo-original-src');
          if (original && !img.hasAttribute('src') && !img.hasAttribute('srcset')) img.setAttribute('src', original);
          img.removeAttribute('data-cpo-original-src');
        }
      }
    }

    canEvictPlayback(media) {
      const sources = [media, ...media.querySelectorAll('source')];
      const protectedSource = sources.some(source => {
        const src = source.getAttribute('src') || '';
        return this.isProtectedMediaSource(src);
      }) || this.isProtectedMediaSource(media.currentSrc || '');
      const flags = [media.paused === true ? 1 : 0, media.currentTime === 0 ? 1 : 0,
        media.srcObject || media.mediaKeys || media.autoplay ? 1 : 0, protectedSource ? 1 : 0];
      return this.policyCall('cpo_can_evict_playback', flags,
        () => Number(flags[0] === 1 && flags[1] === 1 && !flags[2] && !flags[3])) === 1;
    }

    evictPlayback(element) {
      if (this.browserEngine?.media(element, 2) != null) return;
      for (const media of element.querySelectorAll('video, audio')) {
        if (!this.canEvictPlayback(media)) continue;
        let changed = false;
        for (const source of media.querySelectorAll('source[src]')) {
          changed = this.stashSources(source, ['src']) || changed;
        }
        changed = this.stashSources(media, ['src']) || changed;
        if (changed) {
          this.mediaStats.playbackEvicted++;
          // load() requests that the browser release the prior media pipeline.
          // It may emit normal media lifecycle events.
          try { media.load(); } catch {}
        }
      }
    }

    restorePlayback(element) {
      if (this.browserEngine?.media(element, 3) != null) return;
      for (const media of element.querySelectorAll('video, audio')) {
        let changed = false;
        for (const source of media.querySelectorAll('source')) {
          changed = this.restoreSources(source) || changed;
        }
        changed = this.restoreSources(media) || changed;
        if (changed && media.paused === true && media.currentTime === 0 && !media.srcObject) {
          try { media.load(); } catch {}
        }
      }
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
          if (this.state.moreBanner.parentNode === this.state.container &&
              this.state.moreBanner.nextElementSibling === firstVisibleMessage) return;
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
      if (!this.config.autoScroll || this.config.adaptiveBudget || !this.state.moreBanner) {
        if (this.state.observer) this.state.observer.disconnect();
        this.state.observer = null;
        return;
      }

      if (this.state.observer) return;
      if (typeof IntersectionObserver === 'undefined') return;

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
        // Refresh the list once, then reuse that exact result while selecting
        // its container. The old flow discarded the cache twice per refresh.
        this.clearMessageCache();
        this.setupContainer();
        const messages = this.getMessageNodes();

        this.state.lastMessageCount = messages.length;

        if (messages.length === 0) return;

        const desired = this.policyVisible(messages.length);

        if (!this.config.adaptiveBudget && (!this.state.visibleCount || this.state.visibleCount < desired)) {
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
        ? Array.from(document.querySelectorAll('.cpo-hidden, .cpo-offscreen'))
        : [];
      const fromContainer = this.state.container && typeof this.state.container.querySelectorAll === 'function'
        ? Array.from(this.state.container.querySelectorAll('.cpo-hidden, .cpo-offscreen'))
        : [];
      const fromCache = Array.isArray(this._cachedMessages) ? this._cachedMessages : [];
      const messages = [...new Set([...fromDocument, ...fromContainer, ...fromCache])];

      messages.forEach((message) => {
        message.classList.remove('cpo-hidden');
        message.classList.remove('cpo-offscreen');
        this.restoreImages(message);
        this.restorePlayback(message);
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

      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
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
      this.state.manualVisibleCount = 0;
      this.state.adaptiveTarget = 0;
      this.resourceSample = null;
      this.mediaStats = { imagesEvicted: 0, playbackEvicted: 0, restored: 0, estimatedImageBytes: 0 };
      this.clearMessageCache();
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
