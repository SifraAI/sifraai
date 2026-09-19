'use strict';

/*
 * Sifra Motion Engine.
 * Workflow inspired by latent-spaces/brag (MIT): storyboard -> composition
 * -> automated checks -> deterministic Hyperframes render -> poster/QA.
 * The math renderer and lesson composition below are Sifra-specific.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const katex = require('katex');
const math = require('mathjs');

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const JOB_ROOT = process.env.SIFRA_VIDEO_DIR || path.join(os.tmpdir(), 'sifra-video-jobs');

function clamp(value,min,max){
  const n=Number(value);
  return Number.isFinite(n)?Math.min(max,Math.max(min,n)):min;
}

function esc(value){
  return String(value??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function text(value,max=220){
  return String(value??'').replace(/\s+/g,' ').trim().slice(0,max);
}

function formula(value,max=260){
  return String(value??'').trim().slice(0,max);
}

function ktex(value){
  const source=formula(value);
  if(!source)return '';
  try{
    return katex.renderToString(source,{
      displayMode:true,
      throwOnError:false,
      strict:'ignore',
      trust:false,
      output:'html'
    });
  }catch{
    return '<span class="formula-fallback">'+esc(source)+'</span>';
  }
}

function normalizeElement(raw){
  const item=raw&&typeof raw==='object'?raw:{type:'text',text:String(raw??'')};
  return {
    type:text(item.type||'text',40).toLowerCase(),
    text:text(item.text,500),
    label:text(item.label,120),
    equation:text(item.equation,180),
    expression:text(item.expression,180),
    numerator:clamp(item.numerator,0,100),
    denominator:clamp(item.denominator,1,100),
    rows:clamp(Math.floor(Number(item.rows)||0),0,16),
    cols:clamp(Math.floor(Number(item.cols)||0),0,20),
    widthLabel:text(item.widthLabel,60),
    heightLabel:text(item.heightLabel,60),
    values:Array.isArray(item.values)?item.values.slice(0,10).map(Number).filter(Number.isFinite):[],
    labels:Array.isArray(item.labels)?item.labels.slice(0,10).map(v=>text(v,50)):[],
    items:Array.isArray(item.items)?item.items.slice(0,6).map((v,i)=>{
      if(v&&typeof v==='object')return {label:text(v.label||('תוצאה '+(i+1)),80),value:text(v.value,160)};
      return text(v,160);
    }):[],
    steps:Array.isArray(item.steps)?item.steps.slice(0,8).map((step,i)=>({
      formula:formula(step?.formula,260),
      note:text(step?.note,180),
      label:text(step?.label||('שלב '+(i+1)),80)
    })):[]
  };
}

function normalizeLesson(raw){
  const source=raw&&typeof raw==='object'?raw:{};
  const sourceScenes=Array.isArray(source.scenes)?source.scenes.slice(0,7):[];
  if(!sourceScenes.length)throw new Error('Lesson has no scenes');

  const scenes=sourceScenes.map((rawScene,index)=>{
    const scene=rawScene&&typeof rawScene==='object'?rawScene:{};
    const bg=String(scene?.background?.color||'').toLowerCase();
    return {
      seconds:clamp(scene.seconds??scene.duration??6,index===0?2:3.2,11),
      theme:bg==='white'||bg==='#fff'||bg==='#ffffff'?'light':bg==='black'||bg==='#000'||bg==='#000000'?'dark':index%2===0?'dark':'light',
      pattern:['grid','dots','none'].includes(String(scene?.background?.pattern||'').toLowerCase())?String(scene.background.pattern).toLowerCase():'none',
      elements:Array.isArray(scene.elements)?scene.elements.slice(0,12).map(normalizeElement):[]
    };
  });

  scenes[0].seconds=Math.min(scenes[0].seconds,3.2);
  let duration=scenes.reduce((sum,scene)=>sum+scene.seconds,0);

  if(duration>45){
    const scale=45/duration;
    scenes.forEach((scene,index)=>{
      scene.seconds=Math.max(index===0?2:3,scene.seconds*scale);
    });
    duration=scenes.reduce((sum,scene)=>sum+scene.seconds,0);
  }

  return {
    title:text(source.title||'סרטון הסבר במתמטיקה',100),
    scenes,
    duration
  };
}

function first(elements,types){
  const set=new Set(types);
  return elements.find(el=>set.has(el.type));
}

function all(elements,types){
  const set=new Set(types);
  return elements.filter(el=>set.has(el.type));
}

function graphSvg(equation){
  let expr=text(equation,180).replace(/−/g,'-').replace(/π/g,'pi').replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*/i,'');
  if(!expr)return '';

  let compiled;
  try{compiled=math.compile(expr)}catch{return ''}

  const pts=[];
  const ys=[];
  for(let i=0;i<=280;i+=1){
    const x=-10+20*i/280;
    let y=NaN;
    try{y=Number(compiled.evaluate({x,pi:Math.PI,e:Math.E}))}catch{}
    if(Number.isFinite(y)&&Math.abs(y)<1e5){pts.push([x,y]);ys.push(y)}else pts.push([x,NaN]);
  }
  if(ys.length<4)return '';

  const sorted=ys.slice().sort((a,b)=>a-b);
  let yMin=sorted[Math.floor((sorted.length-1)*.04)];
  let yMax=sorted[Math.floor((sorted.length-1)*.96)];
  if(!(yMax>yMin)){yMin-=1;yMax+=1}
  const span=Math.max(2,yMax-yMin);
  yMin-=span*.14;
  yMax+=span*.14;
  if(yMin>0&&yMin<span*.8)yMin=0;
  if(yMax<0&&Math.abs(yMax)<span*.8)yMax=0;

  const W=680,H=390,L=52,R=20,T=26,B=42,pw=W-L-R,ph=H-T-B;
  const px=x=>L+((x+10)/20)*pw;
  const py=y=>T+(1-(y-yMin)/(yMax-yMin))*ph;

  let d='',drawing=false,lastY=null;
  for(const point of pts){
    const x=point[0],y=point[1];
    if(!Number.isFinite(y)||y<yMin-span*2||y>yMax+span*2){drawing=false;lastY=null;continue}
    const sx=px(x),sy=py(y);
    if(lastY!==null&&Math.abs(sy-lastY)>ph*.9)drawing=false;
    d+=(drawing?' L ':' M ')+sx.toFixed(2)+' '+sy.toFixed(2);
    drawing=true;lastY=sy;
  }

  const xAxis=yMin<=0&&yMax>=0?py(0):T+ph;
  const yAxis=px(0);
  let grid='';
  for(let i=0;i<=10;i+=1){
    const gx=L+pw*i/10,gy=T+ph*i/10;
    grid+='<line x1="'+gx+'" y1="'+T+'" x2="'+gx+'" y2="'+(T+ph)+'"/>';
    grid+='<line x1="'+L+'" y1="'+gy+'" x2="'+(L+pw)+'" y2="'+gy+'"/>';
  }

  return '<svg class="math-graph" viewBox="0 0 '+W+' '+H+'"><g class="graph-grid">'+grid+'</g><g class="graph-axes"><line x1="'+L+'" y1="'+xAxis+'" x2="'+(L+pw)+'" y2="'+xAxis+'"/><line x1="'+yAxis+'" y1="'+T+'" x2="'+yAxis+'" y2="'+(T+ph)+'"/></g><path class="graph-path draw-path" d="'+esc(d.trim())+'"/></svg>';
}

