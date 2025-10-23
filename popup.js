'use strict';

let audioCtx = null;
let micStream = null;
let tabStream = null;
let merger = null;
let dest = null;
let processor = null;
let leftChunks = [];
let rightChunks = [];
let totalSamples = 0;
let sr = 48000;

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

    dest = audioCtx.createMediaStreamDestination();
    processor = audioCtx.createScriptProcessor(4096,2,2);
    merger.connect(processor);
    processor.connect(dest);

    resetBuffers();
    processor.onaudioprocess = (e) => {
      const L = e.inputBuffer.getChannelData(0);
      const R = tabStream ? e.inputBuffer.getChannelData(1) : null;
      leftChunks.push(new Float32Array(L));
      rightChunks.push(new Float32Array(R || new Float32Array(L.length)));
      totalSamples += L.length;
    };

    btnStop.disabled=false; btnSave.disabled=true; btnUpload.disabled=true;
    setStatus(tabStream? '录音中…(Mic←左 / Tab←右)' : '录音中…(仅麦克风)');
  }catch(e){
    alert('启动失败：'+(e && e.message ? e.message : e));
    setStatus('失败');
    btnStart.disabled=false;
  }
}

function stop(){
  try{
    if (processor) processor.disconnect();
    if (merger) merger.disconnect();
    if (dest) dest.disconnect();
    if (audioCtx) audioCtx.close();
    [micStream, tabStream].forEach((s)=> s && s.getTracks().forEach((t)=> t.stop()));
  }finally{
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
    const resp = await sendMessage({ type: 'upload-audio', filename, audioBuffer });
    if (!resp || !resp.ok) {
      throw new Error(resp && resp.error ? resp.error : '上传失败');
    }
    const result = resp.result;
    outEl.value = typeof result==='string'? result : JSON.stringify(result, null, 2);
    setStatus('完成');
  }catch(e){ alert('上传/总结失败：'+(e && e.message? e.message : e)); setStatus('失败'); }
}

btnStart.addEventListener('click', start);
btnStop.addEventListener('click', stop);
btnSave.addEventListener('click', save);
btnUpload.addEventListener('click', upload);
