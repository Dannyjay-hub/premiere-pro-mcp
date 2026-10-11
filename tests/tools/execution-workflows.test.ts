import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getExecutionWorkflowTools } from "../../src/tools/execution-workflows.js";
import { guardToolHandler, resolveCapabilities } from "../../src/security/capabilities.js";
import { getExportTools } from "../../src/tools/export.js";
import { withInvocationContext } from "../../src/workflows/invocation-context.js";
import { resetWorkflowJobs } from "../../src/workflows/job-contract.js";
vi.mock("../../src/bridge/file-bridge.js", () => ({sendCommand:vi.fn().mockResolvedValue({success:true,data:{reasons:[],sequenceId:"seq"}}),getTempDir:()=>"/tmp/test"}));
import { sendCommand } from "../../src/bridge/file-bridge.js";

let folder: string;
let outputCounter = 0;
beforeEach(()=> {folder=mkdtempSync(join(tmpdir(),"mcp-execution-"));outputCounter=0;vi.mocked(sendCommand).mockReset().mockResolvedValue({success:true,data:{reasons:[],sequenceId:"seq"}});});
afterEach(()=> {rmSync(folder,{recursive:true,force:true});resetWorkflowJobs();});
const definition=(handler: any, properties: Record<string,unknown>={}, required: string[]=[]) => ({description:"Test registered operation",parameters:{type:"object",properties,required},handler});
const string={type:"string"};
function catalog() {
  return {
    inspect_media_streams: {...definition(vi.fn().mockResolvedValue({success:true,data:{streams:[{codec_type:"video",color_transfer:"bt709",color_range:"tv",color_primaries:"bt709"}]}}),{media_path:string}),operationalCapability:{backends:["local"] as const}},
    read_video_scopes: {...definition(vi.fn().mockResolvedValue({success:true,data:{sample:1}}),{media_path:string,time_seconds:{type:"number"}}),operationalCapability:{backends:["local"] as const}},
    validate_project_for_export: definition(vi.fn().mockResolvedValue({success:true,data:{readyForExport:true,summary:{sequenceId:"seq",projectDocumentId:"project",projectPath:"/project.prproj"}}}),{output_path:string,preset_path:string}),
    export_sequence: definition(vi.fn(async (args: {output_path:string})=>{writeFileSync(args.output_path,"native rendered fixture");return {success:true,data:{outputPath:args.output_path,range:"entire",expectedDurationSeconds:1}};}),{output_path:string,preset_path:string,range:string,timeout_minutes:{type:"number"}}),
    verify_delivery_file: definition(vi.fn(getExportTools({}).verify_delivery_file.handler),{output_path:string}),
    verify_delivery_conformance: definition(vi.fn().mockResolvedValue({success:true,data:{conforms:true}}),{output_path:string,width:{type:"integer"},minimum_video_bitrate_kbps:{type:"number"},maximum_video_bitrate_kbps:{type:"number"}}),
    analyze_video_qc: definition(vi.fn().mockResolvedValue({success:true,data:{passes:true}}),{media_path:string}),
    generate_media_contact_sheet: definition(vi.fn(async (args:{media_path:string;output_path:string})=>{writeFileSync(args.output_path,"new contact sheet");return {success:true,data:{created:true,outputPath:args.output_path,mediaPath:args.media_path}};}),{media_path:string,output_path:string}),
    trim_clip: definition(vi.fn(),{clip_id:string},["clip_id"]),
  };
}
function setup(values=catalog(),capabilities=resolveCapabilities(),uxpBridge?:any) {return {values,tools:getExecutionWorkflowTools({}, {getToolCatalog:()=>values as any,capabilities,uxpBridge})};}
function exportArgs() {const preset=join(folder,"preset.epr");writeFileSync(preset,"<Preset/>" );return {output_path:join(folder,`output-${++outputCounter}.mp4`),preset_path:preset,contract:{width:1920},decoded_qc:true};}
function reviewArgs() {const before=join(folder,"before.mp4"),after=join(folder,"after.mp4");writeFileSync(before,"before rendered fixture");writeFileSync(after,"after rendered fixture");return {before_video:before,after_video:after,before_sheet:join(folder,"before.png"),after_sheet:join(folder,"after.png"),operation_revision:"r1"};}