function fractionHtml(el){
  const den=Math.max(1,Math.min(12,Math.floor(el.denominator||1)));
  const num=Math.max(0,Math.min(den,Math.floor(el.numerator||0)));
  let cells='';
  for(let i=0;i<den;i+=1)cells+='<span class="fraction-cell '+(i<num?'filled':'')+'"></span>';
  return '<div class="fraction-visual"><div class="fraction-grid" style="--parts:'+den+'">'+cells+'</div><div class="fraction-caption" dir="ltr">'+num+' / '+den+'</div></div>';
}

function rectangleHtml(el){
  const rows=Math.max(1,Math.min(8,Math.floor(el.rows||4)));
  const cols=Math.max(1,Math.min(12,Math.floor(el.cols||6)));
  let cells='';
  for(let i=0;i<rows*cols;i+=1)cells+='<span class="area-cell"></span>';
  return '<div class="rectangle-visual"><div class="rectangle-width">'+esc(el.widthLabel||String(cols))+'</div><div class="rectangle-row"><div class="rectangle-height">'+esc(el.heightLabel||String(rows))+'</div><div class="rectangle-grid" style="--rows:'+rows+';--cols:'+cols+'">'+cells+'</div></div><div class="rectangle-answer" dir="ltr">'+cols+' × '+rows+' = '+(cols*rows)+'</div></div>';
}

function numberlineHtml(expression){
  const src=text(expression,120).replace(/−/g,'-');
  const match=src.match(/^\s*x\s*(>=|>|<=|<|=)\s*(-?\d+(?:\.\d+)?)\s*$/i);
  if(!match)return '';
  const op=match[1],value=Number(match[2]),min=value-6,max=value+6;
  const W=700,H=190,L=38,R=38,Y=86,U=W-L-R,pos=v=>L+(v-min)/(max-min)*U;
  let ticks='';
  for(let i=0;i<=6;i+=1){
    const ratio=i/6,v=Math.round((min+ratio*(max-min))*10)/10,x=L+ratio*U;
    ticks+='<g><line x1="'+x+'" y1="'+(Y-7)+'" x2="'+x+'" y2="'+(Y+7)+'"/><text x="'+x+'" y="'+(Y+32)+'">'+esc(v)+'</text></g>';
  }
  const closed=op==='>='||op==='<='||op==='=';
  const seg=op==='='?'':op.startsWith('>')?'<line class="numberline-segment draw-line" x1="'+pos(value)+'" y1="'+Y+'" x2="'+pos(max)+'" y2="'+Y+'"/>':'<line class="numberline-segment draw-line" x1="'+pos(min)+'" y1="'+Y+'" x2="'+pos(value)+'" y2="'+Y+'"/>';
  return '<svg class="numberline" viewBox="0 0 '+W+' '+H+'"><line class="numberline-base" x1="'+L+'" y1="'+Y+'" x2="'+(W-R)+'" y2="'+Y+'"/><g class="numberline-ticks">'+ticks+'</g>'+seg+'<g class="numberline-mark"><circle cx="'+pos(value)+'" cy="'+Y+'" r="10" class="'+(closed?'closed':'open')+'"/><text class="numberline-label" x="'+pos(value)+'" y="'+(Y-28)+'">'+esc(op==='='?'x = '+value:value)+'</text></g></svg>';
}

