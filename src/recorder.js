const statusText = document.querySelector('#statusText');
const startBtn = document.querySelector('#startBtn');
const stopBtn = document.querySelector('#stopBtn');
const saveBtn = document.querySelector('#saveBtn');
const audioPlayerSection = document.querySelector('.player');
const audioPlayer = document.querySelector('#audioPlayer');
const AudioContextClass = window.AudioContext || window.webkitAudioContext;

if (!AudioContextClass || !navigator.mediaDevices) {
  statusText.textContent = '当前浏览器不支持录音所需的 API。';
  startBtn.disabled = true;
}

class RecorderController {
  constructor() {
    this.audioContext = null;
    this.processorNode = null;
    this.silenceNode = null;
    this.microphoneSourceNode = null;
    this.systemSourceNode = null;
    this.microphoneStream = null;
    this.systemStream = null;
    this.activeStreams = [];
    this.sampleRate = 44100;
    this.buffers = [];
    this.state = 'idle';
    this.recordedBlob = null;
  }

  async start() {
    if (this.state === 'recording') {
      throw new Error('录音已经在进行中');
    }

    if (!AudioContextClass) {
      throw new Error('当前浏览器不支持 Web Audio API');
    }

    let microphoneStream;
    let systemStream;

    try {
      ({ microphoneStream, systemStream } = await this.#createCombinedStream());

      this.audioContext = new AudioContextClass();
      this.sampleRate = this.audioContext.sampleRate;
      this.buffers = [];

      const bufferSize = 4096;
      this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 2, 1);
      this.processorNode.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer;
        const chunk = this.#mixToMono(inputBuffer);
        this.buffers.push(chunk);
      };

      this.microphoneSourceNode = this.audioContext.createMediaStreamSource(microphoneStream);
      this.systemSourceNode = this.audioContext.createMediaStreamSource(systemStream);
      this.microphoneSourceNode.connect(this.processorNode);
      this.systemSourceNode.connect(this.processorNode);

      this.silenceNode = this.audioContext.createGain();
      this.silenceNode.gain.value = 0;
      this.processorNode.connect(this.silenceNode);
      this.silenceNode.connect(this.audioContext.destination);

      this.microphoneStream = microphoneStream;
      this.systemStream = systemStream;
      this.activeStreams = [microphoneStream, systemStream];

      this.state = 'recording';
      this.recordedBlob = null;
    } catch (error) {
      this.#stopStream(microphoneStream);
      this.#stopStream(systemStream);
      this.#reset();
      throw error;
    }
  }

  async stop() {
    if (this.state !== 'recording') {
      throw new Error('当前没有进行中的录音');
    }

    this.processorNode?.disconnect();
    this.silenceNode?.disconnect();
    this.microphoneSourceNode?.disconnect();
    this.systemSourceNode?.disconnect();
    this.#stopActiveStreams();

    if (this.audioContext) {
      await this.audioContext.close();
    }

    const samples = this.#mergeBuffers(this.buffers);
    const wavBuffer = this.#encodeWAV(samples, this.sampleRate);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });

    this.#reset();
    this.recordedBlob = blob;
    return blob;
  }

  get hasRecording() {
    return Boolean(this.recordedBlob);
  }

  async placeholderSendToApi() {
    if (!this.recordedBlob) {
      throw new Error('请先完成录音');
    }
    // TODO: 将包含麦克风与系统音频的混合结果上传至后端 API，处理返回的 AI 总结。
    // 例如：
    // const formData = new FormData();
    // formData.append('file', this.recordedBlob, 'recording.wav');
    // const response = await fetch('https://example.com/api/audio-summary', {
    //   method: 'POST',
    //   body: formData,
    // });
    // const result = await response.json();
    // console.log(result.summary);
  }

  #reset() {
    this.audioContext = null;
    this.processorNode = null;
    this.silenceNode = null;
    this.microphoneSourceNode = null;
    this.systemSourceNode = null;
    this.microphoneStream = null;
    this.systemStream = null;
    this.activeStreams = [];
    this.sampleRate = 44100;
    this.buffers = [];
    this.state = 'idle';
  }

  async #createCombinedStream() {
    if (!navigator.mediaDevices?.getDisplayMedia || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('浏览器不支持同时捕获麦克风与系统音频。');
    }

    let systemStream;
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 44100,
        },
      });
      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        displayStream.getTracks().forEach((track) => track.stop());
        throw new Error('未检测到系统或标签页的音频轨道。');
      }
      displayStream.getVideoTracks().forEach((track) => track.stop());
      systemStream = new MediaStream(audioTracks);
    } catch (error) {
      throw new Error(this.#translateError(error, 'system'));
    }

    let microphoneStream;
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
        },
      });
    } catch (error) {
      this.#stopStream(systemStream);
      throw new Error(this.#translateError(error, 'microphone'));
    }

    return { microphoneStream, systemStream };
  }

  #translateError(error, type) {
    const target = type === 'system' ? '系统音频' : '麦克风';
    if (!error) {
      return `无法获取${target}。`;
    }

    const name = error.name || '';
    const message = (error.message || '').toLowerCase();

    if (name === 'NotAllowedError' || name === 'SecurityError') {
      if (message.includes('dismissed')) {
        return `用户取消了${target}权限请求，请重新点击“开始录制”并选择允许。`;
      }
      return `用户拒绝了${target}权限，请允许浏览器访问${target}。`;
    }

    if (name === 'NotFoundError') {
      return type === 'system'
        ? '未检测到可共享的系统或标签页音频，请确认所选窗口有音频输出。'
        : '未检测到可用的麦克风设备，请检查连接后重试。';
    }

    if (name === 'AbortError' || name === 'NotReadableError') {
      return `${target}设备被占用或不可用，请关闭其他应用后重试。`;
    }

    if (type === 'system' && name === 'TypeError') {
      return '需要选择一个要共享的窗口或标签页才能采集系统音频。';
    }

    return error.message || `无法获取${target}。`;
  }

  #stopActiveStreams() {
    this.activeStreams.forEach((stream) => this.#stopStream(stream));
    this.activeStreams = [];
  }

  #stopStream(stream) {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
  }

  #mixToMono(inputBuffer) {
    const channelCount = inputBuffer.numberOfChannels;
    const frameCount = inputBuffer.length;
    const output = new Float32Array(frameCount);

    for (let channel = 0; channel < channelCount; channel += 1) {
      const channelData = inputBuffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i += 1) {
        output[i] += channelData[i] / channelCount;
      }
    }

    return output;
  }

  #mergeBuffers(bufferList) {
    const totalLength = bufferList.reduce((sum, buffer) => sum + buffer.length, 0);
    const result = new Float32Array(totalLength);
    let offset = 0;
    bufferList.forEach((buffer) => {
      result.set(buffer, offset);
      offset += buffer.length;
    });
    return result;
  }

  #encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    this.#writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    this.#writeString(view, 8, 'WAVE');
    this.#writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    this.#writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    this.#floatTo16BitPCM(view, 44, samples);
    return buffer;
  }

  #floatTo16BitPCM(view, offset, samples) {
    for (let i = 0; i < samples.length; i += 1, offset += 2) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, s, true);
    }
  }

  #writeString(view, offset, string) {
    for (let i = 0; i < string.length; i += 1) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

