const statusText = document.querySelector('#statusText');
const startBtn = document.querySelector('#startBtn');
const stopBtn = document.querySelector('#stopBtn');
const saveBtn = document.querySelector('#saveBtn');
const audioSourceSelect = document.querySelector('#audioSource');
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
    this.sourceNode = null;
    this.processorNode = null;
    this.mediaStream = null;
    this.sampleRate = 44100;
    this.buffers = [];
    this.state = 'idle';
    this.recordedBlob = null;
    this.silenceNode = null;
  }

  async start(sourceType = 'microphone') {
    if (this.state === 'recording') {
      throw new Error('录音已经在进行中');
    }

    this.mediaStream = await this.#createStream(sourceType);
    if (!AudioContextClass) {
      throw new Error('当前浏览器不支持 Web Audio API');
    }

    this.audioContext = new AudioContextClass();
    this.sampleRate = this.audioContext.sampleRate;
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.buffers = [];

    const bufferSize = 4096;
    const channelCount = this.#detectChannelCount();
    this.processorNode = this.audioContext.createScriptProcessor(bufferSize, channelCount, 1);
    this.processorNode.onaudioprocess = (event) => {
      const inputBuffer = event.inputBuffer;
      const chunk = this.#mixToMono(inputBuffer);
      this.buffers.push(chunk);
    };

    this.sourceNode.connect(this.processorNode);
    this.silenceNode = this.audioContext.createGain();
    this.silenceNode.gain.value = 0;
    this.processorNode.connect(this.silenceNode);
    this.silenceNode.connect(this.audioContext.destination);

    this.state = 'recording';
    this.recordedBlob = null;
  }

  async stop() {
    if (this.state !== 'recording') {
      throw new Error('当前没有进行中的录音');
    }

    this.processorNode?.disconnect();
    this.silenceNode?.disconnect();
    this.sourceNode?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());

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
    // TODO: 将 this.recordedBlob 发送到后端 API，并处理返回的 AI 总结结果。
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
    this.sourceNode = null;
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
    }
    this.processorNode = null;
    this.mediaStream = null;
    this.sampleRate = 44100;
    this.buffers = [];
    this.state = 'idle';
    this.silenceNode = null;
  }

  #detectChannelCount() {
    if (this.sourceNode?.channelCount) {
      return Math.min(this.sourceNode.channelCount, 2);
    }
    const track = this.mediaStream?.getAudioTracks()[0];
    const reported = track?.getSettings?.().channelCount;
    return reported && reported > 0 ? Math.min(reported, 2) : 2;
  }

  async #createStream(sourceType) {
    if (sourceType === 'system') {
      if (!navigator.mediaDevices.getDisplayMedia) {
        throw new Error('浏览器不支持采集系统或标签页音频');
      }
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: { echoCancellation: false, noiseSuppression: false },
      });
      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        displayStream.getTracks().forEach((track) => track.stop());
        throw new Error('未检测到系统/标签页音频轨道');
      }
      // 移除视频轨道，仅保留音频
      displayStream.getVideoTracks().forEach((track) => track.stop());
      return new MediaStream(audioTracks);
    }

    if (!navigator.mediaDevices.getUserMedia) {
      throw new Error('浏览器不支持麦克风录音');
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100,
      },
    });
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
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
    view.setUint16(22, 1, true); // NumChannels
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
    view.setUint16(32, 2, true); // BlockAlign (NumChannels * BitsPerSample/8)
    view.setUint16(34, 16, true); // BitsPerSample
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
  statusText.textContent = '正在请求音频权限…';

  try {
    await recorder.start(audioSourceSelect.value);
    statusText.textContent = '录音中…点击“结束录制”停止。';
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
