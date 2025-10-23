(() => {
  const globalObj = typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this);

  if (globalObj.ApiHelpers && globalObj.ApiHelpers.__initialized) {
    return;
  }

  const SYS_TOKEN = "sys-HraOJjmzXprcFP5iEO1sfkKenzxFKqD3tY6GhZtSgQOwW8gunMcQSn67d1a8AkEW";
  const APP_TOKEN = "app-ia5iGfz0nHXBIQ317p0oTm5Js0spvUZOjIPLrqyLzaIto3HF7Ud0ElKMheuVKg0u";
  const MODEL = "语音测试";
  const DEFAULT_PROMPT = "请总结这段音频内容，并区分客服与客户要点。";
  const BASE = "https://jftool.soa.com.cn";
  const UPLOAD_URL = BASE.replace(/\/$/, "") + "/api/file/UploadUserFile";
  const CHAT_URL = BASE.replace(/\/$/, "") + "/v1/chat/completions";

  const KNOWN_UPLOAD_ERRORS = {
    "fail.login.token.invalid": "sys- Token 无效，请确认未过期。",
    "fail.http: no such file": "后端未收到文件，请确认字段名 File。",
    "fail.uploaded.file.error.type": "文件类型不在白名单，请确认扩展名。",
    "fail.uploaded.file.size": "文件大小超过限制。"
  };

  function buildAudioContent(uploadData, fallbackName) {
    const info = uploadData || {};
    const fileKey = info.FileKey || info.FileId || info.Key;
    const fileUrl = info.Url || info.FileUrl || info.UrlPath || info.Path;
    if (!fileKey && !fileUrl) {
      throw new Error("上传成功但未返回可用的文件标识");
    }

    const audioPayload = {
      Type: "file_s3",
      Name: info.Name || fallbackName,
      Url: fileUrl || fileKey,
      FileKey: fileKey,
      FileId: info.FileId,
      MimeType: info.MimeType || "audio/wav"
    };

    Object.keys(audioPayload).forEach((key) => {
      if (audioPayload[key] === undefined || audioPayload[key] === null) {
        delete audioPayload[key];
      }
    });
    return audioPayload;
  }

  function describeUploadError(payload, status) {
    const code = payload?.code;
    if (code && KNOWN_UPLOAD_ERRORS[code]) {
      return KNOWN_UPLOAD_ERRORS[code];
    }
    if (code && code !== "success") {
      return `上传失败: ${code}`;
    }
    if (payload && payload.message) {
      return `上传失败: ${payload.message}`;
    }
    return `上传失败: HTTP ${status}`;
  }

  async function parseChatResponse(chatResponse) {
    const contentType = chatResponse.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await chatResponse.json() : await chatResponse.text();

    if (!chatResponse.ok) {
      const msg = typeof payload === "string" ? payload : payload?.error?.message || JSON.stringify(payload);
      throw new Error(`总结失败: ${chatResponse.status} ${msg}`.trim());
    }

    if (typeof payload === "object" && payload !== null && payload.error) {
      const errMsg = payload.error.message || JSON.stringify(payload.error);
      throw new Error(`总结失败: ${errMsg}`);
    }

    return payload;
  }

  function formatSummaryResult(result) {
    if (!result) return "";
    if (typeof result === "string") return result;

    const collectText = (item) => {
      if (!item) return "";
      if (typeof item === "string") return item;
      if (typeof item.Text === "string") return item.Text;
      if (typeof item.text === "string") return item.text;
      if (item.type === "text" && typeof item.data === "string") return item.data;
      return "";
    };

    const choices = Array.isArray(result?.choices) ? result.choices : [];
    const segments = choices
      .map((choice) => {
        const message = choice?.message || {};
        if (Array.isArray(message.content)) {
          return message.content.map(collectText).filter(Boolean).join("\n");
        }
        if (typeof message.content === "string") {
          return message.content;
        }
        if (typeof message.text === "string") {
          return message.text;
        }
        return "";
      })
      .filter(Boolean);

    if (segments.length) {
      return segments.join("\n\n");
    }

    return JSON.stringify(result, null, 2);
  }

  async function uploadAudioBlob(audioBlob, filename, { fetchImpl = fetch } = {}) {
    const formData = new FormData();
    formData.append("File", new File([audioBlob], filename, { type: audioBlob.type || "audio/wav" }));

    const uploadResponse = await fetchImpl(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYS_TOKEN}`
      },
      body: formData
    });

    let uploadJson;
    try {
      uploadJson = await uploadResponse.json();
    } catch (err) {
      throw new Error(`上传失败: 无法解析返回 JSON (${err.message || err})`);
    }

    if (!uploadResponse.ok || uploadJson.code !== "success") {
      throw new Error(describeUploadError(uploadJson, uploadResponse.status));
    }

    const audioContent = buildAudioContent(uploadJson?.data, filename);
    return { audioContent, raw: uploadJson };
  }

  async function uploadAudioBuffer(arrayBuffer, filename, options = {}) {
    const audioBlob = new Blob([arrayBuffer], { type: "audio/wav" });
    return uploadAudioBlob(audioBlob, filename, options);
  }

  async function requestSummary(audioContent, prompt = DEFAULT_PROMPT, { fetchImpl = fetch } = {}) {
    const chatBody = {
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            audioContent,
            { Type: "text", Text: prompt }
          ]
        }
      ],
      stream: false
    };

    const chatResponse = await fetchImpl(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(chatBody)
    });

    return parseChatResponse(chatResponse);
  }

  async function summarizeAudioBuffer(arrayBuffer, filename, prompt = DEFAULT_PROMPT, options = {}) {
    const { audioContent } = await uploadAudioBuffer(arrayBuffer, filename, options);
    return requestSummary(audioContent, prompt, options);
  }

  const ApiHelpers = {
    SYS_TOKEN,
    APP_TOKEN,
    MODEL,
    DEFAULT_PROMPT,
    BASE,
    UPLOAD_URL,
    CHAT_URL,
    buildAudioContent,
    describeUploadError,
    parseChatResponse,
    formatSummaryResult,
    uploadAudioBlob,
    uploadAudioBuffer,
    requestSummary,
    summarizeAudioBuffer,
    __initialized: true
  };

  globalObj.ApiHelpers = ApiHelpers;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ApiHelpers;
  }
})();
