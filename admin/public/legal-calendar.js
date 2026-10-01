'use strict';
(() => {
  const week = '日一二三四五六';
  const monthParts = value => {
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) throw Error('月份格式不正確');
    return value.split('-').map(Number);
  };
  const weekday = value => new Date(value + 'T12:00:00+08:00').getUTCDay();
  // Noon in Taipei is still the same UTC calendar day.
  const slots = data => [...data.sessions].sort((a,b) => a.date.localeCompare(b.date));
  const make = (tag,text,cls) => {const el=document.createElement(tag); if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
  const endsAt = slot => Date.parse(slot.date + 'T' + slot.end + ':00+08:00');
  const taipeiDay = now => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  async function makeCard(data, options={}) {
    const [year, month] = monthParts(data.month);
    const sessions=slots(data), last=new Date(Date.UTC(year,month,0)).getUTCDate();
    if (sessions.some(s=>!s.lawyer)) throw Error('此月份未完整收錄律師姓名，請使用文字時間表或來電確認');
    if(sessions.some(s=>![2,3,4,5,6].includes(weekday(s.date)))) throw Error('此月份包含額外服務日，請以文字時間表為準');
    const base=options.assetBase || 'assets/legal/';
    await Promise.all([document.fonts.load('700 48px HuiwenCardSerif'),document.fonts.load('700 30px HuiwenCardSans')]);
    if (!document.fonts.check('700 48px HuiwenCardSerif') || !document.fonts.check('700 30px HuiwenCardSans')) throw Error('圖卡字型尚未載入');
    const portrait=new Image(), brand=new Image();portrait.src=base+'portrait.webp';brand.src=base+'brand-reference.webp';
    await Promise.all([portrait.decode(),brand.decode()]);
    const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
    canvas.setAttribute('role','img');canvas.setAttribute('aria-label',year+'年'+month+'月公益律師諮詢圖卡；完整日期、律師與時段見文字表');
    const ctx=canvas.getContext('2d');ctx.fillStyle='#76a5a1';ctx.fillRect(0,0,1920,1080);
    const text=(value,x,y,size,color='#242120',font='HuiwenCardSerif',align='left')=>{
      ctx.fillStyle=color;ctx.font='700 '+size+'px '+font;ctx.textAlign=align;ctx.fillText(value,x,y);
    };
    const rect=(x,y,w,h,r,color)=>{ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();};
    ctx.save();ctx.beginPath();ctx.rect(0,145,715,935);ctx.clip();ctx.drawImage(portrait,-60,24,836.4,1255.2);ctx.restore();
    ctx.drawImage(brand,20,22,204,139,20,22,204,139);
    ctx.drawImage(brand,14,911,340,164,14,911,340,164);
    rect(710,35,270,132,25,'#9283bd');text(month+'月',846,143,109,'#fff','HuiwenCardSans','center');
    let titleX=1010;for(const ch of '公益律師諮詢'){text(ch,titleX,144,116,'#fff');titleX+=148;}
    ctx.fillStyle='#f7c38a';for(let x=698;x<1915;x+=14)ctx.fillRect(x,190,7,7);
    const first=weekday(data.month+'-01');
    for(let w=2;w<=6;w++){
      const x=672+(w-2)*249.5, onDay=sessions.filter(s=>weekday(s.date)===w);
      const times=[...new Set(onDay.map(s=>s.start+'~'+s.end))], mixed=times.length>1;
      rect(x,248,228,721,29,'#cbbbb5');rect(x+24,265,180,144,26,'#efebe8');
      text('週 '+week[w],x+114,345,58,'#578f89','HuiwenCardSerif','center');
      text(times.length===1?times[0]:mixed?'各日時間':'本月無場次',x+114,383,27,'#578f89','HuiwenCardSans','center');
      for(let d=1;d<=last;d++){
        const date=data.month+'-'+String(d).padStart(2,'0');if(weekday(date)!==w)continue;
        const row=Math.floor((d+first-1)/7), y=449+row*110, slot=sessions.find(s=>s.date===date);
        text(String(d),x+42,y,37,'#578f89','HuiwenCardSans');
        text(slot?slot.lawyer:'無',x+128,y+(mixed?42:58),slot&&slot.lawyer.length>4?32:43,'#242120','HuiwenCardSerif','center');
        if(slot&&mixed)text(slot.start+'~'+slot.end,x+114,y+69,20,'#242120','HuiwenCardSans','center');
      }
    }
    text(options.draft?'未發布':'huiwen.tw',1285,1052,28,'#242120','HuiwenCardSans','center');
    text(year+'年'+month+'月',1904,1052,28,'#242120','HuiwenCardSans','right');
    return canvas;
  }
  async function download(data,options={}) {
    const canvas=await makeCard(data,options);
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('圖卡輸出失敗')),'image/png'));
    const url=URL.createObjectURL(blob), link=make('a');
    link.href=url;link.download=data.month+'_公益律師_陳慧文服務處'+(options.draft?'_草稿':'')+'.png';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    return {width:canvas.width,height:canvas.height};
  }
  window.HuiwenLegalCard=Object.freeze({makeCard,download,monthParts,weekday,endsAt,taipeiDay});
  async function start(){
    const host=document.querySelector('[data-legal-calendar]');if(!host)return;
    const script=document.getElementById('legal-schedule-data');if(!script)return;
    let data;try{data=JSON.parse(script.textContent);monthParts(data.month);}catch{return;}
    const [year,month]=monthParts(data.month), sessions=slots(data), now=new Date();
    const calendar=host.querySelector('.legal-month-grid'), list=document.querySelector('.schedule-text table');
    const currentDay=taipeiDay(now), pastMonth=currentDay.slice(0,7)>data.month;
    const focus=host.querySelector('.legal-selected'), state=host.querySelector('[data-legal-selection-state]');
    function choose(slot,initial=false){
      const ended=endsAt(slot)<now.getTime();
      state.textContent=ended?'此場次已結束':initial?'下一場已公布諮詢':'已選場次';
      focus.querySelector('[data-legal-date]').textContent=month+'/'+Number(slot.date.slice(-2))+'（週'+week[weekday(slot.date)]+'）';
      focus.querySelector('[data-legal-time]').textContent=slot.start+'–'+slot.end;
      focus.querySelector('[data-legal-lawyer]').textContent=slot.lawyer?slot.lawyer+' 律師':'律師與名額請來電確認';
      for(const button of calendar.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.date===slot.date));
    }
    for(const label of week)calendar.append(make('div',label,'legal-weekday'));
    for(let n=0;n<weekday(data.month+'-01');n++){const blank=make('div','','legal-date-empty');blank.setAttribute('aria-hidden','true');calendar.append(blank);}
    const count=new Date(Date.UTC(year,month,0)).getUTCDate();
    for(let day=1;day<=count;day++){
      const iso=data.month+'-'+String(day).padStart(2,'0'),slot=sessions.find(s=>s.date===iso);
      const cell=make(slot?'button':'div',undefined,'legal-date'+(slot?' has-session':''));
      cell.append(make('span',String(day),'legal-date-number'));
      if(slot){
        cell.type='button';cell.dataset.date=iso;cell.setAttribute('aria-pressed','false');
        cell.setAttribute('aria-label',month+'月'+day+'日 週'+week[weekday(iso)]+' '+slot.start+'至'+slot.end+' '+(slot.lawyer||'律師諮詢')+(endsAt(slot)<now.getTime()?'，已結束':''));
        cell.append(make('span',slot.start+'–'+slot.end,'legal-date-time'));cell.append(make('span',slot.lawyer||'諮詢服務','legal-date-name'));
        cell.addEventListener('click',()=>choose(slot));
        if(endsAt(slot)<now.getTime())cell.classList.add('is-past');
      }
      calendar.append(cell);
    }
    const next=sessions.find(s=>endsAt(s)>=now.getTime());
    if(next)choose(next,true);
    else if(sessions.length){choose(sessions[sessions.length-1]);state.textContent='本月已公布場次已結束';}
    else{state.textContent='本月未安排諮詢場次';}
    const note=host.querySelector('[data-legal-month-state]');
    note.textContent=pastMonth?'此為'+year+'年'+month+'月時間表；新月份請先來電確認':year+'年'+month+'月已公布 '+sessions.length+' 場，請先確認名額再前往';
    const modes=host.querySelector('[data-legal-modes]'), picture=host.querySelector('.legal-card-preview'), feedback=host.querySelector('[data-card-status]');
    let cardPromise;
    async function showCard(){
      if(!cardPromise)cardPromise=makeCard(data).catch(e=>{cardPromise=null;throw e;});
      try{const canvas=await cardPromise;picture.replaceChildren(canvas);feedback.textContent='';}
      catch(e){feedback.textContent=e.message+'；文字時間表與電話預約仍可使用';}
    }
    function show(mode){
      host.dataset.legalActive=mode;calendar.hidden=mode!=='calendar';focus.hidden=mode!=='calendar';list.hidden=mode!=='list';picture.hidden=mode!=='card';
      for(const button of modes.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.legalView===mode));
      if(mode==='card')showCard();
    }
    for(const button of modes.querySelectorAll('button'))button.addEventListener('click',()=>show(button.dataset.legalView));
    const downloadButton=host.querySelector('[data-card-download]');
    downloadButton.addEventListener('click',async()=>{
      if(downloadButton.disabled)return;downloadButton.disabled=true;feedback.textContent='正在準備圖卡…';
      try{await download(data);feedback.textContent='圖卡已準備下載';}catch(e){feedback.textContent=e.message+'，請稍後重試';}
      finally{downloadButton.disabled=false;}
    });
    host.hidden=false;modes.hidden=false;
    show(matchMedia('(max-width: 430px)').matches?'list':'calendar');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
