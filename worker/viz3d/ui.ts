/**
 * 3D order-book depth surface, written directly against WebGL (no three.js / React Three Fiber: nothing can be installed in this build
 * environment, and a single surface does not need a scene graph). Each refresh of the live book adds one row: x = price level (bids left of
 * the spread, asks right), z = time (newest in front), height = cumulative size at that level. Drag or arrow keys rotate, wheel or +/- zooms.
 * Every number drawn comes from the live /api/market/depth snapshots the dashboard already loads; when WebGL is unavailable the panel says so.
 * Embedded in the dashboard template literal: no backticks, dollar-brace sequences or backslashes below.
 */
export const VIZ_CSS = `
.v3 canvas{width:100%;height:340px;display:block;border-radius:10px;background:#070d18;border:1px solid var(--line);touch-action:none;cursor:grab}
.v3 canvas:active{cursor:grabbing}.v3 canvas:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.v3 .v3bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}.v3 .v3bar button{padding:3px 10px;font-size:12px}
.v3 .v3sum{font-size:12px;color:var(--muted)}.v3 .v3off{padding:18px;color:var(--muted);text-align:center}
@media(max-width:600px){.v3 canvas{height:260px}}
`;

export const VIZ_HTML = `
<section class="panel v3" id="v3Panel" aria-label="3D order book depth surface" style="margin-top:14px">
<h2><span>3D Order-Book Depth Surface</span><span class="meta" id="v3Meta">Collecting snapshots…</span></h2>
<div class="v3bar"><button type="button" id="v3Auto" aria-pressed="true">Auto-rotate: on</button><button type="button" id="v3Pause" aria-pressed="false">Pause capture</button><button type="button" id="v3Reset">Reset view</button><span class="v3sum" id="v3Sum"></span></div>
<canvas id="v3Canvas" tabindex="0" role="img" aria-label="3D surface of cumulative order book depth over time. Bids are green on the left, asks red on the right. Arrow keys rotate, plus and minus zoom."></canvas>
<div class="v3off" id="v3Off" hidden></div>
<p class="meta" style="margin:6px 0 0">Height = cumulative size at each price level; depth snapshots are taken at each market refresh (newest row in front). Drag to rotate, scroll or +/- to zoom.</p>
</section>
`;

