// Chrome offscreen documents are background_page targets, not Playwright pages.
// Intercept only their fixture requests so the production transfer code is exercised.
export async function interceptOffscreen(browser,handle,diagnostics){
  const cdp=await browser.newBrowserCDPSession();let counter=0;const pending=new Map();
  function send(sessionId,method,params={}){
    const id=++counter;return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject);
    });
  }
  cdp.on('Target.receivedMessageFromTarget',async({sessionId,message})=>{
    const m=JSON.parse(message);
    if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return;}
    if(m.method==='Fetch.requestPaused'){
      try{const r=await handle(m.params.request);await send(sessionId,'Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:r.status??200,responseHeaders:Object.entries(r.headers??{}).map(([name,value])=>({name,value:String(value)})),body:Buffer.from(r.body??'').toString('base64')});}
      catch(e){if(!/Invalid InterceptionId/.test(String(e)))diagnostics.push(String(e));await send(sessionId,'Fetch.failRequest',{requestId:m.params.requestId,errorReason:'Failed'}).catch(()=>{});}
    }
    if(m.method==='Runtime.exceptionThrown')diagnostics.push(JSON.stringify(m.params.exceptionDetails));
  });
  return {async attach(){
    const {targetInfos}=await cdp.send('Target.getTargets');
    const target=targetInfos.find(t=>t.type==='background_page'&&t.url.endsWith('/offscreen.html'));
    if(!target)throw new Error('Offscreen target missing');
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
    await send(sessionId,'Fetch.enable',{patterns:[{urlPattern:'https://upos-test.bilivideo.com/*'}]});await send(sessionId,'Runtime.enable');
  }};
}
