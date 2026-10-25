import { sleep } from "workflow";
import { readIntakeReadRecoveryStep,resumeIntakeReadRecoveryStep } from "./steps";
import { executeSavIntakeWakeStep,finishSavIntakeWakeStep } from "../sav-intake/steps";
/** Separate workflow name: never changes replay history of the immediate wake. */
export async function processSavIntakeReadRecoveryWorkflow(runId:string){
 "use workflow";
 for(let n=0;n<3;n++){
  const state=await readIntakeReadRecoveryStep(runId);
  if(state.state==="observed"){await executeSavIntakeWakeStep(runId);break;}
  if(state.state!=="scheduled")break;
  await sleep(new Date(state.retryAt));
  const result=await resumeIntakeReadRecoveryStep(runId);
  if(result.state==="observed"){await executeSavIntakeWakeStep(runId);break;}
 }
 await finishSavIntakeWakeStep(runId);
}
