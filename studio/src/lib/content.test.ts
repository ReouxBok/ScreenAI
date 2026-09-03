import { describe, expect, it } from "vitest";
import { assertSafeMarkdown, knowledgeSearchSchema, parseContentInput } from "./content";
const article = { type:"article", slug:"connecter-gmail", locale:"fr-FR", title:"Connecter Gmail", summary:"Connectez Gmail à Limova.", categorySlug:"integrations", agentKey:"common", visibility:"charly_and_help", ownerEmail:"knowledge@limova.ai", bodyMarkdown:"## Connexion\n\nOuvrez les intégrations puis choisissez Gmail.", changeNote:"Création du guide", metadata:{intents:["connecter gmail"],limovaPaths:["/integrations"],prerequisites:[],expectedResult:"Gmail connecté",troubleshooting:"Réessayez."} } as const;
describe("content validation",()=>{
  it("accepte un article structuré",()=>expect(parseContentInput(article).slug).toBe("connecter-gmail"));
  it("sépare explicitement la connaissance SAV de celle de l’extension",()=>{
    expect(knowledgeSearchSchema.parse({query:"connexion gmail"}).scope).toBe("extension");
    expect(knowledgeSearchSchema.parse({query:"résolution ticket",scope:"sav"}).scope).toBe("sav");
    expect(parseContentInput({...article,slug:"resolution-sav",agentKey:"sav"}).agentKey).toBe("sav");
  });
  it.each(["<script>alert(1)</script>","<iframe src=x></iframe>","[piège](javascript:alert(1))"])("refuse le contenu dangereux %s",markdown=>expect(()=>assertSafeMarkdown(markdown)).toThrow());
  it("impose la visibilité interne aux parcours",()=>expect(()=>parseContentInput({...article,type:"onboarding",visibility:"charly_and_help",metadata:{objective:"Créer une campagne",proposalSignals:[],qualificationQuestions:[],expectedPages:[],successCriteria:[],branches:[],fallbacks:[]}})).toThrow());
  it("valide les empreintes d’action apprises",()=>{
    const parsed=parseContentInput({...article,type:"onboarding",visibility:"charly_only",metadata:{objective:"Connecter Gmail",proposalSignals:["gmail"],qualificationQuestions:[],expectedPages:["/integrations"],successCriteria:["Gmail connecté"],branches:[],fallbacks:[],actionSteps:[{order:1,action:"click",path:"/integrations",label:"Connecter Gmail",confidence:"strong",target:{testId:"connect-gmail",section:"Gmail"},preconditions:["[main]"],expected:{pageMarkers:["[modal]"],network:["POST /api/connect status:200"]}}]}});
    expect(parsed.metadata).toHaveProperty("actionSteps.0.target.testId","connect-gmail");
  });
});
