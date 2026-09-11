'use strict';
(() => {
  const countdown=document.getElementById('campaign-countdown');
  if(!countdown)return;
  const target=new Date('2026-11-28T00:00:00+08:00').getTime();
  const update=()=>{
    const diff=Math.max(0,target-Date.now());
    countdown.textContent=String(Math.ceil(diff/86400000));
    const unit=document.getElementById('campaign-countdown-unit');
    if(unit)unit.textContent=diff>0?'天，距離投票日':'投票日';
  };
  update();
  const timer=setInterval(update,60000);
  addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
