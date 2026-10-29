import assert from "node:assert/strict";

/** Controlled road arrival and cancelled date reads exercise the renderer's publication boundary. */
export async function checkAsyncMap({client,evaluate,waitFor,delay,initialDate,changedDate,releaseRoads,releaseSchedule,held}) {
  const read=code=>evaluate(client,code,'controlled async map evidence');
  const key=async(key,code)=>{for(const type of ['keyDown','keyUp'])await client.command('Input.dispatchKeyEvent',{type,key,code});};
  const booked=()=>read(`document.querySelector('.audit-map').reviewMapSourceDiagnostics().find(s=>s.source==='review-booked')?.ids ?? []`);
  const snapshot=async()=>({booked:await booked(),publications:await read("JSON.parse(document.querySelector('.audit-map').dataset.mapMetrics||'null')?.publications")});
  await waitFor(()=>held().roads>0,'held initial road response');
  await waitFor(()=>read("document.querySelector('.audit-map').dataset.mapStyleReady==='true'"),'fallback style ready');
  const before=await snapshot();
  assert.ok(before.booked.length,'booked points render while road response is pending');

  const popup='.review-libre-tooltip';
  const probeTrace=[];
  let fallbackText;
  for(let setup=0;setup<6;setup++) {
    const probes=await read("document.querySelector('.audit-map').reviewMapRoadProbes().filter(p=>p.id==='77:fallback:-1')");
    for(const p of probes.filter(p=>p.x>350&&p.x<1200&&p.y>180&&p.y<800)) {
      if(p.hitId && p.hitId!==p.id)continue;

      await client.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y}); await delay(120);
      fallbackText=await read(`document.querySelector('${popup}')?.textContent`);
      probeTrace.push({setup,...p,text:fallbackText});
      if(fallbackText?.includes('Booked order'))break;
    }
    if(fallbackText?.includes('Booked order'))break;
    const p=probes.find(p=>p.x>350&&p.x<1200&&p.y>180&&p.y<800);
    assert.ok(p,'canonical northern fallback is in viewport');
    await client.command('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:0,deltaY:-500}); await delay(600);
  }
  assert.ok(fallbackText?.includes('Booked order')&&fallbackText.includes('Fixture North Engineer')&&fallbackText.includes('not live GPS or travel timing'),`pending road exposes exact honest order-only tooltip: ${JSON.stringify(probeTrace)}`);
  await releaseRoads();
  await waitFor(()=>read("document.querySelector('.audit-map').reviewMapSourceDiagnostics().find(s=>s.source==='review-roads')?.ids.some(id=>id.includes(':road:'))"),'delayed canonical roads arrive');
  const after=await snapshot();
  assert.deepEqual(after.booked,before.booked,'road arrival preserves booked identities');
  if(before.publications)assert.equal(after.publications['review-booked'],before.publications['review-booked'],'road arrival does not republish booked source');
  await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x:500,y:190,button:'left',clickCount:1});
  await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:500,y:190,button:'left',clickCount:1});
  await key(']','BracketRight');
  await waitFor(()=>held().schedule>0,'changed date request held in flight');
  await key('[','BracketLeft');
  await waitFor(()=>read(`new URL(location.href).searchParams.get('date')==='${initialDate}'`),'returned to initial date before response');
  await releaseSchedule(); await delay(500);
  assert.equal(await read("new URL(location.href).searchParams.get('date')"),initialDate);
  const final=await booked();
  assert.deepEqual(final,before.booked,'late date response cannot replace active booked scene');
  assert.ok(final.every(id=>!id.includes(changedDate)),'no obsolete-date points published');
  return {before,after,final,fallbackText,lateDateIgnored:true};
}
