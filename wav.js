// 提供: 1) mixToWavBlob(leftChunks, rightChunks, totalSamples, sampleRate)
//      2) uploadToAI(wavBlob, filename, cfg)
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

  async function uploadToAI(wavBlob, filename, cfg){
    const BASE='https://jftool.soa.com.cn';
    const UPLOAD_URL = BASE.replace(/\/$/,'') + '/api/file/UploadUserFile';
    const CHAT_URL   = BASE.replace(/\/$/,'') + '/v1/chat/completions';

    // 1) upload
    const fd=new FormData();
    fd.append('File', new File([wavBlob], filename, {type:'audio/wav'}));
    const up = await fetch(UPLOAD_URL, {method:'POST', headers:{'Authorization':`Bearer ${cfg.sysToken}`}, body:fd});
    const upJ = await up.json();
    if(!up.ok || upJ.code!=='success') throw new Error('上传失败: '+(upJ.code||up.status));
    const fileKey = upJ?.data?.FileKey; const retName = upJ?.data?.Name || filename;
    if(!fileKey) throw new Error('上传成功但未返回 FileKey');

    // 2) chat
    const body={
      model: cfg.model,
      messages:[{role:'user', content:[{Type:'file_s3', Name:retName, Url:fileKey},{Type:'text', Text:cfg.prompt}]}],
      stream:false
    };
    const chat=await fetch(CHAT_URL,{method:'POST', headers:{'Authorization':`Bearer ${cfg.appToken}`,'Content-Type':'application/json; charset=utf-8'}, body:JSON.stringify(body)});
    const ctype=chat.headers.get('content-type')||'';
    return ctype.includes('application/json') ? chat.json() : chat.text();
  }

  function mixToWavBlob(leftChunks, rightChunks, totalSamples, sampleRate){
    const inter = interleaveStereo(leftChunks, rightChunks, totalSamples);
    return encodeWavStereo(inter, sampleRate);
  }

  window.WavUtil = { mixToWavBlob, uploadToAI };
})();