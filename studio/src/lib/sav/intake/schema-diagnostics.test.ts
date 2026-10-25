import { expect,it } from "vitest";
import {z} from "zod";
import {intakeSchemaIssues,publicIntakeSchemaIssues} from "./schema-diagnostics";
it("keeps only known paths/codes/bounds, never unknown keys or rejected values",()=>{
 const r=z.object({images:z.array(z.object({text:z.string().max(1)}))}).safeParse({images:[{text:"PRIVATE_VALUE"}],PRIVATE_FIELD:"PRIVATE_OTHER"});
 if(r.success)throw Error("fixture");
 expect(intakeSchemaIssues(r.error)).toEqual([{path:"images.0.text",code:"too_big",maximum:1}]);
 expect(JSON.stringify(intakeSchemaIssues(r.error))).not.toContain("PRIVATE");
 expect(publicIntakeSchemaIssues([{path:"PRIVATE_FIELD.secret",code:"custom",message:"PRIVATE_VALUE",input:"PRIVATE_VALUE"}])).toEqual([{path:"output",code:"custom"}]);
});
