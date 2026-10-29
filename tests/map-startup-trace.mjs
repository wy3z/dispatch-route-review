import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require=createRequire(import.meta.url);
const sharp=createRequire(require.resolve('next/package.json'))('sharp');

/** Asynchronous compositor frames use the same pixel detector and timing boundary for both engines. */
export async function startStartupTrace({client,evaluate,delay,waitFor,output}) {
  const frames=[];
  let active=true;
  client.on('Page.screencastFrame',event=>{
    if(active)frames.push(event);
    void client.command('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
  });
  await client.command('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__startupProjection=[];
    function observeStartup(){
      const host=document.querySelector('.audit-map');
      const point=host?.reviewMapProject?.(-1.89,52.526);
      window.__startupProjection.push({at:performance.now(),point,ready:host?.dataset.mapStyleReady==='true'});
      [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Start reviewing')?.click();
      if(performance.now()<8000)requestAnimationFrame(observeStartup);
    }
    requestAnimationFrame(observeStartup);
  `});
  if(process.env.MAP_TEST_STARTUP_DETAIL==='1') await client.command('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__startupNativeTrace=[];
    function attachNativeTrace(){
      const h=document.querySelector('.audit-map');
      let f=h?.[Object.keys(h).find(k=>k.startsWith('__reactFiber'))],m;
      for(let i=0;f&&i<12;i++,f=f.return){let s=f.memoizedState;for(let j=0;s&&j<30;j++,s=s.next){const v=s.memoizedState?.current;if(v?.map&&typeof v.map.isMoving==='function')m=v.map;}}
      if(!m){if(performance.now()<5000)requestAnimationFrame(attachNativeTrace);return;}
      const record=(name,extra={})=>{if(window.__startupNativeTrace.length<600)window.__startupNativeTrace.push({at:performance.now(),name,idleTriggered:m._idleTriggered,...extra});};
      record('attached');
      for(const name of ['idle','load','style.load'])m.on(name,()=>record(name));
      m.on('sourcedata',e=>{if(['review-booked','review-issues'].includes(e.sourceId))record('point-data',{source:e.sourceId,type:e.sourceDataType,loaded:e.isSourceLoaded,tile:e.tile?.tileID?.key,tileState:e.tile?.state});});
      if(${process.env.MAP_TEST_STARTUP_GL==='1'}) {
        const gl=m.painter.context.gl;
        for(const name of ['compileShader','linkProgram','getProgramParameter','getShaderParameter','texImage2D','texSubImage2D','drawElements','drawArrays','bufferData']) {
          const original=gl[name];
          gl[name]=function(...args){const start=performance.now();const value=original.apply(this,args);const duration=performance.now()-start;if(duration>1)record('gl:'+name,{start,duration});return value;};
        }
      }
      const draw=m.painter.render;
      m.painter.render=function(...args){const start=performance.now();const value=draw.apply(this,args);record('draw',{start,duration:performance.now()-start});return value;};
      const style=m.style,original=style._updatePlacement;
      style._updatePlacement=function(...args){
        const start=performance.now(),old=this.placement;
        const result=original.apply(this,args);
        const sources=['review-booked','review-issues'];
        record('placement',{start,duration:performance.now()-start,fadeDuration:args[2],committed:old!==this.placement,commitTime:this.placement?.commitTime,
          tiles:Object.fromEntries(sources.map(source=>{const tiles=this.tileManagers[source];return [source,tiles?.getRenderableIds(true).map(id=>{const t=tiles.getTileByID(id);return {key:t.tileID.key,state:t.state};})];}))});
        return result;
      };
      m.on('render',()=>record('render',{loaded:m.loaded()}));
    }
    requestAnimationFrame(attachNativeTrace);
  `});
  await client.command('Page.startScreencast',{format:'png',everyNthFrame:1});
  return async()=>{
    await waitFor(()=>evaluate(client,"document.querySelector('.audit-map')?.dataset.mapStyleReady==='true'",'startup ready observation'),'startup style/source/camera idle');
    // Legacy DOM zoom transitions can outlive its camera-end/style-ready signal.
    // Keep recording the tail; measure the first qualifying frame, never this wait.
    await delay(1000);
    await client.command('Page.stopScreencast');active=false;
    const {timeOrigin,projection}=await evaluate(client,'({timeOrigin:performance.timeOrigin,projection:window.__startupProjection})','startup frame timeline');
    mkdirSync(output,{recursive:true});
    const samples=[];
    for(const [index,frame] of frames.entries()) {
      const at=frame.metadata.timestamp*1000-timeOrigin;
      if(at<0)continue;
      const observation=projection.findLast(p=>p.at<=at);
      const bytes=Buffer.from(frame.data,'base64');
      const {data,info}=await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
      let bodyPixels=0;
      if(observation?.point) {
        const cx=Math.round(observation.point.x),cy=Math.round(observation.point.y);
        // The exposed fixture T2002 body is purple (#8C3CFF). A <=5px road
        // cannot fill >60 pixels of this 11px square. No source-ready proxy.
        for(let y=cy-5;y<=cy+5;y++)for(let x=cx-5;x<=cx+5;x++) {
          if(x<0||y<0||x>=info.width||y>=info.height)continue;
          const i=(y*info.width+x)*info.channels;
          if(data[i+2]>140&&data[i+2]-data[i+1]>75&&data[i+2]-data[i]>35)bodyPixels++;
        }
      }
      samples.push({at,projectionAt:observation?.at,point:observation?.point,ready:observation?.ready,bodyPixels,file:`startup-${index}.png`});
      writeFileSync(resolve(output,`startup-${index}.png`),bytes);
    }
    const first=samples.find(s=>s.bodyPixels>60),usable=samples.find(s=>s.bodyPixels>60&&s.ready);
    const result={boundary:'asynchronous compositor frame: >60 purple body pixels in 11x11 around canonical T2002',
      nativeTrace:await evaluate(client,'window.__startupNativeTrace??null','optional native startup trace'),
      firstVisibleIntervalMs:first?[samples[samples.indexOf(first)-1]?.at??0,first.at]:null,
      usableIntervalMs:usable?[samples[samples.indexOf(usable)-1]?.at??0,usable.at]:null,samples,projection};
    writeFileSync(resolve(output,'startup-pixels.json'),JSON.stringify(result,null,2));
    assert.ok(first&&usable,'compositor frames contain the actual exposed booked marker and eventual idle state');
    return result;
  };
}
