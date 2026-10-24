export function validEvents(payload,islands,now=Date.now()){
 return (payload.events||[]).filter(e=>e.published===true&&e.status==='published'&&typeof e.id==='string'&&typeof e.title==='string'&&typeof e.place==='string'&&typeof e.description==='string'&&islands.has(e.island)&&/^\d{4}-\d{2}-\d{2}T.*(?:\+08:00)$/.test(e.date)&&Number.isFinite(Date.parse(e.date))&&Date.parse(e.endDate||e.date)>=now);
}
export function mountEvents({root,payload,index,onSelectIsland,THREE,world,islandCenter}){
 const events=validEvents(payload,index.islands),markers=[];const title=document.createElement('h3');title.textContent='活動宣布';root.append(title);
 if(!events.length){root.hidden=true;}
 for(const e of events){const b=document.createElement('button');b.type='button';b.textContent=`${new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(e.date))}｜${e.title}｜${e.place}`;b.onclick=()=>onSelectIsland(e.island);const p=document.createElement('p');p.textContent=e.description;root.append(b,p);
 const center=islandCenter?.[e.island];if(THREE&&world&&center){const mesh=new THREE.Mesh(new THREE.ConeGeometry(1.1,2.6,6),new THREE.MeshBasicMaterial({color:0xe4994a}));mesh.rotation.x=Math.PI;mesh.position.set(center.x,12,center.z);mesh.userData={island:e.island,eventId:e.id};world.add(mesh);markers.push(mesh);}}
 return {dispose(){for(const m of markers){m.removeFromParent();m.geometry.dispose();m.material.dispose()}root.replaceChildren()}};
}
