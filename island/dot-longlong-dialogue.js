/** 百變隆隆漫畫泡泡。Three.js r169；不註冊 canvas 事件、不自建 RAF。 */
export function createLonglongDialogue({THREE,camera,canvas,cues,host=null,document:doc=globalThis.document,window:win=globalThis.window}) {
  const records=new Map(), rows=Array.isArray(cues)?cues:(cues?.cues||cues?.roles||[]), cueMap=new Map(rows.map(x=>[x.id||x.roleId,x]));
  const root=doc.createElement('div');root.className='dot-longlong-ui';(host||doc.body).append(root);
  let autoClose=0;const bubble=doc.createElement('section');bubble.className='dot-longlong-bubble';bubble.hidden=true;bubble.setAttribute('aria-label','百變隆隆角色對話');root.append(bubble);
  const title=doc.createElement('strong'),label=doc.createElement('small'),visual=doc.createElement('p'),live=doc.createElement('span'),source=doc.createElement('a'),actions=doc.createElement('div');
  visual.setAttribute('aria-hidden','true');live.className='dot-longlong-sr';live.setAttribute('role','status');live.setAttribute('aria-live','polite');live.setAttribute('aria-atomic','true');source.textContent='查看影片來源';source.target='_blank';source.rel='noopener noreferrer';actions.className='dot-longlong-actions';bubble.append(title,label,visual,live,source,actions);
  const button=(text,fn,parent)=>{const b=doc.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',fn);parent.append(b);return b;};
  button('顯示全文',()=>finish(),actions);button('重播',()=>start(),actions);const closeButton=button('關閉',()=>close(true),actions);
  const picker=doc.createElement('details'),summary=doc.createElement('summary'),list=doc.createElement('div');summary.textContent='百變隆隆角色';picker.className='dot-longlong-picker';picker.append(summary,list);root.append(picker);
  const media=win?.matchMedia?.('(prefers-reduced-motion: reduce)');let active=null,full='',elapsed=0,lastIndex=-1,disposed=false,returnFocus=null,gesture=null;
  const v=new THREE.Vector3(),local=new THREE.Vector3(),ray=new THREE.Raycaster(),ndc=new THREE.Vector2();
  const reduced=()=>!!media?.matches;
  const allowed=x=>x && ['verified-excerpt','paraphrase','paraphrased_summary','user-provided'].includes(x.textType) && ['verified','approved','caption_verified_summary'].includes(x.status) && typeof x.displayText==='string' && x.displayText.trim();
  function finish(){visual.textContent=full;lastIndex=Array.from(full).length;elapsed=Infinity;}
  function start(){elapsed=0;lastIndex=-1;visual.textContent='';bubble.classList.remove('dot-longlong-pop');if(reduced())finish();else {void bubble.offsetWidth;bubble.classList.add('dot-longlong-pop');}}
  function close(restore=false){clearTimeout(autoClose);active=null;bubble.hidden=true;live.textContent='';full='';if(restore&&returnFocus?.isConnected)returnFocus.focus();returnFocus=null;}
  function show(id){if(disposed||!records.has(id))return false;const c=cueMap.get(id),r=records.get(id);returnFocus=doc.activeElement;active=id;bubble.hidden=false;title.textContent=c?.name||c?.roleName||id;
    if(allowed(c)){full=c.displayText;label.textContent='';label.hidden=true;}
    else {full=`我是${c?.name||'百變隆隆'}，陪慧文一起顧鳳山！`;label.textContent='';label.hidden=true;}
    let url=null;try{const u=new URL(c?.sourceURL);if(['https:','http:'].includes(u.protocol))url=u.href;}catch{}
    source.hidden=!url;if(url)source.href=url;else source.removeAttribute('href');source.textContent='查看影片來源'+(c?.timecode?'（'+(typeof c.timecode==='object'?'約 '+c.timecode.startSeconds+'–'+c.timecode.endSeconds+' 秒':String(c.timecode))+'）':'');
    live.textContent=title.textContent+'。'+label.textContent+'。'+full;start();update(0);clearTimeout(autoClose);autoClose=setTimeout(()=>{if(active===id)close();},Math.max(4500,Array.from(full).length*160+3000));return true;
  }
  function register(object,id,headOffset){if(disposed)throw Error('已釋放');if(records.has(id))throw Error('重複角色 '+id);object.updateWorldMatrix(true,true);
    const box=new THREE.Box3().setFromObject(object);const anchor=headOffset?new THREE.Vector3(...headOffset):object.worldToLocal(new THREE.Vector3((box.min.x+box.max.x)/2,box.max.y,(box.min.z+box.max.z)/2));
    const c=cueMap.get(id);const b=button(c?.name||c?.roleName||id,()=>show(id),list);records.set(id,{object,anchor,button:b});return ()=>{if(active===id)close();b.remove();records.delete(id);};
  }
  function pick(event,occluders=[]){if(disposed)return null;const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return null;ndc.set((event.clientX-r.left)/r.width*2-1,1-(event.clientY-r.top)/r.height*2);camera.updateMatrixWorld();ray.setFromCamera(ndc,camera);
    const roots=[...records.values()].map(r=>r.object);roots.forEach(o=>o.updateWorldMatrix(true,true));const hits=ray.intersectObjects([...roots,...occluders],true);
    for(const hit of hits){let node=hit.object,visible=true,id=null;while(node){if(!node.visible)visible=false;for(const [key,r] of records)if(node===r.object)id=key;node=node.parent;}if(!visible)continue;return id;}return null;
  }
  // Call from the existing pointer owner only. Multi-touch, cancelled gestures and drags never trigger.
  function pointerDown(e){if(e.isPrimary===false||e.button>0){gesture=null;return;}gesture={id:e.pointerId,x:e.clientX,y:e.clientY};}
  function pointerCancel(){gesture=null;}
  function pointerMove(e){if(gesture&&(e.pointerId!==gesture.id||Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)>6))gesture=null;}
  function pointerUp(e,occluders=[]){const g=gesture;gesture=null;if(!g||g.id!==e.pointerId||Math.hypot(e.clientX-g.x,e.clientY-g.y)>6)return false;const id=pick(e,occluders);return id?show(id):false;}
  function update(dt=0){if(disposed||!active)return;const r=records.get(active);if(!r)return close();if(reduced())finish();else if(Number.isFinite(elapsed)){elapsed+=Math.max(0,Math.min(dt,.1));const chars=Array.from(full),n=Math.min(chars.length,Math.floor(elapsed*32));if(n!==lastIndex){visual.textContent=chars.slice(0,n).join('');lastIndex=n;}}
    r.object.updateWorldMatrix(true,false);camera.updateMatrixWorld();v.copy(r.anchor);r.object.localToWorld(v);local.copy(v).applyMatrix4(camera.matrixWorldInverse);v.project(camera);
    const rect=canvas.getBoundingClientRect(),width=win?.innerWidth||rect.width,height=win?.innerHeight||rect.height;const bw=bubble.offsetWidth||300,bh=bubble.offsetHeight||190;
    const off=local.z>=0||v.z < -1||v.z > 1||Math.abs(v.x)>1||Math.abs(v.y)>1;
    const px=rect.left+(v.x+1)*rect.width/2,py=rect.top+(1-v.y)*rect.height/2;
    const x=Math.max(8,Math.min(width-bw-8,Number.isFinite(px)?px-bw/2:8));const y=Math.max(8,Math.min(height-bh-8,off?16:py-bh-22));
    bubble.style.left=x+'px';bubble.style.top=y+'px';bubble.style.setProperty('--tail-x',Math.max(18,Math.min(bw-18,px-x))+'px');bubble.classList.toggle('dot-longlong-detached',off);bubble.dataset.anchor=off?'offscreen':'head';
  }
  function key(e){if(e.key==='Escape'&&active){e.preventDefault();close(true);}}doc.addEventListener('keydown',key);const motion=()=>{if(reduced())finish();};media?.addEventListener?.('change',motion);
  function dispose(){if(disposed)return;clearTimeout(autoClose);close();disposed=true;gesture=null;records.clear();doc.removeEventListener('keydown',key);media?.removeEventListener?.('change',motion);root.remove();}
  return {register,show,close,update,pick,pointerDown,pointerMove,pointerUp,pointerCancel,dispose,get activeRole(){return active;},get activeObject(){return active?records.get(active)?.object||null:null;}};
}
