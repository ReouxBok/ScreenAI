import {it,expect} from "vitest";
import {z} from "zod";
import {invalidIntakeAddressMetadata} from "./source-validation";
it("only isolates address metadata schema failures without suppressing unrelated failures",()=>{
 const addresses=z.object({fromEmail:z.email(),toEmails:z.array(z.email()).max(30)}).safeParse({fromEmail:"not-email",toEmails:[]});
 expect(addresses.success).toBe(false);if(!addresses.success)expect(invalidIntakeAddressMetadata(addresses.error)).toBe(true);
 const other=z.object({id:z.uuid()}).safeParse({id:"not-id"});
 if(!other.success)expect(invalidIntakeAddressMetadata(other.error)).toBe(false);
 expect(invalidIntakeAddressMetadata(Error("database unavailable"))).toBe(false);
});
