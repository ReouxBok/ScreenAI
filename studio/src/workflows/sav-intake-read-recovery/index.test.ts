import {beforeEach,expect,it,vi} from "vitest";
const f=vi.hoisted(()=>({read:vi.fn(),resume:vi.fn(),sleep:vi.fn(),execute:vi.fn(),finish:vi.fn()}));
vi.mock("workflow",()=>({sleep:f.sleep}));
vi.mock("./steps",()=>({readIntakeReadRecoveryStep:f.read,resumeIntakeReadRecoveryStep:f.resume}));
vi.mock("../sav-intake/steps",()=>({executeSavIntakeWakeStep:f.execute,finishSavIntakeWakeStep:f.finish}));
import {processSavIntakeReadRecoveryWorkflow} from "./index";
beforeEach(()=>{Object.values(f).forEach(fn=>fn.mockReset());});
it("sleeps until the durable date and continues through the existing executor only after observation",async()=>{
 f.read.mockResolvedValue({state:"scheduled",retryAt:"2026-10-25T12:00:30.000Z"});f.resume.mockResolvedValue({state:"observed"});
 await processSavIntakeReadRecoveryWorkflow("synthetic-run");expect(f.sleep).toHaveBeenCalledWith(new Date("2026-10-25T12:00:30.000Z"));expect(f.resume).toHaveBeenCalledTimes(1);expect(f.execute).toHaveBeenCalledTimes(1);expect(f.finish).toHaveBeenCalledTimes(1);
});
it.each(["stopped","off"])("does not sleep/resume/execute after %s",async state=>{
 f.read.mockResolvedValue({state});await processSavIntakeReadRecoveryWorkflow("synthetic-run");expect(f.sleep).not.toHaveBeenCalled();expect(f.resume).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();
});
it("bounds orchestration to three recovery steps and never auto-executes a waiting result",async()=>{
 f.read.mockResolvedValue({state:"scheduled",retryAt:"2026-10-25T12:00:30.000Z"});f.resume.mockResolvedValue({state:"waiting"});
 await processSavIntakeReadRecoveryWorkflow("synthetic-run");expect(f.resume).toHaveBeenCalledTimes(3);expect(f.execute).not.toHaveBeenCalled();
});
it("a replay against already observed durable state does not repeat the analysis step",async()=>{
 f.read.mockResolvedValue({state:"observed"});await processSavIntakeReadRecoveryWorkflow("synthetic-run");expect(f.resume).not.toHaveBeenCalled();expect(f.execute).toHaveBeenCalledTimes(1);
});
