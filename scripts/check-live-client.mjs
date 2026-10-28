const base='http://127.0.0.1:19387'
const r=await fetch(base+'/plugins/events',{signal:AbortSignal.timeout(5000)})
const reader=r.body.getReader(),decoder=new TextDecoder()
let text='',graph
while(!graph){const c=await reader.read();if(c.done)break;text+=decoder.decode(c.value,{stream:true});for(const block of text.split('\n\n')){const line=block.split('\n').find(l=>l.startsWith('data: '));if(line){const d=JSON.parse(line.slice(6));if(d.type==='graph')graph=d.graph}}}
await reader.cancel()
const row=graph?.entries.find(e=>e.id==='dsh-mode-widget')
if(!row)throw Error('Widget absent from live client graph')
const code=await fetch(base+'/'+row.url).then(r=>r.text())
const registeredId=/id:\s*['"]dsh-mode-widget['"]/.test(code.slice(code.indexOf("name: 'conversation.input.left'")))
console.log(JSON.stringify({clientGraphRev:graph.rev,bundleRev:row.rev,hasListRegistrationId:registeredId,bundleBytes:Buffer.byteLength(code),hasCoreV2Protocol:code.includes('EXPECTED_PROTOCOL = 2'),hasStreamEpochFence:code.includes('streamEpoch && d.planEpoch !== streamEpoch'),hasTransportRevisionFence:code.includes('state.planRevision !== requestRevision')}))
const diag=await fetch(base+'/dsh-mode/diag').then(r=>r.json())
console.log(JSON.stringify({lastMount:diag.lastDiag,runtime:diag.runtime||null,restartRequired:diag.runtime?.protocolVersion!==2||diag.runtime?.coreBuild!=='session-core-v2-20261028'}))
