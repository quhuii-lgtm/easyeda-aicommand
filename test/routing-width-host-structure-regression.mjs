import assert from 'node:assert/strict';
import fs from 'node:fs';
import {register} from 'node:module';
register(`data:text/javascript,${encodeURIComponent("export async function resolve(s,c,n){if(s.startsWith('.')&&!/\\.(ts|js|mjs|json)$/.test(s)){try{return await n(s+'.ts',c)}catch{}}return n(s,c)}")}`,import.meta.url);
const {buildRoutingWidthSnapshot,checkSesWidthRules,compareDsnWidthRules}=await import('../src/engine/routingWidthRules.ts');
const {applyDsnLayerWidthRules}=await import('../src/engine/dsnLayerWidths.ts');
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/routing-width-host-structure.json',import.meta.url)));
const stripVersion=s=>{const x=structuredClone(s);delete x.editorVersion;return x};
for(const input of fixture.cases){
 const snapshot=buildRoutingWidthSnapshot({...input,layers:fixture.layers,netRules:input.netRules??fixture.netRules,editorVersion:fixture.editorVersion});
 assert.equal(snapshot.globalStatus,'known',JSON.stringify(snapshot.unknowns));
 assert.ok(snapshot.nets.every(n=>n.status==='known'),JSON.stringify(snapshot.unknowns));
 const net=(name,id)=>snapshot.nets.find(n=>n.net===name).layers.find(l=>l.layerId===id);
 assert.equal(net('ACE_VIA',1).preferredMil,input.expectedPowerTop);
 assert.equal(net('ACE_VIA',2).preferredMil,30);
 assert.equal(net('+5V',1).preferredMil,30);
 assert.equal(net('+5V',2).preferredMil,15);
 for(const version of ['4.1.78','4.1.93','unknown','future-host','']){
  const same=buildRoutingWidthSnapshot({...input,layers:fixture.layers,netRules:input.netRules??fixture.netRules,editorVersion:version});
  assert.deepEqual(stripVersion(same),stripVersion(snapshot));
 }
 assert.equal(checkSesWidthRules(snapshot,[{net:'+5V',layer:1,widthMil:30},{net:'ACE_VIA',layer:2,widthMil:30}]).status,'compliant');
 assert.equal(checkSesWidthRules(snapshot,[{net:'+5V',layer:1,widthMil:20},{net:'ACE_VIA',layer:2,widthMil:20}]).violations.length,2);
 if(input.expectedDsnError){assert.throws(()=>applyDsnLayerWidthRules(snapshot,input.dsn??fixture.dsn),new RegExp(input.expectedDsnError));continue;}
 const converted=applyDsnLayerWidthRules(snapshot,input.dsn??fixture.dsn);
 assert.equal(converted.changed,true);
 const comparison=compareDsnWidthRules(snapshot,converted.text);
 assert.equal(comparison.status,'matched',JSON.stringify(comparison));
 const repeat=applyDsnLayerWidthRules(snapshot,converted.text);
 assert.equal(repeat.changed,false);
 assert.equal(repeat.text,converted.text);
}
const {pcbCommands}=await import('../src/commands/pcb.ts');
const priorEda=globalThis.eda;
try{
 const source=fixture.cases[0].source;
 globalThis.eda={
  sys_Environment:{getEditorCurrentVersion:()=>fixture.editorVersion},
  dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'3883ab720d203769',documentType:3})},
  sys_FileManager:{getDocumentSource:async()=>source},
  pcb_ManufactureData:{getDsnFile:async()=>new Blob([fixture.dsn])},
  pcb_Layer:{getAllLayers:async()=>fixture.layers},
  pcb_PrimitivePour:{getAll:async()=>[]},pcb_PrimitivePoured:{getAll:async()=>[]},
  pcb_Drc:{getNetRules:async()=>fixture.netRules,getCurrentRuleConfiguration:async()=>({})},
 };
 const result=await pcbCommands.find(c=>c.name==='pcb.exportDsn').handler({applyLayerWidthRules:true,__docUuid:'3883ab720d203769'});
 assert.equal(result.widthRuleComparison.status,'matched',JSON.stringify(result.widthRuleComparison));
 assert.equal(result.conversion.changed,true);
 assert.equal(result.routeBaseline.status,'complete');
}finally{globalThis.eda=priorEda;}
console.log('PASS real-host and labelled derived replay; preferred 20/21; version-independent results; legal/illegal widths; DSN conversion/idempotence; registered export command.');
