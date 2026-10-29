import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

/** Compare actual sprite code with GPU-default and CPU-readback canvas contexts outside measured phases. */
export async function checkMapArtwork({ client, evaluate, output }) {
  const modules = Object.fromEntries([
    ["@/modules/engineers/domain", "modules/engineers/colours.ts"],
    ["../markers", "modules/map/markers.ts"],
    ["layers", "modules/map/runtime/maplibre-review-layers.ts"],
  ].map(([name, path]) => [name, ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText]));
  await client.command("Page.navigate", { url: "about:blank" }, "isolating artwork comparison");
  const result = await evaluate(client, `(() => {
    const modules=${JSON.stringify(modules)}, loaded={};
    const load=name=>{if(loaded[name])return loaded[name];const exports={};new Function('exports','require',modules[name])(exports,load);return loaded[name]=exports;};
    const {installPointImages}=load('layers');
    const original=HTMLCanvasElement.prototype.getContext;
    const draw=(properties,cpu)=>{
      HTMLCanvasElement.prototype.getContext=function(type,...args){return original.call(this,type,...(type==='2d'?[{willReadFrequently:cpu}]:args));};
      const images=new Map();
      try {installPointImages({hasImage:id=>images.has(id),addImage:(id,pixels,options)=>images.set(id,{pixels,options})},properties);}finally{HTMLCanvasElement.prototype.getContext=original;}
      return images;
    };
    let variants=0,images=0,differentBytes=0,maxChannelDelta=0,differentImages=0;
    const examples=[];
    const atlas=document.createElement('canvas');atlas.width=800;atlas.height=1600;
    const atlasContext=atlas.getContext('2d',{willReadFrequently:true});atlasContext.fillStyle='#e9edf1';atlasContext.fillRect(0,0,800,1600);
    const darkAtlas=document.createElement('canvas');darkAtlas.width=800;darkAtlas.height=1600;
    const darkContext=darkAtlas.getContext('2d',{willReadFrequently:true});darkContext.fillStyle='#192231';darkContext.fillRect(0,0,800,1600);
    let minMaskIoU=1,maxCompositeMeanDelta=0,atlasRow=0;
    for(const kind of ['visit','demand','home','issue'])for(const colour of ['#7357bd','#e7a500'])for(const severity of ['warning','critical','data'])for(let modifiers=0;modifiers<16;modifiers++){
      const properties={kind,colour,label:kind==='demand'?'S':'12',severity,complete:!!(modifiers&1),thirdParty:!!(modifiers&2),attention:!!(modifiers&4),excluded:!!(modifiers&8)};
      const before=draw(properties,false),after=draw(properties,true); variants++;
      const show=colour==='#7357bd'&&severity==='critical'&&[0,1,2,4,8].includes(modifiers);
      let column=0;
      for(const [id,a] of before){const b=after.get(id);if(!b||a.options.pixelRatio!==b.options.pixelRatio||a.pixels.width!==b.pixels.width||a.pixels.height!==b.pixels.height)throw Error('artwork identity/size mismatch');
        let delta=0;for(let i=0;i<a.pixels.data.length;i++){const d=Math.abs(a.pixels.data[i]-b.pixels.data[i]);if(d){differentBytes++;delta++;maxChannelDelta=Math.max(maxChannelDelta,d);}}
        let intersection=0,union=0,compositeDelta=0;
        for(let i=0;i<a.pixels.data.length;i+=4){const x=a.pixels.data,y=b.pixels.data;const maskA=x[i+3]>127,maskB=y[i+3]>127;if(maskA&&maskB)intersection++;if(maskA||maskB)union++;
          for(let channel=0;channel<3;channel++)compositeDelta+=Math.abs((x[i+channel]*x[i+3]+255*(255-x[i+3]))/255-(y[i+channel]*y[i+3]+255*(255-y[i+3]))/255);
        }
        minMaskIoU=Math.min(minMaskIoU,intersection/union);maxCompositeMeanDelta=Math.max(maxCompositeMeanDelta,compositeDelta/(160*160*3*255));
        if(show){for(const [index,pixels] of [a.pixels,b.pixels].entries()){const cell=document.createElement('canvas');cell.width=cell.height=160;cell.getContext('2d').putImageData(pixels,0,0);for(const context of [atlasContext,darkContext])context.drawImage(cell,column*200+index*100,atlasRow*80,80,80);}
          for(const context of [atlasContext,darkContext]){context.fillStyle=context===atlasContext?'#111827':'#ffffff';context.font='11px system-ui';context.fillText(id.slice(id.lastIndexOf(':')+1)+' B/A',column*200+80,atlasRow*80+74);if(column===0)context.fillText(kind+' '+modifiers,3,atlasRow*80+12);}column++;}
        images++;if(delta){differentImages++;if(examples.length<8)examples.push({id,differentBytes:delta});}
      }
      if(show)atlasRow++;
    }
    return {atlas:atlas.toDataURL(),darkAtlas:darkAtlas.toDataURL(),minMaskIoU,maxCompositeMeanDelta,variants,images,differentBytes,differentImages,maxChannelDelta,examples,tiers:['regional','city','street','detail'],contexts:['default','willReadFrequently'],userAgent:navigator.userAgent};
  })()`, "comparing all sprite tiers/modifiers", 60000);
  if(output) writeFileSync(resolve(output,"artwork-before-after.png"),Buffer.from(result.atlas.split(',')[1],"base64"));
  if(output) writeFileSync(resolve(output,"artwork-before-after-dark.png"),Buffer.from(result.darkAtlas.split(',')[1],"base64"));
  delete result.atlas; delete result.darkAtlas;
  if(output) writeFileSync(resolve(output,"artwork-equivalence.json"),JSON.stringify(result,null,2)+"\n");
  assert.equal(result.images,1536);
  // Retain raw byte differences: different Canvas raster backends need not be byte-identical.
  // Visual acceptance is reviewed separately from these measurements.
  return result;
}