function barsHtml(el){
  if(!el.values.length)return '';
  const max=Math.max(1,...el.values.map(v=>Math.abs(v)));
  return '<div class="bars-visual">'+el.values.map((value,index)=>{
    const h=Math.max(8,Math.abs(value)/max*100);
    return '<div class="bar-wrap"><span class="bar-value">'+esc(Math.round(value*100)/100)+'</span><span class="bar" style="height:'+h+'%"></span><span class="bar-label">'+esc(el.labels[index]||String(index+1))+'</span></div>';
  }).join('')+'</div>';
}

function visualHtml(el){
  if(!el)return '';
  if(el.type==='graph')return graphSvg(el.equation||el.expression||el.text)||('<div class="formula-card">'+ktex(el.equation||el.expression||el.text)+'</div>');
  if(el.type==='fraction')return fractionHtml(el);
  if(el.type==='rectangle')return rectangleHtml(el);
  if(el.type==='numberline')return numberlineHtml(el.expression||el.text);
  if(el.type==='bars')return barsHtml(el);
  if(el.type==='formula')return '<div class="formula-card">'+ktex(el.text)+'</div>';
  return '';
}

function sequenceHtml(el){
  if(!el||!el.steps.length)return '';
  return '<div class="equation-sequence">'+el.steps.map((step,index)=>'<div class="equation-step" data-step="'+index+'"><div class="equation-step-formula">'+ktex(step.formula)+'</div>'+(step.note?'<div class="equation-step-note">'+esc(step.note)+'</div>':'')+'</div>').join('')+'</div>';
}

function summaryHtml(el){
  const items=(el?.items||[]).filter(v=>v&&typeof v==='object').slice(0,4);
  if(!items.length)return '';
  return '<div class="summary-grid summary-count-'+items.length+'">'+items.map(item=>'<div class="summary-card"><span class="summary-label">'+esc(item.label)+'</span><div class="summary-value">'+(/[=+\-×÷^_\\]/.test(item.value)?ktex(item.value):esc(item.value))+'</div></div>').join('')+'</div>';
}

function bulletsHtml(el){
  const items=(el?.items||[]).filter(v=>typeof v==='string'&&v.trim()).slice(0,4);
  return items.length?'<ul class="lesson-bullets">'+items.map(v=>'<li>'+esc(v)+'</li>').join('')+'</ul>':'';
}

function composeScene(scene,index,start){
  const titleEl=first(scene.elements,['title']);
  const title=titleEl?.text||(index===0?'בואו נבין את זה':'שלב '+(index+1));
  const summary=first(scene.elements,['summary']);
  const sequence=first(scene.elements,['equation-sequence']);
  const primary=first(scene.elements,['graph','rectangle','fraction','numberline','bars']);
  const formulas=all(scene.elements,['formula']);
  const bodyText=first(scene.elements,['text']);
  const bullets=first(scene.elements,['bullets']);
  const badge=first(scene.elements,['badge']);

  let layout='focus',body='';
  if(summary){
    layout='summary';
    body=summaryHtml(summary);
  }else if(sequence){
    layout='equation';
    body=sequenceHtml(sequence);
  }else if(primary){
    const support=formulas.length||bodyText||bullets;
    layout=support?'split':'focus';
    const visual=visualHtml(primary);
    const supportHtml=(formulas[0]?'<div class="support-formula">'+ktex(formulas[0].text)+'</div>':'')+(bodyText?.text?'<p class="support-text">'+esc(bodyText.text)+'</p>':'')+bulletsHtml(bullets);
    body=layout==='split'?'<div class="split-layout"><div class="visual-pane">'+visual+'</div><div class="support-pane">'+supportHtml+'</div></div>':'<div class="visual-focus">'+visual+'</div>';
  }else if(formulas.length){
    layout='formula';
    body='<div class="formula-focus">'+visualHtml(formulas[0])+(bodyText?.text?'<p class="support-text center">'+esc(bodyText.text)+'</p>':'')+'</div>';
  }else{
    layout='text';
    body='<div class="text-focus">'+(bodyText?.text?'<p>'+esc(bodyText.text)+'</p>':'')+bulletsHtml(bullets)+'</div>';
  }

  return '<section id="scene-'+index+'" class="clip scene theme-'+scene.theme+' pattern-'+scene.pattern+' layout-'+layout+'" data-start="'+start.toFixed(3)+'" data-duration="'+scene.seconds.toFixed(3)+'" data-track-index="'+index+'"><div class="scene-bg"></div><div class="scene-shell"><header class="scene-head"><span class="scene-kicker">Sifra • '+(index+1)+'</span><h2 class="scene-title">'+esc(title)+'</h2></header><main class="scene-main">'+body+'</main>'+(badge?.text?'<div class="scene-badge">'+esc(badge.text)+'</div>':'')+'</div></section>';
}

