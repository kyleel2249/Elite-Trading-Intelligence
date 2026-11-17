/** Installable ETI web-app shell for Android, iOS and desktop browsers. */
export const PWA_MANIFEST = JSON.stringify({
  id: "/",
  name: "ETI — Elite Trading Intelligence",
  short_name: "ETI",
  description: "Live market intelligence, chart analysis and trading risk tools.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  display_override: ["standalone", "minimal-ui"],
  orientation: "any",
  background_color: "#080d16",
  theme_color: "#080d16",
  categories: ["finance", "productivity"],
  icons: [{ src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }]
});
export const PWA_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="ETI">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#123e73"/><stop offset="1" stop-color="#071321"/></linearGradient><linearGradient id="line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#35a7ff"/><stop offset="1" stop-color="#43e0bd"/></linearGradient></defs>
<rect width="512" height="512" rx="112" fill="url(#bg)"/>
<path d="M74 345h72l45-76 47 38 70-112 43 34 87-102" fill="none" stroke="url(#line)" stroke-width="19" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M74 392h364" stroke="#8fb8df" stroke-opacity=".35" stroke-width="8" stroke-linecap="round"/>
<text x="256" y="230" fill="#f4f8ff" font-family="Arial,Helvetica,sans-serif" font-size="116" font-weight="800" letter-spacing="-7" text-anchor="middle">ETI</text>
</svg>`;
export const PWA_HEAD = `<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#080d16">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="ETI">
<link rel="apple-touch-icon" href="/app-icon.svg">`;
export const PWA_CSS = `<style id="eti-pwa-css">
.eti-install-app{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;padding:7px 12px;border:1px solid rgba(83,170,255,.55);border-radius:8px;background:linear-gradient(135deg,#123e73,#0c263f);color:#f3f8ff;font:700 12px system-ui,sans-serif;white-space:nowrap;cursor:pointer}
.eti-install-app[hidden]{display:none!important}
.eti-pwa-toast{position:fixed;z-index:10000;left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom));max-width:560px;margin:auto;padding:12px 15px;border:1px solid #426386;border-radius:10px;background:#0c1c2d;color:#edf5ff;box-shadow:0 12px 36px rgba(0,0,0,.45);font:13px/1.45 system-ui,sans-serif}
html{scroll-padding-top:12px}
body{padding-bottom:max(12px,env(safe-area-inset-bottom))}
@media(max-width:760px){
 header{display:flex;flex-direction:column;align-items:stretch;gap:9px;padding-top:max(12px,env(safe-area-inset-top))}
 header>div:first-child{min-width:0}
 header>div:nth-child(2){width:100%;max-width:100%;display:flex;flex-wrap:nowrap!important;align-items:center;gap:9px;overflow-x:auto;overscroll-behavior-x:contain;padding-bottom:5px}
 header>div:nth-child(2)>a{flex:0 0 auto;white-space:nowrap}
 main{padding:12px!important}
 .panel{min-width:0;padding:12px}
 .lower,.sigcharts,.execution-grid,.calcgrid{grid-template-columns:minmax(0,1fr)!important}
 .toolbar{display:flex;flex-wrap:wrap;gap:8px}
 .toolbar>*{min-width:0;max-width:100%}
 .chart{height:clamp(230px,55vh,420px)!important}
 #stack{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}
 .scroll{overflow-x:auto}
 input,select,button{min-height:44px;font-size:16px}
 .eti-indicator-bar,.eti-smc-bar{gap:6px;padding:8px}
 .eti-indicator-bar label,.eti-smc-bar label{min-height:36px}
 .eti-install-app{min-height:42px}
}
@media(max-width:420px){
 header h1{font-size:21px}
 .toolbar>select,.toolbar>input{flex:1 1 100%;width:100%}
 .meta{gap:7px;flex-wrap:wrap}
}
@media(prefers-reduced-motion:reduce){.eti-pwa-toast{scroll-behavior:auto}}
</style>`;
export const PWA_JS = String.raw`<script id="eti-pwa-js">
(function(){
"use strict";
try{
var standalone=!!(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches)||!!navigator.standalone;
var ios=/iphone|ipad|ipod/i.test(navigator.userAgent||"");
var host=document.querySelector("header>div:nth-child(2)")||document.querySelector("header")||document.body;
var button=document.createElement("button");button.type="button";button.id="eti-install-app";button.className="eti-install-app";button.textContent="Install ETI";button.hidden=standalone;button.setAttribute("aria-label","Install ETI as an app");
host.appendChild(button);
var deferred=null,toastTimer=0;
function toast(message){
 var old=document.getElementById("eti-pwa-toast");if(old)old.remove();
 var el=document.createElement("div");el.id="eti-pwa-toast";el.className="eti-pwa-toast";el.setAttribute("role","status");el.textContent=message;document.body.appendChild(el);
 clearTimeout(toastTimer);toastTimer=setTimeout(function(){el.remove();},7000);
}
if(ios&&!standalone)button.hidden=false;
window.addEventListener("beforeinstallprompt",function(event){event.preventDefault();deferred=event;button.hidden=false;});
window.addEventListener("appinstalled",function(){deferred=null;button.hidden=true;toast("ETI has been installed on this device.");});
button.addEventListener("click",async function(){
 if(deferred){deferred.prompt();var choice=await deferred.userChoice;deferred=null;if(choice&&choice.outcome==="accepted")button.hidden=true;return;}
 if(ios){toast("To install ETI on iPhone or iPad: tap Share in Safari, then choose Add to Home Screen.");return;}
 toast("Open your browser menu and choose Install app or Add to Home Screen to install ETI.");
});
var ready=Promise.resolve(null);
if("serviceWorker" in navigator&&location.protocol==="https:"){
 ready=navigator.serviceWorker.register("/sw.js",{scope:"/"}).then(function(reg){return reg;}).catch(function(err){if(window.console)console.warn("ETI offline shell registration failed",err&&err.message);return null;});
}
window.etiPwa={standalone:standalone,install:function(){button.click();},serviceWorker:ready,showInstallButton:function(){button.hidden=false;}};
}catch(e){if(window.console)console.warn("ETI PWA layer unavailable",e&&e.message);}
})();
</script>`;
export const PWA_SERVICE_WORKER = String.raw`"use strict";
const CACHE_NAME="eti-shell-v1";
const SHELL_URL="/";
self.addEventListener("install",event=>{
 event.waitUntil((async()=>{const cache=await caches.open(CACHE_NAME);try{await cache.add(new Request(SHELL_URL,{cache:"reload"}));}catch(_){}await self.skipWaiting();})());
});
self.addEventListener("activate",event=>{
 event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith("eti-shell-")&&k!==CACHE_NAME).map(k=>caches.delete(k)));await self.clients.claim();})());
});
self.addEventListener("fetch",event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=="GET"||url.origin!==self.location.origin||url.pathname.startsWith("/api/")||url.pathname.startsWith("/socket"))return;
 if(request.mode==="navigate"){
  event.respondWith(fetch(request).then(response=>{if(response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(SHELL_URL,response.clone()));return response;}).catch(async()=>await caches.match(SHELL_URL)||new Response("ETI is offline. Reconnect to refresh live market data and trading services.",{status:503,headers:{"content-type":"text/plain; charset=utf-8"}})));
  return;
 }
 if(url.pathname==="/manifest.webmanifest"||url.pathname==="/app-icon.svg"){
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));return response;})));
 }
});
self.addEventListener("push",event=>{
 let payload={title:"ETI market alert",body:"A new trading intelligence alert is available.",url:"/"};
 if(event.data){try{payload=Object.assign(payload,event.data.json());}catch(_){payload.body=event.data.text()||payload.body;}}
 event.waitUntil(self.registration.showNotification(payload.title||"ETI alert",{body:payload.body||"Open ETI to review this alert.",icon:"/app-icon.svg",badge:"/app-icon.svg",tag:payload.tag||"eti-market-alert",data:{url:payload.url||"/"}}));
});
self.addEventListener("notificationclick",event=>{
 event.notification.close();
 const target=new URL(event.notification.data&&event.notification.data.url||"/",self.location.origin);
 if(target.origin!==self.location.origin)return;
 event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(async clients=>{
  const existing=clients.find(client=>client.url.startsWith(self.location.origin));
  if(existing){await existing.navigate(target.href);return existing.focus();}
  return self.clients.openWindow(target.href);
 }));
});`;
export function withPwa(page: string): string {
  if (!page.includes("</head>") || !page.includes("</body>")) return page;
  return page.replace("</head>", PWA_CSS + PWA_HEAD + "</head>").replace("</body>", PWA_JS + "</body>");
}
