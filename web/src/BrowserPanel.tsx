import { useEffect, useRef, useState } from 'react';
import { api, browserApi, type BrowserProfile, type BrowserTab } from './api';
import type { AgentPreset } from './types';
import { ErrorText, Field, Modal } from './ui';
import { t } from './i18n';
import './browser.css';

function errorText(error: unknown) {
 const text = error instanceof Error ? error.message : String(error);
 if(text==='BROWSER_START_FAILED')return t('browser.startFailed');
 if(text==='BROWSER_RUNNING_LIMIT')return t('browser.limit');
 if(text==='BROWSER_TAKE_CONTROL')return t('browser.takeRequired');
 return t('browser.error',{error:text});
}
export default function Browsers({compact=false}:{compact?:boolean}) {
 const [profiles,setProfiles]=useState<BrowserProfile[]>([]),[agents,setAgents]=useState<AgentPreset[]>([]);
 const [installed,setInstalled]=useState(true),[error,setError]=useState<string|null>(null);
 const [editing,setEditing]=useState<BrowserProfile|'new'|null>(null),[selected,setSelected]=useState<BrowserProfile|null>(null);
 const [name,setName]=useState(''),[ids,setIds]=useState<string[]>([]),[busy,setBusy]=useState(false);
 const refresh=()=>browserApi.profiles().then(r=>{setProfiles(r.profiles);setInstalled(r.installed);}).catch(e=>setError(errorText(e)));
 useEffect(()=>{void refresh();api.agents().then(r=>setAgents(r.agents)).catch(e=>setError(errorText(e)));},[]);
 async function save(){setBusy(true);setError(null);try{if(editing==='new')await browserApi.create(name,ids);else if(editing)await browserApi.update(editing.id,name,ids);setEditing(null);await refresh();}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 return <section className="browser-profiles">
  {!compact&&<><h1>{t('browser.title')}</h1><p>{t('browser.intro')}</p></>}
  <ErrorText error={error}/>
  {!installed&&<p role="alert">{t('browser.install')} <a href="https://github.com/IgnitionAI/cogitator/blob/dev/docs/browsers.md" target="_blank" rel="noreferrer">{t('browser.guide')}</a></p>}
  {!compact&&<button className="btn btn-primary" onClick={()=>{setEditing('new');setName('');setIds([]);}}>{t('browser.create')}</button>}
  {!profiles.length&&<p>{t(compact?'browser.noProfiles':'browser.empty')}</p>}
  <div className="browser-profile-grid">{profiles.map(p=><article className="browser-profile-card" key={p.id}>
   <h3>{p.name}</h3><p>{t(p.running?'browser.running':'browser.stopped')}</p>
   <p>{p.agentIds.map(id=>agents.find(a=>a.id===id)?.name??id).join(', ')||t('browser.none')}</p>
   <div className="toolbar"><button className="btn btn-primary" disabled={!installed} onClick={()=>setSelected(p)}>{t('browser.open')}</button>
   {!compact&&<button className="btn" onClick={()=>{setEditing(p);setName(p.name);setIds(p.agentIds);}}>{t('browser.edit')}</button>}
   {p.running&&<button className="btn" onClick={()=>void browserApi.stop(p.id).then(refresh).catch(e=>setError(errorText(e)))}>{t('browser.stop')}</button>}</div>
  </article>)}</div>
  {editing&&<Modal title={t(editing==='new'?'browser.create':'browser.edit')} onClose={()=>{if(!busy)setEditing(null);}}>
   <ErrorText error={error}/><Field label={t('browser.name')}><input value={name} maxLength={60} onChange={e=>setName(e.target.value)}/></Field>
   <fieldset><legend>{t('browser.agents')}</legend>{agents.map(a=><label className="browser-agent-option" key={a.id}><input type="checkbox" checked={ids.includes(a.id)} onChange={e=>setIds(e.target.checked?[...ids,a.id]:ids.filter(id=>id!==a.id))}/>{a.name}</label>)}</fieldset>
   <button className="btn btn-primary" disabled={busy||!name.trim()} onClick={()=>void save()}>{t('browser.save')}</button>
  </Modal>}
  {selected&&<Modal wide title={selected.name} onClose={()=>{setSelected(null);void refresh();}}><BrowserView profile={selected}/></Modal>}
 </section>;
}
export function BrowserView({profile}:{profile:BrowserProfile}) {
 const [tabs,setTabs]=useState<BrowserTab[]>([]),[tabId,setTabId]=useState(''),[url,setUrl]=useState('');
 const [human,setHuman]=useState(profile.humanControl),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const [frame,setFrame]=useState(''),[status,setStatus]=useState<'connecting'|'ready'|'disconnected'>('connecting'),[retry,setRetry]=useState(0);
 const socket=useRef<WebSocket|null>(null),image=useRef<HTMLImageElement>(null),surface=useRef<HTMLDivElement>(null);
 const queue=useRef<string[]>([]),pending=useRef(false),latestFrame=useRef('');
 const applyTabs=(next:BrowserTab[])=>{setTabs(next);setTabId(current=>next.some(t=>t.id===current)?current:next.at(-1)?.id??'');};
 useEffect(()=>{let live=true;const refresh=()=>browserApi.tabs(profile.id).then(r=>{if(live)applyTabs(r.tabs);}).catch(e=>{if(live)setError(errorText(e));});void refresh();const timer=setInterval(refresh,2000);return()=>{live=false;clearInterval(timer);};},[profile.id]);
 useEffect(()=>{setUrl(tabs.find(t=>t.id===tabId)?.url??'');},[tabId,tabs.map(t=>t.url).join('\n')]);
 useEffect(()=>{
  if(!tabId)return;
  setFrame('');setStatus('connecting');queue.current=[];pending.current=false;
  const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/browser/view/${profile.id}/${tabId}`);socket.current=ws;ws.binaryType='blob';
  const drain=()=>{if(!pending.current&&queue.current.length&&ws.readyState===WebSocket.OPEN){pending.current=true;ws.send(queue.current.shift()!);}};
  ws.onmessage=e=>{if(e.data instanceof Blob){const next=URL.createObjectURL(e.data);if(latestFrame.current)URL.revokeObjectURL(latestFrame.current);latestFrame.current=next;setFrame(next);setStatus('ready');return;}
   try{const data=JSON.parse(String(e.data));if(data.type==='state')setHuman(data.humanControl);if(data.type==='ack'||data.type==='error'){pending.current=false;if(data.type==='error'){queue.current=[];setError(errorText(data.error));}drain();}}catch{/* Ignore malformed transport frames. */}};
  ws.onclose=()=>{setStatus('disconnected');queue.current=[];pending.current=false;};
  ws.onerror=()=>setStatus('disconnected');
  return()=>{ws.onclose=null;ws.onmessage=null;ws.onerror=null;ws.close();if(latestFrame.current)URL.revokeObjectURL(latestFrame.current);latestFrame.current='';socket.current=null;};
 },[profile.id,tabId,retry]);
 function send(command:Record<string,unknown>){if(!human||socket.current?.readyState!==WebSocket.OPEN)return;const msg=JSON.stringify(command);if(pending.current){if(queue.current.length<100)queue.current.push(msg);return;}pending.current=true;socket.current.send(msg);}
 async function act(action:string,extra:Record<string,unknown>={}){setBusy(true);setError(null);try{const result=await browserApi.action(profile.id,{action,...(tabId?{tabId}:{}),...extra});applyTabs(result.tabs);if(action==='open')setTabId(result.tabs.at(-1)?.id??'');}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 async function control(){setBusy(true);setError(null);try{const r=await browserApi.control(profile.id,!human);setHuman(r.humanControl);queue.current=[];}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 return <div className="browser-view">
  <div className="toolbar"><strong role="status">{t(human?'browser.human':'browser.agent')}</strong><button className="btn btn-primary" disabled={busy} onClick={()=>void control()}>{t(human?'browser.release':'browser.take')}</button><button className="btn" onClick={()=>void surface.current?.requestFullscreen().catch(e=>setError(errorText(e)))}>{t('browser.fullscreen')}</button></div>
  <ErrorText error={error}/>
  <div className="toolbar browser-navigation"><button className="btn" disabled={!tabId||!human||busy} onClick={()=>void act('back')}>{t('browser.back')}</button><button className="btn" disabled={!tabId||!human||busy} onClick={()=>void act('forward')}>{t('browser.forward')}</button><button className="btn" disabled={!tabId||!human||busy} onClick={()=>void act('reload')}>{t('browser.reload')}</button>
   <input aria-label={t('browser.url')} value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&human&&!busy)void act(tabId?'navigate':'open',{url});}}/>
   <button className="btn" disabled={!human||busy||!url} onClick={()=>void act(tabId?'navigate':'open',{url})}>{t('browser.go')}</button><button className="btn" disabled={!human||busy||!url} onClick={()=>void act('open',{url})}>{t('browser.new')}</button>
  </div>
  <div className="browser-tabs" role="tablist" aria-label={t('browser.tabs')}>{tabs.map(tab=><button className="btn" role="tab" aria-selected={tab.id===tabId} key={tab.id} onClick={()=>setTabId(tab.id)}>{tab.title||t('browser.untitled')}</button>)}{tabId&&<button className="btn" disabled={!human||busy} onClick={()=>void act('close')}>{t('browser.closeTab')}</button>}</div>
  {!tabId?<p>{t('browser.noTab')}</p>:<>
   {status!=='ready'&&<p role="status">{t(status==='connecting'?'browser.connecting':'browser.disconnected')} {status==='disconnected'&&<button className="btn" onClick={()=>setRetry(r=>r+1)}>{t('browser.reconnect')}</button>}</p>}
   <div ref={surface} className="browser-surface" role="application" aria-label={t('browser.view')} tabIndex={0}
    onPointerDown={e=>{if(!human||!image.current)return;e.currentTarget.focus({preventScroll:true});const r=image.current.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;if(x>=0&&x<=1&&y>=0&&y<=1)send({action:'click',x,y});}}
    onWheel={e=>{if(human){e.preventDefault();send({action:'scroll',delta:Math.max(-2000,Math.min(2000,e.deltaY))});}}}
    onPaste={e=>{e.preventDefault();send({action:'type',text:e.clipboardData.getData('text').slice(0,16000)});}}
    onKeyDown={e=>{if(!human)return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='v')return;e.preventDefault();if(e.key.length===1&&!e.metaKey&&!e.ctrlKey&&!e.altKey)send({action:'type',text:e.key});else if(!['Meta','Control','Alt','Shift'].includes(e.key))send({action:'press',key:[e.ctrlKey||e.metaKey?'Control':'',e.altKey?'Alt':'',e.shiftKey?'Shift':'',e.key===' '?'Space':e.key].filter(Boolean).join('+')});}}>
    {frame&&<img ref={image} src={frame} alt={t('browser.view')} draggable={false}/>}
   </div><p className="muted">{t('browser.keyboard')}</p>
  </>}
 </div>;
}