const CSS=[
'*{box-sizing:border-box}',
'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0d0e10}',
'body{font-family:Arial,"Noto Sans Hebrew",sans-serif;-webkit-font-smoothing:antialiased}',
'#sifra-lesson{position:relative;width:1280px;height:720px;overflow:hidden;background:#0d0e10}',
'.scene{position:absolute;inset:0;overflow:hidden;isolation:isolate}',
'.scene-bg{position:absolute;inset:0;z-index:-2}',
'.theme-dark{--bg:#0f1012;--panel:#181a1e;--text:#f4f5f7;--muted:#a4a8b1;--line:rgba(255,255,255,.10);--accent:#7b8dff;--green:#58d092}',
'.theme-light{--bg:#f7f7f6;--panel:#fff;--text:#151618;--muted:#6d7179;--line:rgba(0,0,0,.10);--accent:#5668dc;--green:#279566}',
'.theme-dark .scene-bg,.theme-light .scene-bg{background:var(--bg)}',
'.pattern-grid .scene-bg:after{content:"";position:absolute;inset:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:46px 46px;opacity:.18;mask-image:linear-gradient(to bottom,#000,transparent 85%)}',
'.pattern-dots .scene-bg:after{content:"";position:absolute;inset:0;background-image:radial-gradient(circle,var(--line) 1.4px,transparent 1.5px);background-size:34px 34px;opacity:.24;mask-image:radial-gradient(circle at 50% 45%,#000,transparent 76%)}',
'.scene-shell{width:100%;height:100%;padding:58px 74px 54px;color:var(--text);display:grid;grid-template-rows:auto 1fr auto;gap:22px}',
'.scene-head{direction:rtl;text-align:right}',
'.scene-kicker{display:block;color:var(--muted);font-size:18px;font-weight:700;margin-bottom:8px}',
'.scene-title{margin:0;max-width:1000px;font-size:54px;line-height:1.08;letter-spacing:-.035em;font-weight:800}',
'.scene-main{min-height:0;display:flex;align-items:center;justify-content:center}',
'.scene-badge{width:max-content;max-width:760px;justify-self:center;padding:10px 18px;border:1px solid var(--line);background:var(--panel);border-radius:999px;direction:rtl;font-size:20px;font-weight:700}',
'.formula-card,.support-formula{border:1px solid var(--line);background:var(--panel);border-radius:24px;padding:24px 30px;box-shadow:0 18px 50px rgba(0,0,0,.08)}',
'.formula-card{min-width:430px;text-align:center}.formula-card .katex-display,.support-formula .katex-display{margin:0}.formula-card .katex{font-size:2.1em}.support-formula .katex{font-size:1.45em}.formula-fallback{font-size:44px;font-weight:700;direction:ltr}',
'.split-layout{width:100%;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);gap:38px;align-items:center;direction:ltr}.visual-pane,.support-pane{min-width:0}.visual-pane{display:flex;align-items:center;justify-content:center}.support-pane{direction:rtl;display:flex;flex-direction:column;gap:18px}',
'.support-text{margin:0;direction:rtl;text-align:right;color:var(--muted);font-size:26px;line-height:1.55;font-weight:600}.support-text.center{text-align:center}.visual-focus,.formula-focus{width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px}',
'.math-graph{width:100%;max-width:720px;max-height:410px;overflow:visible;color:var(--text)}.graph-grid{stroke:var(--line);stroke-width:1}.graph-axes{stroke:var(--muted);stroke-width:1.8}.graph-path{fill:none;stroke:var(--accent);stroke-width:5;stroke-linecap:round;stroke-linejoin:round}',
'.equation-sequence{position:relative;width:min(940px,100%);height:330px;display:flex;align-items:center;justify-content:center}.equation-step{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;opacity:0}.equation-step-formula{min-width:600px;max-width:930px;padding:24px 34px;border:1px solid var(--line);background:var(--panel);border-radius:24px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.08)}.equation-step-formula .katex{font-size:2em}.equation-step-note{max-width:800px;direction:rtl;text-align:center;color:var(--muted);font-size:27px;line-height:1.45;font-weight:650}',
'.fraction-visual{display:flex;flex-direction:column;align-items:center;gap:20px}.fraction-grid{width:430px;display:grid;grid-template-columns:repeat(var(--parts),1fr);gap:10px}.fraction-cell{aspect-ratio:1;border:2px solid var(--line);border-radius:14px;background:var(--panel)}.fraction-cell.filled{background:var(--accent);border-color:var(--accent)}.fraction-caption{font-size:42px;font-weight:800}',
'.rectangle-visual{display:flex;flex-direction:column;align-items:center;gap:12px}.rectangle-width,.rectangle-height{color:var(--muted);font-size:22px;font-weight:700}.rectangle-row{display:flex;align-items:center;gap:18px}.rectangle-grid{width:460px;height:290px;display:grid;grid-template-columns:repeat(var(--cols),1fr);grid-template-rows:repeat(var(--rows),1fr);border:3px solid var(--text);border-radius:12px;overflow:hidden}.area-cell{border:1px solid var(--line);background:color-mix(in srgb,var(--accent) 12%,var(--panel))}.rectangle-answer{margin-top:8px;padding:9px 18px;border-radius:999px;background:color-mix(in srgb,var(--green) 14%,var(--panel));color:var(--green);font-size:28px;font-weight:800}',
'.numberline{width:100%;max-width:760px}.numberline-base,.numberline-ticks line{stroke:var(--muted);stroke-width:2}.numberline-ticks text{fill:var(--muted);font-size:18px;text-anchor:middle}.numberline-segment{stroke:var(--accent);stroke-width:8;stroke-linecap:round}.numberline-mark circle.open{fill:var(--bg);stroke:var(--accent);stroke-width:4}.numberline-mark circle.closed{fill:var(--accent);stroke:var(--accent);stroke-width:4}.numberline-label{fill:var(--text);font-size:23px;font-weight:800;text-anchor:middle}',
'.bars-visual{width:min(760px,100%);height:350px;padding:24px 28px 18px;border:1px solid var(--line);border-radius:24px;background:var(--panel);display:flex;align-items:flex-end;justify-content:center;gap:28px}.bar-wrap{width:72px;height:100%;display:grid;grid-template-rows:28px 1fr 26px;gap:8px;text-align:center}.bar-value,.bar-label{color:var(--muted);font-size:17px;font-weight:700}.bar{align-self:end;width:100%;min-height:8px;border-radius:10px 10px 4px 4px;background:var(--accent);transform-origin:bottom}',
'.summary-grid{width:min(1040px,100%);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.summary-count-3{grid-template-columns:repeat(3,minmax(0,1fr))}.summary-card{min-height:150px;padding:22px 24px;border:1px solid var(--line);border-radius:22px;background:var(--panel);box-shadow:0 16px 44px rgba(0,0,0,.07);display:flex;flex-direction:column;justify-content:space-between;gap:18px;direction:rtl}.summary-label{color:var(--muted);font-size:21px;font-weight:700}.summary-value{font-size:34px;font-weight:850}.summary-value .katex{font-size:1.2em}',
'.lesson-bullets{list-style:none;margin:0;padding:0;direction:rtl;display:flex;flex-direction:column;gap:12px}.lesson-bullets li{position:relative;padding:10px 18px 10px 12px;border:1px solid var(--line);border-radius:14px;background:var(--panel);font-size:22px;font-weight:650}.lesson-bullets li:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);position:absolute;right:0;top:50%;transform:translate(50%,-50%)}',
'.text-focus{width:min(860px,100%);direction:rtl;text-align:center}.text-focus p{margin:0 0 24px;font-size:38px;line-height:1.45;font-weight:750}'
].join('\n');

