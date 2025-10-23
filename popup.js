'use strict';

let audioCtx = null;
let micStream = null;
let tabStream = null;   // 这里可能是系统音频流或当前标签页音频流
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
const sysTokenEl = $('sysToken');
const appTokenEl = $('appToken');
const modelEl = $('model');
const promptEl = $('prompt');
const sourceEl = $('source');
const audioInputEl = $('audioInput');
const btnRefresh = $('btnRefresh');

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

function captureSystemAudio(){
  return new Promise((resolve, reject) => {
    const sources = ['screen','window','audio'];
    chrome.desktopCapture.chooseDesktopMedia(sources, (streamId) => {
      if (!streamId) return reject(new Error('用户取消或权限被拒绝'));
      navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } },
        video: false
      }).then(resolve).catch(reject);
    });
  });
}

async function listAudioInputs(){
  try{
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d=>d.kind==='audioinput');
    const sel = audioInputEl.value;
    audioInputEl.innerHTML = '';
    inputs.forEach(d=>{
      const opt=document.createElement('option');
      opt.value=d.deviceId; opt.textContent=d.label||`音频输入设备(${d.deviceId.slice(0,6)})`;
      audioInputEl.appendChild(opt);
    });
    if (sel) audioInputEl.value = sel;
  }catch(e){ console.warn('列出音频设备失败：', e); }
}

async function getMicByDeviceId(deviceId){
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId? {exact: deviceId}: undefined, echoCancellation:false, noiseSuppression:false, autoGainControl:false }
  });
}

async function start(){
  try{
    setStatus('请求权限/初始化…');
    btnStart.disabled = true;

    // 0) 填充设备列表（需要一次 getUserMedia 才能拿到设备 label）
    try { await navigator.mediaDevices.getUserMedia({audio:true}); } catch(_){/* ignore */}
    await listAudioInputs();

    // 1) 麦克风（默认设备，若选择“指定输入设备”会在后面替换）
    micStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false } });

    // 2) 按选择的来源捕获音频（带回退）
    const choice = sourceEl.value; // 'system' | 'current' | 'audible' | 'inputDevice'

    function getLastAudibleTabId() {
      return new Promise((resolve) => {
        chrome.tabs.query({ audible: true, lastFocusedWindow: true }, (tabs) => {
          const ok = (t) => t && t.id && t.url && !/^chrome:|^edge:|^devtools:|^chrome-extension:/.test(t.url);
          const found = (tabs || []).find(ok);
          resolve(found ? found.id : null);
        });
      });
    }
    function getActiveTabId() {
      return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0] ? tabs[0].id : null));
      });
    }
    function activateTab(tabId) {
      return new Promise((resolve) => {
        if (!tabId) return resolve(false);
        chrome.tabs.update(tabId, { active: true }, () => resolve(true));
      });
    }
    async function tryTabCaptureEnsureActive(tabId) {
      if (tabId) await activateTab(tabId);
      const s = await captureCurrentTabAudio();
      if (!s || s.getAudioTracks().length === 0) throw new Error('tabCapture无音轨');
      return s;
    }

    async function captureByChoice() {
      if (choice === 'inputDevice') {
        const devId = audioInputEl.value || undefined;
        micStream && micStream.getTracks().forEach(t=>t.stop());
        micStream = await getMicByDeviceId(devId);
        return null; // 不再需要 tab/system 流
      }
      if (choice === 'system') {
        try { return await captureSystemAudio(); }
        catch (e) {
          console.warn('系统音频失败，回退到标签页捕获：', e && e.message);
          try { return await tryTabCaptureEnsureActive(await getActiveTabId()); }
          catch (e1) {
            const audibleId = await getLastAudibleTabId();
            if (audibleId) return await tryTabCaptureEnsureActive(audibleId);
            throw e;
          }
        }
      }
      if (choice === 'current') {
        return await tryTabCaptureEnsureActive(await getActiveTabId());
      }
      if (choice === 'audible') {
        const audibleId = await getLastAudibleTabId();
        if (!audibleId) throw new Error('找不到有声音的标签页');
        return await tryTabCaptureEnsureActive(audibleId);
      }
      throw new Error('未知来源');
    }

    try {
      tabStream = await captureByChoice();
    } catch (e) {
      console.warn('捕获失败：', e && e.message);
      tabStream = null;
      if ((e && /Permission dismissed/i.test(e.message)) || (e && /Permission denied/i.test(e.message))) {
        setStatus('捕获被取消或拒绝。可改选“当前标签页/有声音标签页/指定输入设备”。');
      }
    }

    if (choice!=='inputDevice' && (!tabStream || tabStream.getAudioTracks().length === 0)) {
      console.warn('未拿到系统/标签页音频，降级为仅麦克风');
      tabStream = null;
    }

    // 3) WebAudio 混音（Mic->左，系统/标签页->右）
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
    setStatus(tabStream? '录音中…(Mic←左 / System/Tab←右)' : '录音中…(仅麦克风)');
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
    btnStop.disabled=true; btnSave.disabled=false; btnUpload.disabled=false; btnStart.disabled=false;
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

async function upload(){
  try{
    if (totalSamples===0) throw new Error('没有有效音频');
    const cfg={ sysToken: sysTokenEl.value.trim(), appToken: appTokenEl.value.trim(), model: modelEl.value.trim()||'语音测试', prompt: promptEl.value.trim() };
    if(!cfg.sysToken||!cfg.appToken) throw new Error('请填写 SYS_TOKEN / APP_TOKEN');

    setStatus('上传中…');
    const blob = WavUtil.mixToWavBlob(leftChunks, rightChunks, totalSamples, sr);
    const filename=(filenameEl.value||'recording.wav').replace(/[^A-Za-z0-9_.-]+/g,'_');
    const resp = await WavUtil.uploadToAI(blob, filename, cfg);
    outEl.value = typeof resp==='string'? resp : JSON.stringify(resp, null, 2);
    setStatus('完成');
  }catch(e){ alert('上传/总结失败：'+(e && e.message? e.message : e)); setStatus('失败'); }
}

btnStart.addEventListener('click', start);
btnStop.addEventListener('click', stop);
btnSave.addEventListener('click', save);
btnUpload.addEventListener('click', upload);
btnRefresh.addEventListener('click', listAudioInputs);

// 记忆 tokens（回调风格）
chrome.storage.local.get({ sysToken:'', appToken:'' }, (saved)=>{
  if (saved && typeof saved==='object') {
    if (saved.sysToken) sysTokenEl.value = saved.sysToken;
    if (saved.appToken) appTokenEl.value = saved.appToken;
  }
});

sysTokenEl.addEventListener('change', ()=>{ chrome.storage.local.set({ sysToken: sysTokenEl.value.trim() }); });
appTokenEl.addEventListener('change', ()=>{ chrome.storage.local.set({ appToken: appTokenEl.value.trim() }); });
