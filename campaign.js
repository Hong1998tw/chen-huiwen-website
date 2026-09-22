'use strict';
(() => {
  // A date never establishes an election result or the next term's officeholder.
  const defaults = Object.freeze({voteDate:'2026-11-28',pollsOpen:'08:00',pollsClose:'16:00'});
  function electionState(data=defaults, now=Date.now()) {
    const date=data.voteDate || defaults.voteDate;
    const day=new Date(`${date}T00:00:00+08:00`).getTime();
    const open=new Date(`${date}T${data.pollsOpen || '08:00'}:00+08:00`).getTime();
    const close=new Date(`${date}T${data.pollsClose || '16:00'}:00+08:00`).getTime();
    const year=Number(date.slice(0,4));
    const localYear=Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Taipei'}).format(new Date(now)));
    if (now<day) return {phase:'before',label:'距離投票日',value:String(Math.ceil((day-now)/86400000)),unit:'天'};
    if (now<open) return {phase:'election-day',label:'今日投票',value:'今日',unit:`${data.pollsOpen || '08:00'}–${data.pollsClose || '16:00'}`};
    if (now<close) return {phase:'voting',label:'投票進行中',value:'今日',unit:`至 ${data.pollsClose || '16:00'}`};
    if (localYear>year) return {phase:'historical',label:'歷史選務資訊',value:String(year),unit:'結果以官方公告為準'};
    return {phase:'ended',label:'投票已結束',value:'已結束',unit:'結果以官方公告為準'};
  }
  let current=defaults;
  function apply(data=current) {
    current={...defaults,...data};
    const node=document.getElementById('campaign-countdown');
    if (!node) return;
    const state=electionState(current);
    node.textContent=state.value;
    node.dataset.phase=state.phase;
    const unit=document.getElementById('campaign-countdown-unit');
    if(unit) unit.textContent=state.unit;
    const label=document.getElementById('countdown-heading') || node.parentElement.querySelector('[data-campaign-label]') || node.previousElementSibling;
    if(label) label.textContent=state.label;
    const container=node.closest('.hero-election-status,.campaign-countdown');
    if(container) container.dataset.electionPhase=state.phase;
  }
  window.HuiwenCampaign=Object.freeze({electionState,apply});
  apply();
  let timer=setInterval(()=>apply(),60000);
  addEventListener('pagehide',()=>clearInterval(timer));
  addEventListener('pageshow',()=>{apply();clearInterval(timer);timer=setInterval(()=>apply(),60000);});
})();
