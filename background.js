importScripts('api-helpers.js');

const {
  summarizeAudioBuffer,
  formatSummaryResult
} = ApiHelpers;

async function uploadAudio(arrayBuffer, filename) {
  const result = await summarizeAudioBuffer(arrayBuffer, filename);
  return {
    result,
    text: formatSummaryResult(result)
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "upload-audio") {
    uploadAudio(message.audioBuffer, message.filename)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  return undefined;
});