function animationScript(duration){
  return [
    '(function(){',
    'const tl=gsap.timeline({paused:true});',
    'const scenes=Array.from(document.querySelectorAll(".scene"));',
    'scenes.forEach(function(scene,index){',
    'const start=Number(scene.dataset.start||0),dur=Number(scene.dataset.duration||0),end=start+dur;',
    'const shell=scene.querySelector(".scene-shell"),kicker=scene.querySelector(".scene-kicker"),title=scene.querySelector(".scene-title"),main=scene.querySelector(".scene-main"),badge=scene.querySelector(".scene-badge");',
    'if(shell)tl.fromTo(shell,{opacity:0},{opacity:1,duration:.18,ease:"power1.out"},start);',
    'if(kicker)tl.fromTo(kicker,{opacity:0,y:12},{opacity:1,y:0,duration:.28,ease:"power2.out"},start+.02);',
    'if(title)tl.fromTo(title,{opacity:0,y:28},{opacity:1,y:0,duration:.48,ease:"power3.out"},start+.06);',
    'const steps=Array.from(scene.querySelectorAll(".equation-step"));',
    'if(steps.length){steps.forEach(function(step,stepIndex){const span=Math.max(1.2,dur-1.15)/steps.length;const at=start+.58+stepIndex*span;if(stepIndex>0)tl.to(steps[stepIndex-1],{opacity:0,y:-24,duration:.22,ease:"power2.in"},Math.max(start,at-.18));tl.fromTo(step,{opacity:0,y:30,scale:.985},{opacity:1,y:0,scale:1,duration:.34,ease:"power3.out"},at);});}else if(main){tl.fromTo(main,{opacity:0,y:26,scale:.99},{opacity:1,y:0,scale:1,duration:.5,ease:"power3.out"},start+.34);}',
    'Array.from(scene.querySelectorAll(".draw-path,.draw-line")).forEach(function(node,i){let length=500;try{length=node.getTotalLength()}catch(e){}gsap.set(node,{strokeDasharray:length,strokeDashoffset:length});tl.to(node,{strokeDashoffset:0,duration:Math.min(1.4,Math.max(.65,dur*.22)),ease:"power2.out"},start+.62+i*.08);});',
    'const cells=Array.from(scene.querySelectorAll(".fraction-cell,.area-cell"));if(cells.length)tl.fromTo(cells,{opacity:.2,scale:.82},{opacity:1,scale:1,duration:.25,stagger:.035,ease:"back.out(1.5)"},start+.62);',
    'const bars=Array.from(scene.querySelectorAll(".bar"));if(bars.length)tl.fromTo(bars,{scaleY:0},{scaleY:1,duration:.5,stagger:.08,ease:"power3.out"},start+.6);',
    'const cards=Array.from(scene.querySelectorAll(".summary-card"));if(cards.length)tl.fromTo(cards,{opacity:0,y:28,scale:.97},{opacity:1,y:0,scale:1,duration:.38,stagger:.12,ease:"power3.out"},start+.5);',
    'if(badge)tl.fromTo(badge,{opacity:0,y:14,scale:.97},{opacity:1,y:0,scale:1,duration:.3,ease:"power2.out"},Math.max(start+.72,end-.95));',
    'if(shell&&index<scenes.length-1)tl.to(shell,{opacity:0,duration:.16,ease:"power1.in"},Math.max(start,end-.16));',
    '});',
    'tl.set({}, {}, '+Number(duration).toFixed(3)+');',
    'window.__timelines=window.__timelines||{};window.__timelines["sifra-lesson"]=tl;',
    '})();'
  ].join('\n');
}

