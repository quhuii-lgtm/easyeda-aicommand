const fail = message => { throw new Error(message); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
function parse(source,projectMetadata,inspectNativeProject) {
	const inspected = inspectNativeProject({ source, projectMetadata });
	return { docs: inspected.documents.map(doc => ({ ...doc, heads: doc.docHeads })) };
}
const rows = (doc,type) => doc.effectiveRecords.filter(r=>r.header.type===type);
function one(items,label){if(items.length!==1)fail(`${label}: expected one record, found ${items.length}`);return items[0];}
function getDoc(parsed,type,uuid){return one(parsed.docs.filter(d=>d.docType===type&&d.uuid===uuid),`missing ${type} ${uuid}`);}
const canon = doc => JSON.stringify(doc.effectiveRecords.map(r=>({type:r.header.type,id:r.header.id,data:r.data})));
function record(header,data){return `${JSON.stringify(header)}||${JSON.stringify(data)}|`;}
function serializedName(value,label){
	if(value==null||value===''||value==='[]')return null;
	const decoded=typeof value==='string'?JSON.parse(value):value;
	if(!decoded||typeof decoded.uuid!=='string')fail(`${label} is not a serialized resource name`);
	return decoded;
}
function assertOnlyChangedRecords(source,output,changes,allowedPaths,label,cloneJson){
	const before=source.split(/\r?\n/),after=output.split(/\r?\n/); if(after.length<before.length)fail(`${label}: removed source lines`);
	const changed=new Set();
	for(let i=0;i<before.length;i++){
		if(before[i]===after[i])continue;
		const line=i+1, expected=changes.get(line);
		if(!expected)fail(`${label}: unapproved source line changed: ${line}`);
		const sep=before[i].indexOf('||'), outSep=after[i].indexOf('||'); if(sep<0||outSep<0)fail(`${label}: malformed source record at line ${line}`);
		const sourceHeader=JSON.parse(before[i].slice(0,sep)), outputHeader=JSON.parse(after[i].slice(0,outSep));
		if(JSON.stringify(sourceHeader)!==JSON.stringify(expected.header))fail(`${label}: record identity changed at line ${line}`);
		if(JSON.stringify(sourceHeader)!==JSON.stringify(outputHeader))fail(`${label}: record identity changed at line ${line}`);
		const parseData=raw=>{let value=raw.slice(raw.indexOf('||')+2);if(value.endsWith('|'))value=value.slice(0,-1);return JSON.parse(value);};
		const sourceData=parseData(before[i]), outputData=parseData(after[i]), normalized=cloneJson(sourceData);
		const paths=allowedPaths.get(line)??[]; if(!paths.length)fail(`${label}: no explicit allowed fields for changed line ${line}`);
		for(const path of paths){let a=normalized,b=outputData;for(const key of path.slice(0,-1)){a=a[key];b=b?.[key];}if(b?.[path.at(-1)]===undefined)delete a[path.at(-1)];else a[path.at(-1)]=cloneJson(b[path.at(-1)]);}
		if(canonical(normalized)!==canonical(outputData))fail(`${label}: unapproved field changed at line ${line}`);
		if(after[i]!==record(expected.header,expected.data))fail(`${label}: record has unapproved field changes at line ${line}`);
		changed.add(line);
	}
	if(changed.size!==changes.size)fail(`${label}: not every approved record changed exactly once`);
	return {changedLines:[...changed].sort((a,b)=>a-b),preservedSourceLines:before.length-changed.size};
}
function cloneDoc(doc,uuid,mutate,cloneJson){const meta=one(rows(doc,'META'),`${doc.docType} ${doc.uuid} META`);const next=cloneJson(meta.data);mutate(next);return [record({...doc.heads.at(-1).header},{...doc.heads.at(-1).data,uuid}),...doc.rawRecords.map(r=>r.line===meta.line?record(r.header,next):r.raw)];}
function pairs(parsed,w){
	if(!Array.isArray(w.targetUids)||!w.targetUids.length)fail('targetUids must be a non-empty array');
	if(new Set(w.targetUids).size!==w.targetUids.length)fail('targetUids contains duplicate IDs');
	const pcb=getDoc(parsed,'PCB',w.pcbUuid), page=getDoc(parsed,'SCH_PAGE',w.schematicPageUuid), result=[];
	for(const uid of w.targetUids){
		const pc=one(rows(pcb,'COMPONENT').filter(r=>r.data.attrs?.['Unique ID']===uid),`PCB component UID ${uid}`);
		const schUid=rows(page,'ATTR').filter(r=>r.data.key==='Unique ID'&&r.data.value===uid);
		if(!schUid.length)fail(`SCH UID ${uid}: no matching part`);
		const parts=schUid.map(a=>one(rows(page,'COMPONENT').filter(c=>c.header.id===a.data.parentId),`SCH component ${uid}/${a.data.parentId}`));
		if(new Set(parts.map(p=>p.header.id)).size!==parts.length)fail(`SCH UID ${uid}: duplicate part association`);
		const pcbDa=one(rows(pcb,'ATTR').filter(r=>r.data.parentId===pc.header.id&&r.data.key==='Device'),`PCB Device attr ${uid}`), pcbFa=one(rows(pcb,'ATTR').filter(r=>r.data.parentId===pc.header.id&&r.data.key==='Footprint'),`PCB Footprint attr ${uid}`);
		const schParts=parts.map(sc=>({sc,da:one(rows(page,'ATTR').filter(r=>r.data.parentId===sc.header.id&&r.data.key==='Device'),`SCH Device attr ${uid}/${sc.header.id}`),fa:one(rows(page,'ATTR').filter(r=>r.data.parentId===sc.header.id&&r.data.key==='Footprint'),`SCH Footprint attr ${uid}/${sc.header.id}`)}));
		result.push({uid,pc,pcbDa,pcbFa,schParts});
	} return {pcb,page,pairs:result};
}
function checkBindings(p,w){
	const d=getDoc(p,'DEVICE',w.sourceDeviceUuid); const fm=getDoc(p,'FOOTPRINT',w.sourceFootprintUuid);
	if(!Array.isArray(w.equalSourceFootprints)||!w.equalSourceFootprints.length||!w.equalSourceFootprints.includes(w.sourceFootprintUuid))fail('sourceFootprintUuid must be in non-empty equalSourceFootprints');
	const dm=one(rows(d,'META'),'source Device META').data; if(!dm.attributes?.Symbol||!dm.attributes?.Footprint)fail('source Device lacks Symbol/Footprint binding');
	const deviceFootprintName=serializedName(dm.attributes?.FootprintName,`DEVICE ${w.sourceDeviceUuid} FootprintName`);
	if(deviceFootprintName&&deviceFootprintName.uuid!==dm.attributes.Footprint)fail(`source DEVICE FootprintName UUID conflicts with Footprint binding for ${w.sourceDeviceUuid}`);
	const master=canon(fm); for(const uuid of w.equalSourceFootprints)if(canon(getDoc(p,'FOOTPRINT',uuid))!==master)fail(`source footprint ${uuid} differs from master`);
	const linked=pairs(p,w);
	for(const q of linked.pairs){
		if(JSON.parse(q.pc.data.attrs?.DeviceName||'null')?.uuid!==w.sourceDeviceUuid||q.pcbDa.data.value!==w.sourceDeviceUuid)fail(`source PCB Device binding mismatch for ${q.uid}`);
		if(JSON.parse(q.pc.data.attrs?.DeviceName||'null')?.uuid!==w.sourceDeviceUuid)fail(`source PCB DeviceName mismatch for ${q.uid}`);
		if(!w.equalSourceFootprints.includes(q.pcbFa.data.value))fail(`source PCB footprint binding mismatch for ${q.uid}`);
		const pcbFootprintName=serializedName(q.pc.data.attrs?.FootprintName,`PCB COMPONENT ${q.uid} FootprintName`);
		if(pcbFootprintName&&pcbFootprintName.uuid!==q.pcbFa.data.value)fail(`source PCB FootprintName UUID conflicts with Footprint ATTR for ${q.uid}`);
		for(const part of q.schParts){if(JSON.parse(part.sc.data.attrs?.DeviceName||'null')?.uuid!==w.sourceDeviceUuid||part.da.data.value!==w.sourceDeviceUuid)fail(`source SCH Device binding mismatch for ${q.uid}/${part.sc.header.id}`);
			if(part.fa.data.value!=null&&!w.equalSourceFootprints.includes(part.fa.data.value))fail(`source SCH footprint binding mismatch for ${q.uid}/${part.sc.header.id}`);
			const fn=part.sc.data.attrs?.FootprintName; if(fn&&fn!=='[]'&&!w.equalSourceFootprints.includes(JSON.parse(fn).uuid))fail(`source SCH FootprintName mismatch for ${q.uid}/${part.sc.header.id}`);
		}
	}
	return {device:d,footprint:fm,deviceMeta:dm,linked};
}
export function createInstanceResourceAdapter({ JSZip, sha256, inspectNativeProject, cloneJson } = {}) {
	if (!JSZip || typeof JSZip.loadAsync !== 'function') fail('JSZip dependency is required');
	for (const [name,value] of Object.entries({sha256,inspectNativeProject,cloneJson})) if (typeof value !== 'function') fail(`${name} dependency is required`);
function parseWith(source,projectMetadata){return parse(source,projectMetadata,inspectNativeProject);}
async function deriveInstanceResources({sourceBytes,projectText,epruText,workcard,sourceEpru}){
	if(!(sourceBytes instanceof Uint8Array))fail('sourceBytes must be a Uint8Array');
	const archive=await JSZip.loadAsync(sourceBytes), pf=archive.file('project2.json'); if(!pf)fail('source archive missing project2.json');
	if(await pf.async('string')!==projectText)fail('project2 input does not match source archive');
	const projectMetadata=JSON.parse(projectText);
	const sourceHash=await sha256(sourceBytes), steps=[]; const adaptations=workcard.resourceAdaptations??[workcard];
	if(!Array.isArray(adaptations))fail('resourceAdaptations must be an array');
	let currentBytes=new Uint8Array(sourceBytes), currentText=epruText, currentEntry=sourceEpru;
	for(const [index,w] of adaptations.entries()){
		if(!Array.isArray(w?.targetUids)||!w.targetUids.length)fail('targetUids must be a non-empty array');
		if(!w.newDeviceUuid||!w.newFootprintUuid||!w.newDeviceName||!w.newFootprintName)fail('new resource UUIDs and names are required');
		if(new Set([w.newDeviceUuid,w.newFootprintUuid]).size!==2)fail('new Device and Footprint UUIDs must differ');
		const zip=await JSZip.loadAsync(currentBytes), entries=Object.keys(zip.files).filter(n=>n.toLowerCase().endsWith('.epru')&&!zip.files[n].dir);
		const entry=w.sourceEpru??currentEntry; if(!entries.includes(entry))fail(`adaptation ${index}: source EPRU entry missing: ${entry}`);
		const actual=await zip.file(entry).async('string'); if(actual!==currentText)fail(`adaptation ${index}: EPRU text does not match input archive`);
		const inputArchiveSha256=await sha256(currentBytes);
		const p=parseWith(actual,projectMetadata); for(const [type,uuid] of [['DEVICE',w.newDeviceUuid],['FOOTPRINT',w.newFootprintUuid]])if(p.docs.some(d=>d.uuid===uuid))fail(`new ${type} UUID already exists: ${uuid}`);
		const {device,footprint,deviceMeta,linked}=checkBindings(p,w); const changes=new Map(), allowedPaths=new Map(), fields=[];
		const set=(row,path,value)=>{const data=cloneJson(changes.get(row.line)?.data??row.data);let o=data;for(const k of path.slice(0,-1))o=o[k];o[path.at(-1)]=value;changes.set(row.line,{header:row.header,data});const approved=allowedPaths.get(row.line)??[];if(!approved.some(p=>JSON.stringify(p)===JSON.stringify(path)))approved.push([...path]);allowedPaths.set(row.line,approved);fields.push({line:row.line,type:row.header.type,id:row.header.id,field:path.join('.')});};
		const dn=JSON.stringify({name:w.newDeviceName,source:'',uuid:w.newDeviceUuid}), fn=JSON.stringify({name:w.newFootprintName,source:'',uuid:w.newFootprintUuid});
		for(const q of linked.pairs){set(q.pc,['attrs','DeviceName'],dn);if(serializedName(q.pc.data.attrs?.FootprintName,`PCB COMPONENT ${q.uid} FootprintName`))set(q.pc,['attrs','FootprintName'],fn);set(q.pcbDa,['value'],w.newDeviceUuid);set(q.pcbFa,['value'],w.newFootprintUuid);for(const part of q.schParts){set(part.sc,['attrs','DeviceName'],dn);set(part.sc,['attrs','FootprintName'],fn);set(part.da,['value'],w.newDeviceUuid);set(part.fa,['value'],w.newFootprintUuid);}}
		const lines=actual.split(/\r?\n/);for(const [line,v] of changes)lines[line-1]=record(v.header,v.data);
		const outputEol=actual.includes('\r\n')?'\r\n':'\n';
		const fpLines=cloneDoc(footprint,w.newFootprintUuid,m=>{m.title=w.newFootprintName;m.description=`Derived footprint copied from ${w.sourceFootprintUuid}`;m.source='';},cloneJson);
		const devLines=cloneDoc(device,w.newDeviceUuid,m=>{m.title=w.newDeviceName;m.source='';m.attributes={...m.attributes,Footprint:w.newFootprintUuid,FootprintName:fn};},cloneJson);
		const eol=outputEol, outputText=lines.join(eol)+eol+[...fpLines,...devLines].join(eol)+eol;
		const preservation=assertOnlyChangedRecords(actual,outputText,changes,allowedPaths,`adaptation ${index}`,cloneJson);
		const out=parseWith(outputText,projectMetadata), copied=getDoc(out,'FOOTPRINT',w.newFootprintUuid);
		if(copied.effectiveRecords.length!==footprint.effectiveRecords.length||copied.rawRecords.length!==footprint.rawRecords.length)fail(`adaptation ${index}: copied footprint record count differs`);
		for(const row of footprint.effectiveRecords){const next=one(copied.effectiveRecords.filter(r=>r.header.type===row.header.type&&r.header.id===row.header.id),`copied FP record ${row.header.type}/${row.header.id}`);if(row.header.type==='META'){const a={...row.data,title:w.newFootprintName,description:`Derived footprint copied from ${w.sourceFootprintUuid}`,source:''};if(JSON.stringify(a)!==JSON.stringify(next.data))fail(`adaptation ${index}: copied footprint META differs`);}else if(JSON.stringify(row.data)!==JSON.stringify(next.data))fail(`adaptation ${index}: copied footprint data differs ${row.header.type}/${row.header.id}`);}
		const checked={...w,sourceDeviceUuid:w.newDeviceUuid,sourceFootprintUuid:w.newFootprintUuid,equalSourceFootprints:[w.newFootprintUuid]};
		const verified=pairs(out,checked);
		for(const q of verified.pairs){const pcbDn=serializedName(q.pc.data.attrs.DeviceName,`PCB output DeviceName ${q.uid}`);if(q.pcbDa.data.value!==w.newDeviceUuid||q.pcbFa.data.value!==w.newFootprintUuid||pcbDn?.uuid!==w.newDeviceUuid||pcbDn?.name!==w.newDeviceName||pcbDn?.source!=='')fail(`adaptation ${index}: PCB output reference mismatch ${q.uid}`);const pcbFn=serializedName(q.pc.data.attrs?.FootprintName,`PCB output FootprintName ${q.uid}`);if(pcbFn&&(pcbFn.uuid!==w.newFootprintUuid||pcbFn.name!==w.newFootprintName||pcbFn.source!==''))fail(`adaptation ${index}: PCB output FootprintName mismatch ${q.uid}`);for(const part of q.schParts){const schDn=serializedName(part.sc.data.attrs.DeviceName,`SCH output DeviceName ${q.uid}`),schFn=serializedName(part.sc.data.attrs.FootprintName,`SCH output FootprintName ${q.uid}`);if(part.da.data.value!==w.newDeviceUuid||part.fa.data.value!==w.newFootprintUuid||schDn?.uuid!==w.newDeviceUuid||schDn?.name!==w.newDeviceName||schDn?.source!==''||schFn?.uuid!==w.newFootprintUuid||schFn?.name!==w.newFootprintName||schFn?.source!=='')fail(`adaptation ${index}: SCH output reference mismatch ${q.uid}/${part.sc.header.id}`);}}
	const outputDeviceMeta=one(rows(getDoc(out,'DEVICE',w.newDeviceUuid),'META'),`adaptation ${index} output Device META`).data;
	const outputDeviceFpName=serializedName(outputDeviceMeta.attributes?.FootprintName,`DEVICE ${w.newDeviceUuid} FootprintName`);
	if(outputDeviceMeta.attributes.Footprint!==w.newFootprintUuid||outputDeviceFpName?.uuid!==w.newFootprintUuid||outputDeviceFpName?.name!==w.newFootprintName||outputDeviceFpName?.source!=='')fail(`adaptation ${index}: output Device default FootprintName mismatch`);
		const names=Object.keys(zip.files).filter(n=>!zip.files[n].dir); for(const n of names)if(n!==entry){const a=await zip.file(n).async('uint8array');if(n==='project2.json')continue;if(!a)fail(`cannot read ${n}`);}
		zip.file(entry,outputText); const outputBytes=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
		steps.push({index,sourceEpru:entry,inputSha256:inputArchiveSha256,outputSha256:await sha256(outputBytes),sourceEpruSha256:await sha256(actual),outputEpruSha256:await sha256(outputText),targetUids:[...w.targetUids],newDeviceUuid:w.newDeviceUuid,newFootprintUuid:w.newFootprintUuid,changedRecords:changes.size,changedFields:fields,approvedFieldPaths:['PCB COMPONENT.attrs.DeviceName','PCB COMPONENT.attrs.FootprintName (when present)','PCB ATTR(Device).value','PCB ATTR(Footprint).value','SCH COMPONENT.attrs.DeviceName','SCH COMPONENT.attrs.FootprintName','SCH ATTR(Device).value','SCH ATTR(Footprint).value'],preservation});
		currentBytes=outputBytes;currentText=outputText;currentEntry=entry;
	}
	return {outputBytes:currentBytes,outputText:currentText,proof:{sourceSha256:sourceHash,sourceEpruSha256:await sha256(epruText),adaptationCount:steps.length,resourceAdaptations:steps,resourceReferenceMetadataChanged:steps.length>0,physicalGeometryChanged:false,electricalNetsChanged:false,sourceArchiveUnmodified:true,external3dPayloadValidated:false}};
}
function parseInstanceResources(source,projectMetadata){return parseWith(source,projectMetadata);}
return {deriveInstanceResources,parseInstanceResources};
}
