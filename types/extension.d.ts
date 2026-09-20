type ConversationType = 'new' | 'existing' | 'unknown' | 'unsupported' | string;
type QueueJobPhase =
    | 'queued'
    | 'waiting'
    | 'waiting-for-idle'
    | 'sending'
    | 'retry-wait'
    | 'paused'
    | 'complete'
    | string;
type QueueJobStatus = 'running' | 'paused' | 'stopped' | 'idle' | string;
type ScheduledMessageStatus = 'pending' | 'firing' | 'completed' | 'failed' | 'cancelled' | string;

interface ConversationIdentity {
    provider: string;
    type: ConversationType;
    conversationType?: ConversationType;
    conversationId: string | null;
    key: string;
}

interface QueueSettings {
    queueUnlimitedRetryWait: boolean;
    queueDeepResearchAware: boolean;
    queueDeliveryTimeoutRefresh: boolean;
}

interface QueueJob {
    tabId: number;
    provider: string;
    conversationId: string | null;
    conversationType: ConversationType;
    targetKey: string;
    queue: string[];
    currentMessage: string | null;
    isRunning: boolean;
    isPaused: boolean;
    isStopped: boolean;
    isProcessing?: boolean;
    waitForIdleBeforeSend?: boolean;
    pausedReason: string;
    lastError: string;
    runId: string;
    totalMessages: number;
    completedCount: number;
    currentCommandNumber: number;
    currentPhase: QueueJobPhase;
    deliveryTimeoutAttempts: number;
    startedAt: number;
    updatedAt: number;
}

/** Durable per-tab snapshot stored under QUEUE_DURABLE_STATE_KEY ('queueDurableJobs'). */
interface DurableQueueJob {
    tabId: number;
    provider: string;
    conversationId: string | null;
    conversationType: ConversationType;
    targetKey: string;
    queue: string[];
    currentMessage: string;
    isRunning: boolean;
    isPaused: boolean;
    isStopped: boolean;
    pausedReason: string;
    lastError: string;
    runId: string;
    totalMessages: number;
    completedCount: number;
    currentCommandNumber: number;
    currentPhase: QueueJobPhase;
    waitForIdleBeforeSend: boolean;
    deliveryTimeoutAttempts: number;
    startedAt: number;
    updatedAt: number;
}

type DurableQueueSnapshot = Record<string, DurableQueueJob>;

interface RunningJobSnapshot {
    tabId: number;
    provider: string;
    conversationId: string | null;
    conversationType: ConversationType;
    targetKey: string;
    remaining: number;
    pending: number;
    isRunning: boolean;
    isPaused: boolean;
    isStopped: boolean;
    status: QueueJobStatus;
    pausedReason: string;
    lastError: string;
    currentMessage: string;
    currentMessagePreview: string;
    nextMessagePreview: string;
    runId: string;
    totalMessages: number;
    completedCount: number;
    currentCommandNumber: number;
    currentPhase: QueueJobPhase;
    waitForIdleBeforeSend: boolean;
    deliveryTimeoutAttempts: number;
    startedAt: number;
    updatedAt: number;
}

interface QueueDebugLogEntry {
    ts?: number;
    tabId?: number | string;
    level?: string;
    message?: string;
    source?: string;
    details?: Record<string, unknown>;
    [key: string]: unknown;
}

interface ScheduledMessage {
    id: string;
    text: string;
    dueTs: number;
    tabId: number;
    provider: string;
    conversationId: string | null;
    conversationType: ConversationType;
    targetKey: string;
    createdAt: number;
    updatedAt: number;
    status: ScheduledMessageStatus;
    failureReason: string;
    [key: string]: unknown;
}

interface RuntimeMessageRequest {
    action?: string;
    type?: string;
    tabId?: number;
    message?: string;
    text?: string;
    source?: string;
    level?: string;
    id?: string;
    scheduledId?: string;
    dueTs?: number;
    messages?: string[];
    position?: string;
    waitForIdleBeforeStart?: boolean;
    conversationIdentity?: ConversationIdentity;
    config?: Record<string, unknown>;
    details?: Record<string, unknown>;
    entry?: QueueDebugLogEntry;
    item?: ScheduledMessage;
    deletedId?: string;
    [key: string]: unknown;
}

