import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const state = { calls: [], input: null, backend: null, result: null, imports: [], task: 0, current: null, widthStatus: 'compliant' }
const plugins = [{ name: 'kirouting-command-mocks', setup(build) {
	const mocks = new Map([
		['../engine/tasks', `export function beginTask(cmd, params){ return {task:{id:'task-'+(++globalThis.__kr.task),cmd,state:'running',progress:{}},existing:false} } export function finishTask(t,r){t.state='done';t.result=r} export function failTask(t,e){t.state='error';t.error=String(e?.message??e)}`],
		['../engine/documentRecovery', `export function compareDocumentSources(a,b){return {equal:a===b,difference:a===b?null:'source changed'}}`],
		['../engine/autoRouteSesHost', `export async function readRouteSnapshot(){ return globalThis.__kr.current }`],
		['../engine/routingWidthRules', `export function buildRoutingWidthSnapshot(){return {globalStatus:'known'}} export function checkSesWidthRules(){return {status:globalThis.__kr.widthStatus}}`],
		['../bridge/client', `export function getBridgeInstanceId(){return 'instance-A'}`],
		['../bridge/kirouting', `export async function kiRoutingRequest(action,params){globalThis.__kr.calls.push({action,params}); return await globalThis.__kr.backend(action,params)}`],
		['../pcb/kiroutingInput', `export async function collectKiRoutingInput(){return globalThis.__kr.input}`],
		['../engine/registry', `export async function executeCommand(req){globalThis.__kr.imports.push(req); return {ok:true,data:{sesGeometryVerified:true}}}`],
		['../engine/autoRouteSes', `export function parseAutoRouteSes(s){return {wires:[...s.matchAll(/\\(wire /g)],vias:[...s.matchAll(/\\(via /g)]}} export function mapSesRoutes(p,l){return {lines:globalThis.__kr.result.lines.map(x=>({...x,layerName:'TopLayer'})),vias:globalThis.__kr.result.vias.map(x=>({...x,layerStart:'TopLayer',layerEnd:'BottomLayer'}))}}`],
	])
	build.onResolve({filter:/^\.\.\//}, args => mocks.has(args.path) ? {path:args.path,namespace:'kr-mock'} : undefined)
	build.onLoad({filter:/.*/,namespace:'kr-mock'}, args => ({contents:mocks.get(args.path),loader:'js'}))
}}]
const bundle = await build({entryPoints:['src/commands/kirouting.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins})
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const defs = Object.fromEntries(mod.kiRoutingCommands.map(d=>[d.name,d]))
const realSesBundle = await build({entryPoints:['src/engine/autoRouteSes.ts'],bundle:true,platform:'node',format:'esm',write:false})
const realSes = await import(`data:text/javascript;base64,${Buffer.from(realSesBundle.outputFiles[0].text+'\n//# sourceURL=kirouting-real-ses-regression.mjs').toString('base64')}`)
let focus = {documentType:3,uuid:'doc-A',tabId:'tab-A'}
const source = 'stable-source'
globalThis.__kr = state
globalThis.eda = {
	dmt_SelectControl:{getCurrentDocumentInfo:async()=>({...focus})},
	sys_FileManager:{getDocumentSource:async()=>source},
	sys_ClientUrl:{request:async()=>({ok:true,json:async()=>({ok:true,data:{}})})},
	pcb_Drc:{getNetRules:async()=>[]},sys_Environment:{getEditorCurrentVersion:()=> 'test'},
}
const context = {documentTarget:{uuid:'doc-A',parentProjectUuid:'proj-A',tabId:'tab-A'},assertDocumentTarget:async()=>{if(focus.uuid!=='doc-A')throw new Error('target changed')},onProgress:()=>{}}
const target = {instanceId:'instance-A',projectUuid:'proj-A',documentUuid:'doc-A',tabId:'tab-A'}
const input = {schemaVersion:1,units:'mil',target,inputDigest:'digest-A',coverage:{complete:true,unsupported:[]},ruleEvidence:{trackWidth:{status:'known',mil:10,source:'fixture'},globalClearance:{status:'known',mil:6,source:'fixture'},boardEdgeClearance:{status:'known',mil:12,source:'fixture'}},baseline:{source,documentUuid:'doc-A',projectUuid:'proj-A',tabId:'tab-A'},nets:[{name:'N1',pads:[]}],board:{layers:[{id:1,name:'TopLayer',enabled:true},{id:2,name:'BottomLayer',enabled:true}]}}
state.input=input
state.current={documentUuid:'doc-A',source,layers:[{id:1,name:'TopLayer',type:'SIGNAL',layerStatus:1},{id:2,name:'BottomLayer',type:'SIGNAL',layerStatus:1}],lines:[],vias:[],arcs:[]}
state.backend=async(action,params)=>{
	if(action==='info')return {ok:true,data:{runtimeReady:true,supportedModes:['single'],modeInputSchema:{single:{fields:[{key:'nets',type:'array',required:true}]}}}}
	if(action==='start')return {ok:true,data:{operationId:params.operationId,jobId:'job-'+params.operationId,state:'queued'}}
	if(action==='result')return {ok:true,data:{state:'completed',format:'kirouting-json',result:state.result}}
	if(action==='list')return {ok:true,data:{jobs:[{operationId:'op-a',target},{operationId:'op-other',target:{...target,documentUuid:'doc-B'}}]}}
	return {ok:true,data:{state:'queued'}}
}
let testCount=0
const test=async(name,fn)=>{await fn();testCount++;console.log(`PASS ${name}`)}

await test('start requires declared mode schema, preserves explicit keep-input setting, and registers operation before POST',async()=>{
	const response=await defs['pcb.kiRoutingStart'].handler({operationId:'op-a',settings:{mode:'single',keep_input_copper:true,nets:['N1']}},context)
	assert.equal(response.jobId,'job-op-a')
	const start=state.calls.find(x=>x.action==='start')
	assert.equal(start.params.operationId,'op-a')
	assert.equal(start.params.settings.keep_input_copper,true)
	assert.equal(start.params.settings.ruleEvidence.trackWidth.mil,10)
	assert.equal(start.params.input.inputDigest,'digest-A')
	await assert.rejects(defs['pcb.kiRoutingStart'].handler({operationId:'op-b',settings:{mode:'differential',keep_input_copper:true}},context),/未声明支持/)
	await assert.rejects(defs['pcb.kiRoutingStart'].handler({operationId:'op-c',settings:{mode:'single',keep_input_copper:false,nets:['N1']}},context),/keep_input_copper:true/)
})

await test('target-scoped list filters foreign PCB jobs',async()=>{
	const response=await defs['pcb.kiRoutingList'].handler({},context)
	assert.deepEqual(response.jobs.map(x=>x.operationId),['op-a'])
})

await test('wrong live PCB target rejects start before contacting backend',async()=>{
	const priorCalls=state.calls.length
	focus={...focus,uuid:'doc-B'}
	await assert.rejects(defs['pcb.kiRoutingStart'].handler({operationId:'wrong-target',settings:{mode:'single',keep_input_copper:true}},context),/target changed/)
	assert.equal(state.calls.length,priorCalls)
	focus={documentType:3,uuid:'doc-A',tabId:'tab-A'}
})

await test('response loss returns partial with operationId and is never blindly re-submitted',async()=>{
	state.backend=async(action,params)=>action==='info'?{ok:true,data:{runtimeReady:true,supportedModes:['single'],modeInputSchema:{single:{fields:[{key:'nets',type:'array'}]}}}}:action==='start'?{ok:false,error:{message:'transport timeout',partial:true,outcome:'unknown',details:{operationId:params.operationId}}}:{ok:true,data:{state:'running',operationId:params.operationId,jobId:'recovered'}}
	await assert.rejects(defs['pcb.kiRoutingStart'].handler({operationId:'op-loss',settings:{mode:'single',keep_input_copper:true}},context),e=>e.cause?.partial===true&&e.cause?.operationId==='op-loss')
	const startCount=state.calls.filter(x=>x.action==='start'&&x.params.operationId==='op-loss').length
	await defs['pcb.kiRoutingStatus'].handler({operationId:'op-loss'},context)
	assert.equal(state.calls.filter(x=>x.action==='start'&&x.params.operationId==='op-loss').length,startCount)
})

await test('import rejects stale target, wrong nets/layers, and copper removal before append importer',async()=>{
	state.backend=async(action,params)=>action==='result'?{ok:true,data:{state:'completed',format:'kirouting-json',result:state.result}}:{ok:true,data:{runtimeReady:true,supportedModes:['single']}}
	const valid={schemaVersion:1,units:'mil',target,inputDigest:'digest-A',existingCopperPreserved:true,removedInputCopper:[],coverage:{complete:true,unsupported:[]},lines:[{net:'N1',layer:1,widthMil:10,a:{x:0,y:0},b:{x:20,y:0}}],vias:[]}
	state.result={...valid,lines:[{...valid.lines[0],net:'FOREIGN'}]}
	await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-a',dryRun:true},context),/不存在的网络/)
	state.result={...valid,lines:[{...valid.lines[0],layer:99}]}
	await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-a',dryRun:true},context),/未知或未启用 SIGNAL 层/)
	state.current={...state.current,source:'mutated-after-routing'}
	state.result=valid
	await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-a',dryRun:true},context),/源码发生变化/)
	state.current={...state.current,source}
	state.result={...valid,removedInputCopper:[{id:'old'}]}
	await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-a',dryRun:true},context),/报告移除输入铜/)
	state.result={...valid,lines:[{...valid.lines[0],layer:1,widthMil:4}]}
	state.widthStatus='noncompliant'
	await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-a',dryRun:true},context),/当前 EDA 规则确认/)
	state.widthStatus='compliant'
	state.result={...valid,modeMetrics:{lengthMatch:{skewMil:13.315,toleranceMil:5,withinTolerance:false}}}
	await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-a',dryRun:true},context),/明确报告未达到/)
	assert.equal(state.imports.length,0)
})

await test('KiRouting short SES segments reject dryRun and import before dispatch; one mil and longer pass',async()=>{
	state.current={...state.current,source}
	const base={schemaVersion:1,units:'mil',target,inputDigest:'digest-A',existingCopperPreserved:true,removedInputCopper:[],coverage:{complete:true,unsupported:[]},vias:[]}
	state.result={...base,lines:[
		{net:'N1',layer:1,widthMil:10,a:{x:0,y:0},b:{x:0.5,y:0}},
		{net:'N1',layer:1,widthMil:10,a:{x:1,y:0},b:{x:1.999,y:0}},
	]}
	const importsBefore=state.imports.length, tasksBefore=state.task, sourceBefore=state.current.source
	for(const dryRun of [true,false]){
		await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-a',dryRun},context),error=>{
			assert.match(error.message,/2 条短线段.*最短 0\.5 mil.*导入下限 1 mil.*结果未写入/)
			assert.equal(error.cause.shortSegments.length,2)
			assert.deepEqual(error.cause.shortSegments.map(segment=>[segment.lineIndex,segment.net,segment.layer,Math.round(segment.lengthMil*1e6)/1e6]),[[1,'N1',1,0.5],[2,'N1',1,0.999]])
			assert.deepEqual(error.cause.shortSegments[0].a,{x:0,y:0})
			assert.deepEqual(error.cause.shortSegments[0].b,{x:0.5,y:0})
			return true
		})
	}
	assert.equal(state.imports.length,importsBefore,'short route rejection never dispatches SES import')
	assert.equal(state.task,tasksBefore,'short route rejection happens before task creation')
	assert.equal(state.current.source,sourceBefore,'short route rejection leaves the PCB source unchanged')
	state.result={...base,lines:[{net:'N1',layer:1,widthMil:10,a:{x:0,y:0},b:{x:1,y:0}}]}
	assert.equal((await defs['pcb.importKiRoutingResult'].handler({operationId:'op-a',dryRun:true},context)).dryRun,true,'exactly one mil remains accepted')
	state.result={...base,lines:[{net:'N1',layer:1,widthMil:10,a:{x:0,y:0},b:{x:1.001,y:0}}]}
	assert.equal((await defs['pcb.importKiRoutingResult'].handler({operationId:'op-a',dryRun:true},context)).dryRun,true,'segments longer than one mil remain accepted')
	assert.equal(state.imports.length,importsBefore,'accepted dryRun still does not dispatch SES import')
	assert.equal(state.current.source,sourceBefore,'accepted dryRun leaves the PCB source unchanged')
})

await test('distinct via drill sizes create separate padstacks and repeated write is blocked',async()=>{
	state.current.layers=[{id:1,name:'Top Layer',type:'SIGNAL',layerStatus:1},{id:2,name:'Bottom Layer',type:'SIGNAL',layerStatus:1},{id:15,name:'Inner 1',type:'SIGNAL',layerStatus:1},{id:46,name:'Inactive Inner 32',type:'SIGNAL',layerStatus:0}]
	state.backend=async(action,params)=>action==='info'?{ok:true,data:{runtimeReady:true,supportedModes:['single'],modeInputSchema:{single:{fields:[{key:'nets',type:'array'}]}}}}:action==='start'?{ok:true,data:{operationId:params.operationId,jobId:'job-via',state:'queued'}}:action==='result'?{ok:true,data:{state:'completed',format:'kirouting-json',result:state.result}}:{ok:true,data:{state:'queued'}}
	await defs['pcb.kiRoutingStart'].handler({operationId:'op-via',settings:{mode:'single',keep_input_copper:true,nets:['N1']}},context)
	state.result={schemaVersion:1,units:'mil',target,inputDigest:'digest-A',existingCopperPreserved:true,removedInputCopper:[],coverage:{complete:true,unsupported:[]},lines:[{net:'N1',layer:1,widthMil:10,a:{x:0,y:0},b:{x:20,y:0}}],vias:[{net:'N1',x:20,y:10,diameterMil:24,holeDiameterMil:10,viaType:'through'},{net:'N1',x:40,y:10,diameterMil:24,holeDiameterMil:12,viaType:'through'}]}
	const out=await defs['pcb.importKiRoutingResult'].handler({operationId:'op-via',dryRun:false},context)
	assert.equal(out.imported,true)
	const ses=Buffer.from(state.imports.at(-1).params.base64,'base64').toString('utf8')
	assert.equal((ses.match(/\(padstack /g)||[]).length,2)
	const actualMapped=realSes.mapSesRoutes(realSes.parseAutoRouteSes(ses),state.current.layers)
	assert.equal(actualMapped.lines.length,1)
	assert.equal(actualMapped.vias.length,2)
	assert.equal(actualMapped.sesLayerNamesById[1],'TopLayer')
	assert.equal(actualMapped.sesLayerNamesById[2],'BottomLayer')
	assert.ok(actualMapped.vias.every(via=>via.viaType==='through'))
	const withHoles=realSes.applySesViaHoleDiameters(actualMapped,state.imports.at(-1).params.viaHoleDiametersMil)
	assert.deepEqual(withHoles.vias.map(via=>via.holeDiameterMil),[10,12])
	assert.throws(()=>realSes.mapSesRoutes(realSes.parseAutoRouteSes(ses.replace('(path "TopLayer"','(path "Top Layer"')),state.current.layers),/多个 SES 层名/)
	await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-via',dryRun:false},context),/已导入/)
	await defs['pcb.kiRoutingStart'].handler({operationId:'op-blind',settings:{mode:'single',keep_input_copper:true,nets:['N1']}},context)
	state.result={schemaVersion:1,units:'mil',target,inputDigest:'digest-A',existingCopperPreserved:true,removedInputCopper:[],coverage:{complete:true,unsupported:[]},lines:[{net:'N1',layer:1,widthMil:10,a:{x:0,y:0},b:{x:20,y:0}}],vias:[{net:'N1',x:20,y:10,diameterMil:24,holeDiameterMil:10,viaType:'blind'}]}
	await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-blind',dryRun:true},context),/不是当前导入链/)
	state.result={...state.result,vias:[{net:'N1',x:20,y:10,diameterMil:24,holeDiameterMil:10,viaType:'through',startLayer:1,endLayer:15}]}
	await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-blind',dryRun:true},context),/起止层/)
	for(const span of [{viaSpan:[1,46]},{startLayer:1},{viaSpan:[1,2],via_span:[1,15],startLayer:1,endLayer:2}]){
		state.result={...state.result,vias:[{net:'N1',x:20,y:10,diameterMil:24,holeDiameterMil:10,viaType:'through',...span}]}
		await assert.rejects(defs['pcb.importKiRoutingResult'].handler({operationId:'op-blind',dryRun:true},context),/跨层|起止层/)
	}
	state.result={...state.result,vias:[{net:'N1',x:20,y:10,diameterMil:24,holeDiameterMil:10,viaType:'through',viaSpan:[1,2],via_span:[1,2],startLayer:1,endLayer:2}]}
	assert.equal((await defs['pcb.importKiRoutingResult'].handler({operationId:'op-blind',dryRun:true},context)).dryRun,true)
})

console.log(`KiRouting command regressions passed: ${testCount}`)