export const VIZ_JS = `
const V3={H:48,L:20,hist:[],key:'',yaw:-0.55,pitch:0.55,zoom:1,auto:true,paused:false,gl:null,prog:null,buf:null,nTri:0,nLine:0,drag:null,dirty:true,visible:true,t0:0};
function v3Cum(side){const out=[];let c=0;for(let k=0;k<V3.L;k++){const lv=side[k];if(lv){const q=Number(lv[1]);if(isFinite(q)&&q>0)c+=q;}out.push(c);}return out;}
function v3Push(bk,key){
 if(!V3.gl||!bk||!bk.bids||!bk.asks||!bk.bids.length||!bk.asks.length)return;
 if(key!==V3.key){V3.key=key;V3.hist=[];}
 if(V3.paused)return;
 V3.hist.push({b:v3Cum(bk.bids),a:v3Cum(bk.asks),t:Date.now(),bid:Number(bk.bids[0][0]),ask:Number(bk.asks[0][0])});
 if(V3.hist.length>V3.H)V3.hist.shift();
 V3.dirty=true;v3Summary();
}
function v3Summary(){
 const n=V3.hist.length,last=V3.hist[n-1];
 $('v3Meta').textContent=n<2?'Collecting snapshots… ('+n+'/2)':n+' snapshots';
 if(last){const sp=last.ask-last.bid,bd=last.b[V3.L-1],ad=last.a[V3.L-1];$('v3Sum').textContent='Spread '+sp.toPrecision(4)+' | bid depth '+bd.toPrecision(4)+' | ask depth '+ad.toPrecision(4)+' (top '+V3.L+' levels)';}
}
function v3Mat(){
 const w=V3.cv.width/Math.max(1,V3.cv.height),f=1/Math.tan(0.4),n=0.1,fa=20,P=[f/w,0,0,0,0,f,0,0,0,0,(fa+n)/(n-fa),-1,0,0,2*fa*n/(n-fa),0];
 const d=3.1/V3.zoom,cy=Math.cos(V3.yaw),sy=Math.sin(V3.yaw),cp=Math.cos(V3.pitch),sp=Math.sin(V3.pitch),e=[d*sy*cp,d*sp,d*cy*cp];
 let zx=e[0],zy=e[1],zz=e[2];const zl=Math.hypot(zx,zy,zz);zx/=zl;zy/=zl;zz/=zl;
 let xx=zz,xy=0,xz=-zx;const xl=Math.hypot(xx,xy,xz)||1;xx/=xl;xy/=xl;xz/=xl;
 const yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
 const Vw=[xx,yx,zx,0,xy,yy,zy,0,xz,yz,zz,0,-(xx*e[0]+xy*e[1]+xz*e[2]),-(yx*e[0]+yy*e[1]+yz*e[2]),-(zx*e[0]+zy*e[1]+zz*e[2]),1];
 const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=P[k*4+r]*Vw[c*4+k];o[c*4+r]=s;}return o;
}
function v3Build(){
 const gl=V3.gl,H=V3.hist,n=H.length,L=V3.L,W=2*L;if(n<2){V3.nTri=0;V3.nLine=0;return;}
 let mx=0;for(let j=0;j<n;j++){mx=Math.max(mx,H[j].b[L-1],H[j].a[L-1]);}mx=mx||1;
 const hy=(j,i)=>(i<L?H[j].b[L-1-i]:H[j].a[i-L])/mx*1.1;
 const px=i=>(i-(W-1)/2)/(W/2)*1.25,pz=j=>((j-(n-1)/2)/Math.max(n-1,1))*1.9;
 const pos=new Float32Array(n*W*6);
 for(let j=0;j<n;j++){const age=0.3+0.7*(j/(n-1));for(let i=0;i<W;i++){
  const h=hy(j,i),hl=hy(j,Math.max(0,i-1)),hr=hy(j,Math.min(W-1,i+1)),hb=hy(Math.max(0,j-1),i),hf=hy(Math.min(n-1,j+1),i);
  let nx=hl-hr,nz=hb-hf;const ny=0.12,nl=Math.hypot(nx,ny,nz);nx/=nl;const nyy=ny/nl;nz/=nl;
  const lit=Math.max(0.15,Math.min(1,0.55+0.6*(nx*0.4+nyy*0.8+nz*0.4))),t=Math.min(1,h/1.1),bid=i<L;
  const r=(bid?0.10+0.25*t:0.55+0.45*t)*lit*age,g=(bid?0.45+0.55*t:0.16+0.2*t)*lit*age,b=(bid?0.32+0.3*t:0.25+0.2*t)*lit*age,o=(j*W+i)*6;
  pos[o]=px(i);pos[o+1]=h-0.35;pos[o+2]=pz(j);pos[o+3]=r;pos[o+4]=g;pos[o+5]=b;}}
 const tri=[],ln=[];
 for(let j=0;j<n-1;j++)for(let i=0;i<W-1;i++){const a=j*W+i,b=a+1,c=a+W,d=c+1;tri.push(a,c,b,b,c,d);}
 for(let j=0;j<n;j+=2)for(let i=0;i<W-1;i++){ln.push(j*W+i,j*W+i+1);}
 for(let i=0;i<W;i+=3)for(let j=0;j<n-1;j++){ln.push(j*W+i,(j+1)*W+i);}
 V3.nTri=tri.length;V3.nLine=ln.length;
 const idx=new Uint16Array(tri.length+ln.length);idx.set(tri,0);idx.set(ln,tri.length);
 gl.bindBuffer(gl.ARRAY_BUFFER,V3.buf);gl.bufferData(gl.ARRAY_BUFFER,pos,gl.DYNAMIC_DRAW);
 gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,V3.ibuf);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,idx,gl.DYNAMIC_DRAW);
}
function v3Draw(){
 const gl=V3.gl,cv=V3.cv,dpr=Math.min(2,window.devicePixelRatio||1),w=Math.max(10,Math.round(cv.clientWidth*dpr)),h=Math.max(10,Math.round(cv.clientHeight*dpr));
 if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;}
 if(V3.dirty){v3Build();V3.dirty=false;}
 gl.viewport(0,0,w,h);gl.clearColor(0.027,0.05,0.094,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
 if(V3.nTri===0)return;
 gl.useProgram(V3.prog);gl.uniformMatrix4fv(V3.uM,false,v3Mat());
 gl.bindBuffer(gl.ARRAY_BUFFER,V3.buf);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,V3.ibuf);
 gl.enableVertexAttribArray(V3.aP);gl.vertexAttribPointer(V3.aP,3,gl.FLOAT,false,24,0);gl.enableVertexAttribArray(V3.aC);gl.vertexAttribPointer(V3.aC,3,gl.FLOAT,false,24,12);
 gl.uniform1f(V3.uK,1);gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1,1);gl.drawElements(gl.TRIANGLES,V3.nTri,gl.UNSIGNED_SHORT,0);gl.disable(gl.POLYGON_OFFSET_FILL);
 gl.uniform1f(V3.uK,1.9);gl.drawElements(gl.LINES,V3.nLine,gl.UNSIGNED_SHORT,V3.nTri*2);
}
function v3Frame(t){
 requestAnimationFrame(v3Frame);
 if(!V3.gl||!V3.visible||document.hidden)return;
 if(V3.auto&&!V3.drag){V3.yaw=-0.55+Math.sin(t/4200)*0.5;}
 v3Draw();
}
function v3Init(){
 const cv=$('v3Canvas');V3.cv=cv;
 const gl=cv.getContext('webgl',{antialias:true})||cv.getContext('experimental-webgl');
 if(!gl){cv.hidden=true;$('v3Off').hidden=false;$('v3Off').textContent='WebGL is not available in this browser, so the 3D surface cannot be drawn. The 2D depth chart above is unaffected.';$('v3Meta').textContent='WebGL unavailable';return;}
 const sh=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
 try{
  const p=gl.createProgram();
  gl.attachShader(p,sh(gl.VERTEX_SHADER,'attribute vec3 aP; attribute vec3 aC; uniform mat4 uM; uniform float uK; varying vec3 vC; void main(){ vC=aC*uK; gl_Position=uM*vec4(aP,1.0); }'));
  gl.attachShader(p,sh(gl.FRAGMENT_SHADER,'precision mediump float; varying vec3 vC; void main(){ gl_FragColor=vec4(vC,1.0); }'));
  gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
  V3.prog=p;V3.aP=gl.getAttribLocation(p,'aP');V3.aC=gl.getAttribLocation(p,'aC');V3.uM=gl.getUniformLocation(p,'uM');V3.uK=gl.getUniformLocation(p,'uK');
 }catch(e){cv.hidden=true;$('v3Off').hidden=false;$('v3Off').textContent='The 3D surface could not start: '+e.message;$('v3Meta').textContent='3D unavailable';return;}
 V3.gl=gl;V3.buf=gl.createBuffer();V3.ibuf=gl.createBuffer();gl.enable(gl.DEPTH_TEST);
 cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);V3.drag={x:e.clientX,y:e.clientY};V3.auto=false;$('v3Auto').textContent='Auto-rotate: off';$('v3Auto').setAttribute('aria-pressed','false');});
 cv.addEventListener('pointermove',e=>{if(!V3.drag)return;V3.yaw-=(e.clientX-V3.drag.x)*0.008;V3.pitch=Math.max(0.05,Math.min(1.45,V3.pitch+(e.clientY-V3.drag.y)*0.008));V3.drag={x:e.clientX,y:e.clientY};});
 const up=()=>{V3.drag=null;};cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);
 cv.addEventListener('wheel',e=>{e.preventDefault();V3.zoom=Math.max(0.5,Math.min(3,V3.zoom*(e.deltaY<0?1.1:0.9)));},{passive:false});
 cv.addEventListener('keydown',e=>{const k=e.key;let used=true;
  if(k==='ArrowLeft')V3.yaw-=0.1;else if(k==='ArrowRight')V3.yaw+=0.1;else if(k==='ArrowUp')V3.pitch=Math.min(1.45,V3.pitch+0.08);else if(k==='ArrowDown')V3.pitch=Math.max(0.05,V3.pitch-0.08);
  else if(k==='+'||k==='=')V3.zoom=Math.min(3,V3.zoom*1.1);else if(k==='-')V3.zoom=Math.max(0.5,V3.zoom*0.9);else used=false;
  if(used){V3.auto=false;e.preventDefault();}});
 $('v3Auto').onclick=()=>{V3.auto=!V3.auto;$('v3Auto').textContent='Auto-rotate: '+(V3.auto?'on':'off');$('v3Auto').setAttribute('aria-pressed',String(V3.auto));};
 $('v3Pause').onclick=()=>{V3.paused=!V3.paused;$('v3Pause').textContent=V3.paused?'Resume capture':'Pause capture';$('v3Pause').setAttribute('aria-pressed',String(V3.paused));};
 $('v3Reset').onclick=()=>{V3.yaw=-0.55;V3.pitch=0.55;V3.zoom=1;V3.hist=[];V3.dirty=true;v3Summary();};
 if('IntersectionObserver' in window)new IntersectionObserver(es=>{V3.visible=es[0].isIntersecting;}).observe(cv);
 requestAnimationFrame(v3Frame);
}
v3Init();
`;
