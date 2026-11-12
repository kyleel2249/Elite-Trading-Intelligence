/**
 * Dashboard visual layer: depth, glass surfaces and 3D pointer-responsive motion. Pure CSS + vanilla JS (the dashboard's CSP allows only
 * nonced inline code, so no external UI library is loaded). Purely cosmetic: it never touches data, handlers or element contents.
 * Motion is off for prefers-reduced-motion, tilt is off on touch, and the animation loop pauses when the tab is hidden.
 */
export const MOTION_CSS = `<style id="eti-motion">
html{background:#080d16;overflow-x:clip}body{overflow-x:clip;background:transparent!important;position:relative}
#etiBg{position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none;display:block}
:root{--glow:90,169,255;--tx:0;--ty:0}
header{position:relative;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
header h1{background:linear-gradient(100deg,#eaf2ff 0%,#8fc4ff 35%,#6ef0c4 55%,#eaf2ff 80%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:etiShine 9s linear infinite}
header h1 span{-webkit-text-fill-color:transparent}
@keyframes etiShine{to{background-position:-220% 0}}
.panel{position:relative;transform-style:preserve-3d;will-change:transform;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 background:linear-gradient(145deg,rgba(24,38,58,.82),rgba(12,20,33,.88))!important;border-color:rgba(120,160,210,.22)!important;
 box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 18px 40px -18px rgba(0,0,0,.7);transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s,border-color .25s}
.panel::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .25s;
 background:radial-gradient(420px circle at var(--mx,50%) var(--my,0%),rgba(var(--glow),.16),transparent 55%)}
.panel.eti-hot{box-shadow:0 1px 0 rgba(255,255,255,.07) inset,0 28px 60px -20px rgba(0,0,0,.85),0 0 0 1px rgba(var(--glow),.25);border-color:rgba(var(--glow),.45)!important}
.panel.eti-hot::before{opacity:1}
.panel h2{letter-spacing:.2px;text-shadow:0 0 18px rgba(var(--glow),.25)}
.panel>h2,.panel>.meta{transform:translateZ(18px)}
button{transition:transform .15s,box-shadow .2s,filter .2s}button:hover:not(:disabled){transform:translateY(-1px) translateZ(0);box-shadow:0 6px 18px -6px rgba(var(--glow),.55);filter:brightness(1.08)}button:active:not(:disabled){transform:translateY(0) scale(.98)}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid #5aa9ff;outline-offset:2px}
.eti-in{opacity:0;transform:perspective(900px) translateY(26px) rotateX(10deg) scale(.985)}
.eti-in.eti-seen{opacity:1;transform:none;transition:opacity .6s ease,transform .7s cubic-bezier(.2,.8,.2,1);transition-delay:var(--d,0ms)}
.eti-up{animation:etiUp .9s ease}.eti-down{animation:etiDown .9s ease}
@keyframes etiUp{0%{color:#21d69a;text-shadow:0 0 14px #21d69a}100%{text-shadow:0 0 0 transparent}}
@keyframes etiDown{0%{color:#ff7b7b;text-shadow:0 0 14px #ff7b7b}100%{text-shadow:0 0 0 transparent}}
a{transition:color .2s,text-shadow .2s}a:hover{text-shadow:0 0 12px rgba(var(--glow),.6)}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#243a57;border-radius:8px}::-webkit-scrollbar-track{background:transparent}
@media (max-width:760px){.eti-in{transform:translateY(18px)}.panel{backdrop-filter:none;-webkit-backdrop-filter:none}.panel>h2,.panel>.meta{transform:none}}
@media (prefers-reduced-motion:reduce){header h1{animation:none}.panel,button{transition:none}.eti-in{opacity:1;transform:none}.eti-up,.eti-down{animation:none}}
</style>`;

