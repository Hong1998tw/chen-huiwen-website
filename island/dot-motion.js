import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
export const mod = (x,n) => ((x%n)+n)%n;
export function turn(current,target,dt,rate=9) { return current + Math.atan2(Math.sin(target-current),Math.cos(target-current))*(1-Math.exp(-rate*dt)); }
/** Asset ownership: shared geometry/materials, independent skeleton + animation mixer. */
export function createActors() {
  const assets=new Map(), instances=new WeakMap(), active=new Set();
  return {
    remember(kind,id,gltf) { assets.set(`${kind}/${id}`,gltf); },
    clone(kind,id,scale=1) {
      const a=assets.get(`${kind}/${id}`); if(!a)return null;
      const root=new THREE.Group(), model=skeletonClone(a.scene); model.scale.setScalar(scale);root.add(model);
      const mixer=new THREE.AnimationMixer(model), clip=a.animations.find(c=>c.name.toLowerCase()==='walk')||a.animations.find(c=>c.name.toLowerCase()==='idle');
      const walk=clip?mixer.clipAction(clip):null; walk?.play();
      const record={root,mixer,walk,model};instances.set(root,record);active.add(record);return root;
    },
    update(root,dt,moving,reduced=false) { const a=instances.get(root);if(!a)return false;if(a.walk){a.walk.paused=!moving||reduced;if(moving&&!reduced)a.mixer.update(dt);}return !!a.walk; },
    remove(root){const a=instances.get(root);if(a){a.mixer.stopAllAction();a.mixer.uncacheRoot(a.model);active.delete(a);instances.delete(root);}},
    dispose(){for(const a of active){a.mixer.stopAllAction();a.mixer.uncacheRoot(a.model);}active.clear();}
  };
}
/** Explicit rig adapter: no guessing arbitrary mesh names or modifying shared materials. */
export function createFigureGesture(root,{arm=null,head=null}={}) {
  const baseY=root.position.y, armZ=arm?.rotation.z??0, headY=head?.rotation.y??0;
  let wave=0;
  return { wave(){wave=2.4;}, update(dt,t,reduced){wave=Math.max(0,wave-dt);root.position.y=baseY+(reduced?0:Math.sin(t*1.4)*.025);if(arm)arm.rotation.z=armZ+(reduced?0:wave>0?-.8+Math.sin(t*7)*.18:Math.sin(t)*.025);if(head)head.rotation.y=headY+(reduced?0:Math.sin(t*.7)*.035);},dispose(){root.position.y=baseY;if(arm)arm.rotation.z=armZ;if(head)head.rotation.y=headY;} };
}
/** Single frame owner. Zero-dt initialization places every actor even in reduced motion. */
export function createStreetMotion({walkers,cars,traffic,hexPoint,TOP,actors,sirenRed,sirenBlue}) {
  return {dispose(){for(const c of cars){if(c.sirenGlow){c.siren.material=sirenRed;c.sirenGlow.dispose();delete c.sirenGlow;}}},update(dt,t,reduced=false){
    for(const w of walkers){const dir=Math.sign(w.s)||1;const allowed=traffic.pedestrianAllowed(w.key,w.u,dir);const step=reduced||!allowed?0:w.s*dt;w.u=mod(w.u+step,6);const p=hexPoint(w.c,w.rad,w.u),q=hexPoint(w.c,w.rad,mod(w.u+dir*.02,6));w.p.position.set(p.x,TOP+.08,p.z);const yaw=Math.atan2(q.x-p.x,q.z-p.z);w.p.rotation.y=dt===0?yaw:turn(w.p.rotation.y,yaw,dt);const clip=actors.update(w.p,dt,step!==0,reduced);if(!clip&&w.limbs){const sw=reduced||!step?0:Math.sin(t*7+w.u*13)*.6;w.limbs.legs.forEach((p,i)=>p.rotation.x=i?-sw:sw);w.limbs.arms.forEach((p,i)=>p.rotation.x=(i?sw:-sw)*.8);}}
    for(const c of cars){const dir=Math.sign(c.speed)||1;const f=traffic.speedFactor(c.key,c.u,dir);c.velocity??=0;c.velocity+=(Math.abs(c.speed)*f-c.velocity)*(1-Math.exp(-dt*7));let du=reduced?0:c.velocity*dt;du=Math.min(du,traffic.maxAdvance(c.key,c.u,dir));c.u=mod(c.u+dir*du,6);const p=hexPoint(c.c,c.lane,c.u),q=hexPoint(c.c,c.lane,mod(c.u+dir*.02,6));c.obj.position.set(p.x,TOP+.05,p.z);const yaw=-Math.atan2(q.z-p.z,q.x-p.x);c.obj.rotation.y=dt===0?yaw:turn(c.obj.rotation.y,yaw,dt);if(c.siren){if(!c.sirenGlow){c.sirenGlow=sirenRed.clone();c.siren.material=c.sirenGlow;}const blend=reduced?0:(1+Math.sin(t*2))*.5;c.sirenGlow.color.copy(sirenRed.color).lerp(sirenBlue.color,blend);c.sirenGlow.emissive.copy(sirenRed.emissive).lerp(sirenBlue.emissive,blend);c.sirenGlow.emissiveIntensity=reduced?.4:.65;}}
  }};
}

/** Rig-free greeting: rotate a visual-only pivot at the feet, never add duplicate limbs.
 * Horizontal navigation/yaw stays owned by the parent. Attack/release are C1 smooth.
 */
export function createSimulatedGreeting(root) {
  const pivot=new THREE.Group();pivot.name='dot-greeting-visual';
  for(const child of [...root.children])pivot.add(child);
  root.add(pivot);let elapsed=3,phase=0;const duration=2.6;
  const smooth=x=>x*x*(3-2*x);
  return {trigger(){elapsed=0;},update(dt,reduced=false){
    if(reduced){elapsed=duration;pivot.rotation.set(0,0,0);return;}
    dt=Math.max(0,Math.min(dt,.1));phase+=dt;elapsed=Math.min(duration,elapsed+dt);
    const attack=smooth(Math.min(1,elapsed/.35)),release=smooth(Math.min(1,(duration-elapsed)/.5));
    const weight=attack*release;
    // Small bow + friendly side-to-side greeting. No arm deformation or extra mesh.
    pivot.rotation.x=.012*Math.sin(phase*1.15)+weight*.065*Math.sin(elapsed*Math.PI/duration);
    pivot.rotation.z=weight*.045*Math.sin(elapsed*5.5);
  },dispose(){for(const child of [...pivot.children])root.add(child);root.remove(pivot);},get pivot(){return pivot;}};
}
