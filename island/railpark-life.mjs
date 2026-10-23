/** Three.js r169. Owns no renderer, RAF, DOM or scene assets. */
export function createRailparkLife(root, { reducedMotion, enabled = true } = {}) {
  const swing=root.getObjectByName('RailparkSwingPivot');
  const child=root.getObjectByName('RailparkSlideChild');
  const cart=root.getObjectByName('RailparkPedalCart');
  const nodes=[swing,child,cart].filter(Boolean);
  const saved=nodes.map(node=>({node,p:node.position.clone(),q:node.quaternion.clone(),visible:node.visible}));
  const media=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reduce=reducedMotion ?? media?.matches ?? false, time=0, disposed=false;
  const listener=e=>{if(reducedMotion===undefined){reduce=e.matches;if(reduce) reset();}};
  media?.addEventListener?.('change',listener);
  function reset(){for(const s of saved){s.node.position.copy(s.p);s.node.quaternion.copy(s.q);s.node.visible=s.visible;}}
  // Coordinates are root-local Y-up; follow verified front red slide, never world coords.
  const path=[[-.55,1.25,.96],[-.55,1.17,1.23],[-.55,.92,1.50],[-.55,.59,1.78],[-.55,.38,2.05],[-.55,.35,2.25]];
  return {
    nodesFound: {swing:!!swing,slideChild:!!child,pedalCart:!!cart},
    update(dt){
      if(disposed||!enabled||reduce||!root.visible)return;
      // clamp stalls; one update per parent frame; no new allocations, geometry or shadows.
      if(!Number.isFinite(dt)||dt<=0)return;time+=Math.min(dt,.05);
      if(swing){swing.quaternion.copy(saved.find(s=>s.node===swing).q);swing.rotateX(Math.sin(time*1.7)*.16);}
      if(cart)cart.position.x=1.65+.43*Math.sin(time*.43);
      if(child){
        const phase=(time%7)/7;
        // Child is visible only below the exit or above entrance, not through opaque tube.
        child.visible=phase<.12 || phase>.70 && phase<.88;
        const u=Math.min(phase/.8,1)*(path.length-1),i=Math.min(Math.floor(u),path.length-2),a=path[i],b=path[i+1],f=u-i;
        child.position.set(a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f,a[2]+(b[2]-a[2])*f);
      }
    },
    setEnabled(value){enabled=!!value;if(!enabled)reset();},
    setReducedMotion(value){reduce=!!value;if(reduce)reset();},
    dispose(){if(disposed)return;disposed=true;media?.removeEventListener?.('change',listener);reset();}
  };
}
