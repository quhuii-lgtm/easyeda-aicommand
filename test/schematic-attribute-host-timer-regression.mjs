import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'
const built = buildSync({stdin:{contents:"export { schematicCommands } from '../src/commands/schematic.ts'",resolveDir:resolve(import.meta.dirname),sourcefile:'attribute-timer-entry.ts'},bundle:true,platform:'node',format:'esm',write:false})
const { schematicCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const setAttribute = schematicCommands.find(c => c.name === 'schematic.setAttribute').handler
const params = {primitiveId:'component-test',key:'Value',value:'new'}
function harness(mode='ok') {
 let writes=0, reads=0, value='old', callback
 globalThis.eda={
  sch_PrimitiveAttribute:{
   getAllPrimitiveId:async()=>['attribute-test'],
   get:async ids=>{
    if(Array.isArray(ids)) return mode==='missing'?[]:[{getState_Key:()=> 'Value',getState_PrimitiveId:()=> 'attribute-test'}]
    reads++
    if(mode==='read-error') throw Error('read failed')
    if(mode==='empty') return undefined
    return {getState_Value:()=>mode==='stale'?'old':value}
   },
   modify:async()=>{writes++;value=params.value;if(mode==='modify-error')throw Error('applied then rejected');if(mode==='pending')await new Promise(()=>{})},
  },
  sys_Timer:{setTimeoutTimer:(_id,delay,fn)=>{assert.equal(delay,300);callback=fn;if(mode==='timer-error')return false;if(mode!=='late')queueMicrotask(fn);return true}},
 }
 return {get writes(){return writes},get reads(){return reads},release:()=>callback()}
}
test('host timer succeeds even when ordinary timers are not dispatched',async()=>{
 const h=harness();const original=globalThis.setTimeout
 try {globalThis.setTimeout=()=>0;const r=await setAttribute(params);assert.equal(r.readback.verified,true);assert.equal(h.writes,1)}finally{globalThis.setTimeout=original}
})
for(const mode of ['modify-error','timer-error','read-error','empty','stale'])test(mode+' is partial with no repeat write',async()=>{
 const h=harness(mode);await assert.rejects(setAttribute(params),e=>e.cause?.partial===true);assert.equal(h.writes,1)
})
test('invalid input and absent attribute perform no writes',async()=>{
 const h=harness('missing');await assert.rejects(setAttribute({...params,value:3}));await assert.rejects(setAttribute(params));assert.equal(h.writes,0)
})
test('pending SDK mutation does not proceed to readback',async()=>{
 const h=harness('pending');let settled=false;void setAttribute(params).finally(()=>settled=true)
 for(let i=0;i<10;i++)await Promise.resolve()
 assert.equal(h.writes,1);assert.equal(h.reads,0);assert.equal(settled,false)
})
test('late host timer completes the original call without another mutation',async()=>{
 const h=harness('late');const pending=setAttribute(params)
 for(let i=0;i<10;i++)await Promise.resolve()
 assert.equal(h.writes,1);assert.equal(h.reads,0);h.release();assert.equal((await pending).readback.verified,true);assert.equal(h.writes,1)
})
