const SYS_TOKEN = "sys-HraOJjmzXprcFP5iEO1sfkKenzxFKqD3tY6GhZtSgQOwW8gunMcQSn67d1a8AkEW";
const APP_TOKEN = "app-ia5iGfz0nHXBIQ317p0oTm5Js0spvUZOjIPLrqyLzaIto3HF7Ud0ElKMheuVKg0u";
const MODEL = "语音测试";
const DEFAULT_PROMPT = "请总结这段音频内容，并区分客服与客户要点。";

const BASE = "https://jftool.soa.com.cn";
const UPLOAD_URL = BASE.replace(/\/$/, "") + "/api/file/UploadUserFile";
const CHAT_URL = BASE.replace(/\/$/, "") + "/v1/chat/completions";

async function uploadAudio(arrayBuffer, filename) {
  const audioBlob = new Blob([arrayBuffer], { type: "audio/wav" });
  const formData = new FormData();
  formData.append("File", new File([audioBlob], filename, { type: "audio/wav" }));

  const uploadResponse = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SYS_TOKEN}`
    },
    body: formData
  });

  const uploadJson = await uploadResponse.json();
  if (!uploadResponse.ok || uploadJson.code !== "success") {
    throw new Error(`上传失败: ${uploadJson.code || uploadResponse.status}`);
  }

  const fileKey = uploadJson?.data?.FileKey;
  const returnedName = uploadJson?.data?.Name || filename;
  if (!fileKey) {
    throw new Error("上传成功但未返回 FileKey");
  }

  const chatBody = {
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [
          { Type: "file_s3", Name: returnedName, Url: fileKey },
          { Type: "text", Text: DEFAULT_PROMPT }
        ]
      }
    ],
    stream: false
  };

  const chatResponse = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${APP_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(chatBody)
  });

  const contentType = chatResponse.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return chatResponse.json();
  }
  return chatResponse.text();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "upload-audio") {
    uploadAudio(message.audioBuffer, message.filename)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  return undefined;
});