const recorder = new RecorderController();

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = true;
  saveBtn.disabled = true;
  statusText.textContent = '正在请求麦克风和系统音频权限…';

  try {
    await recorder.start();
    statusText.textContent = '录音中…麦克风与系统音频已开始混合。';
    stopBtn.disabled = false;
  } catch (error) {
    console.error(error);
    statusText.textContent = `启动录音失败：${error.message}`;
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  statusText.textContent = '正在停止录音…';
  try {
    const blob = await recorder.stop();
    statusText.textContent = '录音完成，可点击保存或重新录制。';
    startBtn.disabled = false;
    saveBtn.disabled = false;
    audioPlayer.src = URL.createObjectURL(blob);
    audioPlayerSection.hidden = false;
  } catch (error) {
    console.error(error);
    statusText.textContent = `停止录音失败：${error.message}`;
    startBtn.disabled = false;
  }
});

saveBtn.addEventListener('click', () => {
  if (!recorder.hasRecording) {
    statusText.textContent = '没有可保存的录音，请先录制音频。';
    return;
  }

  const downloadLink = document.createElement('a');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadLink.href = URL.createObjectURL(recorder.recordedBlob);
  downloadLink.download = `recording-${timestamp}.wav`;
  downloadLink.click();
  URL.revokeObjectURL(downloadLink.href);
  statusText.textContent = 'WAV 文件已保存。';
});

window.addEventListener('beforeunload', () => {
  if (recorder.state === 'recording') {
    recorder.stop().catch((error) => {
      console.error('卸载前停止录音失败', error);
    });
  }
});
