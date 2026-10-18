import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

let sequence = 0;

function directoryPath(directory) {
  return directory instanceof URL ? fileURLToPath(directory) : directory;
}

function filenamePart(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'layout-failure';
}

export async function captureLayoutDiagnostics(page, {directory, label, error, extra} = {}) {
  const evidence = await page.evaluate(({label: pageLabel}) => {
    const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
    const rectOf = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {x:round(rect.x),y:round(rect.y),top:round(rect.top),right:round(rect.right),bottom:round(rect.bottom),left:round(rect.left),width:round(rect.width),height:round(rect.height)};
    };
    const selectorOf = element => {
      if (!element) return null;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
        let part = node.localName;
        if (node.id) {
          part += `#${node.id}`;
          parts.unshift(part);
          break;
        }
        if (node.classList.length) part += [...node.classList].slice(0, 3).map(name => `.${name}`).join('');
        const siblings = node.parentElement ? [...node.parentElement.children].filter(sibling => sibling.localName === node.localName) : [];
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    };
    const describe = element => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        selector:selectorOf(element),
        rect:rectOf(element),
        display:style.display,
        visibility:style.visibility,
        position:style.position,
        zIndex:style.zIndex,
        pointerEvents:style.pointerEvents,
        overflowX:style.overflowX,
        fontSize:style.fontSize,
        minWidth:style.minWidth,
        flex:style.flex,
        gridTemplateColumns:style.gridTemplateColumns,
        scrollWidth:element.scrollWidth,
        clientWidth:element.clientWidth,
        scrollHeight:element.scrollHeight,
        clientHeight:element.clientHeight,
      };
    };
    const documentElement = document.documentElement;
    const header = document.querySelector('.site-header');
    const navigation = document.querySelector('.site-header nav');
    const toggle = document.querySelector('.menu-toggle');
    const backdrop = document.querySelector('.menu-backdrop');
    const sectionNodes = [...new Set(document.querySelectorAll('main section,main article,main > *'))];
    const sections = sectionNodes.map(element => ({selector:selectorOf(element),rect:rectOf(element),scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight}));
    const overflowCulprits = [...document.body.querySelectorAll('*')].map(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const boxOverflow = Math.max(0, -rect.left, rect.right - innerWidth);
      const contentOverflow = Math.max(0, element.scrollWidth - element.clientWidth);
      return {element,boxOverflow,contentOverflow,style,rect};
    }).filter(item => item.boxOverflow > 0.5 || item.contentOverflow > 1).sort((a,b) => Math.max(b.boxOverflow,b.contentOverflow) - Math.max(a.boxOverflow,a.contentOverflow)).slice(0,80).map(item => ({
      selector:selectorOf(item.element),
      rect:{x:Math.round(item.rect.x*100)/100,y:Math.round(item.rect.y*100)/100,left:Math.round(item.rect.left*100)/100,right:Math.round(item.rect.right*100)/100,width:Math.round(item.rect.width*100)/100,height:Math.round(item.rect.height*100)/100},
      boxOverflow:round(item.boxOverflow),
      contentOverflow:round(item.contentOverflow),
      scrollWidth:item.element.scrollWidth,
      clientWidth:item.element.clientWidth,
      display:item.style.display,
      position:item.style.position,
      overflowX:item.style.overflowX,
      whiteSpace:item.style.whiteSpace,
      minWidth:item.style.minWidth,
      flex:item.style.flex,
      gridTemplateColumns:item.style.gridTemplateColumns,
    }));
    const hitTest = [];
    const backdropRect = backdrop?.getBoundingClientRect();
    if (backdrop && backdropRect && backdropRect.width > 0 && backdropRect.height > 0 && getComputedStyle(backdrop).display !== 'none') {
      for (const yRatio of [0.1,0.3,0.5,0.7,0.9]) for (const xRatio of [0.1,0.3,0.5,0.7,0.9]) {
        const x = Math.max(0,Math.min(innerWidth-1,backdropRect.left+backdropRect.width*xRatio));
        const y = Math.max(0,Math.min(innerHeight-1,backdropRect.top+backdropRect.height*yRatio));
        const stack = document.elementsFromPoint(x,y).slice(0,4);
        hitTest.push({x:round(x),y:round(y),top:selectorOf(stack[0]),stack:stack.map(selectorOf),backdropReceivesPointer:stack[0] === backdrop || backdrop.contains(stack[0])});
      }
    }
    return {
      label:pageLabel,
      url:location.pathname,
      viewport:{innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY},
      document:{scrollWidth:documentElement.scrollWidth,clientWidth:documentElement.clientWidth,scrollHeight:documentElement.scrollHeight,clientHeight:documentElement.clientHeight},
      header:describe(header),
      brand:describe(document.querySelector('.site-header .brand')),
      brandChildren:[...document.querySelectorAll('.site-header .brand > *')].map(describe),
      navigation:describe(navigation),
      menuToggle:describe(toggle),
      backdrop:describe(backdrop),
      backdropHitTest:hitTest,
      sections,
      overflowCulprits,
    };
  }, {label});

  const outputDirectory = directoryPath(directory);
  await mkdir(outputDirectory, {recursive:true});
  sequence += 1;
  const base = `${String(sequence).padStart(2,'0')}-${filenamePart(label)}`;
  const jsonPath = path.join(outputDirectory, `${base}.json`);
  const screenshotPath = path.join(outputDirectory, `${base}.png`);
  const diagnostic = {label,error:error === undefined ? null : String(error),...evidence,...(extra === undefined ? {} : {extra}),files:{json:jsonPath,screenshot:screenshotPath}};
  await writeFile(jsonPath, JSON.stringify(diagnostic,null,2));
  try {
    await page.screenshot({path:screenshotPath,animations:'disabled',timeout:8000});
    diagnostic.files.screenshotStatus = 'saved';
  } catch (screenshotError) {
    diagnostic.files.screenshotStatus = `failed: ${String(screenshotError)}`;
  }
  await writeFile(jsonPath, JSON.stringify(diagnostic,null,2));
  console.error(`[layout-diagnostic] ${JSON.stringify({label,document:diagnostic.document,header:diagnostic.header?.rect,backdrop:diagnostic.backdrop?.rect,files:diagnostic.files})}`);
  return diagnostic;
}

