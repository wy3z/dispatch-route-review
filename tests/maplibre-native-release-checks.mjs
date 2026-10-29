import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Exercises the real native drag lifecycle across canvas and sibling UI boundaries. */
export async function checkNativeRelease({client,evaluate,waitFor,delay,output}) {
  const read=code=>evaluate(client,code,'native release observation');
  const mouse=(type,x,y,extra={})=>client.command('Input.dispatchMouseEvent',{type,x,y,...extra},'native release input');
  await read(`(()=>{window.__releaseEvents=[];for(const type of ['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture','mousedown','mouseup','blur'])window.addEventListener(type,e=>window.__releaseEvents.push({type,at:performance.now(),target:e.target===window?"window":e.target?.className??e.target?.nodeName,node:e.target?.nodeName,button:e.button,buttons:e.buttons,pointerId:e.pointerId,pointerType:e.pointerType,trusted:e.isTrusted}),true);})()`);
  const state=()=>read("document.querySelector('.audit-map').reviewMapCameraDiagnostics()");
  const observations=[];
  async function drag(name,end,{cancel}={}) {
    const start=await read("[{x:1000,y:650},{x:500,y:190},{x:1300,y:220}].find(p=>document.elementFromPoint(p.x,p.y)?.classList.contains('maplibregl-canvas'))");
    assert.ok(start,'an exposed canvas grip is available');
    assert.equal(await read(`document.elementFromPoint(${start.x},${start.y})?.classList.contains('maplibregl-canvas')`),true,'drag starts on actual canvas');
    const before=await state();
    await mouse('mouseMoved',start.x,start.y);
    await mouse('mousePressed',start.x,start.y,{button:'left',buttons:1,clickCount:1});
    for(let i=1;i<=8;i++){await mouse('mouseMoved',start.x+(end.x-start.x)*i/8,start.y+(end.y-start.y)*i/8,{button:'left',buttons:1});await delay(20);}
    await delay(150);
    if(cancel) {
      await cancel();
      // releasePointerCapture changes pending capture; the next real pointer
      // event processes it. Same position keeps this a lifecycle-only probe.
      await mouse('mouseMoved',end.x,end.y,{button:'left',buttons:1});
    }
    const releaseTarget=await read(`document.elementFromPoint(${end.x},${end.y})?.className`);
    if(!cancel)await mouse('mouseReleased',end.x,end.y,{button:'left',buttons:0,clickCount:1});
    let error;
    try {await waitFor(async()=>{const s=await state();return !s.dragActive&&!s.moving;},`${name}: native release terminates drag`,1500,50);}catch(e){error=e;}
    const after=await state();
    observations.push({name,before,releaseTarget,after,events:await read('window.__releaseEvents.splice(0)')});
    mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'native-release.json'),JSON.stringify(observations,null,2));
    if(cancel)await mouse('mouseReleased',end.x,end.y,{button:'left',buttons:0,clickCount:1});
    if(error)throw error;
    if(!cancel) {
      assert.ok(observations.at(-1).events.some(e=>e.type==='mouseup'&&e.trusted&&e.buttons===0&&e.target.includes('maplibregl-canvas-container')),'real release reaches native canvas handler');
      assert.ok(observations.at(-1).events.some(e=>e.type==='lostpointercapture'&&e.trusted),'browser releases mouse capture');
    }
    assert.notDeepEqual(before.center,after.center,'native drag moved the camera');
  }
  await drag('ordinary canvas release',{x:1100,y:700});
  const chrome=await read("(()=>{const r=document.querySelector('#map-tool-date').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await drag('release over date toolbar',chrome);
  await drag('release outside viewport',{x:1500,y:950});
  await mouse('mouseMoved',1000,650);
  assert.equal((await state()).dragActive,false,'returning pointer does not resume a released drag');
  await drag('lost capture cancels active mouse gesture',{x:1100,y:700},{cancel:()=>read("(()=>{const c=document.querySelector('.maplibregl-canvas-container');const id=window.__releaseEvents.findLast(e=>e.type==='gotpointercapture').pointerId;c.releasePointerCapture(id);})()")});
  // A mouse pointercancel cannot be requested through CDP. Exercise that branch
  // explicitly as an untrusted DOM cancellation; trusted lost-capture is above.
  await drag('DOM mouse pointercancel branch',{x:1100,y:700},{cancel:()=>read("(()=>{const c=document.querySelector('.maplibregl-canvas-container');const id=window.__releaseEvents.findLast(e=>e.type==='gotpointercapture').pointerId;c.dispatchEvent(new PointerEvent('pointercancel',{pointerType:'mouse',pointerId:id,bubbles:true}));})()")});
  await drag('native window blur',{x:1100,y:700},{cancel:async()=>{
    const {targetId}=await client.command('Target.createTarget',{url:'about:blank'});
    await client.command('Target.activateTarget',{targetId});
    await delay(100);
    await client.command('Target.closeTarget',{targetId});
  }});
  assert.ok(observations.at(-1).events.some(e=>e.type==='blur'&&e.target==='window'&&e.trusted),'browser window blur was actually observed');
  // Native two-touch pinch remains owned by MapLibre; mouse capture must not
  // intercept touch's implicit capture or change the enabled gesture handlers.
  await read('window.__releaseEvents=[]');
  await client.command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
  const beforeTouch=await state();
  const touch=(type,points)=>client.command('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:1,radiusY:1,force:1}))});
  await touch('touchStart',[[1,950,600],[2,1050,600]]);
  await touch('touchMove',[[1,900,600],[2,1100,600]]);
  await touch('touchEnd',[]);
  await waitFor(async()=>!(await state()).moving,'native pinch ends');
  const afterTouch=await state(),touchEvents=await read('window.__releaseEvents.splice(0)');
  assert.notEqual(beforeTouch.zoom,afterTouch.zoom,'native pinch changes zoom');
  assert.ok(!touchEvents.some(e=>e.type==='gotpointercapture'&&e.target.includes('canvas-container')),'mouse capture does not own touch pointers');
  await touch('touchStart',[[1,1000,600]]);
  await touch('touchMove',[[1,1050,630]]);
  await touch('touchCancel',[]);
  await waitFor(async()=>!(await state()).moving,'native touch cancellation ends');
  await client.command('Emulation.setTouchEmulationEnabled',{enabled:false});
  observations.push({name:'native touch pinch and cancel',beforeTouch,afterTouch,events:touchEvents,cancelEvents:await read('window.__releaseEvents.splice(0)')});
  // A real right-button chord must not release the still-held left drag.
  await mouse('mouseMoved',1000,650);
  await mouse('mousePressed',1000,650,{button:'left',buttons:1,clickCount:1});
  await mouse('mouseMoved',1020,650,{button:'left',buttons:1});
  await mouse('mousePressed',1020,650,{button:'right',buttons:3,clickCount:1});
  await mouse('mouseReleased',1020,650,{button:'right',buttons:1,clickCount:1});
  assert.equal((await state()).dragActive,true,'right release does not terminate held left drag');
  await mouse('mouseReleased',1020,650,{button:'left',buttons:0,clickCount:1});
  await waitFor(async()=>!(await state()).moving,'multibutton release completes');
  observations.push({name:'native multibutton',after:await state(),events:await read('window.__releaseEvents.splice(0)')});
  // Context loss while dragging must release capture and destroy the native map.
  await mouse('mouseMoved',1000,650);
  await mouse('mousePressed',1000,650,{button:'left',buttons:1,clickCount:1});
  await mouse('mouseMoved',1020,650,{button:'left',buttons:1});
  assert.equal((await state()).dragActive,true);
  await read("(()=>{window.__failedCapture=document.querySelector('.maplibregl-canvas-container');const c=document.querySelector('.maplibregl-canvas');const gl=c.getContext('webgl2')??c.getContext('webgl');gl.getExtension('WEBGL_lose_context').loseContext();})()");
  await waitFor(()=>read("document.querySelector('.audit-map').dataset.basemap==='unavailable'&&document.querySelectorAll('.maplibregl-canvas').length===0"),'context loss removes captured map');
  assert.equal(await read('window.__failedCapture.hasPointerCapture(1)'),false,'context loss releases native capture');
  await mouse('mouseReleased',1020,650,{button:'left',buttons:0,clickCount:1});
  observations.push({name:'context loss while captured',events:await read('window.__releaseEvents.splice(0)')});
  writeFileSync(resolve(output,'native-release.json'),JSON.stringify(observations,null,2));
  return observations;
}
