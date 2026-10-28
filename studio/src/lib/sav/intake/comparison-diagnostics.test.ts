import {expect,it} from "vitest";
import {comparisonValidationDiagnostics} from "./comparison-diagnostics";
import type {IntakeModelTrace} from "./model-readers";
it("retains useful bounded rejection fields without arbitrary values, keys, messages or source text",()=>{
 const traces=[{phase:"ticket_matching",accepted:false,errorCode:"SAV_INTAKE_MODEL_CITATION_REJECTED",privateText:"PRIVATE_MODEL_OUTPUT",validationFailure:{reason:"wrong_anchor_source",path:"tickets.0.grounding.1",stage:"decode",excerptHash:"a".repeat(64),excerptLength:30,privateText:"PRIVATE_CUSTOMER_TEXT",issues:[{path:"private-key@example.invalid",code:"invalid_value",message:"PRIVATE_MESSAGE"}]}}] as unknown as IntakeModelTrace[];
 const result=comparisonValidationDiagnostics(traces);
 expect(result).toEqual([{phase:"ticket_matching",code:"SAV_INTAKE_MODEL_CITATION_REJECTED",validationFailure:{reason:"wrong_anchor_source",path:"tickets.0.grounding.1",stage:"decode",issues:[{path:"output",code:"invalid_value"}]}}]);
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example.invalid|excerptHash/);
});
it("bounds trace count and sanitizes unexpected error codes and paths",()=>{
 const t={phase:"private-model-phase",accepted:false,errorCode:"PRIVATE_ERROR",validationFailure:{reason:"required_source_missing",path:"PRIVATE_PATH"}} as unknown as IntakeModelTrace;
 const result=comparisonValidationDiagnostics(Array.from({length:30},()=>t));
 expect(result).toHaveLength(8);expect(result[0]).toEqual({phase:"understanding",code:"SAV_INTAKE_MODEL_OUTPUT_REJECTED",validationFailure:{reason:"required_source_missing",path:"output"}});
});