interface RuntimeMessageResponse {
    ok?: boolean;
    success?: boolean;
    error?: string;
    tabId?: number;
    queued?: boolean;
    paused?: boolean;
    remaining?: number;
    message?: string;
    waitingForIdle?: boolean;
    jobs?: Record<string, RunningJobSnapshot>;
    logs?: QueueDebugLogEntry[];
    items?: ScheduledMessage[];
    item?: ScheduledMessage;
    identity?: ConversationIdentity;
    details?: Record<string, unknown>;
    [key: string]: unknown;
}

interface ContentScriptMessage {
    type?: string;
    action?: string;
    config?: Record<string, unknown>;
    [key: string]: unknown;
}

interface ContentScriptResponse {
    ok?: boolean;
    success?: boolean;
    error?: string;
    enabled?: boolean;
    unsupported?: boolean;
    provider?: string | null;
    messageCount?: number;
    hiddenCount?: number;
    visibleCount?: number;
    identity?: ConversationIdentity;
    state?: GenerationState;
    lastAssistant?: unknown;
    diagnostics?: unknown;
    count?: number;
    debugInfo?: Record<string, unknown>;
    [key: string]: unknown;
}

interface SelectorMatch {
    element?: any;
    selector?: string | null;
    signalKey?: string | null;
}

interface GenerationState {
    generating: boolean;
    hasActiveStopButton?: boolean;
    hasResultStreaming?: boolean;
    hasActiveToolOrResearch?: boolean;
    deepResearchActive?: boolean;
    matchedResearchMarker?: string | null;
    researchStatusPreview?: string | null;
    hasError?: boolean;
    hasDeliveryTimedOut?: boolean;
    hasTryAgainButton?: boolean;
    errorSnippet?: string;
    matchedError?: string;
    url?: string;
    title?: string;
    [key: string]: unknown;
}

interface ProviderAdapterContract {
    id?: string;
    name?: string;
    supportsOptimizer?: boolean;
    selectors?: Record<string, string[]>;
    getCompatibilityContract?: (...args: any[]) => any;
    getConversationIdentity?: (...args: any[]) => ConversationIdentity;
    getGenerationState?: (...args: any[]) => GenerationState;
    getComposerFromEventTarget?: (...args: any[]) => any;
    getComposerMatchFromEventTarget?: (...args: any[]) => any;
    getSendActionFromEventTarget?: (...args: any[]) => any;
    getComposerText?: (...args: any[]) => string;
    clearComposer?: (...args: any[]) => void;
    getLastAssistantTurn?: (...args: any[]) => any;
    clickRetryButton?: (...args: any[]) => boolean;
    getCompatibilityDiagnostics?: (...args: any[]) => any;
    getMainRoot?: (...args: any[]) => any;
    getMessageNodes?: (...args: any[]) => any[];
    normalizeMessageNode?: (...args: any[]) => any;
    isValidMessageNode?: (...args: any[]) => boolean;
    getFallbackMessages?: (...args: any[]) => any[];
    isValidFallbackNode?: (...args: any[]) => boolean;
    isSupportedUrl?: (...args: any[]) => boolean;
    [key: string]: any;
}

interface ProviderAdapterRegistryLike {
    ProviderAdapter?: unknown;
    getProvider?: (...args: any[]) => any;
    getProviderForUrl?: (...args: any[]) => any;
    getConversationIdentity?: (...args: any[]) => any;
    [key: string]: any;
}

declare function extensionApiPromise(callbackForm: Function, promiseForm?: Function): Promise<any>;
declare var getProvider: any;
declare var getProviderForUrl: any;
declare var getConversationIdentity: any;
declare function isSupportedProviderUrl(url?: string): boolean;
declare function isChatGPTUrl(url?: string): boolean;
declare function isGeminiUrl(url?: string): boolean;
declare function isClaudeUrl(url?: string): boolean;
declare function getUrlProvider(url?: string): string | null;
declare function importScripts(...urls: string[]): void;

declare var ProviderAdapterRegistry: any;
declare var ProviderAdapters: any;
declare var ProviderAdapter: any;
declare var ChatGPTAdapter: any;
declare var GeminiAdapter: any;
declare var ClaudeAdapter: any;

interface Window {
    ChatGPTOptimizerInstance?: unknown;
}
