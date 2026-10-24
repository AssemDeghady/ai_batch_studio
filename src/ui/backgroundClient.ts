import {
  BackgroundCommandMessage,
  handleBackgroundCommand
} from '../background/serviceWorker';

export async function dispatchBackgroundCommand<T = unknown>(
  command: BackgroundCommandMessage
): Promise<T> {
  if (
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    typeof chrome.runtime.sendMessage === 'function' &&
    chrome.runtime.id
  ) {
    try {
      const response = await chrome.runtime.sendMessage(command);
      if (response && typeof response === 'object' && 'ok' in response) {
        if (!response.ok) {
          throw new Error(response.error || 'Background command failed');
        }
        return response.data as T;
      }
    } catch {
      // Fall back to direct execution in same-context / test runner
    }
  }
  return (await handleBackgroundCommand(command)) as T;
}
