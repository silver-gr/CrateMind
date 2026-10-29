(() => {
  const fixtures = __NATIVE_QA_FIXTURES__;
  const report = {pending:true, origin:location.origin, user_agent:navigator.userAgent, checks:{}, media:[]};
  const budgetDeadline=Date.now()+110000; // Leave the fixed Rust probe's 120-second deadline time to collect the report.
  window.__cratemindNativeQa=report;
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const wait=async(predicate,timeout=15000)=>{const deadline=Math.min(budgetDeadline,Date.now()+timeout);while(Date.now()<deadline){if(predicate())return;await delay(100)}throw Error('Timed out waiting for rendered application')};
  const navigate=async(path)=>{await wait(()=>document.querySelector('a[href="'+path+'"]'));document.querySelector('a[href="'+path+'"]').click()};
  const probe=async(name,fn)=>{try{report.checks[name]={ok:true,value:await fn()}}catch(error){report.checks[name]={ok:false,error:String(error),...(error.unverified?{unverified:true}: {})}}};
  const bounded=async(promise,timeout,label)=>{
    let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),Math.max(1,Math.min(timeout,budgetDeadline-Date.now())))})])}finally{clearTimeout(timer)}
  };
  const unverified=message=>Object.assign(Error(message),{unverified:true});
  // Fixed UI-only background acceptance. No caller-supplied script, selectors, or
  // preferences enter this probe; the existing fixture-only Rust gate owns access.
  const backgroundIds=['soft-aurora','scanner','grainient','grainient-aurora','threads','particles','aurora','prismatic-burst','faulty-terminal'];
  let backgroundDeadline=budgetDeadline;
  const backgroundPicker=()=>Array.from(document.querySelectorAll('main [role="combobox"][aria-label="Φόντο εφαρμογής"]')).find(node=>node.offsetParent!==null);
  const selectBackground=async(value)=>{
    await wait(()=>backgroundPicker(),3000);
    const picker=backgroundPicker();if(!picker)throw Error('Settings background picker is unavailable');
    picker.click();
    await wait(()=>Array.from(document.querySelectorAll('[role="option"][data-background-option]')).some(node=>node.dataset.backgroundOption===value),3000);
    const option=Array.from(document.querySelectorAll('[role="option"][data-background-option]')).find(node=>node.dataset.backgroundOption===value);
    if(!option)throw Error('Settings background option is unavailable');
    option.click();
    await wait(()=>backgroundPicker()?.dataset.backgroundValue===value&&document.querySelector('.cm-background')?.dataset.background===value&&backgroundPicker()?.getAttribute('aria-expanded')==='false',3000);
  };
  const selectTheme=async(value)=>{
    if(document.documentElement.dataset.theme===value)return;
    const button=Array.from(document.querySelectorAll('button[aria-label^="Εναλλαγή σε "]')).find(node=>node.offsetParent!==null);
    if(!button)throw Error('Theme toggle is unavailable');
    button.click();await wait(()=>document.documentElement.dataset.theme===value,3000);
  };
  const backgroundPixels=canvas=>new Promise((resolve,reject)=>{
    const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
    if(!gl){reject(Error('Selected background has no WebGL context'));return}
    const width=Math.min(gl.drawingBufferWidth,1024);const height=Math.min(gl.drawingBufferHeight,1024);
    if(width<1||height<1){reject(Error('Selected background has an empty drawing buffer'));return}
    const pixels=new Uint8Array(width*height*4); // At most 4MiB, never returned in the report.
    const x=Math.floor((gl.drawingBufferWidth-width)/2);const y=Math.floor((gl.drawingBufferHeight-height)/2);
    let raf=0;let frames=0;let timer;
    const finish=(error,value)=>{cancelAnimationFrame(raf);clearTimeout(timer);error?reject(error):resolve(value)};
    const sample=()=>{
      try{
        if(document.hidden)throw unverified('Native background pixel proof requires a visible application');
        if(!canvas.isConnected||gl.isContextLost())throw Error('Selected background canvas was lost during pixel capture');
        frames++;gl.readPixels(x,y,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        const error=gl.getError();if(error!==gl.NO_ERROR)throw Error('Background pixel read failed: '+error);
        let rgbNonzero=0;let alphaNonzero=0;let rgbSum=0;
        for(let i=0;i<pixels.length;i+=4){const sum=pixels[i]+pixels[i+1]+pixels[i+2];rgbSum+=sum;if(sum>0)rgbNonzero++;if(pixels[i+3]>0)alphaNonzero++}
        if(rgbNonzero>0){finish(null,{frames,sampled_width:width,sampled_height:height,rgb_nonzero_pixels:rgbNonzero,rgb_sum:rgbSum,alpha_nonzero_pixels:alphaNonzero});return}
        // preserveDrawingBuffer=false clears after composition. Sampling directly
        // in consecutive RAF callbacks catches the selected renderer's 30fps draw.
        if(frames<6)raf=requestAnimationFrame(sample);
        else finish(Error('No nonzero background RGB pixels within six animation frames'));
      }catch(error){finish(error)}
    };
    timer=setTimeout(()=>finish(Error('Background pixel capture timed out')),Math.max(1,Math.min(1000,budgetDeadline-Date.now())));
    raf=requestAnimationFrame(sample);
  });
  const loudness=async(id)=>{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(10000,budgetDeadline-Date.now())));
    const started=performance.now();
    try{
      let response;
      do{
        response=await fetch('/api/tracks/'+id+'/playback-loudness',{signal:controller.signal});
        if(response.status!==503)break;
        await response.arrayBuffer();await delay(250);
      }while(!controller.signal.aborted);
      if(response.status!==200)throw await failure('Playback loudness',response);
      const value=await response.json();
      if(value.status!=='ready'||![value.gain_db,value.integrated_lufs,value.true_peak_dbfs,value.target_lufs].every(Number.isFinite))throw Error('Missing finite ready loudness measurements');
      if(value.target_lufs!==-18||value.gain_db>12+1e-6||value.true_peak_dbfs+value.gain_db>-1+1e-6)throw Error('Unsafe loudness playback gain');
      const expected=Math.min(Math.max(-24,Math.min(12,-18-value.integrated_lufs)),-1-value.true_peak_dbfs);
      if(Math.abs(value.gain_db-expected)>1e-6)throw Error('Unexpected integrated loudness gain');
      return {value,elapsed_ms:Math.round(performance.now()-started)};
    }finally{clearTimeout(timer)}
  };
  // Fixture-only server diagnostics contain booleans, never cookie/header values.
  const failure=async(label,response)=>{
    const result={status:response.status};
    try{const body=await response.clone().json();if(typeof body.code==='string')result.code=body.code.slice(0,80);if(body.checks&&typeof body.checks==='object')result.checks=Object.fromEntries(Object.entries(body.checks).filter(([key,value])=>['host','cookie_present','cookie_matches','origin_present','origin_matches','referer_matches','fetch_site_allowed'].includes(key)&&typeof value==='boolean'))}catch{}
    return Error(label+' '+JSON.stringify(result));
  };
  const event=(audio,name,timeout=10000)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error(name+' timed out'))},Math.max(1,Math.min(timeout,budgetDeadline-Date.now())));
    const done=()=>{cleanup();resolve()};const fail=()=>{cleanup();reject(Error('Media error '+audio.error?.code))};
    const cleanup=()=>{clearTimeout(timer);audio.removeEventListener(name,done);audio.removeEventListener('error',fail)};
    audio.addEventListener(name,done,{once:true});audio.addEventListener('error',fail,{once:true});
  });
  (async()=>{
    await probe('authenticated_fetch',async()=>{const response=await fetch('/api/capabilities');if(response.status!==200)throw await failure('Capabilities',response);const value=await response.json();if(value.analysis!==false||value.provider_workflows!==false)throw Error('Deferred capabilities exposed');return value});
    if(!report.checks.authenticated_fetch.ok){report.ok=false;report.bootstrap_failed=true;return}
    await probe('rendered_application',async()=>{await wait(()=>document.querySelector('#root')?.children.length>0);return document.title});
    await probe('http_only_cookie',async()=>{if(document.cookie.includes('cratemind_'))throw Error('Session cookie exposed to JavaScript');return true});
    await probe('global_tauri_absent',async()=>{if(window.__TAURI__)throw Error('Global Tauri API exposed');return true});
    await probe('native_audio_worklet_module',async()=>{
      if(!window.AudioContext||!window.AudioWorkletNode)throw unverified('Native AudioWorklet is unavailable');
      const context=new AudioContext();
      try{
        if(!context.audioWorklet)throw unverified('Native audioWorklet is unavailable; secure context='+window.isSecureContext);
        await bounded(context.audioWorklet.addModule('/audio/peak-limiter.worklet.js'),8000,'Native worklet module');
        const node=new AudioWorkletNode(context,'cratemind-peak-limiter',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});
        node.disconnect();
        return {module_loaded:true,processor_created:true,secure_context:window.isSecureContext,sample_rate:context.sampleRate};
      }finally{await bounded(context.close(),2000,'Native audio context close')}
    });
    await probe('native_limiter_processing',async()=>{
      if(!window.OfflineAudioContext)throw unverified('OfflineAudioContext unavailable. Required fallback: muted real-time AudioContext with captured generated PCM; no limiter processing proof yet.');
      const rate=48000;const frames=rate;const context=new OfflineAudioContext(2,frames,rate);
      if(!context.audioWorklet)throw unverified('Offline AudioWorklet unavailable. Required fallback: real-time AudioContext, generated PCM -> limiter -> captured buffer with destination muted; native module load alone does not verify limiting.');
      await bounded(context.audioWorklet.addModule('/audio/peak-limiter.worklet.js'),8000,'Offline worklet module');
      const buffer=context.createBuffer(2,frames,rate);const left=buffer.getChannelData(0);const right=buffer.getChannelData(1);
      let inputPeak=0;
      for(let i=0;i<frames;i++){
        left[i]=i%503===0?8:1.7*Math.sin(i*0.23);right[i]=-0.25*left[i];inputPeak=Math.max(inputPeak,Math.abs(left[i]));
      }
      const source=context.createBufferSource();source.buffer=buffer;
      const limiter=new AudioWorkletNode(context,'cratemind-peak-limiter',{
        numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'clamped-max',channelInterpretation:'speakers'
      });
      let processorError=false;limiter.onprocessorerror=()=>{processorError=true};
      source.connect(limiter);limiter.connect(context.destination);source.start();
      const rendered=await bounded(context.startRendering(),10000,'Native limiter rendering');
      const outL=rendered.getChannelData(0);const outR=rendered.getChannelData(1);let peak=0;let stereoError=0;
      for(let i=0;i<rendered.length;i++){
        if(!Number.isFinite(outL[i])||!Number.isFinite(outR[i]))throw Error('Native limiter produced nonfinite samples');
        peak=Math.max(peak,Math.abs(outL[i]),Math.abs(outR[i]));stereoError=Math.max(stereoError,Math.abs(outR[i]+outL[i]*0.25));
      }
      const ceiling=10**(-1/20);
      if(processorError)throw Error('Native limiter processor failed');
      if(peak<0.8||peak>ceiling+1e-6)throw Error('Native sample ceiling failed: '+peak);
      if(stereoError>1e-6)throw Error('Native limiter changed stereo ratio: '+stereoError);
      source.disconnect();limiter.disconnect();
      return {sample_rate:rate,frames:rendered.length,input_peak:inputPeak,output_peak:peak,ceiling,stereo_ratio_max_error:stereoError,sample_peak_verified:true,true_peak_verified:false};
    });
    await probe('settings_greek',async()=>{await navigate('/settings');await wait(()=>Array.from(document.querySelectorAll('h1')).some(node=>node.textContent.includes('Ρυθμίσεις')));return document.body.innerText.slice(0,1600)});
    const originalTheme=document.documentElement.dataset.theme;
    const originalBackground=backgroundPicker()?.dataset.backgroundValue||'soft-aurora';
    // Reserve media time even if every new renderer fails to initialize.
    backgroundDeadline=Math.min(Date.now()+24000,budgetDeadline-45000);
    report.backgrounds={requested:backgroundIds,themes:['dark','light'],original_theme:originalTheme,original_background:originalBackground,pixel_buffer_max_bytes:1024*1024*4,budget_ms:Math.max(0,backgroundDeadline-Date.now())};
    try{
      for(const id of backgroundIds){
        for(const theme of ['dark','light'])await probe('background_'+theme+'_'+id,async()=>{
          if(Date.now()>=backgroundDeadline)throw Error('Background QA time budget exhausted; remaining time reserved for media probes');
          await selectBackground(id);
          await wait(()=>{
            const root=document.querySelector('.cm-background');
            return root?.dataset.background===id&&(root.querySelector('canvas[data-background-ready="true"]')||root.querySelector('[data-background-fallback]:not([data-background-fallback="loading"])'));
          },3000);
          const root=document.querySelector('.cm-background');
          const fallback=root?.querySelector('[data-background-fallback]')?.dataset.backgroundFallback;
          if(fallback==='reduced-motion')throw unverified('Reduced motion is enabled; '+id+' shader rendering is unverified');
          if(fallback==='page-hidden'||document.hidden)throw unverified('Native application is hidden; '+id+' shader rendering is unverified');
          if(fallback)throw Error('Selected background used fallback: '+fallback);
          const canvases=root.querySelectorAll('canvas');
          if(canvases.length!==1||canvases[0].dataset.backgroundReady!=='true')throw Error('Expected exactly one ready background canvas');
          // A real UI theme change also wakes the static flow=0 Grainient shader.
          // Read on the following RAFs, before its back buffer is discarded.
          await selectTheme(theme);
          const pixels=await backgroundPixels(canvases[0]);
          if(document.documentElement.dataset.theme!==theme||document.querySelector('.cm-background')?.dataset.background!==id)throw Error('Background/theme changed during pixel proof');
          return {background:id,theme,canvas_count:1,ready:true,pixels};
        });
      }
    }finally{
      await probe('background_preferences_restored',async()=>{
        await selectBackground(backgroundIds.includes(originalBackground)?originalBackground:'soft-aurora');
        if(originalTheme==='dark'||originalTheme==='light')await selectTheme(originalTheme);
        const restored={background:backgroundPicker()?.dataset.backgroundValue,theme:document.documentElement.dataset.theme};
        report.backgrounds.restored=restored;
        if(restored.background!==originalBackground||restored.theme!==originalTheme)throw Error('Background QA did not restore original preferences');
        return restored;
      });
    }
    await probe('library_greek',async()=>{await navigate('/library');await wait(()=>Array.from(document.querySelectorAll('input')).some(node=>(node.placeholder||'').startsWith('Αναζήτηση — π.χ.')));return document.body.innerText.slice(0,1600)});
    await probe('preferences_across_launches',async()=>{const response=await fetch('/api/desktop/preferences');if(response.status!==200)throw await failure('Preferences read',response);const value=await response.json();if(fixtures.previous_preference&&value['cratemind-native-qa']!==fixtures.previous_preference)throw Error('Saved preference lost across restart');if(fixtures.previous_preference&&(value['cratemind-theme']!=='light'||document.documentElement.dataset.theme!=='light'))throw Error('Saved theme was not applied on restart');if(fixtures.previous_origin&&location.origin===fixtures.previous_origin)throw Error('Acceptance requires a different ephemeral origin');return {previous:value['cratemind-native-qa']||null,theme:document.documentElement.dataset.theme,origin_changed:fixtures.previous_origin?location.origin!==fixtures.previous_origin:null}});
    await probe('native_cue_pad_layout',async()=>{
      const fixture=fixtures.tracks.find(item=>item.codec==='wav');
      if(!fixture)throw unverified('A generated WAV fixture is required for cue pads');
      const response=await fetch('/api/tracks/'+fixture.id);if(!response.ok)throw await failure('Cue fixture',response);
      const detail=await response.json();const title=detail.track.title||detail.track.file_name;
      const row=Array.from(document.querySelectorAll('[role="row"]')).find(node=>node.innerText.includes(title));
      const button=row?.querySelector('button[aria-label="Ακρόαση track"]');if(!button)throw Error('Fixture audition button not rendered');
      const audio=document.querySelector('audio');if(audio){audio.muted=true;audio.volume=0;audio.dispatchEvent(new Event('volumechange'));await delay(100)}
      button.click();await wait(()=>document.querySelectorAll('[data-cue-pad]').length===8,5000);
      await wait(()=>Array.from(document.querySelectorAll('[data-cue-pad]')).some(node=>(node.getAttribute('aria-label')||'').startsWith('Pad ')),5000);
      const deadline=Date.now()+3000;let slots;
      do{const prefs=await(await fetch('/api/desktop/preferences')).json();slots=JSON.parse(prefs['cm:cue-pads:v1:'+(fixture.id%16)]||'{}')[fixture.id];if(Array.isArray(slots)&&slots.length===8)break;await delay(100)}while(Date.now()<deadline);
      document.querySelector('audio')?.pause();
      if(!Array.isArray(slots)||slots.length!==8)throw Error('Cue pad device layout was not persisted');
      return {track_id:fixture.id,pads:8,assigned:slots.filter(value=>value!==null).length,device_layout_saved:true};
    });
    for(const fixture of fixtures.tracks){
      const media={id:fixture.id,codec:fixture.codec};report.media.push(media);
      const source='/api/tracks/'+fixture.id+'/audio';
      try{
        if(Date.now()>budgetDeadline-2000)throw Error('Fixed native QA time budget exhausted before this fixture');
        const range=await fetch(source,{headers:{Range:'bytes=0-127'}});media.range_status=range.status;media.content_range=range.headers.get('Content-Range');
        if(range.status!==206&&range.status!==415)throw await failure('Range',range);await range.arrayBuffer();
        if(fixture.codec==='aiff'){if(range.status!==415)throw Error('AIFF refusal changed');media.expected_refusal=true;media.ok=true;continue}
        if(range.status!==206)throw Error('Range '+range.status);
        const first=await loudness(fixture.id);const repeated=await loudness(fixture.id);
        if(JSON.stringify(first.value)!==JSON.stringify(repeated.value))throw Error('Repeated loudness result changed');
        media.loudness={...first.value,repeat_identical:true,first_elapsed_ms:first.elapsed_ms,repeat_elapsed_ms:repeated.elapsed_ms,cache_hit_proven:false};
        const invalid=await fetch(source,{headers:{Range:'bytes=999999999999-'}});media.invalid_range_status=invalid.status;await invalid.arrayBuffer();if(invalid.status!==416)throw Error('Invalid range '+invalid.status);
        const audio=document.createElement('audio');audio.muted=true;audio.preload='auto';document.body.append(audio);
        try{
          const metadata=event(audio,'loadedmetadata');audio.src=source;audio.load();await metadata;
          media.duration=audio.duration;if(!Number.isFinite(audio.duration)||audio.duration<=0)throw Error('Invalid duration');
          if(audio.readyState<3)await event(audio,'canplay');
          const target=Math.min(0.6,audio.duration/2);const seeked=event(audio,'seeked');audio.currentTime=target;await seeked;media.seek_time=audio.currentTime;
          if(Math.abs(audio.currentTime-target)>0.2)throw Error('Native decoder did not seek to requested time');
          const start=audio.currentTime;await audio.play();await delay(500);audio.pause();media.playback_advanced=audio.currentTime>start+0.05;
          if(!media.playback_advanced)throw Error('Native decoder did not advance playback');media.ok=true;
        }finally{audio.pause();audio.removeAttribute('src');audio.load();audio.remove()}
      }catch(error){media.ok=false;media.error=String(error)}
    }
    await probe('save_preferences',async()=>{
      const marker='native-qa-'+Date.now();const response=await fetch('/api/desktop/preferences',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({'cratemind-native-qa':marker,'cratemind-theme':'light'})});if(response.status!==200)throw await failure('Preferences write',response);const value=await response.json();if(value['cratemind-native-qa']!==marker)throw Error('Preference write missing');report.saved_preference=marker;return true
    });
    report.ok=Object.values(report.checks).every(value=>value.ok)&&report.media.every(value=>value.ok);
    report.media_fixture_count=fixtures.tracks.length;
  })().catch(error=>{report.ok=false;report.error=String(error)}).finally(()=>{report.pending=false});
})();