async function copyAssets(dir){
  const gsap=require.resolve('gsap/dist/gsap.min.js');
  const katexCss=require.resolve('katex/dist/katex.min.css');
  const katexDir=path.dirname(katexCss);
  await fsp.copyFile(gsap,path.join(dir,'gsap.min.js'));
  await fsp.copyFile(katexCss,path.join(dir,'katex.min.css'));
  await fsp.cp(path.join(katexDir,'fonts'),path.join(dir,'fonts'),{recursive:true});
}

async function buildComposition(rawLesson,dir){
  const lesson=normalizeLesson(rawLesson);
  await fsp.mkdir(dir,{recursive:true});
  await copyAssets(dir);

  let cursor=0;
  const scenes=lesson.scenes.map((scene,index)=>{
    const html=composeScene(scene,index,cursor);
    cursor+=scene.seconds;
    return html;
  });

  const html=[
    '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>'+esc(lesson.title)+'</title>',
    '<link rel="stylesheet" href="./katex.min.css">',
    '<style>'+CSS+'</style></head><body>',
    '<div id="sifra-lesson" data-composition-id="sifra-lesson" data-start="0" data-width="'+WIDTH+'" data-height="'+HEIGHT+'" data-duration="'+lesson.duration.toFixed(3)+'">',
    scenes.join(''),
    '</div><script src="./gsap.min.js"><\/script><script>',
    animationScript(lesson.duration),
    '<\/script></body></html>'
  ].join('');

  await fsp.writeFile(path.join(dir,'index.html'),html,'utf8');
  await fsp.writeFile(path.join(dir,'lesson.json'),JSON.stringify(lesson,null,2),'utf8');
  return lesson;
}


function sceneVisualName(scene){
  const visual=first(scene.elements,[
    'equation-sequence','graph','rectangle','fraction',
    'numberline','bars','formula','summary','text'
  ]);

  return visual?.type||'text';
}

async function writePlanningArtifacts(lesson,root){
  const sceneLines=lesson.scenes.map((scene,index)=>{
    const titleEl=first(scene.elements,['title']);
    const title=titleEl?.text||('שלב '+(index+1));
    return (
      '### Scene '+(index+1)+' — '+title+' — '+
      scene.seconds.toFixed(1)+'s\n'+
      '- Main visual: '+sceneVisualName(scene)+'\n'+
      '- Theme: '+scene.theme+' / '+scene.pattern+'\n'+
      '- Goal: '+(
        first(scene.elements,['text'])?.text||
        first(scene.elements,['badge'])?.text||
        'להמחיש את הצעד המתמטי בצורה ברורה.'
      )+'\n'
    );
  }).join('\n');

  const plan=[
    '# Sifra Video Plan: '+lesson.title,
    '',
    '## Angle',
    'שיעור מתמטי קצר, ויזואלי וממוקד: מראים את הפעולה המתמטית עצמה במקום שקופיות.',
    '',
    '## Hook',
    'הסצנה הראשונה חייבת לתת רעיון או שאלה משמעותיים בתוך 2–3 שניות.',
    '',
    '## Format',
    '- landscape — 1280x720',
    '- duration: '+lesson.duration.toFixed(1)+'s',
    '- language: Hebrew RTL; math LTR',
    '',
    '## Creative laws',
    '- No empty scenes.',
    '- No long static holds.',
    '- One main visual idea per scene.',
    '- Readable text first; motion supports the explanation.',
    '- Algebra transforms in-place with equation-sequence.',
    '',
    '## Storyboard',
    '',
    sceneLines
  ].join('\n');

  const brief=[
    '# Hyperframes Composition Brief: '+lesson.title,
    '',
    '## Objective',
    'Render a polished Hebrew math explainer from the semantic Sifra storyboard.',
    '',
    '## Output',
    '- 1280x720 @ 30fps',
    '- H.264 MP4, high quality',
    '- deterministic seek-safe GSAP timeline',
    '',
    '## Visual identity',
    '- restrained black/white Sifra palette',
    '- blue-violet accent for active math',
    '- green for verified answers',
    '- real KaTeX for formulas',
    '',
    '## Motion',
    '- fast entrance, readable hold, subtle continuous drift',
    '- graphs draw on',
    '- fractions/area cells reveal sequentially',
    '- equation steps replace each other in one focal position',
    '- summaries arrive card-by-card',
    '',
    '## Quality gates',
    '- Hyperframes check (layout + runtime + motion + contrast + transition sampling)',
    '- ffprobe output verification',
    '- FFmpeg post-render freeze scan',
    '- poster extraction + frame-0 bake',
    '',
    '## Storyboard source',
    'See brag-plan.md and composition/lesson.json.'
  ].join('\n');

  await Promise.all([
    fsp.writeFile(path.join(root,'brag-plan.md'),plan,'utf8'),
    fsp.writeFile(path.join(root,'composition-brief.md'),brief,'utf8')
  ]);
}

