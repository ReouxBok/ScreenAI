import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./chunking";
describe("chunkMarkdown",()=>{
  it("découpe par sections et conserve les titres",()=>{const chunks=chunkMarkdown("# Gmail\n\nIntroduction.\n\n## Connexion\n\nOuvrez le catalogue.\n\n## Résultat\n\nLe compte apparaît.",60);expect(chunks.length).toBeGreaterThanOrEqual(3);expect(chunks.some(c=>c.heading==="Connexion")).toBe(true);expect(chunks.map(c=>c.ordinal)).toEqual(chunks.map((_,i)=>i));});
  it("ne perd aucun texte utile lors d'un gros paragraphe",()=>{const text="mot ".repeat(1000);const chunks=chunkMarkdown(text,200);expect(chunks.every(c=>c.content.length<=200)).toBe(true);expect(chunks.join).not.toBeNull();});
});
