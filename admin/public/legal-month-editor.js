'use strict';
(() => {
  const names=['林岡輝','鄭明達','陳順得','蘇姵禎','唐治民','林宜儒','湯雅竣'];
  const defaults={2:{start:'16:30',end:'18:00'},3:{start:'10:00',end:'11:30'},4:{start:'19:30',end:'21:00'},5:{start:'16:30',end:'18:00'},6:{start:'10:00',end:'11:30'}};
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  function create(payload,onChange){
    let month=payload.month, hours=structuredClone(payload.weekdayTimes||defaults), selected=new Map(), renderVersion=0;
    const cache=new Map(), root=el('section',undefined,'lawyer-month-editor'), grid=el('div',undefined,'lawyer-month-columns');
    const status=el('p');status.setAttribute('role','status');
    const note=el('p','年月會自動重排星期與日期。逐日選擇律師或無／停辦；待填內容可存草稿，填妥後才能發布。','hint');
    const tools=el('div',undefined,'toolbar'), empty=el('button','待填日期全部設為無／停辦','secondary'), preview=el('button','預覽本月圖卡','secondary');
    empty.type=preview.type='button';tools.append(empty,preview);
    const picture=el('div',undefined,'legal-card-preview');
    const load=value=>{
      selected=new Map();
      hours=structuredClone(value.weekdayTimes||defaults);
      for(const s of value.sessions||[]){selected.set(s.date,s.lawyer||'');const w=window.HuiwenLegalCard.weekday(s.date);if(w>=2)hours[w]={start:s.start,end:s.end};}
      for(const date of value.closedDates||[])selected.set(date,'none');
    };
    load(payload);
    function dates(){
      if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month||''))return [];
      const [y,m]=month.split('-').map(Number),count=new Date(Date.UTC(y,m,0)).getUTCDate(),result=[];
      for(let d=1;d<=count;d++){const date=month+'-'+String(d).padStart(2,'0');if(window.HuiwenLegalCard.weekday(date)>=2)result.push(date);}
      return result;
    }
    function value(){
      const sessions=[],closedDates=[],unconfirmedDates=[];
      for(const date of dates()){
        const name=selected.get(date),w=window.HuiwenLegalCard.weekday(date);
        if(name==='none')closedDates.push(date);
        else if(name)sessions.push({date,start:hours[w].start,end:hours[w].end,lawyer:name});
        else unconfirmedDates.push(date);
      }
      return {sessions,closedDates,unconfirmedDates,weekdayTimes:structuredClone(hours)};
    }
    function changed(){renderVersion++;picture.replaceChildren();updateStatus();onChange();}
    function updateStatus(){const v=value();status.textContent=v.unconfirmedDates.length?'尚有 '+v.unconfirmedDates.length+' 日待填；已排 '+v.sessions.length+' 場':'本月已確認 '+v.sessions.length+' 場，其餘已選無／停辦';preview.disabled=Boolean(v.unconfirmedDates.length)||!dates().length;}
    function render(){
      grid.replaceChildren();
      for(let w=2;w<=6;w++){
        const col=el('section',undefined,'lawyer-month-column'),heading=el('h3','週'+'日一二三四五六'[w]);col.append(heading);
        for(const [key,label] of [['start','開始時間'],['end','結束時間']]){
          const field=el('label','週'+'日一二三四五六'[w]+label),input=el('input');input.type='time';input.step='60';input.value=hours[w][key];input.required=true;
          input.setAttribute('aria-label','週'+'日一二三四五六'[w]+label);
          input.addEventListener('input',()=>{hours[w][key]=input.value;changed();});field.append(input);col.append(field);
        }
        for(const date of dates().filter(d=>window.HuiwenLegalCard.weekday(d)===w)){
          const label=el('label',Number(date.slice(5,7))+'/'+Number(date.slice(8))),select=el('select');
          select.dataset.legalDate=date;select.setAttribute('aria-label',date+' 律師');
          const choices=[['','待填'],['none','無／停辦'],...names.map(n=>[n,n])];
          const existing=selected.get(date);if(existing&&existing!=='none'&&!names.includes(existing))choices.push([existing,existing]);
          for(const [v,t] of choices){const option=el('option',t);option.value=v;select.append(option);}
          select.value=existing||'';select.addEventListener('change',()=>{selected.set(date,select.value);changed();});label.append(select);col.append(label);
        }
        grid.append(col);
      }
      updateStatus();
    }
    empty.addEventListener('click',()=>{for(const date of dates())if(!selected.get(date))selected.set(date,'none');render();changed();});
    preview.addEventListener('click',async()=>{
      const v=value();if(v.unconfirmedDates.length)return;
      const version=++renderVersion;preview.disabled=true;status.textContent='正在準備草稿圖卡…';
      try{
        const canvas=await window.HuiwenLegalCard.makeCard({month,...v},{draft:true});
        if(version!==renderVersion)return;picture.replaceChildren(canvas);status.textContent='草稿圖卡預覽；儲存並確認發布後，民眾才會看到新月份';
      }catch(e){status.textContent=e.message;}
      finally{if(version===renderVersion)preview.disabled=false;}
    });
    root.append(note,tools,grid,status,picture);render();
    return {element:root,getValue:value,setMonth(next){
      if(next===month)return;
      if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(next))return;
      cache.set(month,value());month=next;
      load(cache.get(next)||{sessions:[],closedDates:[],weekdayTimes:defaults});
      render();changed();
    }};
  }
  window.HuiwenLegalEditor=Object.freeze({create});
})();
