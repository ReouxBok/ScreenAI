import { createHash } from "node:crypto";
import type { OnboardingMetadata } from "@/db/schema";
import { canonicalKnowledgeSchema, type CanonicalKnowledge, type SemanticStep, type OnboardingSourceSection } from "./contracts";
import { onboardingSectionsBody, onboardingSectionsQualified } from "./onboarding-sections";
import { redactSavLearningText } from "@/lib/sav/learning-extraction";

export type OnboardingKnowledgePreparation = {
  title: string;
  document: CanonicalKnowledge;
  quality: { state: "ready" | "needs_completion"; missing: string[]; warnings: string[] };
  provenance: Array<{ field: string; source: string }>;
  supportBody: string;
};

type Section = { heading: string; key: string; lines: string[]; level?: number; omittedCode?: boolean };
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’]/g, "'").trim();
const technical = /(?:querySelector|data-testid|data-test-id|nth-child|testId\s*[:=]|domId\s*[:=]|selector\s*[:=]|sélecteur\s*[:=]|\bDOM\b|\b(?:xpath|css selector)\b|\b(?:coordinates|coordonnées)\s*[:=]|\b[xy]\s*[:=]\s*-?\d|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/)/i;
const technicalHeading = /rep[eè]res techniques|donn[eé]es techniques|cibles? techniques?|d[eé]tails? (?:dom|techniques)|^dom$|s[eé]lecteurs?/i;
const secretAssignment = /\b(?:bearer|api[_ -]?key|token|password|mot de passe)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/i;
const explicitCssSelector = /\b(?:s[eé]lecteur\s+CSS|CSS\s+selector|class(?:Name)?\s*[:=])/i;
const generic = /ouvrir la fiche de l['’][eé]l[eé]ment exact|s[eé]lectionner l['’]action destructive demand[eé]e|ouvrir le catalogue des int[eé]grations et rechercher le fournisseur demand[eé]|s[eé]lectionner la bonne carte|identifier l['’]organisation, l['’]espace et l['’]objet recherch[eé]s|inspecter les contr[oô]les visibles et s[eé]lectionner l['’]objet exact|le r[eé]sultat de [«“"][^»”"]+[»”"] est visible dans Limova apr[eè]s r[eé]inspection|ouvrir la section correspondant [àa]|ouvrir la section indiqu[eé]e|choisir l['’]action correspondant [àa]|recueillir les valeurs obligatoires visibles|le parcours d[eé]montr[eé] est termin[eé]|ouvrir la liste concern[eé]e|s[eé]lectionner l['’][eé]l[eé]ment exact [àa] modifier|r[eé]aliser l['’]action attendue|v[eé]rifier que le r[eé]sultat correspond [àa] la demande|effectuer les (?:actions|modifications) n[eé]cessaires|action [àa] (?:confirmer|compl[eé]ter)|r[eé]sultat (?:de cette [eé]tape )?[àa] confirmer|contr[oô]le observ[eé]|^\s*(?:clic|click|button|div|span|scroll|d[eé]filement)\s*$/i;
const truncation = /(?:\.{3}|…)\s*$/;
const knownHeading = /^(?:objectif|quand utiliser ce parcours|point d['’]entr[eé]e|pr[eé]requis|questions [àa] poser si l['’]information manque|[eé]tapes op[eé]rationnelles|v[eé]rification de r[eé]ussite|variantes et blocages|reprise s[uû]re|d[eé]monstration|rep[eè]res techniques appris)\s*:?$/i;
const headingKeys: Record<string, string> = {
  objectif: "objective", "quand utiliser ce parcours": "signals", "point d'entree": "entry", prerequis: "prerequisites",
  "questions a poser si l'information manque": "questions", "etapes operationnelles": "steps", "verification de reussite": "success",
  "variantes et blocages": "exceptions", "reprise sure": "escalation", demonstration: "demonstration",
};

function sectionsFromMarkdown(body: string, title: string): Section[] {
  const sections: Section[] = [{ heading: "Préambule", key: "preamble", lines: [] }];
  let fenced = false;
  for (const rawLine of body.replace(/\r/g, "").split("\n")) {
    if (/^\s*(```|~~~)/.test(rawLine)) { if (!fenced) sections.at(-1)!.omittedCode = true; fenced = !fenced; continue; }
    if (fenced) continue;
    const line = rawLine.trim();
    const markdownHeading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)?.[1];
    const plainHeading = line.replace(/^\*\*(.*?)\*\*:?$/, "$1").replace(/:$/, "");
    const heading = markdownHeading ?? (knownHeading.test(plainHeading) ? plainHeading : null);
    if (heading) {
      const key = technicalHeading.test(heading) ? "technical" : headingKeys[normalize(heading)] ?? "other";
      sections.push({ heading, key, lines: [], level: markdownHeading ? /^#+/.exec(line)![0].length : undefined });
    } else sections.at(-1)!.lines.push(line);
  }
  const first = sections[1];
  // Only a matching document title (or a content-free title line) can label the preamble.
  // An arbitrary first H1 may itself carry a business restriction and must be qualified.
  if (first?.key === "other" && first.level === 1 && (normalize(first.heading) === normalize(title)
    || (!first.lines.some((line) => line.trim()) && !first.omittedCode))) first.key = "preamble";
  return sections;
}

function listItems(lines: string[], preserveParagraphs = false) {
  const result: string[] = [];
  const numbered = preserveParagraphs && lines.some((line) => /^\d+[.)]\s+/.test(line));
  let current = "";
  const flush = () => { if (current.trim()) result.push(current.trim()); current = ""; };
  for (const line of lines) {
    const item = (numbered ? /^\d+[.)]\s+(.*)$/ : /^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/).exec(line);
    if (item) { flush(); current = item[1]; }
    else if (!line) { if (preserveParagraphs && current) current += "\n"; else flush(); }
    else current += `${current ? "\n" : ""}${line}`;
  }
  flush();
  return result;
}

/** Navigation route inventories describe implementation, not prerequisites for the member. */
function withoutTechnicalInventory(lines: string[]) {
  return lines.filter((line) => {
    const text = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").replace(/`/g, "").trim();
    return !/^pages? rep[eé]r[eé]es? dans le front(?: Limova)?\s*:?$/i.test(text)
      && !/^(?:\/[a-z0-9_()[\]{}./?=&:-]+|https?:\/\/\S+)$/i.test(text);
  });
}

function withoutNavigationNotes(lines: string[]) {
  return lines.filter((line) => !/narration de l['’]entr[eé]e de navigation/i.test(line));
}

function cleanNarration(value: string) {
  return value.split(/\n\s*\n/).map((paragraph) => {
    let text = paragraph.trim();
    text = text.replace(/^(?:salut|bonjour|hello)(?:\s+(?:charly|charlie|[àa] tous|tout le monde))?\s*[,!.:—-]\s*/i, "");
    text = text.replace(/^(?:aujourd['’]hui\s*[,]?\s*)?(?:dans cette (?:vid[eé]o|d[eé]monstration)[,]?\s*)?(?:on va|nous allons|je vais)\s+(?:voir|montrer)\s+comment\s+/i, "");
    text = text.replace(/^(?:alors|donc|du coup|voil[àa]|bon|eh bien)\s*[,!.:—-]\s*/i, "");
    return text ? text[0].toLocaleUpperCase("fr") + text.slice(1) : "";
  }).filter(Boolean).join("\n\n");
}

function conditionalIdentity(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("fr").replace(/[’]/g, "'").replace(/^si\s+/, "")
    .replace(/\s+/g, " ").replace(/\s*:\s*/g, ":").replace(/[.!;]+$/, "").trim();
}

/** A pure, conservative preparation: it never publishes, executes a tutorial, or calls a model. */
export function prepareOnboardingKnowledge(input: {
  title: string; bodyMarkdown: string; metadata: OnboardingMetadata; locale: string; sourceKey: string;
}): OnboardingKnowledgePreparation {
  const missing: string[] = [];
  const warnings: string[] = [];
  const provenance: OnboardingKnowledgePreparation["provenance"] = [];
  const overflow: string[] = [];
  const addMissing = (message: string) => { if (!missing.includes(message)) missing.push(message); };
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  const source = (field: string, origin: string) => {
    if (!provenance.some((entry) => entry.field === field && entry.source === origin)) provenance.push({ field, source: origin });
  };
  const sections = sectionsFromMarkdown(input.bodyMarkdown, input.title);
  const navigationNote = sections.filter((section) => section.key !== "technical").flatMap((section) => section.lines)
    .find((line) => /narration de l['’]entr[eé]e de navigation/i.test(line));
  const navigation = navigationNote?.match(/(?:dire|utiliser)\s+[«“"]([^»”"]+)[»”"]/i)?.[1].trim();
  const oldLabels = navigationNote ? [...navigationNote.matchAll(/[«“"]([^»”"]+)[»”"]/g)].map((match) => match[1].trim()).filter((label) => label !== navigation) : [];
  // EXT-1's explicit navigation correction applies to the procedure, never to its source title.
  if (navigation) { source("navigation", "bodyMarkdown.preamble.navigationCorrection"); warn("La correction de navigation explicite de la source a été appliquée ; le titre du tutoriel reste inchangé."); }

  function sanitize(raw: string, origin: string) {
    if (/<(?:script|style)\b|\bon[a-z]+\s*=|\bjavascript\s*:/i.test(raw)) {
      warn("Un passage de code a été exclu de la procédure."); addMissing("Compléter le passage contenant du code par une explication métier."); return "";
    }
    let value = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, " ").replace(/\*\*|__/g, "").replace(/`/g, "");
    const beforeRedaction = value;
    value = redactSavLearningText(value)
      .replace(/\+\d{1,3}(?:[ .-]?\d){7,14}\b/g, "[téléphone masqué]")
      .replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, "[lien retiré]")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[identifiant retiré]")
      .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, "[coordonnée bancaire retirée]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[secret retiré]")
      .replace(new RegExp(secretAssignment.source, "gi"), "[secret retiré]")
      .replace(/(?:\/[^\s/]+){2,}/g, "[chemin technique retiré]")
      .replace(/^\/[a-z0-9][a-z0-9/_?=&.-]*$/i, "[chemin technique retiré]")
      .trim();
    if (value !== beforeRedaction.trim()) { warn("Des données sensibles ou techniques ont été retirées de la source."); addMissing("Vérifier les passages dont les données sensibles ou techniques ont été retirées."); }
    if (hasUnsafeKnowledgeText(value) || /^(?:nom du client|client|contact|adresse|identifiant|email)\s*:/i.test(value)) {
      warn("Un passage technique ou nominatif a été exclu de la procédure."); addMissing("Compléter les passages exclus pour protéger les données ou séparer la technique du métier."); return "";
    }
    if (navigation) {
      for (const oldLabel of oldLabels) value = value.split(oldLabel).join(navigation);
      value = value.replace(/Limova\s*(?:3\.0\s*)?(?:B[eê]ta|Beta)(?:\s+en\s+(?:bas|haut)\s+[àa]\s+(?:gauche|droite))?/gi, navigation);
    }
    if (truncation.test(value)) addMissing("Compléter les explications tronquées dans la source.");
    if (value) source(origin, origin);
    return value;
  }

  // Exact title is a user requirement. Reject unsafe titles instead of silently rewriting them.
  const checkedTitle = redactSavLearningText(input.title);
  if (!input.title || input.title !== input.title.trim() || checkedTitle !== input.title || input.title.length > 500
      || hasUnsafeKnowledgeText(input.title)) {
    throw new Error("ONBOARDING_KNOWLEDGE_TITLE_REQUIRES_REVIEW");
  }
  source("title", "contentItem.title");

  function cleanSection(key: string) {
    return sections.filter((section) => section.key === key).flatMap((section) => listItems(withoutNavigationNotes(withoutTechnicalInventory(section.lines)), key === "steps")
      .map((value) => sanitize(value, `bodyMarkdown.${key}`)).filter(Boolean));
  }
  function cleanMetadata(values: string[] | undefined, key: string) {
    return (values ?? []).map((value) => sanitize(value, `metadata.${key}`)).filter(Boolean);
  }
  function limitedText(value: string, max: number, field: string, fallback = "") {
    if (value.length <= max) return value;
    addMissing(`Le champ « ${field} » dépasse la capacité du format ; le texte complet reste dans les éléments à structurer.`);
    overflow.push(`${field}\n${value}`); return fallback;
  }
  function limitedList(values: string[], field: string) {
    const distinct = [...new Set(values)];
    const kept = distinct.filter((value) => {
      if (value.length <= 500) return true;
      overflow.push(`${field}\n${value}`); addMissing(`Un élément de « ${field} » dépasse 500 caractères et doit être structuré.`); return false;
    });
    if (kept.length > 50) { overflow.push(`${field}\n${kept.slice(50).join("\n")}`); addMissing(`La liste « ${field} » dépasse 50 éléments et doit être structurée.`); }
    return kept.slice(0, 50);
  }

  const isStaffSupplement = (section: Section) => /compl[eé]ments (?:d[eé]j[àa] )?transmis par le staff/i.test(section.heading);
  const preamble = sections.filter((section) => section.key === "preamble")
    .flatMap((section) => listItems(withoutNavigationNotes(withoutTechnicalInventory(section.lines)))
      .map((value) => sanitize(value, "bodyMarkdown.preamble")).filter(Boolean));
  const supplements = sections.filter(isStaffSupplement)
    .flatMap((section) => listItems(withoutNavigationNotes(withoutTechnicalInventory(section.lines))).map((value) => sanitize(value, "bodyMarkdown.staffSupplements")).filter(Boolean));
  // Keep every occurrence and its position. Unknown business headings are evidence, never disposable prose.
  const sourceSections: OnboardingSourceSection[] = sections.flatMap((section, order) => {
    if (section.key !== "other" || isStaffSupplement(section)) return [];
    const origin = `bodyMarkdown.section.${order}`;
    const heading = sanitize(section.heading, `${origin}.heading`) || `Rubrique ${order}`;
    const content = withoutNavigationNotes(withoutTechnicalInventory(section.lines))
      .map((line) => sanitize(line, `${origin}.content`)).join("\n").trim();
    if (section.omittedCode) addMissing(`Reformuler le passage de code exclu de la section « ${heading} » si son contenu est pertinent.`);
    if (heading.length > 500 || content.length > 10_000) throw new Error("ONBOARDING_KNOWLEDGE_SOURCE_CONTEXT_REQUIRES_SPLIT");
    addMissing(`Qualifier la section « ${heading} » (position ${order}) : la classer ou justifier qu’elle n’est pas pertinente pour le SAV.`);
    source(`onboardingContext.sourceSections.${order}`, origin);
    return [{ id: `section.${createHash("sha256").update(JSON.stringify([input.sourceKey, order, section.heading, section.lines])).digest("hex").slice(0, 24)}`,
      order, heading, content, classification: "pending", rationale: "" }];
  });
  if (sourceSections.length > 50) throw new Error("ONBOARDING_KNOWLEDGE_SOURCE_CONTEXT_REQUIRES_SPLIT");
  const objectiveSource = cleanSection("objective")[0] || sanitize(input.metadata.objective || "", "metadata.objective");
  if (!objectiveSource || generic.test(objectiveSource)) addMissing("Préciser l’objectif métier du parcours.");
  const objective = limitedText(objectiveSource || input.title, 500, "objectif", input.title);
  const signals = limitedList([...cleanSection("signals"), ...cleanMetadata(input.metadata.proposalSignals, "proposalSignals")], "situations d’utilisation");
  let questions = limitedList([...cleanSection("questions"), ...cleanMetadata(input.metadata.qualificationQuestions, "qualificationQuestions")], "questions de qualification");
  const prerequisites = limitedList(cleanSection("prerequisites"), "prérequis");
  const entry = cleanSection("entry");
  const success = [...cleanSection("success"), ...cleanMetadata(input.metadata.successCriteria, "successCriteria")];
  const expectedResult = limitedText([...new Set(success)].join("\n"), 5_000, "résultat attendu");
  const branchText = (input.metadata.branches ?? []).map((branch) => {
    const condition = sanitize(branch.condition, "metadata.branches.condition");
    const next = sanitize(branch.next, "metadata.branches.next");
    return condition && next ? `${/^si\s/i.test(condition) ? "" : "Si "}${condition} : ${next}` : "";
  }).filter(Boolean);
  const exceptionKeys = new Set<string>();
  const exceptions = limitedList([...cleanSection("exceptions"), ...branchText].filter((value) => {
    const key = conditionalIdentity(value);
    if (exceptionKeys.has(key)) return false;
    exceptionKeys.add(key); return true;
  }), "variantes et blocages");
  let escalation = limitedText([...new Set([...cleanSection("escalation"), ...cleanMetadata(input.metadata.fallbacks, "fallbacks")])].join("\n"), 5_000, "reprise sûre");
  if (!signals.length) addMissing("Préciser dans quelles situations utiliser ce parcours.");
  if (!prerequisites.length) addMissing("Documenter les prérequis ou confirmer explicitement leur absence.");
  if (!expectedResult || generic.test(expectedResult)) addMissing("Préciser un résultat observable permettant de vérifier la réussite.");
  if (escalation.trim().length < 3) addMissing("Préciser la reprise sûre ou l’escalade lorsque le résultat n’est pas confirmé.");

  const id = (position: number) => `step.${createHash("sha256").update(`${input.sourceKey}:source-step:${position}`).digest("hex").slice(0, 24)}`;
  const steps: SemanticStep[] = [];
  const rawSteps = cleanSection("steps");
  const demonstration = sections.filter((section) => section.key === "demonstration").flatMap((section) => listItems(withoutNavigationNotes(section.lines), true));
  const metadataSteps = input.metadata.semanticSteps ?? [];
  if (input.metadata.sourceMetadata?.origin === "limova_code_inventory" && !metadataSteps.length) {
    addMissing("La source provient d’un inventaire de code : ses gabarits ne prouvent pas le parcours métier. Documenter et vérifier les étapes, prérequis et résultats propres à ce tutoriel avant validation.");
    source("quality", "metadata.sourceMetadata.origin");
  }
  if (metadataSteps.length) {
    for (const [index, raw] of metadataSteps.entries()) {
      const field = `metadata.semanticSteps.${index}`;
      const instruction = sanitize(raw.instruction, `${field}.instruction`);
      const label = sanitize(raw.userLabel, `${field}.userLabel`);
      if (!instruction || instruction.length < 3 || instruction.length > 2_000 || label.length > 500 || !label) {
        if (instruction) overflow.push(`${field}\n${instruction}`);
        addMissing("Une étape sémantique est incomplète ou dépasse la capacité du format."); continue;
      }
      const step: SemanticStep = {
        id: id(index), userLabel: label, objective: limitedText(sanitize(raw.objective, `${field}.objective`) || label, 500, "objectif d’étape", label), instruction,
        location: limitedText(sanitize(raw.location, `${field}.location`), 200, "emplacement"),
        prerequisites: limitedList(cleanMetadata(raw.prerequisites, `${field}.prerequisites`), "prérequis d’étape"),
        expectedResult: limitedText(sanitize(raw.expectedResult, `${field}.expectedResult`), 5_000, "résultat d’étape"),
        exceptions: limitedList(cleanMetadata(raw.exceptions, `${field}.exceptions`), "exceptions d’étape"),
        escalation: limitedText(sanitize(raw.escalation, `${field}.escalation`), 5_000, "escalade d’étape"), variants: [],
      };
      for (const variant of raw.variants ?? []) {
        const variantInstruction = sanitize(variant.instruction, `${field}.variants.instruction`);
        if (variantInstruction.length < 3 || variantInstruction.length > 2_000 || step.variants.length >= 20) {
          addMissing("Une variante d’étape doit être complétée ou restructurée."); if (variantInstruction) overflow.push(`Variante\n${variantInstruction}`); continue;
        }
        step.variants.push({ roles: limitedList(cleanMetadata(variant.roles, `${field}.variants.roles`), "rôles de variante"),
          productVersion: limitedText(sanitize(variant.productVersion, `${field}.variants.productVersion`), 100, "version de variante"),
          instruction: variantInstruction, expectedResult: limitedText(sanitize(variant.expectedResult, `${field}.variants.expectedResult`), 5_000, "résultat de variante") });
      }
      steps.push(step);
    }
  } else {
    const narratives = rawSteps.length ? rawSteps : demonstration;
    for (const [index, narrative] of narratives.entries()) {
      // Recording labels name controls; only the source explanation is a written procedure.
      const explanations = [...narrative.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?(?:Explication|Narration)\s*:\s*([\s\S]*?)(?=\n\s*(?:[-*]\s*)?(?:Rep[eè]re|Cible|Action|Label|Libell[eé]|URL|S[eé]lecteur)\s*:|$)/gi)];
      const instruction = rawSteps.length ? narrative : explanations.map((match) => sanitize(cleanNarration(match[1]), "bodyMarkdown.demonstration")).filter(Boolean).join("\n\n");
      if (!instruction || instruction.length < 3) {
        if (rawSteps.length) addMissing("Une étape écrite ne contient pas d’instruction exploitable.");
        continue;
      }
      if (instruction.length > 2_000) { overflow.push(`Étape ${index + 1}\n${instruction}`); addMissing("Une instruction dépasse 2 000 caractères et doit être structurée sans perdre son contenu."); continue; }
      const quoted = instruction.match(/[«“"]([^»”"]{1,200})[»”"]/);
      steps.push({ id: id(index), userLabel: quoted?.[1] ?? `Étape ${index + 1}`, objective: instruction.length <= 500 ? instruction : `Étape ${index + 1}`,
        instruction, location: "", prerequisites: [], expectedResult: "", exceptions: [], escalation: "", variants: [] });
    }
  }
  if (demonstration.length && !rawSteps.length && !metadataSteps.length) {
    const narrativeQuestions = steps.flatMap((step) => step.instruction.split(/(?<=[.!?])\s+|\n+/))
      .map((sentence) => sentence.trim()).filter((sentence) => /\b(?:demander|demandez|demande)\s+(?:[àa]|aux|au|quels?|quelles?|si|les?|une?|comment|pourquoi|quand)(?=\s|$)/i.test(sentence)
        && !/\b(?:jamais|sans demander)|\bne\b[\s\S]*\bpas\b/i.test(sentence));
    if (narrativeQuestions.length) { questions = limitedList([...questions, ...narrativeQuestions], "questions de qualification"); source("supportContext.diagnosticQuestions", "bodyMarkdown.demonstration"); }
  }
  if (!steps.length) addMissing("Décrire les étapes métier : des libellés de contrôles seuls ne constituent pas une procédure.");
  if (steps.some((step) => generic.test(step.instruction) || generic.test(step.objective))) addMissing("Remplacer les étapes génériques par les actions et repères propres à ce parcours.");
  if (steps.length > 50) { overflow.push(`Étapes supplémentaires\n${steps.slice(50).map((step) => step.instruction).join("\n")}`); addMissing("Le parcours dépasse 50 étapes ; il doit être structuré avant validation."); }
  if (demonstration.length && !rawSteps.length && !metadataSteps.length) {
    warn("Procédure issue des explications de la démonstration ; les libellés seuls et repères techniques ont été exclus.");
    addMissing("Reformuler et vérifier la narration de démonstration, ses conditions et son résultat : les explications enregistrées peuvent être tronquées sans marque visible.");
  }
  if (entry.length) source("entry", "bodyMarkdown.entry");
  if (metadataSteps.length && rawSteps.length && JSON.stringify(metadataSteps.map((step) => normalize(step.instruction))) !== JSON.stringify(rawSteps.map(normalize))) {
    warn("Les étapes sémantiques structurées sont prioritaires ; confronter leur version au texte du tutoriel lors de la revue.");
    addMissing("Rapprocher les étapes sémantiques et les étapes écrites du tutoriel avant validation.");
    overflow.push(`Étapes écrites à rapprocher\n${rawSteps.join("\n")}`);
  }
  const explicitVersion = typeof input.metadata.sourceMetadata?.productVersion === "string"
    ? limitedText(sanitize(input.metadata.sourceMetadata.productVersion, "metadata.sourceMetadata.productVersion"), 100, "version produit") : "";
  const titleVersion = input.title.match(/\(\s*(V\d+(?:\.\d+)*)\s*\)/i)?.[1].toLocaleUpperCase("fr") ?? "";
  const productVersion = explicitVersion || titleVersion;
  if (productVersion) source("productVersion", explicitVersion ? "metadata.sourceMetadata.productVersion" : "contentItem.title");
  if (explicitVersion && titleVersion && normalize(explicitVersion).replace(/^v/, "") !== normalize(titleVersion).replace(/^v/, "")) {
    addMissing("La version produit indiquée dans les métadonnées diffère de celle du titre ; confirmer le périmètre avant validation.");
    overflow.push(`Version du titre : ${titleVersion}\nVersion des métadonnées : ${explicitVersion}`);
  }
  const sourceGroup = typeof input.metadata.sourceMetadata?.group === "string" ? input.metadata.sourceMetadata.group : "";
  if (/r[eé]sili|annul(?:er|ation)\s+(?:un|l['’])?\s*abonnement|rembours|paiement|factur|cr[eé]dit|pr[eé]l[eè]vement/i.test(`${input.title} ${objective} ${sourceGroup}`)) {
    const guard = "Cette connaissance décrit le parcours ; elle n’autorise aucune opération financière ni traitement autonome d’une résiliation. La navigation vers les factures reste soumise à une connaissance validée ; les actions sensibles relèvent de l’humain.";
    escalation = limitedText([escalation, guard].filter(Boolean).join("\n"), 5_000, "reprise sûre", guard);
    warn("Périmètre financier ou résiliation : connaissance descriptive, sans droit d’action supplémentaire."); source("escalation", "policy:PRODUCT_GUARDRAILS");
  }
  const entryPoint = limitedText(entry.join("\n"), 5_000, "point d’entrée");
  const sourceNotes = [...new Set([...preamble, ...supplements, ...overflow])].flatMap((note) => {
    const pieces: string[] = [];
    for (let offset = 0; offset < note.length; offset += 10_000) pieces.push(note.slice(offset, offset + 10_000));
    return pieces;
  });
  if (sourceNotes.length > 50) throw new Error("ONBOARDING_KNOWLEDGE_SOURCE_CONTEXT_REQUIRES_SPLIT");
  const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective, applicability: "sav_only", locale: input.locale, productVersion,
    prerequisites, expectedResult, exceptions, escalation, steps: steps.slice(0, 50),
    supportContext: { symptoms: signals, diagnosticQuestions: questions, responseTemplate: "" },
    onboardingContext: { entryPoint, sourceNotes, sourceSections } });
  const supportBody = ["## Objectif", document.objective, "## Quand utiliser cette connaissance", ...signals,
    ...(entry.length ? ["## Point d’entrée", ...entry] : []), "## Prérequis", ...prerequisites, "## Questions de qualification", ...questions,
    "## Procédure sourcée", ...document.steps.map((step, index) => `${index + 1}. ${step.instruction}`),
    "## Vérification de réussite", expectedResult, "## Variantes et blocages", ...exceptions, "## Reprise sûre", escalation,
    ...(preamble.length ? ["## Précisions préalables de la source", ...preamble] : []),
    ...(supplements.length ? ["## Compléments transmis par le staff", ...supplements] : []),
    ...(overflow.length ? ["## Éléments sourcés à structurer avant validation", ...overflow] : []),
    ...(sourceSections.length ? ["## Sections sourcées à qualifier", ...onboardingSectionsBody(document)] : []),
    ...(missing.length ? ["## À compléter avant validation", ...missing.map((value) => `- ${value}`)] : []),
  ].filter(Boolean).join("\n\n");
  assertSafeOnboardingKnowledge(document);
  return { title: input.title, document, quality: { state: missing.length ? "needs_completion" : "ready", missing, warnings }, provenance, supportBody };
}


function hasUnsafeKnowledgeText(value: string) {
  return redactSavLearningText(value) !== value.trim()
    || /\b(?:https?:\/\/|www\.)\S+|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|<[^>]+>|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/i.test(value)
    || secretAssignment.test(value) || /\+\d{1,3}(?:[ .-]?\d){7,14}\b/i.test(value)
    || /(?:^|\s)\/[a-z][a-z0-9/_?=&.-]*(?:\s|$)|(?:^|[\s('"«])#[a-z][\w-]*|\[(?:data-|aria-)[^\]]+\]|\b(?:document|window)\.[a-z]+|\bjavascript\s*:|\b(?:coordonn[eé]es|coordinates)\s*:?\s*\(?\d+\s*[,;]\s*\d+/i.test(value)
    || /^(?:nom du client|client|contact|adresse|identifiant|email)\s*:/i.test(value)
    || technical.test(value) || explicitCssSelector.test(value);
}

/** Re-check the semantic allowlist after a human edit; this is not publication approval. */
export function assertSafeOnboardingKnowledge(document: CanonicalKnowledge): void {
  const parsed = canonicalKnowledgeSchema.parse(document);
  const inspect = (value: unknown): void => {
    if (typeof value === "string") {
      if (hasUnsafeKnowledgeText(value)) throw new Error("ONBOARDING_KNOWLEDGE_UNSAFE_CONTENT");
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => { if (key !== "id") inspect(child); });
  };
  inspect(parsed);
}


/** Structural completion is required in addition to Ugo's sourced human review. */
export function assertCompleteOnboardingKnowledge(document: CanonicalKnowledge): void {
  const parsed = canonicalKnowledgeSchema.parse(document);
  if (!onboardingSectionsQualified(parsed)) throw new Error("ONBOARDING_SOURCE_SECTIONS_REVIEW_REQUIRED");
  if (!parsed.steps.length) throw new Error("ONBOARDING_KNOWLEDGE_STEPS_REQUIRED");
  // An old display objective can survive an edit; the actual procedure must be concrete.
  if (parsed.steps.some((step) => generic.test(step.instruction) || truncation.test(step.instruction))) throw new Error("ONBOARDING_KNOWLEDGE_GENERIC_STEPS");
  if (!parsed.prerequisites.length) throw new Error("ONBOARDING_KNOWLEDGE_PREREQUISITES_REQUIRED");
  if (!parsed.expectedResult.trim() || generic.test(parsed.expectedResult) || truncation.test(parsed.expectedResult)) throw new Error("ONBOARDING_KNOWLEDGE_RESULT_REQUIRED");
  if (!parsed.supportContext?.symptoms.length) throw new Error("ONBOARDING_KNOWLEDGE_SITUATIONS_REQUIRED");
  if (parsed.escalation.trim().length < 3) throw new Error("ONBOARDING_KNOWLEDGE_RECOVERY_REQUIRED");
}
