import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'
const built=buildSync({stdin:{contents:"export { schematicCommands } from '../src/commands/schematic.ts'",resolveDir:resolve(import.meta.dirname),sourcefile:'wire-host-entry.ts'},bundle:true,platform:'node',format:'esm',write:false})
const {schematicCommands}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const draw=schematicCommands.find(c=>c.name==='schematic.drawWire').handler
const label=(id,parentId,value='',extra={})=>({id,parentId,key:'NET',value,x:0,y:0,rotation:null,color:null,zIndex:2,...extra})
const wire=(id,paths,net='')=>({id,paths,net,color:null,width:null,type:null,zIndex:0,attrs:[label('net-'+id,id,net)]})
function harness(initial=[],onWrite=()=>{},mode={}) {
 const wires=new Map(structuredClone(initial).map(w=>[w.id,w]));let calls=0
 const component={x:100,y:100};const extra=[]
 const sdk=w=>({getState_PrimitiveId:()=>w.id,getState_Line:()=>w.paths,getState_Net:()=>w.net,getState_Color:()=>w.color,getState_LineWidth:()=>w.width,getState_LineType:()=>w.type})
 const source=()=>{
  let ticket=0;const rows=[];const add=(type,id,data)=>rows.push(JSON.stringify({type,id,ticket:++ticket})+'||'+JSON.stringify(data))
  add('DOCHEAD','doc',{docType:'SCH_PAGE',uuid:'page-test'});add('COMPONENT','component-test',component)
  for(const w of wires.values()) {
   add('WIRE',w.id,{zIndex:w.zIndex,...w.properties})
   w.paths.forEach((p,i)=>add('LINE','line-'+w.id+'-'+i,{lineGroup:w.id,startX:p[0],startY:-p[1],endX:p[2],endY:-p[3],strokeColor:w.sourceColor??w.color,strokeWidth:w.width,strokeStyle:w.type===null?null:['SOLID','SHORT_DASH','DOT'][w.type]}))
   for(const a of w.attrs){const {id,...d}=a;add('ATTR',id,d)}
  }
  for(const r of extra)add(r.type,r.id,r.data)
  return rows.join('\n')
 }
 globalThis.eda={dmt_SelectControl:{getCurrentDocumentInfo:async()=>({documentType:1,uuid:'page-test'})},sys_FileManager:{getDocumentSource:async()=>source()},sch_PrimitiveAttribute:{getAll:async()=>[]},sch_PrimitiveWire:{
  getAll:async()=>[...wires.values()].map(sdk),
  create:async(path,net,color,width,type)=>{
   calls++;let result
   if(mode.extend){result=wires.get(mode.extend);result.paths.push(path)}
   else{result=wire('new-'+calls,[path],net??'');result.color=color??null;result.width=width??null;result.type=type??null;wires.set(result.id,result)}
   onWrite({wires,result,component,extra,calls});return sdk(result)
  },
 }}
 return {wires,get calls(){return calls}}
}
async function fails(h,params={points:[[10,0],[20,0]]}){await assert.rejects(draw(params),e=>e.cause?.partial===true);assert.equal(h.calls,1)}
test('independent wire uses explicit null default styles',async()=>{const h=harness();assert.equal((await draw({points:[[0,0],[10,0]]})).segments,1);assert.equal(h.calls,1)})
test('existing point is preserved while drawing elsewhere',async()=>{const h=harness([wire('point',[[50,50,50,50]])]);await draw({points:[[0,0],[10,0]]});assert.equal(h.calls,1)})
test('zero-length new request is rejected without writing',async()=>{const h=harness();await assert.rejects(draw({points:[[0,0],[0,0]]}));assert.equal(h.calls,0)})
test('extension recreates empty automatic label and rotates anchor',async()=>{const h=harness([wire('old',[[0,0,10,0]])],({result,calls})=>{result.attrs=[label('replacement-'+calls,'old','',{rotation:90,x:20,fontWeight:false})]},{extend:'old'});await draw({points:[[10,0],[20,0],[20,10]]});assert.equal(h.calls,2)})
test('same net survives host merge with duplicate labels and new wire ID',async()=>{const h=harness([wire('old',[[0,0,10,0]],'SIG')],({wires,result})=>{const old=wires.get('old');wires.delete('old');result.paths.unshift(...old.paths);result.net='SIG';result.attrs=[label('copy-a',result.id,'SIG'),label('copy-b',result.id,'SIG')];result.zIndex=9});await draw({points:[[10,0],[20,0]]});assert.equal(h.calls,1)})
test('T branch preserves the old geometry',async()=>{const h=harness([wire('old',[[0,0,20,0]])],()=>{},{extend:'old'});await draw({points:[[10,0],[10,10]]});assert.equal(h.calls,1)})
test('unrelated wire display indices may be reassigned',async()=>{const h=harness([wire('far',[[50,50,60,50]])],({wires})=>{wires.get('far').zIndex=7;wires.get('far').attrs[0].zIndex=9});const r=await draw({points:[[0,0],[10,0]]});assert.equal(h.calls,1);assert.equal(r.drawingOrderChanges[0].after,9)})
for(const [name,mutate]of Object.entries({
 'moved point':({wires})=>wires.get('point').paths=[[51,50,51,50]],
 'point replaced by nonzero segment':({wires})=>wires.get('point').paths=[[49,50,51,50]],
 'point style changed':({wires})=>wires.get('point').width=1,
}))test(name+' is rejected',async()=>{await fails(harness([wire('point',[[50,50,50,50]])],mutate))})
for(const [name,mutate]of Object.entries({
 'source SDK style mismatch':({result})=>{result.sourceColor='#123456'},
 'missing style getter':({result})=>{result.type=undefined},
 'conflicting names':({result})=>{result.attrs=[label('a',result.id,'A'),label('b',result.id,'B')];result.net='A'},
 'unexpected name in both source and SDK':({result})=>{result.attrs[0].value='UNREQUESTED';result.net='UNREQUESTED'},
 'wrong label parent':({result})=>{result.attrs[0].parentId='absent'},
 'invalid display index':({result})=>{result.attrs[0].zIndex=1.5},
 'invalid rotation':({result})=>{result.attrs[0].rotation='bad'},
 'orphan new attribute':({extra})=>extra.push({type:'ATTR',id:'orphan',data:{parentId:'absent',key:'NET',value:''}}),
 'unrelated component moved':({component})=>{component.x++},
}))test(name+' is rejected after exactly one write',async()=>{await fails(harness([],mutate))})
for(const field of ['value','parentId','x','rotation','color'])test('unrelated label '+field+' change rejected',async()=>{await fails(harness([wire('far',[[50,50,60,50]])],({wires})=>{wires.get('far').attrs[0][field]=field==='x'||field==='rotation'?90:'changed'}))})
test('merge does not skip unrelated component preservation',async()=>{await fails(harness([wire('old',[[0,0,10,0]])],({wires,result,component})=>{result.paths.unshift(...wires.get('old').paths);wires.delete('old');component.x++}))})
test('non-display WIRE property must be inherited',async()=>{const old=wire('old',[[0,0,10,0]]);old.properties={locked:false};await fails(harness([old],({result})=>{result.properties={locked:true}},{extend:'old'}))})
