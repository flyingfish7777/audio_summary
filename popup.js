'use strict';

let audioCtx = null;
let micStream = null;
let tabStream = null;
let merger = null;
let recorderNode = null;
let silentGain = null;
let leftChunks = [];
let rightChunks = [];
let totalSamples = 0;
let sr = 48000;

const SYS_TOKEN = "sys-HraOJjmzXprcFP5iEO1sfkKenzxFKqD3tY6GhZtSgQOwW8gunMcQSn67d1a8AkEW";
const APP_TOKEN = "app-ia5iGfz0nHXBIQ317p0oTm5Js0spvUZOjIPLrqyLzaIto3HF7Ud0ElKMheuVKg0u";
const MODEL = "语音测试";
const DEFAULT_PROMPT = "请总结这段音频内容，并区分客服与客户要点。";
const BASE = "https://jftool.soa.com.cn";
const UPLOAD_URL = BASE.replace(/\/$/, "") + "/api/file/UploadUserFile";
const CHAT_URL = BASE.replace(/\/$/, "") + "/v1/chat/completions";

const $ = (id) => document.getElementById(id);
const btnStart = $('btnStart');
const btnStop = $('btnStop');
const btnSave = $('btnSave');
const btnUpload = $('btnUpload');
const statusEl = $('status');
const outEl = $('output');
const filenameEl = $('filename');

function setStatus(s) { statusEl.textContent = s; }
function resetBuffers(){ leftChunks=[]; rightChunks=[]; totalSamples=0; }

function captureCurrentTabAudio(){
  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio:true, video:false }, (stream) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message || 'tabCapture 失败')); return; }
      resolve(stream || null);
    });
  });
}

function ensureRightChannelArray(sourceArray, desiredLength){
  if (sourceArray && sourceArray.length === desiredLength) {
    return sourceArray;
  }
  return new Float32Array(desiredLength);
}

async function start(){
  try{
    setStatus('请求权限/初始化…');
    btnStart.disabled = true;

    micStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false } });

    try {
      tabStream = await captureCurrentTabAudio();
    } catch (e) {
      console.warn('捕获当前标签页失败：', e && e.message);
      tabStream = null;
    }

    if (!tabStream || tabStream.getAudioTracks().length === 0) {
      console.warn('未拿到标签页音频，降级为仅麦克风');
      tabStream = null;
    }

    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    if (!audioCtx.audioWorklet) {
      throw new Error('当前环境不支持 AudioWorkletNode');
    }

    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('recorder-worklet.js'));

    sr = audioCtx.sampleRate;

    const micSrc = audioCtx.createMediaStreamSource(micStream);
    const micGain = audioCtx.createGain(); micGain.gain.value = 1.0; micSrc.connect(micGain);

    merger = audioCtx.createChannelMerger(2);
    micGain.connect(merger,0,0);

    if (tabStream) {
      const tabSrc = audioCtx.createMediaStreamSource(tabStream);
      const tabGain = audioCtx.createGain(); tabGain.gain.value = 1.0; tabSrc.connect(tabGain);
      tabGain.connect(merger,0,1);
    }

    recorderNode = new AudioWorkletNode(audioCtx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    });

    resetBuffers();

    recorderNode.port.onmessage = (event) => {
      const data = event.data || {};
      const channels = data.channels;
      if (!channels || !channels.length) return;
      const left = channels[0] instanceof Float32Array ? channels[0] : new Float32Array(channels[0] || []);
      const rightRaw = channels[1] instanceof Float32Array ? channels[1] : (channels[1] ? new Float32Array(channels[1]) : null);
      leftChunks.push(left);
      rightChunks.push(ensureRightChannelArray(rightRaw, left.length));
      totalSamples += left.length;
    };

    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;

    merger.connect(recorderNode);
    recorderNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    btnStop.disabled=false; btnSave.disabled=true; btnUpload.disabled=true;
    setStatus(tabStream? '录音中…(Mic←左 / Tab←右)' : '录音中…(仅麦克风)');
  }catch(e){
    alert('启动失败：'+(e && e.message ? e.message : e));
    setStatus('失败');
    btnStart.disabled=false;
    cleanupAudioGraph();
  }
}

