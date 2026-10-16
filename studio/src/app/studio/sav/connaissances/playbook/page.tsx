import Link from "next/link";
import { requireSavStaff } from "@/lib/sav/auth";
import { getSavPlaybookWorkspace } from "@/lib/sav/playbook";
import { canManageSavPlaybook, savTicketProcessInstruction } from "@/lib/sav/playbook-contract";
import { PlaybookEditor } from "./playbook-editor";
export const dynamic = "force-dynamic";
export default async function SavPlaybookPage() {
  const staff = await requireSavStaff();
  const workspace = await getSavPlaybookWorkspace(staff.email);
  return <div className="stack"><Link href="/studio/sav/connaissances">← Connaissances</Link>
    <header><h1>Master prompt SAV</h1><p>Les règles pour gérer les dossiers et rédiger les réponses. Les procédures de résolution restent dans les fiches de connaissances.</p></header>
    <details><summary>Process et protections appliqués par le serveur</summary><p>{savTicketProcessInstruction()}</p></details>
    <PlaybookEditor initial={workspace} canManage={canManageSavPlaybook(staff.email)}/>
  </div>;
}