export async function assertNoHorizontalOverflow(page, {directory, label} = {}) {
  const dimensions = await page.evaluate(() => ({innerWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}));
  if (dimensions.scrollWidth > dimensions.innerWidth) {
    await captureLayoutDiagnostics(page,{directory,label,error:`horizontal overflow: document scrollWidth ${dimensions.scrollWidth}px exceeds viewport ${dimensions.innerWidth}px`,extra:dimensions});
    throw new Error(`${label}: horizontal overflow ${dimensions.scrollWidth}px > ${dimensions.innerWidth}px`);
  }
  return dimensions;
}

export async function findVisibleClickPoint(page, selector) {
  return page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect();
    const samples = [];
    for (const yRatio of [0.95,0.8,0.65,0.5,0.35,0.2,0.05]) for (const xRatio of [0.95,0.75,0.5,0.25,0.05]) {
      const x = Math.max(0,Math.min(innerWidth-1,rect.left+rect.width*xRatio));
      const y = Math.max(0,Math.min(innerHeight-1,rect.top+rect.height*yRatio));
      const hit = document.elementFromPoint(x,y);
      const stack = document.elementsFromPoint(x,y).slice(0,4);
      samples.push({x:Math.round(x*100)/100,y:Math.round(y*100)/100,hit:hit ? `${hit.localName}${hit.id ? `#${hit.id}` : ''}${[...hit.classList].slice(0,3).map(name=>'.'+name).join('')}` : null,stack:stack.map(node=>`${node.localName}${node.id ? `#${node.id}` : ''}${[...node.classList].slice(0,3).map(name=>'.'+name).join('')}`),targetReceivesPointer:hit === element || element.contains(hit)});
    }
    return {rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},samples,selected:samples.find(sample=>sample.targetReceivesPointer) || null};
  });
}