function cleanupAudioGraph(){
  if (recorderNode) {
    try { recorderNode.port.onmessage = null; recorderNode.disconnect(); } catch (_) {}
    recorderNode = null;
  }
  if (silentGain) {
    try { silentGain.disconnect(); } catch (_) {}
    silentGain = null;
  }
  if (merger) {
    try { merger.disconnect(); } catch (_) {}
    merger = null;
  }
  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
}

function stop(){
  try{
    cleanupAudioGraph();
    [micStream, tabStream].forEach((s)=> s && s.getTracks().forEach((t)=> t.stop()));
  }finally{
    micStream = null;
    tabStream = null;
    btnStop.disabled=true; btnStart.disabled=false; btnSave.disabled=false; btnUpload.disabled=false;
    setStatus('已停止，待保存/上传');
  }
}

function save(){
  try{
    if (totalSamples===0) throw new Error('没有有效音频');
    const blob = WavUtil.mixToWavBlob(leftChunks, rightChunks, totalSamples, sr);
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=(filenameEl.value||'recording.wav').replace(/[^A-Za-z0-9_.-]+/g,'_');
    a.click();
    setStatus('已保存');
  }catch(e){ alert(e.message||String(e)); }
}

function sendMessage(msg){
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
      } else {
        resolve(resp);
      }
    });
  });
}

async function upload(){
  try{
    if (totalSamples===0) throw new Error('没有有效音频');
    setStatus('上传中…');
    const blob = WavUtil.mixToWavBlob(leftChunks, rightChunks, totalSamples, sr);
    const filename=(filenameEl.value||'recording.wav').replace(/[^A-Za-z0-9_.-]+/g,'_');
    const audioBuffer = await blob.arrayBuffer();
    let resp;
    try {
      resp = await sendMessage({ type: 'upload-audio', filename, audioBuffer });
    } catch (err) {
      if (err && err.message && err.message.includes('Receiving end does not exist')) {
        resp = await uploadDirectly(filename, audioBuffer);
      } else {
        throw err;
      }
    }
    if (!resp || !resp.ok) {
      throw new Error(resp && resp.error ? resp.error : '上传失败');
    }
    const result = resp.result;
    outEl.value = typeof result==='string'? result : JSON.stringify(result, null, 2);
    setStatus('完成');
  }catch(e){ alert('上传/总结失败：'+(e && e.message? e.message : e)); setStatus('失败'); }
}

async function uploadDirectly(filename, audioBuffer) {
  const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
  const formData = new FormData();
  formData.append('File', new File([audioBlob], filename, { type: 'audio/wav' }));

  const uploadResponse = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SYS_TOKEN}`
    },
    body: formData
  });

  const uploadJson = await uploadResponse.json();
  if (!uploadResponse.ok || uploadJson.code !== 'success') {
    return { ok: false, error: `上传失败: ${uploadJson.code || uploadResponse.status}` };
  }

  const fileKey = uploadJson?.data?.FileKey;
  const returnedName = uploadJson?.data?.Name || filename;
  if (!fileKey) {
    return { ok: false, error: '上传成功但未返回 FileKey' };
  }

  const chatBody = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { Type: 'file_s3', Name: returnedName, Url: fileKey },
          { Type: 'text', Text: DEFAULT_PROMPT }
        ]
      }
    ],
    stream: false
  };

  const chatResponse = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${APP_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(chatBody)
  });

  const contentType = chatResponse.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await chatResponse.json() : await chatResponse.text();
  if (!chatResponse.ok) {
    const msg = typeof result === 'string' ? result : JSON.stringify(result);
    return { ok: false, error: `总结失败: ${chatResponse.status} ${msg}`.trim() };
  }
  return { ok: true, result };
}

btnStart.addEventListener('click', start);
btnStop.addEventListener('click', stop);
btnSave.addEventListener('click', save);
btnUpload.addEventListener('click', upload);
