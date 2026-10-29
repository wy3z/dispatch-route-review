import assert from "node:assert/strict";

/** Additional fixture-only modifier, home, Timeline and shortcut coverage outside timing comparisons. */
export async function checkExtraMap({client,evaluate,clickElement,pressKey,waitFor,delay,date,capture}) {
  const read=code=>evaluate(client,code,"additional fixture parity");
  const popup=".review-libre-popup";
  const popupText=()=>read(`document.querySelector('${popup}')?.textContent||''`);
  const ready=()=>waitFor(()=>read("document.querySelector('.audit-map')?.dataset.mapStyleReady==='true'"),"restored map style");
  const route=async name=>{
    await read("[...document.querySelectorAll('[data-rail-category-trigger]')].filter(b=>b.getAttribute('aria-expanded')==='false').forEach(b=>b.click())");
    assert.equal(await read(`(()=>{const b=[...document.querySelectorAll('button.route-rail-route')].find(b=>b.textContent.includes('${name}'));if(!b)return false;b.click();return true})()`),true);
  };
  const focusVisit=async(id,ticket)=>{await clickElement(client,`[data-detail-visit-id='fixture-${date}-${id}']`,"additional visit");await waitFor(async()=>(await popupText()).includes(ticket),"correct additional popup");await delay(600);};
  const closeDetails=()=>read("document.querySelector('[role=dialog][aria-modal=true] button[aria-label*=Close]')?.click()");
  await pressKey(client,"t","KeyT");await pressKey(client,"t","KeyT");
  await waitFor(()=>read("document.querySelector('main').dataset.routePaneMode==='routes'"),"routes for additional coverage");
  await route("Fixture Midlands Engineer");await focusVisit("midlands-1","T2001");
  assert.ok((await popupText()).includes("Complete"));await capture("complete-visit-light");
  await clickElement(client,".theme-toggle","dark complete visit");await ready();
  assert.ok((await popupText()).includes("T2001"));await capture("complete-visit-dark");
  await clickElement(client,".theme-toggle","restore light");await ready();
  await route("Fixture Third Party");await focusVisit("third-party","T3001");
  assert.ok((await popupText()).includes("Third party"));await capture("third-party-popup");
  await pressKey(client,"Enter","Enter");await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('T3001')"),"third party details");await closeDetails();
  await pressKey(client,"Escape","Escape");await route("Fixture North Engineer");await delay(600);
  const home=()=>read(`(()=>{const p=document.querySelector('.audit-map').reviewMapDiagnostics('home:77').firstVisit;return {x:p.left,y:p.top};})()`);
  const target=await home();
  for(const type of ["mouseMoved","mousePressed","mouseReleased"]) await client.command("Input.dispatchMouseEvent",{type,x:target.x,y:target.y,button:type==="mouseMoved"?"none":"left",buttons:type==="mousePressed"?1:0,clickCount:1});
  await waitFor(async()=>(await popupText()).includes("Fixture North Engineer"),"native home popup");assert.ok((await popupText()).includes("Home base"));await capture("home-popup");
  await pressKey(client,"Escape","Escape");await route("Fixture North Engineer");
  await read("(()=>{const b=[...document.querySelectorAll('[data-rail-category-trigger]')].find(b=>b.textContent.includes('Unassigned'));if(b?.getAttribute('aria-expanded')==='false')b.click()})()");
  await clickElement(client,"[data-detail-demand-id=d4]","overdue maintenance demand");
  await waitFor(async()=>(await popupText()).includes("Outside engineer coverage"),"excluded demand truth");
  assert.ok((await popupText()).includes("Overdue"));assert.ok((await popupText()).includes("Maintenance"));await delay(600);await capture("overdue-maintenance-demand");
  assert.equal(await read("Boolean(document.querySelector('[data-detail-demand-id=d3]'))"),true,"unassigned demand remains selectable without tenant approval rules");
  await clickElement(client,"[data-detail-demand-id=d5]","unmapped demand");await pressKey(client,"Enter","Enter");
  await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('Fixture Demand d5')"),"unmapped demand details");
  assert.equal((await popupText()).includes("Dd5"),false,"unmapped demand creates no fabricated map popup");await closeDetails();
  await pressKey(client,"m","KeyM");await delay(600);
  for(const [key,code,selector] of [["c","KeyC","[data-map-tool-content=date]"],["f","KeyF","[data-map-tool-content=filters]"],["i","KeyI",".dispatch-review-popover-panel"]]){
    await pressKey(client,key,code);await waitFor(()=>read(`Boolean(document.querySelector('${selector}'))`),`${key} opens correct tool`);await pressKey(client,"Escape","Escape");await waitFor(()=>read(`!document.querySelector('${selector}')`),"Escape dismisses tool");
  }
  await read("document.querySelector('.audit-map').focus()");
  const category=async shift=>{for(const type of ["keyDown","keyUp"])await client.command("Input.dispatchKeyEvent",{type,key:shift?"R":"r",code:"KeyR",windowsVirtualKeyCode:82,modifiers:shift?8:0});await delay(100);return read("document.activeElement?.closest('[data-rail-category-trigger]')?.textContent");};
  const next=await category(false),previous=await category(true);assert.ok(next&&previous&&next!==previous,"physical R/Shift+R moves through distinct rail categories");
  await pressKey(client,"t","KeyT");await waitFor(()=>read("Boolean(document.querySelector('.review-timeline-scroll'))"),"Timeline visible");
  await clickElement(client,`.review-timeline-scroll [data-detail-visit-id='fixture-${date}-north-2']`,"Timeline chooses canonical visit");
  await waitFor(async()=>(await popupText()).includes("T1002"),"Timeline selection reaches map");await pressKey(client,"Enter","Enter");
  await waitFor(()=>read("document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('T1002')"),"Timeline selection reaches shared details");await closeDetails();
  return {completePopup:true,thirdPartyPopup:true,homeNativeClick:true,overdueMaintenance:true,unassignedDemandSelectable:true,unmappedDemandDetails:true,toolKeys:["C","F","I","Escape"],categoryKeys:[next,previous],timelineVisit:true};
}
