import "server-only";
import { readReadRecoveryWake } from "@/lib/sav/intake/read-recovery-wake";
import { savIntakeRuntimeConfig } from "@/lib/sav/intake/runtime-contract";
import { analyseSavIntakeRuntime } from "@/lib/sav/intake/runtime";
export async function readIntakeReadRecoveryStep(runId:string){
 "use step";
 return readReadRecoveryWake(runId);
}
readIntakeReadRecoveryStep.maxRetries=0;
export async function resumeIntakeReadRecoveryStep(runId:string){
 "use step";
 const state=await readReadRecoveryWake(runId);if(state.state!=="scheduled")return {state:state.state};
 const config=savIntakeRuntimeConfig();if(!config)return {state:"off"};
 const result=await analyseSavIntakeRuntime(runId,config);
 return {state:"state" in result?result.state:"skipped"};
}
resumeIntakeReadRecoveryStep.maxRetries=0;
