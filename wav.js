// 提供: mixToWavBlob(leftChunks, rightChunks, totalSamples, sampleRate)
(function(){
  function interleaveStereo(leftBuffers, rightBuffers, totalSamples){
    const out = new Float32Array(totalSamples*2);
    let offset=0;
    for(let i=0;i<leftBuffers.length;i++){
      const L = leftBuffers[i];
      const R = rightBuffers[i] || new Float32Array(L.length);
      for(let j=0;j<L.length;j++){
        out[offset++] = L[j];
        out[offset++] = (R[j] ?? 0);
      }
    }
    return out;
  }
  function floatTo16PCM(float32){
    const out = new Int16Array(float32.length);
    for(let i=0;i<float32.length;i++){
      let s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s<0 ? s*0x8000 : s*0x7FFF;
    }
    return out;
  }
  function encodeWavStereo(interleaved, sampleRate){
    const bytesPerSample=2, blockAlign=2*bytesPerSample;
    const buffer=new ArrayBuffer(44+interleaved.length*bytesPerSample);
    const view=new DataView(buffer);
    writeStr(view,0,'RIFF');
    view.setUint32(4,36+interleaved.length*bytesPerSample,true);
    writeStr(view,8,'WAVE');
    writeStr(view,12,'fmt ');
    view.setUint32(16,16,true);
    view.setUint16(20,1,true);
    view.setUint16(22,2,true);
    view.setUint32(24,sampleRate,true);
    view.setUint32(28,sampleRate*blockAlign,true);
    view.setUint16(32,blockAlign,true);
    view.setUint16(34,16,true);
    writeStr(view,36,'data');
    view.setUint32(40,interleaved.length*bytesPerSample,true);
    const pcm16=floatTo16PCM(interleaved);
    let off=44; for(let i=0;i<pcm16.length;i++,off+=2) view.setInt16(off,pcm16[i],true);
    return new Blob([view],{type:'audio/wav'});
  }
  function writeStr(view,off,str){ for(let i=0;i<str.length;i++) view.setUint8(off+i,str.charCodeAt(i)); }

  function mixToWavBlob(leftChunks, rightChunks, totalSamples, sampleRate){
    const inter = interleaveStereo(leftChunks, rightChunks, totalSamples);
    return encodeWavStereo(inter, sampleRate);
  }

  window.WavUtil = { mixToWavBlob };
})();