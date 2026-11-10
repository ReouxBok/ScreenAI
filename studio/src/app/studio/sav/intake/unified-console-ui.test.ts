import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { UnifiedConsoleOverview } from "./unified-console-overview";
import { UnifiedConsoleLine } from "./unified-console-line";
import { unifiedConsoleLine } from "./unified-console-model";
const line=unifiedConsoleLine({threadId:"synthetic",view:null,status:"processing"},{state:"confirmed",ticketId:"201"},{state:"absent"});
it("labels every summary as page-local and keeps completed work distinct from customer resolution",()=>{
 const html=renderToStaticMarkup(createElement(UnifiedConsoleOverview,{lines:{a:line,b:line}}));
 expect(html).toContain("Sur cette page");expect(html).toContain("Ticket créé ou lié : <strong>2</strong>");expect(html).toContain("ne signifie pas que le problème client est résolu");
 expect(html).toContain("Collecte non branchée");expect(html).not.toContain("État global vérifié");
});
it("empty and unavailable data cannot imply a healthy global agent",()=>{
 expect(renderToStaticMarkup(createElement(UnifiedConsoleOverview,{lines:{}}))).toContain("Aucun dossier affiché sur cette page");
 const html=renderToStaticMarkup(createElement(UnifiedConsoleOverview,{lines:{},monitoring:{state:"unavailable",coverage:"unknown",observedAt:null,causes:[]}}));
 expect(html).toContain("Collecte indisponible");expect(html).toContain("aucun rétablissement n’est confirmé");
});
it("renders partial coverage, unknown dates and escaped long causes with no command",()=>{
 const html=renderToStaticMarkup(createElement(UnifiedConsoleOverview,{lines:{a:line},monitoring:{state:"available",coverage:"partial",observedAt:null,causes:[{label:"<script>synthetic</script>"+" attente".repeat(40),nextAction:"Consulter le dossier"}]}}));
 expect(html).toContain("partielle");expect(html).toContain("date inconnue");expect(html).toContain("&lt;script&gt;");expect(html).not.toContain("<script>");expect(html).not.toContain("<form");
});
it("keeps the exact-ticket navigation and pagination return separate from dossier actions",()=>{
 const exact=unifiedConsoleLine({threadId:"synthetic",view:null,status:"human_hold"},{state:"confirmed",ticketId:"201"},{state:"found",ticketId:"201",owner:"agent",phase:"acting",updatedAt:"x",reply:{state:"unavailable"}});
 const origin="/studio/sav/intake?view=to_validate&page=2&sort=oldest";
 const html=renderToStaticMarkup(createElement(UnifiedConsoleLine,{line:exact,origin}));
 expect(html).toContain("Pause active");expect(html).toContain("returnTo=%2Fstudio%2Fsav%2Fintake%3Fview%3Dto_validate%26page%3D2%26sort%3Doldest");
 expect(html.match(/<a /g)).toHaveLength(1);expect(html).not.toContain("<button");expect(html).not.toContain("<form");
});
