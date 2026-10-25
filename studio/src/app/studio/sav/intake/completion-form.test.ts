import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({ok:false,message:"",pending:false}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),useActionState:()=>[{ok:state.ok,message:state.message},()=>{},state.pending]}));
vi.mock("./actions",()=>({completeIntakeDossierAction:vi.fn()}));
import {IntakeCompletionForm} from "./completion-form";
const render=()=>renderToStaticMarkup(createElement(IntakeCompletionForm,{threadId:"thread",messageId:"message",requestKey:"request"}));
beforeEach(()=>{state.ok=false;state.message="";state.pending=false;});
it("offers a labelled required confirmation and the frozen message and request key",()=>{
 const html=render();expect(html).toMatch(/<input(?=[^>]*name="confirmed")(?=[^>]*required="")[^>]*>/);expect(html).toContain("J’ai déjà traité cette demande");
 expect(html).toContain('name="messageId" value="message"');expect(html).toContain('name="requestKey" value="request"');expect(html).not.toContain("disabled");
});
it("disables confirmation and submit while pending",()=>{state.pending=true;const html=render();expect(html).toContain("Classement administratif en cours…");expect(html.match(/disabled=""/g)).toHaveLength(2);});
it("announces actual success and prevents a second submission",()=>{state.ok=true;state.message="Dossier passé en Terminés";const html=render();expect(html).toContain('role="status"');expect(html).toContain(state.message);expect(html.match(/disabled=""/g)).toHaveLength(2);});
it("announces a refusal and leaves retry available",()=>{state.message="Une action reste à vérifier";const html=render();expect(html).toContain('role="alert"');expect(html).toContain(state.message);expect(html).not.toContain("disabled");});
