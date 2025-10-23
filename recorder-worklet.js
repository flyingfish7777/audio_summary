class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs && inputs[0];
    if (input && input.length) {
      const channels = [];
      for (let i = 0; i < input.length; i++) {
        const channelData = input[i];
        if (channelData && channelData.length) {
          channels.push(new Float32Array(channelData));
        } else {
          channels.push(new Float32Array(0));
        }
      }
      if (channels.length) {
        this.port.postMessage({ channels });
      }
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
