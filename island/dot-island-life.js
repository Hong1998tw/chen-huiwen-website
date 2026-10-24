import * as THREE from 'three';
/** No extra RAF, no postprocessing, at most 24 relationship curves. */
export function createIslandLife({scene,world,camera,controls,renderer,islandCenter,islandCells={},data,onIsland=()=>{},onItem=()=>{},container=document.body}) {
 const media=matchMedia('(prefers-reduced-motion: reduce)'), root=new THREE.Group();world.add(root);
 const rings=new Map(), owned=[], lines=[];let selected=null,hover=null,flight=null,tour=null,elapsed=0;
 // 導覽從中央的議會出發
 const tourOrder=[...data.islands].sort((a,b)=>(b.id==='Q1')-(a.id==='Q1'));
 const at=id=>islandCenter[id]??islandCenter.get?.(id);
 for(const isl of data.islands){const c=at(isl.id);if(!c)continue;const pts=[];for(const center of islandCells[isl.id]||[c])for(let i=0;i<6;i++){for(const k of [i,i+1])pts.push(new THREE.Vector3(center.x+Math.sin(k*Math.PI/3)*10.1,.65,center.z+Math.cos(k*Math.PI/3)*10.1));}const g=new THREE.BufferGeometry().setFromPoints(pts),m=new THREE.LineBasicMaterial({color:0xf6b956,transparent:true,opacity:.9,depthTest:false});const line=new THREE.LineSegments(g,m);line.renderOrder=20;line.visible=false;root.add(line);rings.set(isl.id,line);owned.push(g,m);}
 const ui=document.createElement('section');ui.id='dot-life-ui';ui.setAttribute('aria-label','探索工具');ui.className='dot-life-ui';container.append(ui);
 const caption=document.createElement('p');caption.setAttribute('aria-live','polite');
 const button=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',fn);ui.append(b);return b;};
 const paint=()=>{for(const[id,r]of rings){r.visible=id===selected||id===hover;r.material.color.set(id===selected?0xf1a63b:0x74d9d5);}};
 function flyTo(target,zoom=2,duration=1){if(!target)return;flight={a:controls.target.clone(),b:target.clone(),offset:camera.position.clone().sub(controls.target),z:camera.zoom,end:zoom,t:0,duration};if(media.matches)stepFlight(1e3);}
 function stepFlight(dt){if(!flight)return;const f=flight;f.t=Math.min(1,f.t+dt/f.duration);const k=f.t*f.t*(3-2*f.t);controls.target.lerpVectors(f.a,f.b,k);camera.position.copy(controls.target).add(f.offset);camera.zoom=THREE.MathUtils.lerp(f.z,f.end,k);camera.updateProjectionMatrix();if(f.t===1)flight=null;}
 function stopTour(){tour=null;caption.textContent='導覽已停止';}
 const stopManual=()=>{flight=null;if(tour)stopTour();};controls.addEventListener('start',stopManual);
 function visit(){if(!tour)return;const isl=tourOrder[tour.i];selected=isl.id;paint();const axisName=(data.axes||[]).find(a=>a.id===isl.axis)?.name||'';caption.textContent=`${tour.i+1}／${tourOrder.length}　${isl.name}${isl.pledge?'：'+isl.pledge:isl.id==='Q1'?'：慧文在議會問了什麼':axisName?'：'+axisName:''}`;onIsland(isl.id,false);flyTo(at(isl.id),2);}
 button('開始導覽',()=>{tour={i:0,wait:0,paused:media.matches};visit();});
 const pause=button('暫停／繼續',()=>{if(tour)tour.paused=!tour.paused;});pause.setAttribute('aria-label','暫停或繼續導覽');
 button('下一站',()=>{if(tour){tour.i=(tour.i+1)%data.islands.length;tour.wait=0;visit();}});button('結束導覽',stopTour);
 const label=document.createElement('label');label.textContent='居民視角 ';const persona=document.createElement('select');label.append(persona);ui.append(label);
 const personas=[['全部',[]],['通勤族',['P01','P02','P03']],['親子家庭',['P11','P12','P13','X1','X2']],['文化散步',['P06','P07','P08','P10','X3','LCG']],['日常生活',['P04','P05','P09','X4']]];
 for(const[n]of personas){const o=document.createElement('option');o.textContent=n;persona.append(o);}persona.addEventListener('change',()=>{const ids=personas[persona.selectedIndex][1];showConnections(ids);caption.textContent=ids.length?'依探索主題標示相關地點，非個人化政策評分。':'';});
 button('匯出照片卡',async()=>{try{await exportPhoto();caption.textContent='照片卡已產生';}catch(e){caption.textContent='照片卡無法匯出，請確認模型圖片允許跨來源讀取。';}});ui.append(caption);
 function clearLines(){for(const l of lines){root.remove(l);l.geometry.dispose();l.material.dispose();}lines.length=0;}
 function showConnections(ids){clearLines();const valid=[...new Set(ids)].filter(id=>at(id)).slice(0,25);for(let i=1;i<valid.length;i++){const a=at(valid[0]).clone(),b=at(valid[i]).clone();a.y=b.y=1.3;const m=a.clone().lerp(b,.5);m.y+=Math.min(8,a.distanceTo(b)*.12);const g=new THREE.BufferGeometry().setFromPoints(new THREE.QuadraticBezierCurve3(a,m,b).getPoints(24));const mat=new THREE.LineDashedMaterial({color:0xd5805e,dashSize:1,gapSize:.6,transparent:true,opacity:.8});const l=new THREE.Line(g,mat);l.computeLineDistances();root.add(l);lines.push(l);}}
 async function exportPhoto(){// Synchronous render+copy avoids preserveDrawingBuffer and GPU memory overhead.
  renderer.render(scene,camera);const c=document.createElement('canvas');c.width=1200;c.height=800;const ctx=c.getContext('2d');ctx.fillStyle='#f5f1e8';ctx.fillRect(0,0,1200,800);ctx.drawImage(renderer.domElement,0,0,1200,700);ctx.fillStyle='#283b3d';ctx.font='bold 26px sans-serif';ctx.fillText('慧文政績島',32,745);ctx.font='18px sans-serif';ctx.fillText(data.islands.find(x=>x.id===selected)?.name||'一起探索生活的改變',32,777);const blob=await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error('canvas')),'image/png'));const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='慧文政績島_照片卡.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 const changed=()=>{if(media.matches){if(flight)stepFlight(1e3);if(tour)tour.paused=true;}};media.addEventListener('change',changed);
 return {get reduced(){return media.matches;},get touring(){return !!tour;},startTour(){tour={i:0,wait:0,paused:media.matches};visit();},selectIsland(id){selected=id;paint();},hoverIsland(id){hover=id;paint();},showConnections,flyTo,exportPhoto,
 update(dt,t){if(document.hidden)return;stepFlight(dt);if(tour&&!tour.paused&&!media.matches){tour.wait+=dt;if(tour.wait>7){tour.wait=0;tour.i++;if(tour.i>=tourOrder.length){tour=null;caption.textContent='導覽結束';}else visit();}}if(!media.matches){for(const l of lines)l.material.opacity=.65+.15*Math.sin(t*1.5);}elapsed=t;},
 dispose(){controls.removeEventListener('start',stopManual);media.removeEventListener('change',changed);clearLines();owned.forEach(o=>o.dispose());world.remove(root);ui.remove();}};
}
export function createTicker({element,items,onItem,reduced=()=>false}){
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());
 const entries=items.flatMap((it,n)=>(it.h||[]).filter(([d,t])=>t&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&d<=today).map(([d,t])=>({d,t,n,title:it.t}))).sort((a,b)=>b.d.localeCompare(a.d)).slice(0,40);let i=0,time=0;
 const show=()=>{element.replaceChildren();if(!entries.length){element.hidden=true;return;}element.hidden=false;const e=entries[i],b=document.createElement('button');b.type='button';b.textContent=`鳳山日誌 ${e.d} ${e.title}｜${e.t}`;b.onclick=()=>onItem(e.n);element.append(b);};show();return{update(dt){if(document.hidden||reduced()||element.matches(':hover,:focus-within'))return;time+=dt;if(time>=8&&entries.length){time=0;i=(i+1)%entries.length;show();}},dispose(){element.replaceChildren();}};
}
