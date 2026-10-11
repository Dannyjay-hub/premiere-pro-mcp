import { performance } from "node:perf_hooks";
import { snapshotRevision, validateSnapshot, predictEdits } from "../dist/ai/timeline-contract.js";
import { frameToTicks } from "../dist/ai/exact-time.js";

const frameRate = {numerator:30000,denominator:1001};
function fixture(count) {
  const snapshot = { schema_version:1,backend:"offline",project_id:"generated-project",sequence_id:"generated-sequence",session_id:"benchmark-session",revision:"pending",frame_rate:frameRate,display_start_ticks:"0",tracks:[{id:"v1",type:"video",index:0,locked:false,sync_locked:true,targeted:true,muted:false}],clips:Array.from({length:count},(_,index) => ({id:`c${index}`,source_id:`s${index}`,track_id:"v1",start_ticks:frameToTicks(String(index*60),frameRate),end_ticks:frameToTicks(String(index*60+30),frameRate),in_ticks:"0",out_ticks:frameToTicks("30",frameRate),source_duration_ticks:frameToTicks("120",frameRate),speed:{numerator:1,denominator:1},reversed:false,enabled:true,linked_ids:[],identity:"host",effects:[],nested:false})),completeness:{clips:true,links:true,locks:true,effects:true,transitions:true,markers:true},transitions:[],markers:[],pagination:{offset:0,total:count,next_offset:null}};
  snapshot.revision=snapshotRevision(snapshot); return snapshot;
}
const runs = 7;
const results=[];
for (const clips of [100,1000,10000]) {
  const snapshot=fixture(clips); const times=[];
  for (let run=0;run<runs;run++) { const start=performance.now(); validateSnapshot(snapshot); predictEdits(snapshot,[{type:"enable",clip_id:"c0",enabled:false}]); times.push(performance.now()-start); }
  times.sort((a,b)=>a-b);
  results.push({clips,runs,medianMs:times[Math.floor(runs/2)],p95Ms:times[Math.ceil((runs-1)*.95)],inputBytes:Buffer.byteLength(JSON.stringify(snapshot)),changedClips:1});
}
process.stdout.write(JSON.stringify({schemaVersion:1,node:process.version,platform:process.platform,architecture:process.arch,scope:"generated_local_validate_and_predict; not host latency",results},null,2)+"\n");
