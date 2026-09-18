const $=s=>document.querySelector(s);
const input=$('#input'),send=$('#send'),chat=$('#chat'),home=$('#home'),homeWrap=$('#homeWrap'),bottom=$('#bottom'),follow=$('#follow'),send2=$('#send2'),side=$('#side'),overlay=$('#overlay'),file=$('#file'),attachments=$('#attachments'),miniAttachments=$('#miniAttachments'),box=$('#box'),miniBox=$('#miniBox'),toast=$('#toast');
const state={messages:[],images:[],busy:false};
const MAX_IMAGES=2;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function showToast(text){toast.textContent=text;toast.classList.add('on');clearTimeout(showToast.t);showToast.t=setTimeout(()=>toast.classList.remove('on'),2600)}
function resize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px'}
function updateButtons(){const hasText=input.value.trim()||state.images.length;send.disabled=state.busy||!hasText;send2.disabled=state.busy||!(follow.value.trim()||state.images.length)}
input.addEventListener('input',()=>{resize(input);updateButtons()});follow.addEventListener('input',()=>{resize(follow);updateButtons()});

document.querySelectorAll('.q').forEach(x=>x.onclick=()=>{input.value=x.textContent;resize(input);updateButtons();input.focus()});

function renderAttachments(){
  for(const target of [attachments,miniAttachments]){
    target.innerHTML='';
    target.classList.toggle('on',state.images.length>0);
    state.images.forEach((img,i)=>{
      const wrap=document.createElement('div');wrap.className='attachment';
      const image=document.createElement('img');image.src=img.dataUrl;image.alt='תמונה מצורפת';
      const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','הסר תמונה');
      remove.onclick=()=>{state.images.splice(i,1);renderAttachments();updateButtons()};
      wrap.append(image,remove);target.appendChild(wrap);
    });
  }
}

function blobToDataUrl(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob)})}
async function compressImage(fileObj){
  if(!/^image\/(png|jpeg|webp)$/.test(fileObj.type))throw new Error('אפשר להעלות PNG, JPG או WebP בלבד');
  if(fileObj.size>10*1024*1024)throw new Error('התמונה גדולה מדי');
  const bitmap=await createImageBitmap(fileObj);
  const maxSide=1500,scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();
  let quality=.82;
  let blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',quality));
  while(blob&&blob.size>1350000&&quality>.5){quality-=.1;blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',quality))}
  if(!blob||blob.size>1500000)throw new Error('לא הצלחתי להקטין את התמונה מספיק');
  return {dataUrl:await blobToDataUrl(blob),name:fileObj.name||'image.jpg'};
}

async function addFiles(fileList){
  const list=[...fileList].slice(0,MAX_IMAGES-state.images.length);
  if(!list.length){if(state.images.length>=MAX_IMAGES)showToast(`אפשר לצרף עד ${MAX_IMAGES} תמונות`);return}
  try{
    for(const f of list){state.images.push(await compressImage(f));renderAttachments();updateButtons()}
  }catch(e){showToast(e.message||'לא הצלחתי לצרף את התמונה')}
  file.value='';
}

function openPicker(){if(state.images.length>=MAX_IMAGES)return showToast(`אפשר לצרף עד ${MAX_IMAGES} תמונות`);file.click()}
$('#attach').onclick=openPicker;$('#attach2').onclick=openPicker;file.onchange=()=>addFiles(file.files);

document.addEventListener('paste',e=>{const imgs=[...(e.clipboardData?.files||[])].filter(x=>x.type.startsWith('image/'));if(imgs.length){e.preventDefault();addFiles(imgs)}});
for(const target of [box,miniBox]){
  target.addEventListener('dragover',e=>{e.preventDefault();target.classList.add('drag')});
  target.addEventListener('dragleave',()=>target.classList.remove('drag'));
  target.addEventListener('drop',e=>{e.preventDefault();target.classList.remove('drag');addFiles([...e.dataTransfer.files].filter(x=>x.type.startsWith('image/')))})
}

function formatAnswer(text){
  return esc(text)
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/\n/g,'<br>');
}

function addMessage(text,type,images=[]){
  const d=document.createElement('div');d.className='msg '+type;
  if(images.length){const gallery=document.createElement('div');gallery.className='user-images';images.forEach(src=>{const i=document.createElement('img');i.src=src;i.alt='תמונה שצורפה';gallery.appendChild(i)});d.appendChild(gallery)}
  const content=document.createElement('div');content.innerHTML=formatAnswer(text);d.appendChild(content);chat.appendChild(d);return d;
}

function enterChat(){
  if(chat.classList.contains('on'))return false;
  home.style.display='none';homeWrap.style.display='none';chat.classList.add('on');bottom.classList.add('on');chat.scrollTop=0;return true;
}

async function askServer(images){
  const pending=addMessage('חושב…','ai thinking');
  try{
    const r=await fetch('/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:state.messages.slice(-16),images:images.map(x=>({dataUrl:x.dataUrl}))})
    });
    let j={};try{j=await r.json()}catch{}
    pending.remove();
    if(!r.ok){
      if(r.status===429&&j.retryAfter)throw new Error(`שלחת יותר מדי הודעות. נסה שוב בעוד ${j.retryAfter} שניות.`);
      throw new Error(j.error||'לא הצלחתי לקבל תשובה כרגע.');
    }
    if(!j.answer)throw new Error('השרת החזיר תשובה ריקה.');
    state.messages.push({role:'assistant',content:j.answer});
    addMessage(j.answer,'ai');
  }catch(e){pending.remove();addMessage(e.message||'לא הצלחתי לקבל תשובה.','ai error')}
}

async function submit(el){
  if(state.busy)return;
  const text=el.value.trim()||(state.images.length?'פתור את התרגיל שבתמונה והסבר שלב-שלב.':'');
  if(!text)return;

  state.busy=true;updateButtons();send.classList.add('busy');send2.classList.add('busy');
  const first=enterChat();
  const images=state.images.splice(0);renderAttachments();
  addMessage(text,'user',images.map(x=>x.dataUrl));
  state.messages.push({role:'user',content:text});
  el.value='';resize(el);
  if(first)chat.scrollTop=0;else chat.scrollTop=chat.scrollHeight;

  await askServer(images);
  state.busy=false;send.classList.remove('busy');send2.classList.remove('busy');updateButtons();
  chat.scrollTo({top:chat.scrollHeight,behavior:'smooth'});
  follow.focus();
}

send.onclick=()=>submit(input);send2.onclick=()=>submit(follow);
[input,follow].forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit(el)}}));

$('#new').onclick=()=>{
  state.messages=[];state.images=[];state.busy=false;chat.innerHTML='';chat.classList.remove('on');bottom.classList.remove('on');home.style.display='';homeWrap.style.display='flex';input.value='';follow.value='';renderAttachments();updateButtons();side.classList.remove('on');overlay.classList.remove('on');setTimeout(()=>input.focus(),50)
};
function closeMenu(){side.classList.remove('on');overlay.classList.remove('on')}
$('#menu').onclick=()=>{side.classList.add('on');overlay.classList.add('on')};overlay.onclick=closeMenu;
updateButtons();
