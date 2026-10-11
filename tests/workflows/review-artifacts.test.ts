import {execFileSync} from "node:child_process";
import {existsSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,unlinkSync,utimesSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {createReviewClip,hashStableArtifact,publishArtifactExclusive,removeOwnedStaging,snapshotArtifact} from "../../src/workflows/review-artifacts.js";
import {withInvocationContext} from "../../src/workflows/invocation-context.js";
const hooks=vi.hoisted(()=>({run:null as null|((file:string,args:string[],options:unknown)=>Promise<{stdout:string;stderr:string}>),beforeLink:null as null|((source:string,destination:string)=>void),afterLink:null as null|((source:string,destination:string)=>void),frozenSource:null as null|{path:string;metadata:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}},sourceDescriptors:new Set<number>()}));
vi.mock("node:child_process",async importOriginal=>{
 const actual=await importOriginal<typeof import("node:child_process")>();const {promisify}=await import("node:util");const native=promisify(actual.execFile);
 const execFile=actual.execFile.bind(null);
 Object.defineProperty(execFile,promisify.custom,{value:(file:string,args:string[],options:unknown)=>hooks.run ? hooks.run(file,args,options):(native as any)(file,args,options)});
 return {...actual,execFile};
});
vi.mock("node:fs",async importOriginal=>{
 const actual=await importOriginal<typeof import("node:fs")>();return {...actual,
  lstatSync:(path:string)=>{const stats=actual.lstatSync(path);return path===hooks.frozenSource?.path ? Object.assign(stats,hooks.frozenSource.metadata):stats;},
  openSync:(path:string,flags:string|number)=>{const descriptor=actual.openSync(path,flags);if(path===hooks.frozenSource?.path)hooks.sourceDescriptors.add(descriptor);return descriptor;},
  fstatSync:(descriptor:number)=>{const stats=actual.fstatSync(descriptor);return hooks.sourceDescriptors.has(descriptor) && hooks.frozenSource ? Object.assign(stats,hooks.frozenSource.metadata):stats;},
  closeSync:(descriptor:number)=>{hooks.sourceDescriptors.delete(descriptor);actual.closeSync(descriptor);},
  linkSync:(source:string,destination:string)=>{hooks.beforeLink?.(source,destination);actual.linkSync(source,destination);hooks.afterLink?.(source,destination);}};
});
let directory:string;
afterEach(()=>{hooks.run=null;hooks.beforeLink=null;hooks.afterLink=null;hooks.frozenSource=null;hooks.sourceDescriptors.clear();if(directory)rmSync(directory,{recursive:true,force:true});});
function fixture() {directory=mkdtempSync(join(tmpdir(),"mcp-review-race-"));const input=join(directory,"input.mp4"),output=join(directory,"output.mp4");writeFileSync(input,"source fixture");return {input,output};}
function fakeEncoder(onProbe?:(staging:string)=>void) {
 hooks.run=async(file,args)=>{const staging=args.at(-1)!;if(file==="ffmpeg"){writeFileSync(staging,"encoded review fixture");return {stdout:"",stderr:""};}onProbe?.(staging);return {stdout:JSON.stringify({streams:[{codec_type:"video",nb_read_frames:"24"}],format:{duration:"1"}}),stderr:""};};
}
describe("create-only review excerpts",()=>{
 it("refuses unsafe paths, bad ranges and pre-existing destinations before encoding",async()=>{
  directory=mkdtempSync(join(tmpdir(),"mcp-review-range-"));const input=join(directory,"input.mp4"),output=join(directory,"output.mp4");writeFileSync(input,"fixture");
  await expect(createReviewClip("relative",output,0,1)).rejects.toThrow("REVIEW_CLIP_PATH");
  await expect(createReviewClip(input,output,NaN,1)).rejects.toThrow("REVIEW_CLIP_RANGE");
  await expect(createReviewClip(input,output,0,31)).rejects.toThrow("REVIEW_CLIP_RANGE");
  await expect(createReviewClip(directory,output,0,1)).rejects.toThrow("REVIEW_CLIP_INPUT");
  const controller=new AbortController();controller.abort();await expect(withInvocationContext({signal:controller.signal},()=>createReviewClip(input,output,0,1))).rejects.toThrow("REQUEST_CANCELLED");
  writeFileSync(output,"preserve");await expect(createReviewClip(input,output,0,1)).rejects.toThrow("REVIEW_CLIP_PATH");
  expect(readdirSync(directory).some(name=>name.startsWith('.mcp-review-'))).toBe(false);
 });
 it("detects same-size source writes with restored mtime during encoding",async()=>{
  const {input,output}=fixture();const date=new Date("2010-01-01T00:00:00Z");utimesSync(input,date,date);const initial=statSync(input);
  fakeEncoder(()=>{writeFileSync(input,"x".repeat(initial.size));utimesSync(input,date,date);});
  await expect(createReviewClip(input,output,0,1)).rejects.toThrow("REVIEW_CLIP_SOURCE_CHANGED");
  expect(statSync(input).size).toBe(initial.size);expect(statSync(input).mtimeMs).toBe(initial.mtimeMs);expect(existsSync(output)).toBe(false);expect(readdirSync(directory).some(name=>name.startsWith(".mcp-review-"))).toBe(false);
 });
 it.each(["encoding","publication"])("rejects actual source content changed during %s even when every observed timestamp and identity stays unchanged",async(stage)=>{
  const {input,output}=fixture();const date=new Date("2010-01-01T00:00:00Z");utimesSync(input,date,date);const initial=statSync(input);
  hooks.frozenSource={path:input,metadata:{dev:initial.dev,ino:initial.ino,size:initial.size,mtimeMs:initial.mtimeMs,ctimeMs:initial.ctimeMs}};
  const mutate=()=>{writeFileSync(input,"x".repeat(initial.size));utimesSync(input,date,date);};
  // Keep real file bytes and descriptors; model unchanged Windows metadata only.
  fakeEncoder(stage==="encoding" ? mutate:undefined);if(stage==="publication")hooks.afterLink=mutate;
  await expect(createReviewClip(input,output,0,1)).rejects.toThrow("REVIEW_CLIP_SOURCE_CHANGED");
  const current=statSync(input);expect(current.ino).toBe(initial.ino);expect(current.size).toBe(initial.size);expect(current.mtimeMs).toBe(initial.mtimeMs);
  expect(readFileSync(input,"utf8")).toBe("x".repeat(initial.size));expect(existsSync(output)).toBe(false);expect(readdirSync(directory).some(name=>name.startsWith(".mcp-review-"))).toBe(false);
 });
 it("refuses probe metadata for a staging file replaced before hashing",async()=>{
  const {input,output}=fixture();let replaced="";
  fakeEncoder(staging=>{replaced=staging;const other=join(directory,"replacement.mp4");writeFileSync(other,"other encoded fixture");renameSync(other,staging);});
  await expect(createReviewClip(input,output,0,1)).rejects.toThrow("REVIEW_CLIP_STAGING_CHANGED");expect(existsSync(output)).toBe(false);
  // This path now belongs to another writer; cleanup preserves that replacement.
  expect(readFileSync(replaced,"utf8")).toBe("other encoded fixture");
 });
 it("preserves a destination created concurrently before exclusive publication",async()=>{
  const {input,output}=fixture();fakeEncoder();hooks.beforeLink=(_source,destination)=>writeFileSync(destination,"unrelated output");
  await expect(createReviewClip(input,output,0,1)).rejects.toThrow("EEXIST");expect(readFileSync(output,"utf8")).toBe("unrelated output");expect(readdirSync(directory).some(name=>name.startsWith(".mcp-review-"))).toBe(false);
 });
 it("refuses publication identity readback without removing another writer's replacement",async()=>{
  const {input,output}=fixture();fakeEncoder();hooks.afterLink=(_source,destination)=>{unlinkSync(destination);writeFileSync(destination,"unrelated replacement");};
  await expect(createReviewClip(input,output,0,1)).rejects.toThrow("REVIEW_PUBLICATION_CHANGED");expect(readFileSync(output,"utf8")).toBe("unrelated replacement");
 });
 it("streams a pinned checksum, rejects changed staging, and never cleans an unmeasured path",async()=>{
  const {input,output}=fixture();const snapshot=snapshotArtifact(input);
  expect(await hashStableArtifact(input,snapshot)).toBe(createHash("sha256").update("source fixture").digest("hex"));
  writeFileSync(input,"changed fixture");await expect(hashStableArtifact(input,snapshot)).rejects.toThrow("ARTIFACT_SOURCE_CHANGED");
  await expect(publishArtifactExclusive(input,output,snapshot,"0".repeat(64))).rejects.toThrow("REVIEW_PUBLICATION_CHANGED");expect(existsSync(output)).toBe(false);
  removeOwnedStaging(input);expect(existsSync(input)).toBe(true);
 });
});
let decoders=true;try{execFileSync("ffmpeg",["-version"],{stdio:"ignore"});execFileSync("ffprobe",["-version"],{stdio:"ignore"});}catch{decoders=false;}
it.skipIf(!decoders)("creates a decoded bounded excerpt, refuses an empty range and cleans only staging",async()=>{
 directory=mkdtempSync(join(tmpdir(),"mcp-review-render-"));const input=join(directory,"input.mp4"),output=join(directory,"output.mp4");
 execFileSync("ffmpeg",["-nostdin","-v","error","-n","-f","lavfi","-i","color=c=red:s=160x90:r=24:d=2","-c:v","libx264",input],{timeout:30000});
 expect(await createReviewClip(input,output,0.5,1)).toMatchObject({path:output,sourceSha256:createHash("sha256").update(readFileSync(input)).digest("hex"),renderVerified:false,decodedFrames:24,observedDurationSeconds:1});expect(existsSync(output)).toBe(true);
 await expect(createReviewClip(input,join(directory,"empty.mp4"),10,1)).rejects.toThrow("REVIEW_CLIP_EMPTY");
 expect(readdirSync(directory).some(name=>name.startsWith('.mcp-review-'))).toBe(false);
},60000);
