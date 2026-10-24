import { ChatGPTDomAdapter } from '../adapters/chatgptAdapter';
import { GoogleFlowDomAdapter } from '../adapters/googleFlowAdapter';
import { ContentScriptActionMessage } from '../adapters/tabBridgeAdapter';
import { PlatformAdapter } from '../adapters/types';
import { PlatformId } from '../types/models';

const adapters: Record<PlatformId, PlatformAdapter> = {
  chatgpt: new ChatGPTDomAdapter(),
  google_flow: new GoogleFlowDomAdapter()
};

export async function handleContentScriptMessage(
  message: ContentScriptActionMessage
): Promise<unknown> {
  const adapter = adapters[message.platformId];
  if (!adapter) {
    throw new Error(`Unsupported platform adapter: ${message.platformId}`);
  }

  switch (message.type) {
    case 'BS_ADAPTER_CHECK_AVAILABILITY':
      return adapter.checkAvailability(message.taskType, message.settings);
    case 'BS_ADAPTER_ATTACH_REFERENCES':
      return adapter.attachReferences(message.task, message.references);
    case 'BS_ADAPTER_SUBMIT_TASK':
      return adapter.submitTask(message.task, message.references, message.options);
    case 'BS_ADAPTER_GET_TASK_STATUS':
      return adapter.getTaskStatus(message.task);
    case 'BS_ADAPTER_GET_RESULTS':
      return adapter.getResults(message.task);
    case 'BS_ADAPTER_DOWNLOAD_RESULT':
      return adapter.downloadResult(message.asset, message.suggestedFilename);
    case 'BS_ADAPTER_RECOVER_TASK':
      return adapter.recoverTask(message.task);
  }
}

interface WindowWithBatchStudio extends Window {
  __BATCH_STUDIO_ACTIVE_RUNTIME_ID__?: string;
  __BATCH_STUDIO_MESSAGE_LISTENER__?: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => boolean | void;
}

const customWin = typeof window !== 'undefined' ? (window as WindowWithBatchStudio) : undefined;

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage && chrome.runtime.id) {
  const currentRuntimeId = chrome.runtime.id;

  // Cleanly remove any previous listener in this isolated world so re-injections after
  // unpacked extension reload always upgrade to the newest handler code immediately.
  if (customWin?.__BATCH_STUDIO_MESSAGE_LISTENER__ && chrome.runtime.onMessage.removeListener) {
    try {
      chrome.runtime.onMessage.removeListener(customWin.__BATCH_STUDIO_MESSAGE_LISTENER__);
    } catch {
      // Previous extension context may already be invalidated
    }
  }

  const messageListener = (
    rawMessage: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    const message = rawMessage as
      | ContentScriptActionMessage
      | { type: 'BS_PING'; platformId?: PlatformId }
      | undefined;

    if (!message || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'BS_PING') {
      sendResponse({
        ok: true,
        version: '1.1.0',
        platformId: message.platformId,
        runtimeId: currentRuntimeId,
        ready: true,
        href: typeof window !== 'undefined' ? window.location.href : ''
      });
      return true;
    }

    if (!message.type.startsWith('BS_ADAPTER_')) {
      return false;
    }

    handleContentScriptMessage(message as ContentScriptActionMessage)
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({
          available: false,
          submitted: false,
          initiated: false,
          state: 'unknown',
          detectedAssets: [],
          userMessage: err instanceof Error ? err.message : String(err)
        })
      );
    return true;
  };

  if (customWin) {
    customWin.__BATCH_STUDIO_ACTIVE_RUNTIME_ID__ = currentRuntimeId;
    customWin.__BATCH_STUDIO_MESSAGE_LISTENER__ = messageListener;
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-batch-studio-connected', currentRuntimeId);
  }

  chrome.runtime.onMessage.addListener(messageListener);
}