describe("exact invocation preflight",()=>{
  it("validates schema and authority without ever calling proposed handler",async()=>{
    const {tools,values}=setup();
    expect((await tools.can_execute.handler({tool_name:"missing",arguments:{}})).data).toMatchObject({enabled:false,reasons:[{code:"TOOL_UNAVAILABLE"}]});
    const result=await tools.can_execute.handler({tool_name:"trim_clip",arguments:{clip_id:"clip",typo:1}});expect(result.data).toMatchObject({enabled:false});expect(values.trim_clip.handler).not.toHaveBeenCalled();expect(sendCommand).not.toHaveBeenCalled();
    const narrow=setup(values,resolveCapabilities("inspect"));expect((await narrow.tools.can_execute.handler({tool_name:"trim_clip",arguments:{clip_id:"clip"}})).data?.reasons.map(reason=>reason.code)).toContain("AUTHORITY_DENIED");
  });
  it("returns named live target refusal and bounded state evidence",async()=>{
    vi.mocked(sendCommand).mockResolvedValue({success:true,data:{reasons:[{code:"TRACK_LOCKED",detail:"Locked"}],sequenceId:"seq"}});
    const {tools}=setup();const result=await tools.can_execute.handler({tool_name:"trim_clip",arguments:{clip_id:'clip"\n'},expected_sequence_id:"seq",expected_project_path:"/project.prproj"});expect(result.data).toMatchObject({enabled:false,dispatchRevalidationRequired:true});expect(result.data?.reasons).toEqual([{code:"TRACK_LOCKED",detail:"Locked"}]);
    const script=vi.mocked(sendCommand).mock.calls[0][0];expect(script).toContain("SELECTION_MISSING");expect(script).toContain("SOURCE_OFFLINE");expect(script).toContain("clip\\\"\\n");
    vi.mocked(sendCommand).mockResolvedValue({success:false,error:"offline bridge"});expect((await tools.can_execute.handler({tool_name:"trim_clip",arguments:{clip_id:"c"}})).data?.reasons[0].code).toBe("BACKEND_UNAVAILABLE");
  });
  it("local prerequisites are distinct from unproven UXP action predicates",async()=>{
    const values=catalog();const {tools}=setup(values);const media=join(folder,"source.mp4");writeFileSync(media,"fixture");expect((await tools.can_execute.handler({tool_name:"inspect_media_streams",arguments:{media_path:media}})).data?.enabled).toBe(true);expect((await tools.can_execute.handler({tool_name:"inspect_media_streams",arguments:{media_path:"missing"}})).data?.enabled).toBe(false);
    const bridge={getState:()=>({connected:true}),refreshCapabilities:vi.fn().mockResolvedValue(true),request:vi.fn().mockResolvedValue({project:{id:"p"}})};
    const uxp=setup({...values,mutate_uxp:definition(vi.fn())} as any,resolveCapabilities(),bridge);expect((await uxp.tools.can_execute.handler({tool_name:"mutate_uxp",arguments:{}})).data?.reasons[0].code).toBe("ACTION_PREFLIGHT_REQUIRED");
    bridge.request.mockRejectedValue(Error("state inaccessible"));expect((await uxp.tools.can_execute.handler({tool_name:"mutate_uxp",arguments:{}})).data?.reasons.map(reason=>reason.code)).toContain("HOST_STATE_UNKNOWN");
  });
  it("never inspects preset files after schema refusal or without filesystem authority",async()=>{
    const preset=join(folder,"private.epr");writeFileSync(preset,"");
    const values={get_project_info:definition(vi.fn()),get_export_file_extension:definition(vi.fn(),{preset_path:string})};
    const narrow=getExecutionWorkflowTools({}, {getToolCatalog:()=>values as any,capabilities:resolveCapabilities("inspect")});
    const guarded=guardToolHandler("can_execute",narrow.can_execute.handler,resolveCapabilities("inspect"));
    const invalid=await guarded({tool_name:"get_project_info",arguments:{preset_path:preset}});
    expect(invalid.data?.reasons.map(reason=>reason.code)).toEqual(["INVALID_ARGUMENT"]);
    const denied=await guarded({tool_name:"get_export_file_extension",arguments:{preset_path:preset}});
    expect(denied.data?.reasons.map(reason=>reason.code)).toEqual(["AUTHORITY_DENIED"]);
    expect(sendCommand).not.toHaveBeenCalled();
    const allowed=getExecutionWorkflowTools({}, {getToolCatalog:()=>values as any});
    expect((await allowed.can_execute.handler({tool_name:"get_export_file_extension",arguments:{preset_path:preset}})).data?.reasons.map(reason=>reason.code)).toContain("EXPORT_PRESET_INVALID");
  });
});
describe("export evidence composition",()=>{
  it("validates exact fresh artifact and every declared check",async()=>{
    const {tools,values}=setup();const result=await tools.export_and_verify.handler(exportArgs());expect(result).toMatchObject({success:true,data:{outcome:"verified",renderVerified:false}});expect(values.verify_delivery_conformance.handler).toHaveBeenCalledWith(expect.objectContaining({width:1920}));
    values.verify_delivery_conformance.handler.mockResolvedValue({success:true,data:{conforms:false}});expect(await tools.export_and_verify.handler(exportArgs())).toMatchObject({success:false,data:{outcome:"committed_unverified"}});
    values.verify_delivery_conformance.handler.mockResolvedValue({success:true,data:{conforms:true}});values.analyze_video_qc.handler.mockResolvedValue({success:true,data:{passes:false}});expect(await tools.export_and_verify.handler(exportArgs())).toMatchObject({success:false});
  });
  it("refuses malformed or contradictory delivery contracts before render",async()=>{
    const {tools,values}=setup(); const args=exportArgs();
    for(const contract of [{}, {width:-1}, {minimum_video_bitrate_kbps:20,maximum_video_bitrate_kbps:10}, {typo:1}, {output_path:"different"}]) expect((await tools.export_and_verify.handler({...args,contract})).success).toBe(false);
    expect(values.export_sequence.handler).not.toHaveBeenCalled();
    writeFileSync(args.output_path,"older delivery");expect((await tools.export_and_verify.handler(args)).error).toContain("OUTPUT_NOT_NEW");
    const denied=setup(values,resolveCapabilities("inspect"));expect((await denied.tools.export_and_verify.handler({...args,output_path:join(folder,"new.mp4")})).error).toContain("AUTHORITY_DENIED");
  });
  it("retains failed preflight, unknown render, changed target and partial artifacts",async()=>{
    const {tools,values}=setup();const args=exportArgs();
    values.validate_project_for_export.handler.mockResolvedValue({success:true,data:{readyForExport:false}});expect(await tools.export_and_verify.handler(args)).toMatchObject({success:false,data:{dispatched:false,outcome:"not_applied"}});expect(values.export_sequence.handler).not.toHaveBeenCalled();
    values.validate_project_for_export.handler.mockResolvedValue({success:true,data:{readyForExport:true,summary:{sequenceId:"seq",projectDocumentId:"project",projectPath:"/project.prproj"}}});values.export_sequence.handler.mockResolvedValue({success:false,error:"lost reply"});expect(await tools.export_and_verify.handler(args)).toMatchObject({success:false,data:{outcome:"unknown",recoveryRequired:true}});
    values.export_sequence.handler.mockResolvedValue({success:true,data:{outputPath:"/another.mp4"}});expect(await tools.export_and_verify.handler(args)).toMatchObject({success:false,error:expect.stringContaining("OUTPUT_IDENTITY_CHANGED")});
  });
  it("makes before/after sheets without overwriting or exaggerating still proof",async()=>{
    const {tools,values}=setup();const args=reviewArgs();expect(await tools.build_edit_review_evidence.handler(args)).toMatchObject({success:true,data:{renderVerified:false,operationRevision:"r1"}});expect(values.generate_media_contact_sheet.handler).toHaveBeenCalledTimes(2);expect(existsSync(args.before_sheet)).toBe(true);expect(existsSync(args.after_sheet)).toBe(true);
    values.generate_media_contact_sheet.handler.mockResolvedValue({success:false,error:"decode error"});expect(await tools.build_edit_review_evidence.handler({...args,before_sheet:join(folder,"failed-before.png"),after_sheet:join(folder,"failed-after.png")})).toMatchObject({success:false,data:{outcome:"committed_unverified"}});
    expect((await tools.build_edit_review_evidence.handler({...args,after_sheet:args.before_sheet})).error).toContain("REVIEW_OUTPUT_EXISTS");
  });
  it("decoded output scopes carry both metadata and declared color domains",async()=>{
    const {tools}=setup();const file=join(folder,"render.mp4");writeFileSync(file,"fixture");const result=await tools.inspect_rendered_video_scopes.handler({output_path:file,color_transfer:"bt709"});expect(result).toMatchObject({success:true,data:{legalRangeVerified:false,hdrVerified:false,color:{encodedMetadata:{transfer:"bt709"}}}});
    expect((await tools.inspect_rendered_video_scopes.handler({output_path:folder})).error).toContain("OUTPUT_INVALID");
  });
  it.each(["conformance", "decoded_qc"])("refuses a delivery replaced during %s instead of combining its checks with the earlier checksum",async(stage)=>{
    const {tools,values}=setup();const args=exportArgs();
    const mutate=async()=>{writeFileSync(args.output_path,"replacement artifact");return {success:true,data:stage==="conformance" ? {conforms:true}:{passes:true}};};
    if(stage==="conformance") values.verify_delivery_conformance.handler.mockImplementationOnce(mutate);else values.analyze_video_qc.handler.mockImplementationOnce(mutate);
    expect(await tools.export_and_verify.handler(args)).toMatchObject({success:false,error:expect.stringContaining("ARTIFACT_SOURCE_CHANGED"),data:{outcome:"committed_unverified"}});
  });
  it("rejects an unrelated checksum receipt even when all other checks pass",async()=>{
    const {tools,values}=setup();values.verify_delivery_file.handler.mockResolvedValue({success:true,data:{valid:true,checksum:{algorithm:"sha256",value:"0".repeat(64)}}});
    expect(await tools.export_and_verify.handler(exportArgs())).toMatchObject({success:false,error:expect.stringContaining("ARTIFACT_CHECKSUM_CHANGED"),data:{outcome:"committed_unverified"}});
  });
  it("detects same-size source changes with restored mtime while making a review grid",async()=>{
    const {tools,values}=setup();const args=reviewArgs();const oldDate=new Date("2010-01-01T00:00:00Z");utimesSync(args.before_video,oldDate,oldDate);
    const initial=statSync(args.before_video);
    values.generate_media_contact_sheet.handler.mockImplementationOnce(async({media_path,output_path})=>{writeFileSync(media_path,"x".repeat(initial.size));utimesSync(media_path,oldDate,oldDate);writeFileSync(output_path,"grid from replacement");return {success:true,data:{created:true}};});
    expect(await tools.build_edit_review_evidence.handler(args)).toMatchObject({success:false,error:expect.stringContaining("ARTIFACT_SOURCE_CHANGED"),data:{outcome:"committed_unverified"}});
    expect(statSync(args.before_video).size).toBe(initial.size);expect(statSync(args.before_video).mtimeMs).toBe(initial.mtimeMs);expect(existsSync(args.before_sheet)).toBe(false);
  });
  it("rechecks the before source after processing the after source",async()=>{
    const {tools,values}=setup();const args=reviewArgs();const original=values.generate_media_contact_sheet.handler.getMockImplementation()!;
    values.generate_media_contact_sheet.handler.mockImplementation(async(input)=>{if(input.media_path===args.after_video)writeFileSync(args.before_video,"changed during after phase");return original(input);});
    expect(await tools.build_edit_review_evidence.handler(args)).toMatchObject({success:false,error:expect.stringContaining("ARTIFACT_SOURCE_CHANGED"),data:{outcome:"committed_unverified"}});
  });
  it("preserves a concurrently created contact-sheet destination and cleans owned staging",async()=>{
    const {tools,values}=setup();const args=reviewArgs();const original=values.generate_media_contact_sheet.handler.getMockImplementation()!;
    values.generate_media_contact_sheet.handler.mockImplementationOnce(async(input)=>{writeFileSync(args.before_sheet,"unrelated destination");return original(input);});
    expect(await tools.build_edit_review_evidence.handler(args)).toMatchObject({success:false,error:expect.stringContaining("EEXIST"),data:{outcome:"committed_unverified"}});
    expect(readFileSync(args.before_sheet,"utf8")).toBe("unrelated destination");expect(readdirSync(folder).some(name=>name.startsWith(".mcp-review-"))).toBe(false);
  });
  it("does not finish verified when the published before sheet changes during the after phase",async()=>{
    const {tools,values}=setup();const args=reviewArgs();const original=values.generate_media_contact_sheet.handler.getMockImplementation()!;
    values.generate_media_contact_sheet.handler.mockImplementation(async(input)=>{if(input.media_path===args.after_video)writeFileSync(args.before_sheet,"replacement grid");return original(input);});
    expect(await tools.build_edit_review_evidence.handler(args)).toMatchObject({success:false,error:expect.stringContaining("REVIEW_PUBLICATION_CHANGED"),data:{outcome:"committed_unverified",steps:[{phase:"before",published:true},{phase:"after",published:true}]}});
    expect(readFileSync(args.before_sheet,"utf8")).toBe("replacement grid");
  });
});
describe("local/native job observation",()=>{
  it("starts local-only analysis, waits, cancels and handles missing receipts",async()=>{
    const {tools}=setup();const start=await tools.start_local_analysis_job.handler({tool_name:"read_video_scopes",arguments:{media_path:"fixture"}});const id=(start.data as any).id;await new Promise(resolve=>setImmediate(resolve));expect(await tools.wait_workflow_job.handler({origin:"local",job_id:id,timeout_ms:0})).toMatchObject({success:true,data:{job:{state:"completed",outputVerified:false}}});expect((await tools.inspect_workflow_job.handler({origin:"local",job_id:id})).success).toBe(true);expect((await tools.cancel_workflow_job.handler({job_id:id})).success).toBe(true);
    expect((await tools.inspect_workflow_job.handler({origin:"local",job_id:"missing"})).success).toBe(false);expect((await tools.wait_workflow_job.handler({origin:"local",job_id:id,timeout_ms:-1})).success).toBe(false);expect((await tools.start_local_analysis_job.handler({tool_name:"export_sequence",arguments:{}})).success).toBe(false);
    expect((await tools.get_operation_performance.handler()).success).toBe(true);
  });
  it("native waits preserve exact identity and output boundary",async()=>{
    const bridge={request:vi.fn().mockResolvedValue({job:{jobId:"one",nativeJobId:"native-1",correlationVerified:true,state:"completed",terminal:true,progress:1}})};const {tools}=setup(undefined,resolveCapabilities(),bridge);const notify=vi.fn().mockResolvedValue(undefined);const result=await withInvocationContext({notify,progressToken:"p"},()=>tools.wait_workflow_job.handler({origin:"uxp",job_id:"one",timeout_ms:100}));expect(result).toMatchObject({success:true,data:{job:{outputVerified:false,id:"one",state:"completed",terminal:true},timedOut:false,requiresReconciliation:false,nativeCancelled:false}});expect(notify).toHaveBeenCalled();expect(bridge.request).toHaveBeenCalledTimes(1);
    bridge.request.mockResolvedValue({jobs:[{jobId:"wrong",state:"completed"}]});expect((await tools.inspect_workflow_job.handler({origin:"uxp",job_id:"one"})).success).toBe(false);
    const noBridge=setup();expect((await noBridge.tools.wait_workflow_job.handler({origin:"uxp",job_id:"one",timeout_ms:0})).success).toBe(false);
  });
  it("stops on an uncorrelated terminal receipt and requests reconciliation without polling again",async()=>{
    const bridge={request:vi.fn().mockResolvedValue({job:{jobId:"one",state:"completed",terminal:true,progress:1,correlationBoundary:"single_active_job_heuristic_native_boolean_has_no_job_id"}})};
    const {tools}=setup(undefined,resolveCapabilities(),bridge);
    expect(await tools.wait_workflow_job.handler({origin:"uxp",job_id:"one",timeout_ms:60000})).toMatchObject({success:true,data:{job:{id:"one",state:"unknown",terminal:false,outputVerified:false,result:{observedState:"completed",observedTerminal:true,correlationVerified:false,attribution:"single_active_job_heuristic_native_boolean_has_no_job_id"}},timedOut:false,requiresReconciliation:true,nativeCancelled:false}});
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(await tools.inspect_workflow_job.handler({origin:"uxp",job_id:"one"})).toMatchObject({success:true,data:{state:"unknown",terminal:false,requiresReconciliation:true}});
  });
  it("reports timeout for an accepted native receipt with no observed terminal event",async()=>{
    const bridge={request:vi.fn().mockResolvedValue({job:{jobId:"one",state:"accepted",terminal:false}})};
    const {tools}=setup(undefined,resolveCapabilities(),bridge);
    expect(await tools.wait_workflow_job.handler({origin:"uxp",job_id:"one",timeout_ms:0})).toMatchObject({success:true,data:{job:{state:"accepted",terminal:false},timedOut:true,requiresReconciliation:false,nativeCancelled:false}});
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });
});
