import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { observeSavOther, savOtherFamilies, type SavOtherRegistry } from "../other-observation";
import { isSavOtherAuthentication, type SavOtherAuthentication } from "../other-auth";
const hash=(text:string)=>createHash("sha256").update(text.replace(/\r\n?/g,"\n")).digest("hex");
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const rule=z.object({ id:z.string().min(1).max(100),family:z.enum(["trustpilot_positive","vistaprint_promotions","datarevolution_prospecting","own_campaign_copy","authenticated_newsletter"]),mailboxId:z.uuid(),subjectSha256:digest,bodySha256:digest }).strict();
const catalogueSchema=z.object({version:z.literal(1),resource:z.object({resourceId:z.string().min(1).max(200),revisionId:z.string().min(1).max(200),sha256:digest}).strict(),approvedBy:z.string().min(1).max(200),approvedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),rules:z.array(rule).min(1).max(100)}).strict();
export function readIntakeOtherRules(raw=process.env.SAV_INTAKE_OTHER_RULES_JSON,now=new Date()) {
  if(!raw)return null;
  if(raw.length>100000)throw Error("SAV_INTAKE_OTHER_CONFIGURATION_REQUIRED");
  try {
    const value=catalogueSchema.parse(JSON.parse(raw));
    if(hash(JSON.stringify(value.rules))!==value.resource.sha256 || Date.parse(value.approvedAt)>now.getTime() || now.getTime()>=Date.parse(value.expiresAt)
      || new Set(value.rules.map(r=>r.id)).size!==value.rules.length)throw Error();
    return value;
  } catch { throw Error("SAV_INTAKE_OTHER_CONFIGURATION_REQUIRED"); }
}
export type IntakeOtherQualification={family:keyof typeof savOtherFamilies|"authenticated_newsletter";label:string;ruleId:string;resource:NonNullable<ReturnType<typeof readIntakeOtherRules>>["resource"];messageId:string;sourceHash:string;authenticatedHeaderHash:string;observedAt:string};
/** Exact approved bodies initially: no free-form body remainder, regex, domain or
 * model confidence can authorize hiding a customer request. */
export function qualifyIntakeOther(input:{mailboxId:string;mailboxEmail:string;messageId:string;gmailMessageId:string;gmailThreadId:string;fromEmail:string;subject:string;body:{text:string;headers?:Record<string,string>;attachments?:unknown[]};sourceHash:string;protectedContext:boolean;inventoryComplete:boolean},
  registry:SavOtherRegistry|null,catalogue:ReturnType<typeof readIntakeOtherRules>,proof:SavOtherAuthentication|null,now=new Date()):IntakeOtherQualification|null {
  if(!catalogue||Date.parse(catalogue.approvedAt)>now.getTime()||Date.parse(catalogue.expiresAt)<=now.getTime()||!proof||!isSavOtherAuthentication(proof)||!input.inventoryComplete||input.protectedContext||input.body.text.length>=99999
    ||proof.mailboxEmail!==input.mailboxEmail.toLowerCase()||proof.messageId!==input.gmailMessageId||proof.threadId!==input.gmailThreadId||proof.sender!==input.fromEmail.toLowerCase()
    ||Date.parse(proof.observedAt)>now.getTime()||now.getTime()-Date.parse(proof.observedAt)>60000)return null;
  const newsletter=proof.bulk===true&&!input.body.attachments?.length&&!/^\s*(?:re|fw|fwd|tr|rép)\s*:/iu.test(input.subject)
    &&!/[?？]/u.test(input.subject+input.body.text)&&!/ne\s+(?:fonctionne|marche)\s+(?:pas|plus)|\burgent\b|\b(?:aidez|help|rembours|factur|r[eé]sil)/iu.test(input.subject+input.body.text)
    &&/\b(?:newsletter|lettre d.information|[eé]dition|actualit[eé]s|weekly digest)\b/iu.test(input.subject+input.body.text)
    &&/d[eé]sinscri|unsubscribe|pr[eé]f[eé]rences d.abonnement/iu.test(input.body.text);
  const candidate=observeSavOther({...input,gmailMessageId:input.gmailMessageId},registry)
    ??(newsletter?{family:"authenticated_newsletter" as const,label:"Newsletter authentifiée et approuvée"}:null);if(!candidate)return null;
  const matches=catalogue.rules.filter(r=>r.mailboxId===input.mailboxId&&r.family===candidate.family&&r.subjectSha256===hash(input.subject)&&r.bodySha256===hash(input.body.text));
  if(matches.length!==1)return null;
  return {family:candidate.family,label:candidate.label,ruleId:matches[0].id,resource:catalogue.resource,messageId:input.messageId,sourceHash:input.sourceHash,authenticatedHeaderHash:proof.headerHash,observedAt:proof.observedAt};
}

/** Revalidate the expiring server authority immediately before publication. */
export function intakeOtherQualificationFresh(qualification:IntakeOtherQualification,raw:string|undefined,now=new Date()) {
  try {
    const catalogue=readIntakeOtherRules(raw,now);
    return Boolean(catalogue&&JSON.stringify(catalogue.resource)===JSON.stringify(qualification.resource)
      &&catalogue.rules.some(r=>r.id===qualification.ruleId&&r.family===qualification.family)
      &&Date.parse(qualification.observedAt)<=now.getTime()&&now.getTime()-Date.parse(qualification.observedAt)<=60000);
  } catch { return false; }
}