export const MOTION_JS = `<script id="eti-motion-js">
(function(){
try{
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var fine=window.matchMedia&&matchMedia('(hover:hover) and (pointer:fine)').matches;
var px=0,py=0,tx=0,ty=0;
// 1. Depth background: perspective grid floor, drifting particles, pointer parallax.
var cv=document.createElement('canvas');cv.id='etiBg';cv.setAttribute('aria-hidden','true');document.body.insertBefore(cv,document.body.firstChild);
var cx=cv.getContext('2d'),W=0,H=0,dpr=Math.min(2,window.devicePixelRatio||1),P=[],raf=0,t0=performance.now();
function size(){W=innerWidth;H=innerHeight;cv.width=W*dpr;cv.height=H*dpr;cx.setTransform(dpr,0,0,dpr,0,0);var n=Math.round(Math.min(70,W*H/26000));P=[];for(var i=0;i<n;i++)P.push({x:Math.random(),y:Math.random(),z:Math.random(),s:.15+Math.random()*.5})}
function frame(now){
 var t=(now-t0)/1000;tx+=(px-tx)*.06;ty+=(py-ty)*.06;
 cx.clearRect(0,0,W,H);
 var hy=H*.58+ty*14,vx=W/2+tx*60;
 var g=cx.createRadialGradient(vx,hy,0,vx,hy,Math.max(W,H)*.7);g.addColorStop(0,'rgba(40,90,160,.22)');g.addColorStop(1,'rgba(8,13,22,0)');cx.fillStyle=g;cx.fillRect(0,0,W,H);
 cx.lineWidth=1;
 for(var i=0;i<14;i++){var k=((i+t*.35)%14)/14,y=hy+Math.pow(k,2.2)*(H-hy);cx.strokeStyle='rgba(90,169,255,'+(.04+k*.14)+')';cx.beginPath();cx.moveTo(0,y);cx.lineTo(W,y);cx.stroke()}
 for(var j=-12;j<=12;j++){cx.strokeStyle='rgba(90,169,255,'+(.05+(1-Math.abs(j)/12)*.09)+')';cx.beginPath();cx.moveTo(vx+j*14,hy);cx.lineTo(vx+j*W*.12+tx*-40,H);cx.stroke()}
 for(var m=0;m<P.length;m++){var p=P[m];p.y-=p.s*.0004*(.4+p.z);if(p.y<-.02){p.y=1.02;p.x=Math.random()}
  var x=p.x*W+tx*-30*p.z,y2=p.y*H+ty*-20*p.z,r=.6+p.z*1.8;cx.fillStyle='rgba('+(p.z>.7?'110,240,196':'143,196,255')+','+(.15+p.z*.4)+')';cx.beginPath();cx.arc(x,y2,r,0,6.283);cx.fill()}
 raf=requestAnimationFrame(frame)}
function still(){cx.clearRect(0,0,W,H);var g=cx.createRadialGradient(W/2,H*.5,0,W/2,H*.5,Math.max(W,H)*.7);g.addColorStop(0,'rgba(40,90,160,.2)');g.addColorStop(1,'rgba(8,13,22,0)');cx.fillStyle=g;cx.fillRect(0,0,W,H)}
size();addEventListener('resize',function(){size();if(reduce)still()});
if(reduce)still();else{raf=requestAnimationFrame(frame);document.addEventListener('visibilitychange',function(){cancelAnimationFrame(raf);if(!document.hidden)raf=requestAnimationFrame(frame)})}
addEventListener('pointermove',function(e){px=(e.clientX/W-.5)*2;py=(e.clientY/H-.5)*2},{passive:true});
// 2. Panels: staggered 3D entrance, then pointer-driven tilt with a following glow (mouse only).
var panels=[].slice.call(document.querySelectorAll('.panel'));
panels.forEach(function(el,i){el.classList.add('eti-in');el.style.setProperty('--d',Math.min(i,8)*70+'ms')});
if('IntersectionObserver' in window&&!reduce){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('eti-seen');io.unobserve(e.target)}})},{threshold:.05});panels.forEach(function(el){io.observe(el)})}
else panels.forEach(function(el){el.classList.add('eti-seen')});
setTimeout(function(){panels.forEach(function(el){el.classList.add('eti-seen')})},2500);
if(fine&&!reduce){panels.forEach(function(el){
 if(el.classList.contains('execpanel'))return;
 var settle=0;
 el.addEventListener('pointermove',function(e){
  var r=el.getBoundingClientRect(),nx=(e.clientX-r.left)/r.width,ny=(e.clientY-r.top)/r.height,max=r.width>720?1.1:(r.width>420?2.6:4.5);
  if(el.matches(':focus-within')&&e.target.closest&&e.target.closest('input,select,textarea'))return;
  el.style.transition='transform .08s linear,box-shadow .25s,border-color .25s';
  el.style.transform='perspective(1000px) rotateX('+((.5-ny)*max).toFixed(2)+'deg) rotateY('+((nx-.5)*max).toFixed(2)+'deg) translateZ(0)';
  el.style.setProperty('--mx',(nx*100)+'%');el.style.setProperty('--my',(ny*100)+'%');el.classList.add('eti-hot')});
 el.addEventListener('pointerleave',function(){el.style.transition='';el.style.transform='';el.classList.remove('eti-hot')});
})}
// 3. Live numbers flash green/red when they change (observes text only; never writes to the element).
var watch=['last','volume','change','chan','pct'].map(function(i){return document.getElementById(i)}).filter(Boolean);
var prev=new WeakMap();
function num(s){var n=parseFloat(String(s).replace(/[^0-9.\\-]/g,''));return isFinite(n)?n:null}
if(!reduce&&'MutationObserver' in window)watch.forEach(function(el){prev.set(el,num(el.textContent));new MutationObserver(function(){var a=prev.get(el),b=num(el.textContent);if(a!=null&&b!=null&&a!==b){el.classList.remove('eti-up','eti-down');void el.offsetWidth;el.classList.add(b>a?'eti-up':'eti-down')}prev.set(el,b)}).observe(el,{childList:true,characterData:true,subtree:true})});
}catch(err){try{console.error('eti motion layer disabled',err&&err.message)}catch(_){}}
})();
</script>`;

export function withMotion(page: string): string {
  return page.replace("</head>", MOTION_CSS + "</head>").replace("</body>", MOTION_JS + "</body>");
}