function runProcess(command,args,options={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:options.cwd,env:Object.assign({},process.env,options.env||{}),stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{const value=String(chunk);stdout+=value;options.onOutput?.(value,'stdout')});
    child.stderr.on('data',chunk=>{const value=String(chunk);stderr+=value;options.onOutput?.(value,'stderr')});
    let timer=null;
    if(options.timeoutMs>0)timer=setTimeout(()=>child.kill('SIGKILL'),options.timeoutMs);
    child.on('error',reject);
    child.on('close',(code,signal)=>{
      if(timer)clearTimeout(timer);
      if(code===0)return resolve({stdout,stderr,code});
      const error=new Error((stderr||stdout||(signal?'Process killed: '+signal:'Process exited with '+code)).trim().slice(-4000));
      error.code=code;error.stdout=stdout;error.stderr=stderr;reject(error);
    });
  });
}

function npx(){return process.platform==='win32'?'npx.cmd':'npx'}

async function checkComposition(dir,onProgress){
  onProgress?.(.08,'בודק פריסה, תנועה וניגודיות…');

  await runProcess(
    npx(),
    [
      '--no-install',
      'hyperframes',
      'check',
      '.',
      '--samples','15',
      '--at-transitions',
      '--frame-check',
      '--timeout','30000'
    ],
    {
      cwd:dir,
      timeoutMs:180000,
      env:{
        HYPERFRAMES_NO_UPDATE_CHECK:'1'
      }
    }
  );

  onProgress?.(.20,'בדיקת Hyperframes עברה בהצלחה');
}

function parseProgress(value){
  const match=String(value).match(/(\d+)\s*\/\s*(\d+)/);
  if(!match)return null;
  const current=Number(match[1]),total=Number(match[2]);
  return Number.isFinite(current)&&Number.isFinite(total)&&total>0?clamp(current/total,0,1):null;
}

async function renderHyperframes(dir,output,onProgress){
  onProgress?.(.23,'מרנדר באיכות גבוהה…');
  await runProcess(npx(),['--no-install','hyperframes','render','--quality','high','--fps',String(FPS),'--output',output],{
    cwd:dir,
    env:{
      HYPERFRAMES_NO_UPDATE_CHECK:'1'
    },
    timeoutMs:Number(process.env.SIFRA_VIDEO_TIMEOUT_MS||12*60*1000),
    onOutput(value){
      const p=parseProgress(value);
      if(p!==null)onProgress?.(.23+p*.67,'מרנדר באיכות גבוהה…');
    }
  });
  onProgress?.(.91,'בודק את קובץ ה-MP4…');
}

async function probeVideo(file){
  const result=await runProcess('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,duration','-show_entries','format=duration','-of','json',file],{timeoutMs:30000});
  const parsed=JSON.parse(result.stdout);
  const stream=parsed?.streams?.[0];
  if(!stream)throw new Error('לא נמצא ערוץ וידאו ב-MP4.');
  if(Number(stream.width)!==WIDTH||Number(stream.height)!==HEIGHT)throw new Error('רזולוציית הווידאו אינה תקינה.');
  return {codec:stream.codec_name||'',width:Number(stream.width),height:Number(stream.height),duration:Number(stream.duration||parsed?.format?.duration||0)};
}


