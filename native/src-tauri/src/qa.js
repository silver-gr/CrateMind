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
  const backgroundIds=['soft-aurora','scanner','grainient','grainient-aurora','threads','particles','aurora','prismatic-burst','faulty-terminal','iridescence'];
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
    const started=Date.now();const deadline=Math.min(started+3000,backgroundDeadline,budgetDeadline);
    let raf=0;let frames=0;let timer;let retry;let settled=false;
    const restores=[];
    const finish=(error,value)=>{if(settled)return;settled=true;cancelAnimationFrame(raf);clearTimeout(timer);clearTimeout(retry);restores.forEach(restore=>restore());error?reject(error):resolve(value)};
    const sample=(capture='raf')=>{
      try{
        if(settled)return;
        if(Date.now()>=deadline)throw Error('No nonzero background RGB pixels within capture budget');
        if(document.hidden)throw unverified('Native background pixel proof requires a visible application');
        if(!canvas.isConnected||gl.isContextLost())throw Error('Selected background canvas was lost during pixel capture');
        frames++;gl.readPixels(x,y,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        const error=gl.getError();if(error!==gl.NO_ERROR)throw Error('Background pixel read failed: '+error);
        let rgbNonzero=0;let alphaNonzero=0;let rgbSum=0;
        for(let i=0;i<pixels.length;i+=4){const sum=pixels[i]+pixels[i+1]+pixels[i+2];rgbSum+=sum;if(sum>0)rgbNonzero++;if(pixels[i+3]>0)alphaNonzero++}
        if(rgbNonzero>0){finish(null,{capture,frames,elapsed_ms:Date.now()-started,sampled_width:width,sampled_height:height,rgb_nonzero_pixels:rgbNonzero,rgb_sum:rgbSum,alpha_nonzero_pixels:alphaNonzero});return}
        // Allow a renderer's intro to leave black before judging its pixels.
        // RAF sampling catches the draw before its non-preserved buffer clears;
        // spacing retries avoids scanning a full pixel buffer on every frame.
        if(capture==='raf')retry=setTimeout(()=>{raf=requestAnimationFrame(()=>sample())},Math.min(100,deadline-Date.now()));
      }catch(error){finish(error)}
    };
    // A static shader may finish its only frame before a later RAF callback.
    // Capture its default framebuffer synchronously after a real draw, before
    // WebKit discards it. These context-local hooks exist only during this probe.
    for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
      const original=gl[name];if(typeof original!=='function')continue;
      const descriptor=Object.getOwnPropertyDescriptor(gl,name);
      gl[name]=function(...args){
        const result=original.apply(this,args);
        if(!settled&&gl.getParameter(gl.FRAMEBUFFER_BINDING)===null)sample('draw');
        return result;
      };
      restores.push(()=>{if(descriptor)Object.defineProperty(gl,name,descriptor);else delete gl[name]});
    }
    timer=setTimeout(()=>finish(Error('No nonzero background RGB pixels within capture budget')),Math.max(1,deadline-Date.now()));
    raf=requestAnimationFrame(()=>sample());
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
    await probe('native_titlebar_overlay',async()=>{
      const strip=document.querySelector('[data-native-titlebar-strip]');
      const main=document.querySelector('main');
      if(document.documentElement.dataset.nativeTitlebar!=='overlay'||!strip||!main)throw Error('Native overlay marker/strip is missing');
      const rect=strip.getBoundingClientRect();const mainRect=main.getBoundingClientRect();
      if(!strip.hasAttribute('data-tauri-drag-region')||Math.abs(rect.height-32)>1||Math.abs(rect.top)>1||Math.abs(rect.width-innerWidth)>1||mainRect.top<rect.bottom-1)throw Error('Native overlay does not reserve the full-width 32px drag region');
      return {strip_height:rect.height,main_top:mainRect.top,drag_region:true,physical_window_drag:'not exercised'};
    });
    await probe('luna_artist_results',async()=>{
      const confirmedName='Δοκιμή επιβεβαιωμένου Luna';const pendingName='Δοκιμή πρότασης Luna';
      const card=name=>Array.from(document.querySelectorAll('main h2')).find(node=>node.textContent.trim()===name)?.closest('[data-artist-result]');
      const artists=async()=>{
        const response=await bounded(fetch('/api/artists?min_track_count=2&limit=5000'),3000,'Artist fixture read');
        if(!response.ok)throw await failure('Artist fixtures',response);
        return response.json();
      };
      try{
        const before=await artists();
        const pending=before.find(row=>row.id===71003&&row.canonical_name===pendingName);
        if(!pending||!before.some(row=>row.id===71001)||!before.some(row=>row.id===71002))throw Error('Synthetic Luna artist fixtures are missing');
        await navigate('/artists');
        await wait(()=>card(confirmedName)&&card(pendingName),4000);
        const cards=Array.from(document.querySelectorAll('main [data-artist-result]'));
        if(cards.length!==2||document.querySelector('main').innerText.includes('Δοκιμή παλαιού προφίλ'))throw Error('Legacy/Gemini profile appeared among Luna results');
        for(const [name,genre] of [[confirmedName,'Forest'],[pendingName,'Hi-Tech']]){
          const result=card(name);const visible=result.innerText;
          if(Array.from(result.querySelectorAll('p')).filter(node=>node.textContent.trim()===genre).length!==1)throw Error('Artist card did not show exactly one primary genre: '+name);
          if(/Διατήρηση:|Νέο:|BPM|Ενέργεια|Παλαιά δοκιμαστική/.test(visible))throw Error('Old comparison or numeric profile leaked into artist result');
          const details=result.querySelector('details');
          if(!details||details.open||!details.querySelector('summary')?.textContent.includes('Αιτιολόγηση και πηγές'))throw Error('Artist sources are not initially collapsed');
          if(!details.querySelector('a[href^="https://label.example/"]'))throw Error('Artist result lost its synthetic evidence link');
        }
        const proposed=card(pendingName);
        if(/Forest|χαμηλή/.test(proposed.innerText))throw Error('Ready Luna proposal displays the old genre or old confidence');
        let clicked=false;
        if(pending.review?.state!=='confirmed'){
          const confirm=Array.from(proposed.querySelectorAll('button')).find(node=>node.textContent.trim()==='Επιβεβαίωση είδους');
          if(!confirm||confirm.disabled)throw Error('Luna genre confirmation action is unavailable');
          confirm.click();clicked=true;
        }
        await wait(()=>card(pendingName)?.innerText.includes('Επιβεβαιωμένο · προστατεύεται από enrichment'),4000);
        const after=await artists();const sealed=after.find(row=>row.id===71003);
        if(sealed?.review?.state!=='confirmed'||sealed.primary_subgenre!=='Hi-Tech'||sealed.needs_review!==false||sealed.research?.model!=='gpt-6-luna')throw Error('Luna result confirmation did not persist to the fixture API');
        for(const field of ['canonical_name','normalized_name','typical_bpm_min','typical_bpm_max','energy_min','energy_max','set_role_hints_json']){
          if(sealed[field]!==pending[field])throw Error('Genre confirmation changed preserved artist field: '+field);
        }
        if(Array.from(card(pendingName).querySelectorAll('button')).some(node=>['Επιβεβαίωση είδους','Διόρθωση','Ορισμός είδους'].includes(node.textContent.trim())))throw Error('Confirmed Luna artist still exposes editing actions');
        return {visible_artist_ids:[71002,71003],legacy_hidden:true,single_genres:true,sources_collapsed:true,comparison_hidden:true,confirmed:sealed.review.state,confirmation_clicked:clicked,numeric_profile_preserved:true};
      }finally{await navigate('/library')}
    });
    await probe('library_new_set_dialog',async()=>{
      await navigate('/library');
      await wait(()=>Array.from(document.querySelectorAll('button')).some(node=>node.textContent.trim()==='Νέο set'));
      const response=await fetch('/api/sets');if(!response.ok)throw await failure('Sets before Library dialog',response);
      const before=await response.json();
      const action=Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()==='Νέο set');
      action.click();
      await wait(()=>document.querySelector('[role="dialog"] input[required]'),2000);
      const dialog=document.querySelector('[role="dialog"]');
      if(!dialog.textContent.includes('Νέο set'))throw Error('Library did not open the New set dialog');
      await wait(()=>document.activeElement===dialog.querySelector('input[required]'),1000);
      if(!dialog.querySelector('button[type="submit"]')?.disabled)throw Error('Blank Library set title can be submitted');
      const cancel=Array.from(dialog.querySelectorAll('button')).find(node=>node.textContent.trim()==='Ακύρωση');
      if(!cancel)throw Error('Library New set dialog has no cancel action');
      cancel.click();await wait(()=>!document.querySelector('[role="dialog"]'),2000);
      const afterResponse=await fetch('/api/sets');if(!afterResponse.ok)throw await failure('Sets after Library cancel',afterResponse);
      if(JSON.stringify(before)!==JSON.stringify(await afterResponse.json()))throw Error('Cancelled Library dialog changed fixture sets');
      return {dialog_opened:true,title_focused:true,blank_disabled:true,cancelled:true,sets_unchanged:true};
    });
    await probe('library_create_fixture_set',async()=>{
      // This compiled probe is available only under the Rust fixture-marker gate.
      // It never runs against personal app data and writes only a named QA set.
      if(!report.checks.library_new_set_dialog.ok)throw Error('Library dialog prerequisite failed');
      const beforeResponse=await fetch('/api/sets');if(!beforeResponse.ok)throw await failure('Sets before fixture creation',beforeResponse);
      const before=await beforeResponse.json();
      const title='Native QA set '+Date.now();
      Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()==='Νέο set').click();
      await wait(()=>document.querySelector('[role="dialog"] input[required]'),2000);
      const dialog=document.querySelector('[role="dialog"]');
      const input=dialog.querySelector('input[required]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,title);
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await delay(0);
      dialog.querySelector('button[type="submit"]').click();
      await wait(()=>!document.querySelector('[role="dialog"]'),3000);
      const afterResponse=await fetch('/api/sets');if(!afterResponse.ok)throw await failure('Sets after fixture creation',afterResponse);
      const after=await afterResponse.json();const created=after.filter(item=>item.title===title);
      if(after.length!==before.length+1||created.length!==1)throw Error('Library did not create exactly one named fixture set');
      const selected=Array.from(document.querySelectorAll('main [role="combobox"]')).some(node=>node.textContent.includes(title));
      if(!selected)throw Error('Library did not select the newly created fixture set');
      return {set_id:created[0].id,title,created_once:true,selected:true};
    });
    await probe('new_set_menu_dialog',async()=>{
      await navigate('/sets');
      await wait(()=>document.querySelector('[data-set-actions-menu]'));
      const response=await fetch('/api/sets');if(!response.ok)throw await failure('Sets before menu probe',response);
      const before=await response.json();
      const menu=document.querySelector('[data-set-actions-menu]');
      const summary=menu.querySelector('summary');
      const action=Array.from(menu.querySelectorAll('button')).find(node=>node.textContent.trim()==='Νέο set');
      if(!summary||!action||action.disabled)throw Error('New set menu action is unavailable');
      summary.focus();summary.click();
      await wait(()=>menu.open,2000);
      // macOS WebKit can blur the summary without focusing the pressed button.
      // Reproduce that ordering before click: hidden actions cannot receive the
      // physical pointer release, although HTMLElement.click() would still run.
      action.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0}));
      summary.blur();
      await delay(0);
      if(!menu.open)throw Error('Set actions closed on internal pointer blur before New set could receive click');
      action.click();
      await wait(()=>document.querySelector('[role="dialog"] input[required]'),2000);
      const dialog=document.querySelector('[role="dialog"]');
      if(!dialog.textContent.includes('Νέο set')||menu.open)throw Error('New set dialog did not replace its action menu');
      const input=dialog.querySelector('input[required]');
      if(document.activeElement!==input)throw Error('New set title did not receive focus');
      const cancel=Array.from(dialog.querySelectorAll('button')).find(node=>node.textContent.trim()==='Ακύρωση');
      if(!cancel)throw Error('New set dialog has no cancel action');
      cancel.click();
      await wait(()=>!document.querySelector('[role="dialog"]'),2000);
      summary.focus();summary.click();await wait(()=>menu.open,2000);
      const outside=document.querySelector('a[href="/library"]');
      if(!outside)throw Error('Outside focus target is unavailable');
      outside.focus();
      if(menu.open)throw Error('Set actions did not close when keyboard focus moved outside');
      const afterResponse=await fetch('/api/sets');if(!afterResponse.ok)throw await failure('Sets after menu probe',afterResponse);
      const after=await afterResponse.json();
      if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Cancelled New set dialog changed fixture sets');
      return {internal_pointer_blur_preserved:true,dialog_opened:true,title_focused:true,cancelled:true,outside_focus_dismissed:true,sets_unchanged:true};
    });
    const limiterWorkletModuleUrl=()=>{
      const markers=document.querySelectorAll('meta[name="cratemind-audio-worklet"]');
      if(markers.length!==1||!markers[0].content)throw Error('Missing unique bundled audio worklet marker');
      const url=new URL(markers[0].content,location.href);
      if(url.origin!==location.origin||url.protocol!=='http:'||url.username||url.password||url.search||url.hash||!/^\/assets\/[^/]+\.js$/.test(url.pathname))throw Error('Audio worklet marker is not a same-origin bundled module');
      return url;
    };
    await probe('native_audio_worklet_module',async()=>{
      if(!window.AudioContext||!window.AudioWorkletNode)throw unverified('Native AudioWorklet is unavailable');
      const moduleUrl=limiterWorkletModuleUrl();
      const context=new AudioContext();
      try{
        if(!context.audioWorklet)throw unverified('Native audioWorklet is unavailable; secure context='+window.isSecureContext);
        await bounded(context.audioWorklet.addModule(moduleUrl.href),8000,'Native worklet module');
        const node=new AudioWorkletNode(context,'cratemind-peak-limiter',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});
        node.disconnect();
        return {module_loaded:true,module_path:moduleUrl.pathname,processor_created:true,secure_context:window.isSecureContext,sample_rate:context.sampleRate};
      }finally{await bounded(context.close(),2000,'Native audio context close')}
    });
    await probe('native_limiter_processing',async()=>{
      if(!window.OfflineAudioContext)throw unverified('OfflineAudioContext unavailable. Required fallback: muted real-time AudioContext with captured generated PCM; no limiter processing proof yet.');
      const rate=48000;const frames=rate;const context=new OfflineAudioContext(2,frames,rate);
      if(!context.audioWorklet)throw unverified('Offline AudioWorklet unavailable. Required fallback: real-time AudioContext, generated PCM -> limiter -> captured buffer with destination muted; native module load alone does not verify limiting.');
      const moduleUrl=limiterWorkletModuleUrl();
      await bounded(context.audioWorklet.addModule(moduleUrl.href),8000,'Offline worklet module');
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
      return {module_path:moduleUrl.pathname,sample_rate:rate,frames:rendered.length,input_peak:inputPeak,output_peak:peak,ceiling,stereo_ratio_max_error:stereoError,sample_peak_verified:true,true_peak_verified:false};
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
          // Arm capture before the real UI theme change wakes static shaders.
          const [pixels]=await Promise.all([backgroundPixels(canvases[0]),selectTheme(theme)]);
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
    await probe('library_table_controls',async()=>{
      await wait(()=>document.querySelectorAll('[role="columnheader"]').length>5,3000);
      const headers=Array.from(document.querySelectorAll('[role="columnheader"]')).map(node=>node.querySelector('button')?.getAttribute('aria-label')||node.textContent.trim());
      const buttons=Array.from(document.querySelectorAll('main button'));
      if(!buttons.some(node=>node.textContent.trim()==='Στήλες')||!buttons.some(node=>node.textContent.trim()==='Επαναφορά μεγεθών'))throw Error('Library table adjustment controls are missing');
      if(!headers.includes('Μελωδία')||!headers.includes('Ιδιορρυθμία')||headers.some(label=>['Δημιουργήθηκε','Τελευταίο','Είδος'].includes(label)))throw Error('Library fixture defaults do not match the configured columns');
      const response=await fetch('/api/desktop/preferences');if(!response.ok)throw await failure('Table preferences',response);
      const preferences=await response.json();const table=JSON.parse(preferences['cratemind:table:full:v2']||'null');
      if(table?.version!==2||table.widths?.track!==381||table.widths?.key!==52)throw Error('Native table defaults were not persisted');
      return {headers,defaults_persisted:true,width_reset_button:true,columns_button:true};
    });
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
      const waveform=document.querySelector('[data-player-waveform]');const group=document.querySelector('[aria-label="Cue pads 1–8"]');
      const pads=Array.from(group?.querySelectorAll('[data-cue-pad]')||[]);
      const height=group?.getBoundingClientRect().height||0;
      if(!waveform||waveform.getBoundingClientRect().width>800.5||pads.length!==8||height<100||pads.some(node=>node.getBoundingClientRect().height<height*0.4))throw Error('Waveform/pad area does not match the resized dock layout');
      const visibleCaptureActions=Array.from(document.querySelectorAll('[data-player-cues] button')).filter(node=>(node.getAttribute('aria-label')||'').startsWith('Σημείωσε')&&node.getClientRects().length);
      if(visibleCaptureActions.length)throw Error('Redundant cue capture toolbar is still visible');
      return {track_id:fixture.id,pads:8,assigned:slots.filter(value=>value!==null).length,device_layout_saved:true,waveform_width:waveform.getBoundingClientRect().width,pad_area_height:height,pad_heights:pads.map(node=>node.getBoundingClientRect().height),capture_toolbar_above:false};
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
