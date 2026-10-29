import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Paired real-input phases and controlled cache/lifecycle stress for the production workspace. */
export async function checkStressMap({ client, evaluate, clickElement, pressKey, waitFor, delay, engine, date, output, partial, refresh, requestCounts, failStyle }) {
  const read = (code) => evaluate(client, code, "stress observation");
  const phases = [];
  const observations = {};
  const popup = ".review-libre-popup";
  const tooltip = ".review-libre-tooltip";
  const visitId = `fixture-${date}-north-1`;
  const point = async (id=visitId) => read(`(() => {
    const p = document.querySelector('.audit-map').reviewMapDiagnostics('visit:${id}').firstVisit;
    return {x:p.left,y:p.top};
  })()`);
  const counters = () => read(`({camera:document.querySelector('.audit-map').reviewMapCameraDiagnostics?.(),runtime:JSON.parse(document.querySelector('.audit-map').dataset.mapMetrics || 'null'), canvases:document.querySelectorAll('.maplibregl-canvas').length, popups:document.querySelectorAll('.review-libre-popup').length, domNodes:document.querySelector('.audit-map').querySelectorAll('*').length})`);
  async function settle() {
    let previous; let stable = 0;
    await waitFor(async () => {
      const p = await point();
      stable = p && previous && Math.hypot(p.x-previous.x,p.y-previous.y)<.5 ? stable+1 : 0;
      previous=p;
      const complete=await read(`(()=>{const engine=document.querySelector('.audit-map').dataset.mapEngine;const last=window.__mapComparison.nativeEvents.findLast(e=>e.engine===engine&&['constructed','camera-start','camera-end'].includes(e.name));return last?.name!=='camera-start';})()`);
      return complete && stable>=4;
    }, "completed camera and stable rendered projection", 10000, 100);
  }
  async function phase(name, action) {
    const before = await counters();
    const start = await read("performance.now()");
    try { await action(); } catch (error) {
      mkdirSync(output,{recursive:true});
      await screenshot("failure");
      const p=await point();
      const hit=p && await read(`document.elementFromPoint(${p.x},${p.y})?.outerHTML.slice(0,1200)`);
      writeFileSync(resolve(output,"failure.json"),JSON.stringify({phase:name,point:p,hit,diagnostics:await read("document.querySelector('.audit-map').reviewMapDiagnostics?.()"),counters:await counters(),startup:await read("({events:window.__mapComparison.nativeEvents,firstVisible:window.__mapComparison.firstVisibleBookedPointMs,usable:window.__mapComparison.initialUsableMs})"),phases},null,2));
      throw error;
    }
    await delay(250);
    const end = await read("performance.now()");
    const samples = await read(`({frames:window.__mapComparison.frameTimes.filter(f => f.start>=${start} && f.start<${end}), longTasks:window.__mapComparison.longTasks.filter(t => t.start>=${start} && t.start<${end})})`);
    phases.push({name,start,end,durationMs:end-start,...samples,before,after:await counters(),requests:requestCounts()});
  }
  async function mouse(type, x, y, extra = {}) { await client.command("Input.dispatchMouseEvent", {type,x,y,...extra}); }
  async function pointerClick(p, count = 1) {
    await mouse("mouseMoved",p.x,p.y);
    await mouse("mousePressed",p.x,p.y,{button:"left",buttons:1,clickCount:count});
    await mouse("mouseReleased",p.x,p.y,{button:"left",buttons:0,clickCount:count});
  }
  async function exposePoint(id=visitId,ticket="T1001") {
    // Clear/focus may retain a zoom that leaves this point off screen.
    // A native drag is explicit setup, excluded from measured hover/selection phases.
    for(let i=0;i<3;i++) {
      const p=await point(id,ticket);
      const viewport=await read("({w:innerWidth,h:innerHeight})");
      if(p.x>370 && p.x<viewport.w-80 && p.y>180 && p.y<viewport.h-100) return;
      const x=viewport.w*.65,y=viewport.h*.55;
      const dx=Math.max(-250,Math.min(250,x-p.x)),dy=Math.max(-300,Math.min(300,y-p.y));
      await mouse("mouseMoved",x,y); await mouse("mousePressed",x,y,{button:"left",buttons:1,clickCount:1});
      for(let j=1;j<=8;j++) await mouse("mouseMoved",x+dx*j/8,y+dy*j/8,{button:"left",buttons:1});
      await delay(150); await mouse("mouseReleased",x+dx,y+dy,{button:"left",buttons:0,clickCount:1}); await settle();
    }
    const p=await point(id,ticket); assert.ok(p.y>100&&p.y<800,"pointer target reachable after bounded native setup");
  }
  async function exposeDistinct(id=visitId, ticket="T1001") {
    // Establish the actual native target, not a guessed number of tiny wheel ticks.
    // Geographic positions and overlap ordering remain unchanged.
    const attempts=[];
    for(let step=0;step<10;step++) {
      await exposePoint(id,ticket);
      const p=await point(id,ticket);
      const hit=await read(`(()=>{const e=document.elementFromPoint(${p.x},${p.y});const map=document.querySelector('.audit-map');return {canvas:e?.classList.contains('maplibregl-canvas'),native:map.reviewMapHitDiagnostics?.(${p.x},${p.y}),camera:map.reviewMapCameraDiagnostics()};})()`);
      attempts.push({point:p,...hit});
      const expected=hit.canvas && ['visit:'+id,'issue:'+id].includes(hit.native?.winner?.id);
      if(expected) { (observations.distinctTargetSetup??=[]).push({id,attempts}); return p; }
      if(hit.camera.zoom>=16) break;
      await mouse('mouseWheel',p.x,p.y,{deltaX:0,deltaY:-500}); await settle();
    }
    mkdirSync(output,{recursive:true});
    writeFileSync(resolve(output,'distinct-target-failure.json'),JSON.stringify({id,attempts},null,2));
    assert.fail(`Native top hit never exposed ${ticket}; see distinct-target-failure.json`);
  }
  async function screenshot(name) {
    mkdirSync(output,{recursive:true});
    const shot=await client.command("Page.captureScreenshot",{format:"png"});
    writeFileSync(resolve(output,`${name}.png`),Buffer.from(shot.data,"base64"));
  }
  async function startMotionProbe(name) {
    if (process.env.MAP_TEST_INPUT_PROBE !== "1") return;
    await read(`(() => {
      const locate=()=>{const p=document.querySelector('.audit-map').reviewMapDiagnostics('visit:${visitId}').firstVisit;return {x:p.left,y:p.top};};
      const probe=window.__motionProbe={name:${JSON.stringify(name)},commandAt:performance.now(),positions:[],baseline:locate()};
      let previous=probe.baseline;
      const frame=()=>{const p=locate();if(Math.hypot(p.x-previous.x,p.y-previous.y)>.5){probe.positions.push({at:performance.now(),...p});previous=p;}window.__motionProbeFrame=requestAnimationFrame(frame);};
      window.__motionProbeFrame=requestAnimationFrame(frame);
    })()`);
  }
  async function finishMotionProbe() {
    if (process.env.MAP_TEST_INPUT_PROBE !== "1") return;
    (observations.motionResponse??=[]).push(await read(`(()=>{cancelAnimationFrame(window.__motionProbeFrame);const p=window.__motionProbe;return {...p,settledObservedAt:performance.now(),camera:document.querySelector('.audit-map').reviewMapCameraDiagnostics(),events:window.__mapComparison.nativeEvents.filter(e=>e.at>=p.commandAt&&e.name.startsWith('camera-'))};})()`));
  }
  async function routeFocus() {
    const requestedAt=await read("performance.now()");
    assert.equal(await read("(() => {const b=[...document.querySelectorAll('button.route-rail-route')].find(b=>b.textContent.includes('Fixture North Engineer')); if(!b)return false;b.click();return true;})()"),true,"route focus control exists");
    await settle();
    (observations.focusTimings??=[]).push(await read(`({kind:'route',requestedAt:${requestedAt},settledObservedAt:performance.now(),motion:matchMedia('(prefers-reduced-motion: reduce)').matches?'reduce':'normal'})`));
  }
  async function visitFocus() {
    await routeFocus();
    const requestedAt=await read("performance.now()");
    await clickElement(client,`[data-detail-visit-id="${visitId}"]`,"booked visit focus");
    await waitFor(()=>read(`document.querySelector('${popup}')?.textContent.includes('T1001')`),"booked popup");
    const popupObservedAt=await read("performance.now()");
    await settle();
    (observations.focusTimings??=[]).push(await read(`({kind:'visit',requestedAt:${requestedAt},popupObservedAt:${popupObservedAt},settledObservedAt:performance.now(),motion:matchMedia('(prefers-reduced-motion: reduce)').matches?'reduce':'normal'})`));
  }
  const assertBulkStable = (before,after,label,sources=["review-roads","review-booked","review-demand","review-issues","review-advisory","review-homes"]) => {
    if (!before.runtime) return;
    for (const source of sources) assert.equal(after.runtime.publications[source],before.runtime.publications[source],`${label}: ${source}`);
  };
  await pressKey(client,"t","KeyT"); await pressKey(client,"t","KeyT");
  await waitFor(()=>read("document.querySelector('main').dataset.routePaneMode==='routes'"),"routes pane");
  await pressKey(client,"e","KeyE"); await delay(250);
  // Collapse/expand is already covered by the core path; expand the actual target route here.
  await routeFocus();
  for (const motion of ["no-preference","reduce"]) {
    await client.command("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:motion}]});
    await pressKey(client,"m","KeyM"); await settle();
    await phase(`${motion}:drag`,async()=>{
      const before=await point();
      const r=await read("(() => {const r=document.querySelector('.audit-map').getBoundingClientRect();return {x:r.x+r.width*.68,y:r.y+r.height*.62};})()");
      await mouse("mouseMoved",r.x,r.y); await mouse("mousePressed",r.x,r.y,{button:"left",buttons:1,clickCount:1});
      await startMotionProbe(`${motion}:drag`);
      for(let i=1;i<=12;i++){ await mouse("mouseMoved",r.x+i*8,r.y+20*i/12,{button:"left",buttons:1}); await delay(16); }
      await mouse("mouseReleased",r.x+96,r.y+20,{button:"left",buttons:0,clickCount:1});
      if(process.env.MAP_TEST_INPUT_PROBE === "1") await read("window.__motionProbe.inputEndAt=performance.now()");
      await settle(); await finishMotionProbe(); const after=await point();
      assert.ok(Math.hypot(after.x-before.x,after.y-before.y)>30,"native drag moves geographic content");
    });
    await phase(`${motion}:wheel`,async()=>{
      const before=await point();
      const r=await read("(() => {const r=document.querySelector('.audit-map').getBoundingClientRect();return {x:r.x+r.width*.65,y:r.y+r.height*.55};})()");
      for(let i=0;i<4;i++){await mouse("mouseWheel",r.x,r.y,{deltaX:0,deltaY:-80});await delay(50);}
      await settle(); const after=await point();
      assert.ok(Math.hypot(after.x-before.x,after.y-before.y)>5,"native wheel changes geographic projection");
    });
    await phase(`${motion}:keyboard`,async()=>{
      const before=await point(); await startMotionProbe(`${motion}:keyboard`); await pressKey(client,"ArrowRight","ArrowRight");
      if(process.env.MAP_TEST_INPUT_PROBE === "1") await read("window.__motionProbe.inputEndAt=performance.now()");
      await settle(); await finishMotionProbe();
      assert.ok(Math.abs((await point()).x-before.x)>8);
    });
    await visitFocus(); await pressKey(client,"Escape","Escape"); await settle(); await exposePoint();
    await exposeDistinct();
    const exposed=await point();await mouse("mouseMoved",exposed.x+90,exposed.y+90);await delay(100);
    await phase(`${motion}:hover`,async()=>{
      const before=await counters();
      for(let i=0;i<5;i++) {
        const p=await point(); assert.ok(p,"booked geographic point available");
        await mouse("mouseMoved",p.x,p.y);
        await waitFor(()=>read(`Boolean(document.querySelector('${tooltip}'))`),"pointer tooltip");
        const text=await read(`document.querySelector('${tooltip}').textContent`);
        assert.ok(text.includes("T1001"),"hover resolves the intended first canonical booked visit");
        (observations.bookedHoverTargets??=[]).push({motion,ticket:"T1001",text});
        await mouse("mouseMoved",p.x+90,p.y+90); await delay(60);
      }
      assertBulkStable(before,await counters(),"hover");
    });
    await phase(`${motion}:selection`,async()=>{
      const before=await counters();
      for(let i=0;i<3;i++) {
        await visitFocus(); await pressKey(client,"Escape","Escape"); await settle(); const p=await exposeDistinct(); await pointerClick(p);
        await waitFor(()=>read(`document.querySelector('${popup}')?.textContent.includes('T1001')`),"pointer-selected booked popup");
        await settle(); await pressKey(client,"Escape","Escape");
        await waitFor(()=>read(`!document.querySelector('${popup}')`),"Escape clears selection");
      }
      assertBulkStable(before,await counters(),"selection");
    });
  }
  await client.command("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:process.env.MAP_TEST_MOTION==="reduce"?"reduce":"no-preference"}]});
  await visitFocus(); await exposePoint();
  const selectedPoint=await point();
  await mouse("mouseMoved",selectedPoint.x,selectedPoint.y);
  const popupHasTooltip=await read(`Boolean(document.querySelector('${tooltip}'))`);
  assert.equal(popupHasTooltip,false,"active popup suppresses pointer tooltip");
  await pointerClick({x:500,y:190});
  await waitFor(()=>read(`!document.querySelector('${popup}')`),"native background click clears selection");
  assert.equal(await read("Boolean(document.querySelector('button.route-rail-route[aria-current=true]'))"),false,'background clear also clears route selection');
  await settle(); await exposePoint();
  // A partial route can have no intact road at the focused visit. Fit the whole
  // scene before probing an actual intact segment; this setup is outside phases.
  await pressKey(client,"m","KeyM"); await settle();
  let road;
  const visibleRoadProbes = async () => read(`document.querySelector('.audit-map').reviewMapRoadProbes().filter(p=>(${partial}?p.id==='77:road:0':true)&&p.x>350&&p.x<innerWidth-60&&p.y>150&&p.y<innerHeight-100&&document.elementFromPoint(p.x,p.y)?.classList.contains('maplibregl-canvas'))`);
  let roadSetupWheelEvents=0;
  for(let attempt=0;attempt<3;attempt++) {
    const probes=await visibleRoadProbes();
    road=probes.find(p=>p.hitId===p.id);
    if(road) break;
    assert.ok(probes.length,"an intact canonical segment is visible before native zoom setup");
    if(attempt<2) { for(let i=0;i<3;i++){await mouse("mouseWheel",probes[0].x,probes[0].y,{deltaX:0,deltaY:-80});await delay(50);roadSetupWheelEvents++;}await settle(); }
  }
  if(!road) {
    mkdirSync(output,{recursive:true});
    const probes=await visibleRoadProbes();
    for(const p of probes)p.native=await read(`document.querySelector('.audit-map').reviewMapHitDiagnostics(${p.x},${p.y})`);
    writeFileSync(resolve(output,'road-hit-failure.json'),JSON.stringify({probes,camera:(await counters()).camera},null,2));
  }
  assert.ok(road,"an actual canonical road hit is reachable without point overlap after bounded untimed setup");
  if(partial) assert.equal(road.id,"77:road:0","hover probes the intact first leg of the same northern route containing the missing visit");
  road.native=await read(`document.querySelector('.audit-map').reviewMapHitDiagnostics(${road.x},${road.y})`);
  observations.roadProbe={...road,setupWheelEvents:roadSetupWheelEvents,camera:await read("document.querySelector('.audit-map').reviewMapCameraDiagnostics()")};
  await mouse("mouseMoved",road.x,road.y);
  await waitFor(()=>read(`Boolean(document.querySelector('${tooltip} .route-leg-tooltip-copy'))`),"native road-leg tooltip, never a nearby point tooltip");
  observations.roadTooltip=await read(`document.querySelector('${tooltip}').textContent`);
  assert.ok(observations.roadTooltip.includes("12 min")&&observations.roadTooltip.includes("Static road estimate"),"road tooltip preserves actual static travel context");
  if(partial) assert.ok(observations.roadTooltip.includes("Fixture North Engineer")&&observations.roadTooltip.includes("Home → Fixture Company T1001"),"correct canonical northern inbound leg endpoints");
  await pointerClick(road);
  await waitFor(()=>read("[...document.querySelectorAll('button.route-rail-route')].find(b=>b.textContent.includes('Fixture North Engineer'))?.getAttribute('aria-current')==='true'"),"native road click selects canonical route");
  await pointerClick({x:500,y:190}); await settle();
  await mouse("mouseMoved",500,190);
  await waitFor(()=>read(`!document.querySelector('${tooltip}')`),"pointer leave removes tooltip");
  observations.backgroundClear=true;
  observations.popupTooltipPolicy="global exclusion asserted";
  await visitFocus(); await pressKey(client,"Escape","Escape"); await settle();
  const p=await exposeDistinct();
  await pointerClick(p); await delay(60); await pointerClick(p,2);

  observations.detailsInput = "native double click";
  await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('T1001')"),"native double click opens exact booked details");
  await settle();
  const modalBefore=await point();
  await client.command("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
  await client.command("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
  await delay(250); const modalAfter=await point();
  assert.ok(Math.hypot(modalAfter.x-modalBefore.x,modalAfter.y-modalBefore.y)<1,"modal owns physical keyboard input");
  await read("document.querySelector('[role=dialog] button[aria-label*=Close]')?.click()");
  await waitFor(()=>read("!document.querySelector('[role=dialog][aria-modal=true]')"),"closed details");
  observations.doubleClickAndModal=true;
  await visitFocus();
  await read("window.__openedTicket=[];window.__originalOpen=window.open;window.open=(...args)=>{window.__openedTicket.push(args);return null}");
  await pressKey(client,"a","KeyA");
  const opened=await read("window.__openedTicket");
  await read("window.open=window.__originalOpen;delete window.__originalOpen");
  assert.equal(opened.length,1); assert.equal(opened[0][0],"https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=1001");
  assert.equal(opened[0][1],"_blank"); assert.equal(opened[0][2],"noopener,noreferrer");
  observations.ticketShortcut="window.open intent captured; no external navigation";
  await read(`document.querySelector('[data-detail-visit-id="${visitId}"]').focus()`);
  const expectedNext=await read(`(()=>{const items=[...document.querySelectorAll('.route-rail-route,[data-detail-visit-id],[data-detail-demand-id]')].filter(b=>b.offsetParent!==null);const next=items[items.indexOf(document.activeElement)+1];return next?.dataset.detailVisitId;})()`);
  assert.ok(expectedNext);
  for(const type of ["keyDown","keyUp"]) await client.command("Input.dispatchKeyEvent",{type,key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
  await waitFor(()=>read(`document.activeElement.dataset.detailVisitId==='${expectedNext}'`),"Tab selects adjacent rail visit");
  for(const type of ["keyDown","keyUp"]) await client.command("Input.dispatchKeyEvent",{type,key:"Tab",code:"Tab",windowsVirtualKeyCode:9,modifiers:8});
  await waitFor(()=>read(`document.activeElement.dataset.detailVisitId==='${visitId}'`),"Shift Tab returns to prior visit");
  observations.tabTraversal=true;
  await pressKey(client,"?","Slash");
  await waitFor(()=>read("Boolean(document.querySelector('#keyboard-shortcuts-title'))"),"keyboard help");
  await read("document.querySelector('[aria-label=\"Close keyboard shortcuts\"]')?.click()");
  await waitFor(()=>read("!document.querySelector('#keyboard-shortcuts-title')"),"keyboard help closes");
  await pressKey(client,"Escape","Escape");
  await clickElement(client,"#map-tool-filters","filters");
  const beforeFilter=await counters();
  await read("[...document.querySelectorAll('[data-keyboard-group=layers] button')].find(b=>b.textContent.trim().startsWith('Open'))?.click()");
  const hiddenOpen=await read("[...document.querySelectorAll('[data-keyboard-group=layers] button')].find(b=>b.textContent.trim().startsWith('Open'))?.getAttribute('aria-pressed')");
  assert.equal(hiddenOpen,"false");
  await clickElement(client,"#map-tool-notifications","issues after hiding open layer");
  await clickElement(client,'[data-notification-item][aria-label="Show T2002 on the map"]',"focus a hidden issue visit");
  await waitFor(()=>read(`Boolean(document.querySelector('${popup}'))`),"hidden selected exception popup");
  observations.hiddenSelectedPopup=await read(`document.querySelector('${popup}').textContent`);
  await clickElement(client,"#map-tool-filters","restore layers");
  assert.equal(await read("[...document.querySelectorAll('[data-keyboard-group=layers] button')].find(b=>b.textContent.trim().startsWith('Open'))?.getAttribute('aria-pressed')"),"false","explicit focus preserves layer choice");
  await read("[...document.querySelectorAll('[data-keyboard-group=layers] button')].find(b=>b.textContent.trim().startsWith('Open'))?.click()");
  await clickElement(client,"#map-tool-filters","close filters");
  assertBulkStable(beforeFilter,await counters(),"filter changes preserve canonical booked facts",["review-booked","review-roads"]);
  await pressKey(client,"Escape","Escape"); await settle();
  const beforeEditable=await point();
  await read("document.querySelector('select[aria-label=\"Suggestion radius\"]').focus()");
  assert.equal(await read("document.activeElement.getAttribute('aria-label')"),"Suggestion radius","visible editable control receives focus");
  await client.command("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
  await client.command("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
  await delay(250);
  const afterEditable=await point();
  assert.ok(Math.hypot(afterEditable.x-beforeEditable.x,afterEditable.y-beforeEditable.y)<1,"editable controls own physical arrow input");
  observations.editableKeyboardOwnership=true;
  await pressKey(client,"Escape","Escape");
  await phase("native-keyboard-rail-details",async()=>{
    // Enter from a real pointer focus on the map, then use physical keys only.
    await pointerClick({x:500,y:190});
    const key=async(key,code=key)=>{for(const type of ['keyDown','keyUp']) await client.command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:key==='Tab'?9:key==='Enter'?13:key==='Escape'?27:0});};
    const trace=[];
    let focused;
    for(let i=0;i<40;i++) {
      await key('Tab'); await delay(80);
      focused=await read("({id:document.activeElement.dataset.detailVisitId,demandId:document.activeElement.dataset.detailDemandId,tag:document.activeElement.tagName,label:document.activeElement.textContent.slice(0,120)})");
      trace.push(focused);
      if(focused.demandId==='d1') {
        await read('window.__demandInitiator=document.activeElement; true');
        await key('Enter');
        await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('Fixture Demand d1')"),'native demand Enter opens demand, never its booked anchor');
        await key('Escape');
        await waitFor(()=>read('document.activeElement===window.__demandInitiator'),'demand detail returns focus to initiating demand control');
        await read('window.__nativeTicketOpen=window.open; window.open=(...args)=>{window.__ticketOpen=args;return null;}; true');
        await key('a','KeyA');
        assert.deepEqual(await read('window.__ticketOpen'),['https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=9001','_blank','noopener,noreferrer'],'native demand A opens its own ticket, never the anchor');
        await read('window.open=window.__nativeTicketOpen; true');
        observations.nativeDemandKeyboard=true;
      }
      if(focused.demandId==='d5') {
        await read('window.__nativeTicketOpen=window.open; window.__ticketOpen=null; window.open=(...args)=>{window.__ticketOpen=args;return null;}; window.__unmappedInitiator=document.activeElement; true');
        await key('a','KeyA');
        assert.equal(await read('window.__ticketOpen'),null,'no ticket ID means no external navigation');
        await read('window.open=window.__nativeTicketOpen; true');
        await key('Enter');
        await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('Fixture Demand d5')"),'unmapped demand remains accessible');
        assert.equal(await read("Boolean(document.querySelector('[role=dialog][aria-modal=true] a[target=_blank]'))"),false,'missing ticket link is not fabricated');
        await key('Escape');
        await waitFor(()=>read('document.activeElement===window.__unmappedInitiator'),'unmapped demand focus restored');
        observations.nativeNoTicketKeyboard=true;
      }
      if(focused.id===visitId) break;
    }
    assert.equal(focused.id,visitId,'native Tab reaches exact booked rail control and selects it');
    assert.equal(observations.nativeDemandKeyboard,true); assert.equal(observations.nativeNoTicketKeyboard,true);
    assert.ok(await read(`document.querySelector('${popup}')?.textContent.includes('T1001')`));
    await read('window.__keyboardInitiator=document.activeElement; true');
    await key('Enter');
    await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('T1001')"),'native Enter opens selected details');
    let link;
    for(let i=0;i<12;i++) {
      link=await read("document.activeElement.tagName==='A'?{href:document.activeElement.href,target:document.activeElement.target}:null");
      if(link)break;
      await key('Tab');
    }
    assert.equal(link?.href,'https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=1001');
    assert.equal(link?.target,'_blank');
    // Link is physically reachable; do not open an external ticket from a test.
    await key('Escape');
    await waitFor(()=>read("!document.querySelector('[role=dialog][aria-modal=true]')"),'native Escape closes details');
    assert.equal(await read('document.activeElement===window.__keyboardInitiator'),true,'details restores initiating rail control');
    await read('window.__nativeTicketOpen=window.open; window.__ticketOpen=null; window.open=(...args)=>{window.__ticketOpen=args;return null;}; true');
    await key('a','KeyA');
    const ticketAction=await read('window.__ticketOpen');
    await read('window.open=window.__nativeTicketOpen; true');
    assert.deepEqual(ticketAction,['https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=1001','_blank','noopener,noreferrer'],'native A invokes the safe ticket action without provider access');
    observations.nativeKeyboard={trace,link,ticketAction,restored:true};
    await key('Escape'); await settle();
  });
  {
    const before=await counters();
    await clickElement(client,"[data-detail-demand-id=d5]","focus unmapped demand for clear-opacity regression");
    await waitFor(()=>read("Array.isArray(document.querySelector('.audit-map').reviewMapPaintDiagnostics()['review-demand-icon']['icon-opacity'])"),"unmapped demand applies contextual opacity");
    await pressKey(client,"Escape","Escape");
    await waitFor(()=>read("document.querySelector('.audit-map').reviewMapPaintDiagnostics()['review-demand-icon']['icon-opacity']===1"),"clearing unmapped demand restores ordinary opacity");
    assertBulkStable(before,await counters(),"unmapped demand clear keeps bulk sources stable");
    observations.unmappedDemandOpacityReset=true;
  }
  await phase("unchanged-304",async()=>{
    const before=await counters(), requests=requestCounts(); const responses=await refresh("unchanged");
    assert.equal(responses.length,2); assert.ok(responses.every(r=>r.code===304&&r.conditional));
    assertBulkStable(before,await counters(),"unchanged ETags");
    assert.equal(requestCounts().geometryPosts,requests.geometryPosts);
  });
  await phase("changed-demand",async()=>{
    const before=await counters(), requests=requestCounts(); const responses=await refresh("demand");
    assert.equal(responses.find(r=>r.kind==="demand").code,200);
    assert.equal(responses.find(r=>r.kind==="schedule").code,304);
    assertBulkStable(before,await counters(),"demand refresh",["review-roads","review-booked","review-homes","review-issues"]);
    if(before.runtime) assert.equal((await counters()).runtime.publications["review-demand"],before.runtime.publications["review-demand"]+1);
    assert.equal(requestCounts().geometryPosts,requests.geometryPosts);
  });
  await phase("changed-schedule-geometry",async()=>{
    const before=await counters(), requests=requestCounts(); const responses=await refresh("schedule");
    assert.equal(responses.find(r=>r.kind==="schedule").code,200);
    await waitFor(()=>requestCounts().geometryPosts===requests.geometryPosts+1,"single changed geometry publication");
    await settle();
    assertBulkStable(before,await counters(),"schedule refresh",["review-demand"]);
    if(before.runtime) assert.ok((await counters()).runtime.publications["review-roads"]>before.runtime.publications["review-roads"]);
  });
  async function sourceIdentity(label) {

    const sources=await read("document.querySelector('.audit-map').reviewMapSourceDiagnostics()");
    for(const source of sources) {
      assert.deepEqual(source.promotedIds,source.ids,`${label}: canonical source identity`);
      assert.ok(source.queriedIds.every(id=>source.ids.includes(id)),`${label}: source query preserves canonical IDs for ${source.source}`);
      assert.ok(source.renderedIds.every(id=>source.ids.includes(id)),`${label}: actual rendered IDs match canonical IDs for ${source.source}`);
      assert.deepEqual(source.states.map(state=>state.id),source.ids,`${label}: feature-state targets match canonical IDs`);
    }
    const bookedStates = new Map(sources.find(s=>s.source==='review-booked').states.map(s=>[s.id,s.reviewOpacity]));
    for (const state of sources.find(s=>s.source==='review-issues').states) {
      assert.equal(state.reviewOpacity,bookedStates.get(state.id.replace(/^issue:/,'visit:')),`${label}: issue body has the same native opacity state as its booked point`);
    }
    observations[label]=sources;
    const paints=await read("document.querySelector('.audit-map').reviewMapPaintDiagnostics()");
    assert.deepEqual(paints['review-issues-icon']['icon-opacity'],paints['review-booked-icon']['icon-opacity'],`${label}: issue context matches booked context`);
    assert.deepEqual(paints['review-suggested-icon']['icon-opacity'],paints['review-demand-icon']['icon-opacity'],`${label}: suggested body follows demand context`);
    observations[`${label}-paints`]=paints;
    const points=await read("document.querySelector('.audit-map').reviewMapPointLayers()");
    for(const point of points) {
      if(point.layer==='review-issues-icon') assert.ok(!points.some(p=>p.id===point.id&&p.layer==='review-booked-icon'),`${label}: issue body drawn once`);
      if(point.layer==='review-suggested-icon') assert.ok(!points.some(p=>p.id===point.id&&p.layer==='review-demand-icon'),`${label}: suggested body drawn once`);
    }
    observations[`${label}-rendered-point-layers`]=points;
  }
  if(partial) {
    await sourceIdentity("partial-road-source-ids");
    {
      const roads=observations["partial-road-source-ids"].find(s=>s.source==="review-roads");
      assert.deepEqual(roads.ids.sort(),["77:road:0","78:road:0","78:road:2"],"missing visit ends northern geometry; unavailable middle road leg remains absent");
      const booked=observations["partial-road-source-ids"].find(s=>s.source==="review-booked");
      assert.ok(!booked.ids.includes(`visit:fixture-${date}-missing`));
    }

    await routeFocus();
    await clickElement(client,`[data-detail-visit-id="fixture-${date}-missing"]`,"unmapped visit in rail");
    await pressKey(client,"Enter","Enter");
    await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('T1003')"),"unmapped visit remains accessible in details");
    await read("document.querySelector('[role=dialog] button[aria-label*=Close]')?.click()");
    await screenshot("stress-partial-roads");
  }
  await phase("overlap-demand-and-booked",async()=>{
    await refresh("overlap"); await visitFocus(); await pressKey(client,"Escape","Escape"); await settle(); await exposePoint();
    const p=await point();
    const demandPoint=await read("(()=>{const p=document.querySelector('.audit-map').reviewMapDiagnostics('demand:d1').firstVisit;return {x:p.left,y:p.top};})()");
    assert.ok(Math.hypot(demandPoint.x-p.x,demandPoint.y-p.y)<1,'true overlap uses the refreshed booked coordinate');
    await pointerClick(p);
    await waitFor(()=>read(`document.querySelector('${popup}')?.textContent.includes('Fixture Demand refreshed')`),"higher-priority demand at booked coordinate");
    await settle();
    await sourceIdentity("selected-demand-source-ids");
    {
      const advisory=observations["selected-demand-source-ids"].find(s=>s.source==="review-advisory");
      assert.equal(advisory.states.find(s=>s.id==="advisory:d1")?.focused,true,"canonical advisory feature state is focused");
      const coincident=advisory.advisoryEndpoints.find(line=>line.id==="advisory:d1");
      assert.equal(coincident.demandId,"d1"); assert.equal(coincident.routeId,"77"); assert.equal(coincident.anchorId,visitId);
      assert.deepEqual(coincident.coordinates[0],coincident.coordinates[1],"coincident suggestion stays zero-length, never displaced for visibility");
    }
    await pressKey(client,"Escape","Escape"); await settle(); await exposePoint();
    const doublePoint=await point();
    await pointerClick(doublePoint); await delay(60); await pointerClick(doublePoint,2);

    await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('Fixture Demand refreshed')"),"double click opens correct demand details");
    await read("document.querySelector('[role=dialog] button[aria-label*=Close]')?.click()");
    await visitFocus();
    assert.ok(await read(`document.querySelector('${popup}').textContent.includes('T1001')`),"overlapped booked visit remains reachable through rail");
    await screenshot("stress-overlap-booked-selected");
    await pressKey(client,"Escape","Escape");
  });
  async function popupAccess(label) {
    const bounds=await read(`(()=>{const popup=document.querySelector('${popup}');const content=popup.querySelector('.maplibregl-popup-content');const p=content.getBoundingClientRect();const chrome=[...document.querySelectorAll('.dispatch-map-tools-tabs,.dispatch-map-tools-panel,.dispatch-map-route-rail')].map(e=>({name:e.className,rect:e.getBoundingClientRect()})).filter(e=>e.rect.width&&e.rect.height);return {popup:{left:p.left,right:p.right,top:p.top,bottom:p.bottom},intersections:chrome.filter(e=>p.left<e.rect.right&&p.right>e.rect.left&&p.top<e.rect.bottom&&p.bottom>e.rect.top).map(e=>e.name)};})()`);
    observations[label]=bounds;

    await screenshot(label);
    assert.deepEqual(bounds.intersections,[],`${label}: popup content clears actual rail, top HUD and tool panel`);
    await read(`document.querySelector('${popup} a[target=_blank]').focus()`);
    const controls=[];
    for(let i=0;i<4;i++) {
      const active=await read(`(()=>{const a=document.activeElement;if(!a.closest('${popup}'))return null;a.scrollIntoView({block:'nearest'});const r=a.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:a.textContent.trim()||a.getAttribute('aria-label'),visible:hit===a||a.contains(hit),tag:a.tagName,close:a.classList.contains('maplibregl-popup-close-button')};})()`);
      assert.ok(active,`${label}: keyboard remains in popup until details`); assert.equal(active.visible,true,`${label}: focused popup control is unobscured`);controls.push(active);
      if(active.close)break;
      for(const type of ["keyDown","keyUp"]) await client.command("Input.dispatchKeyEvent",{type,key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
    }
    assert.ok(controls.some(c=>c.tag==="A"),`${label}: ticket link keyboard accessible`);
    assert.ok(controls.some(c=>c.label==="Open details")); assert.equal(controls.at(-1).close,true); observations[`${label}-controls`]=controls;
    await read("document.querySelector('.audit-map').focus({preventScroll:true})");
  }
  await phase("popup-chrome-access",async()=>{
  await visitFocus();
  for(const width of [1434,1000]) {
    const beforeResize=await counters();
    if(width===1000) await client.command("Emulation.setDeviceMetricsOverride",{width:1000,height:760,deviceScaleFactor:1,mobile:false});
    await delay(500);
    if(beforeResize.runtime) assert.equal((await counters()).runtime.cameraIntents,beforeResize.runtime.cameraIntents,"resize does not replay focus intent");
    await clickElement(client,`[data-detail-visit-id="${visitId}"]`,"explicit focus with current chrome"); await settle();
    await popupAccess(`stress-popup-${width}`);
    const beforeIssues=await counters();
    await clickElement(client,"#map-tool-notifications","open issues beside selected popup"); await delay(500);
    if(beforeIssues.runtime) assert.equal((await counters()).runtime.cameraIntents,beforeIssues.runtime.cameraIntents,"chrome changes do not replay focus intent");
    await clickElement(client,`[data-detail-visit-id="${visitId}"]`,"repeat focus with Issues and rail"); await settle();
    await popupAccess(`stress-popup-${width}-issues`);
    await clickElement(client,"#map-tool-notifications","close issues"); await delay(300);
  }
  await client.command("Emulation.clearDeviceMetricsOverride"); await delay(500);
  });
  // Native camera setup is excluded from all timed phases.
  const distinctSetupBefore=await counters();
    await routeFocus();
    const id=`fixture-${date}-north-2`;
    await clickElement(client,`[data-detail-visit-id="${id}"]`,"focus a second distinct booked identity"); await settle();
    await pressKey(client,"Escape","Escape"); await settle();
    await exposeDistinct(id,"T1002");
    observations.secondVisitPointerPreparation={before:distinctSetupBefore.camera,after:(await counters()).camera,engine};
  await phase("distinct-issue-visit-pointer",async()=>{
    const target=await point(id,"T1002");
    await mouse("mouseMoved",target.x,target.y);
    await waitFor(()=>read(`document.querySelector('${tooltip}')?.textContent.includes('T1002')`),"hover resolves second canonical visit through its issue modifier");
    await pointerClick(target);
    await waitFor(()=>read(`document.querySelector('${popup}')?.textContent.includes('T1002')`),"click selects second canonical visit"); await settle();
    await pointerClick(await point(id,"T1002"),2); // Baseline has no double-click details action.

    await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('T1002')"),"second canonical visit details");
    await read("document.querySelector('[role=dialog] button[aria-label*=Close]')?.click()");
    observations.secondDistinctVisitPointer=true;
  });
  await pressKey(client,"Escape","Escape");
  await clickElement(client,"[data-detail-demand-id=d2]","home suggestion before style change");
  await waitFor(()=>read(`document.querySelector('${popup}')?.textContent.includes('Fixture Demand d2')`),"home suggestion popup"); await settle();
  {
    const before=await counters();
    await clickElement(client,"[data-detail-demand-id=d2]","repeat demand focus"); await settle();
    assert.equal((await counters()).runtime.cameraIntents,before.runtime.cameraIntents+1);
  }
  await sourceIdentity("selected-home-connector-source-ids");
  {
    const connector=observations["selected-home-connector-source-ids"].find(s=>s.source==="review-advisory").advisoryEndpoints.find(line=>line.id==="advisory:d2");
    assert.deepEqual(connector,{id:"advisory:d2",demandId:"d2",routeId:"unbooked-engineer-79",anchorId:"home:unbooked-engineer-79",coordinates:[[-1.201,54.601],[-1.2,54.6]]},"home advisory retains exact demand, route and anchor identity/geometry");
  }
  assert.ok(observations["selected-home-connector-source-ids"].find(s=>s.source==="review-advisory").renderedIds.includes("advisory:d2"),"short home connector has rendered canonical identity at explicit focus zoom");
  // Establish the actual native surface on each step: popup position changes
  // during zoom, so a previously clear fixed coordinate can become popup chrome.
  const nativeSurface=()=>read(`(()=>{const host=document.querySelector('.audit-map');for(const [x,y] of [[500,190],[1100,400],[600,650],[400,500],[1100,650]]){const e=document.elementFromPoint(x,y);if(host.contains(e)&&!e.closest('.maplibregl-popup,.maplibregl-ctrl')&&e.classList.contains('maplibregl-canvas'))return {x,y};}return null;})()`);
  const contextZoom=[];
  for(let i=0;i<10;i++) {
    const camera=await read("document.querySelector('.audit-map').reviewMapCameraDiagnostics()");
    if(camera.zoom<=6.5)break;
    const grip=await nativeSurface();assert.ok(grip,'unobscured native canvas accepts setup input');
    contextZoom.push({camera,grip});
    await mouse('mouseWheel',grip.x,grip.y,{deltaX:0,deltaY:500});await settle();
  }
  for(let i=0;i<3;i++) {
    const p=await read("document.querySelector('.audit-map').reviewMapProject(-1.201,54.601)");
    if(Math.abs(p.x-750)<70 && Math.abs(p.y-450)<70)break;
    const dx=Math.max(-250,Math.min(250,750-p.x)),dy=Math.max(-200,Math.min(200,450-p.y));
    const grip=await nativeSurface();assert.ok(grip);
    await mouse('mouseMoved',grip.x,grip.y);await mouse('mousePressed',grip.x,grip.y,{button:'left',buttons:1,clickCount:1});
    for(let j=1;j<=8;j++)await mouse('mouseMoved',grip.x+dx*j/8,grip.y+dy*j/8,{button:'left',buttons:1});
    await delay(150);
    const releaseTarget=await read(`(()=>{const e=document.elementFromPoint(${grip.x+dx},${grip.y+dy});return {node:e?.nodeName,classes:e?.className,popup:Boolean(e?.closest('.review-libre-popup'))};})()`);
    await mouse('mouseReleased',grip.x+dx,grip.y+dy,{button:'left',buttons:0,clickCount:1});await settle();
    (observations.contextDragReleases??=[]).push({releaseTarget,camera:await read("document.querySelector('.audit-map').reviewMapCameraDiagnostics()")});
  }
  observations.contextZoom=contextZoom;
  {
    const visible=await read("document.querySelector('.audit-map').reviewMapPointLayers()");
    const setup=await read("({camera:document.querySelector('.audit-map').reviewMapCameraDiagnostics(),d1:document.querySelector('.audit-map').reviewMapDiagnostics('demand:d1'),d2:document.querySelector('.audit-map').reviewMapDiagnostics('demand:d2')})");
    writeFileSync(resolve(output,'two-suggestion-setup.json'),JSON.stringify({setup,visible,contextZoom},null,2));
    for(const id of ['d1','d2'])assert.ok(visible.some(p=>p.id===id),'both suggested bodies rendered for contextual comparison');
    const paints=await read("document.querySelector('.audit-map').reviewMapPaintDiagnostics()");
    assert.deepEqual(paints['review-suggested-icon']['icon-opacity'],['case',['==',['get','entityId'],'d2'],1,.4]);
    assert.deepEqual(paints['review-suggested-halo']['circle-opacity'],['case',['==',['get','entityId'],'d2'],.16,.064]);
    const pointStates=(await read("document.querySelector('.audit-map').reviewMapSourceDiagnostics()"))
      .filter(s=>['review-booked','review-issues','review-homes'].includes(s.source)).map(s=>({source:s.source,states:s.states}));
    for (const source of pointStates) for (const state of source.states) {
      assert.equal(state.reviewOpacity,source.source==='review-homes' && state.id==='home:unbooked-engineer-79' ? 1 : .38,"unbooked-home focus dims unrelated context through native state");
    }
    observations.twoSuggestionContext={visible,paints,pointStates};
  }
  await screenshot('stress-two-suggestions-light');
  const imagesBeforeStyle = await read("document.querySelector('.audit-map').reviewMapImageDiagnostics()");
  await clickElement(client,".theme-toggle","dark style");
  await waitFor(()=>read("document.querySelector('.audit-map').dataset.mapStyleReady==='true' && document.documentElement.dataset.theme==='dark'"),"dark style replacement");
  await waitFor(()=>read(`document.querySelector('${popup}')?.textContent.includes('Fixture Demand d2')`),"selected demand survives style replacement");
  await sourceIdentity("restored-style-source-ids");
  {
    assert.deepEqual(observations["restored-style-source-ids-paints"],observations.twoSuggestionContext.paints,"selected-home/demand contextual paints survive style replacement");
    const restored=observations["restored-style-source-ids"].filter(s=>['review-booked','review-issues','review-homes'].includes(s.source)).map(s=>({source:s.source,states:s.states}));
    assert.deepEqual(restored,observations.twoSuggestionContext.pointStates,"all point opacity states survive style replacement, including hidden canonical context");
  }
  await screenshot("stress-two-suggestions-dark");
  {
    const images = await read("document.querySelector('.audit-map').reviewMapImageDiagnostics()");
    assert.ok(images.length >= 4, "style restoration retains actual sprite images");
    for (const image of images) assert.deepEqual(image, imagesBeforeStyle.find(before => before.id === image.id), "restored artwork dimensions/ratio/RGBA hash remain identical");
    for (const key of new Set(images.map(image => image.id.slice(0, image.id.lastIndexOf(":")))))
      for (const tier of ["regional", "city", "street", "detail"]) assert.ok(images.some(image => image.id === `${key}:${tier}`), "all four artwork tiers restored");
    observations.restoredArtwork = images;
  }
  assert.equal(observations["restored-style-source-ids"].find(s=>s.source==="review-advisory").states.find(s=>s.id==="advisory:d2")?.focused,true);
  // The overlap fixture's d1 is exactly coincident; d2 is only 0.001 degrees
  // from home. Overview zoom can quantize either line to zero tile length.
  // Refocus through the real control to prove the nonzero connector survived
  // style replacement at a scale where it has rendered geometry.
  await clickElement(client,"[data-detail-demand-id=d2]","refocus short connector after style replacement"); await settle();
  await sourceIdentity("restored-home-connector-source-ids");
  assert.ok(observations["restored-home-connector-source-ids"].find(s=>s.source==="review-advisory").renderedIds.includes("advisory:d2"),"restored short connector retains actual canonical identity");
  writeFileSync(resolve(output,"stress-observations.json"),JSON.stringify(observations,null,2));
  for(const source of ["review-booked","review-demand","review-homes","review-roads","review-advisory"]) {
    const seen=[...observations["selected-demand-source-ids"],...observations["restored-style-source-ids"],...observations["selected-home-connector-source-ids"],...observations["restored-home-connector-source-ids"]].filter(s=>s.source===source).flatMap(s=>s.renderedIds);
    assert.ok(seen.length,`actual rendered canonical identities observed for ${source} across selected and restored views`);
  }
  await visitFocus(); await screenshot("stress-booked-dark");
  observations.beforeDegradation=await counters();
  {
    // Context-loss teardown is covered by the extended suite; this run checks
    // style failure independently without a retired engine-switch retry path.
    failStyle();
    await clickElement(client,".theme-toggle","failed style replacement");
    await waitFor(()=>read("document.querySelector('.audit-map').dataset.basemap==='unavailable'"),"bounded style failure",24000,100);
    assert.equal((await counters()).canvases,0);
    await read("[...document.querySelectorAll('button.route-rail-route')].find(b=>b.textContent.includes('Fixture North Engineer'))?.click()");
    await clickElement(client,`[data-detail-visit-id="${visitId}"]`,"visit after style failure");
    await pressKey(client,"Enter","Enter");
    await waitFor(()=>read("Boolean(document.querySelector('[role=dialog][aria-modal=true]'))"),"details after style timeout");
    observations.styleFailure=true;
  }
  writeFileSync(resolve(output,"stress-phases.json"),JSON.stringify({engine,phases,observations},null,2)+"\n");
  return {phases,observations};
}