async function analyzeRenderedVideo(video){
  let freezeOutput='';

  try{
    const result=await runProcess(
      'ffmpeg',
      [
        '-hide_banner',
        '-i',video,
        '-vf','freezedetect=n=-55dB:d=5',
        '-an',
        '-f','null',
        '-'
      ],
      {
        timeoutMs:120000,
        onOutput(value,stream){
          if(stream==='stderr')freezeOutput+=value;
        }
      }
    );

    freezeOutput+=result.stderr||'';
  }catch(error){
    // ffmpeg writes normal filter output to stderr; only preserve it as QA data.
    freezeOutput+=(error?.stderr||'');
  }

  const freezes=[];
  const lines=freezeOutput.split(/\r?\n/);

  for(const line of lines){
    const durationMatch=line.match(/freeze_duration:\s*([0-9.]+)/);
    if(durationMatch){
      const duration=Number(durationMatch[1]);
      if(Number.isFinite(duration)){
        freezes.push(duration);
      }
    }
  }

  const longestFreeze=freezes.length?Math.max(...freezes):0;

  if(longestFreeze>8){
    throw new Error(
      'בדיקת הווידאו מצאה קטע סטטי ארוך מדי ('+
      longestFreeze.toFixed(1)+
      ' שניות).'
    );
  }

  return {
    longestFreeze,
    freezes
  };
}

async function bakePosterFrame(video,poster){
  const temp=video.replace(/\.mp4$/i,'.poster.mp4');

  await runProcess(
    'ffmpeg',
    [
      '-y',
      '-i',video,
      '-i',poster,
      '-filter_complex',
      "[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]",
      '-map','[v]',
      '-map','0:a?',
      '-c:v','libx264',
      '-crf','17',
      '-preset','slow',
      '-pix_fmt','yuv420p',
      '-c:a','copy',
      '-movflags','+faststart',
      temp
    ],
    {
      timeoutMs:180000
    }
  );

  await fsp.rename(temp,video);
}

async function makePoster(video,poster,lesson){
  const at=Math.max(.7,Math.min(1.8,(lesson.scenes[0]?.seconds||2.5)*.55));
  await runProcess('ffmpeg',['-y','-ss',at.toFixed(3),'-i',video,'-frames:v','1','-q:v','2',poster],{timeoutMs:45000});
}

async function renderLesson({lesson:rawLesson,jobId,onProgress}){
  const id=String(jobId||crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);
  if(!id)throw new Error('Invalid video job id');

  const root=path.join(JOB_ROOT,id);
  const composition=path.join(root,'composition');
  const output=path.join(root,'sifra.mp4');
  const poster=path.join(root,'poster.jpg');

  await fsp.rm(root,{recursive:true,force:true});
  await fsp.mkdir(composition,{recursive:true});
  onProgress?.(.02,'בונה סטוריבורד…');

  const lesson=normalizeLesson(rawLesson);
  await writePlanningArtifacts(lesson,root);
  await buildComposition(lesson,composition);

  await checkComposition(composition,onProgress);
  await renderHyperframes(composition,output,onProgress);

  const probeBeforePoster=await probeVideo(output);

  onProgress?.(.93,'בודק תנועה וקצב…');
  const quality=await analyzeRenderedVideo(output);

  onProgress?.(.96,'בוחר תמונת פתיחה…');
  await makePoster(output,poster,lesson);

  onProgress?.(.98,'מסיים את קובץ ה-MP4…');
  await bakePosterFrame(output,poster);

  const probe=await probeVideo(output);

  if(
    Math.abs(
      probe.duration-
      probeBeforePoster.duration
    )>.15
  ){
    throw new Error(
      'בדיקת הווידאו נכשלה אחרי יצירת תמונת הפתיחה.'
    );
  }

  const stat=await fsp.stat(output);
  if(!stat.isFile()||stat.size<20000)throw new Error('קובץ הווידאו שנוצר קטן מדי.');
  onProgress?.(1,'הסרטון מוכן');

  return {id,root,outputPath:output,posterPath:poster,lesson,probe,quality,size:stat.size};
}

async function ensureVideoEnvironment(){
  await fsp.mkdir(JOB_ROOT,{recursive:true});

  const major=
    Number(
      String(process.versions.node||'0')
        .split('.')[0]
    );

  const results=[
    {
      command:'node',
      ok:major>=22,
      detail:process.versions.node
    }
  ];

  const tests=[
    ['ffmpeg',['-version']],
    ['ffprobe',['-version']],
    [
      npx(),
      [
        '--no-install',
        'hyperframes',
        'browser',
        'ensure'
      ]
    ]
  ];

  for(const entry of tests){
    try{
      await runProcess(
        entry[0],
        entry[1],
        {
          timeoutMs:
            entry[1].includes('browser')
              ? 180000
              : 30000,
          env:{
            HYPERFRAMES_NO_UPDATE_CHECK:'1'
          }
        }
      );

      results.push({
        command:
          entry[0]+' '+
          entry[1].slice(2).join(' '),
        ok:true
      });
    }catch(error){
      results.push({
        command:
          entry[0]+' '+
          entry[1].slice(2).join(' '),
        ok:false,
        error:
          error?.message||
          String(error)
      });
    }
  }

  return {
    ok:
      results.every(
        item=>item.ok
      ),
    results,
    root:JOB_ROOT
  };
}

async function removeJobFiles(jobId){
  const safe=String(jobId||'').replace(/[^a-zA-Z0-9_-]/g,'');
  if(safe)await fsp.rm(path.join(JOB_ROOT,safe),{recursive:true,force:true});
}

module.exports={WIDTH,HEIGHT,FPS,JOB_ROOT,normalizeLesson,buildComposition,renderLesson,ensureVideoEnvironment,removeJobFiles};
