import Link from "next/link";
import { getAgent } from "@/lib/agents";
import { listContent } from "@/lib/workflow";
import { requireStaff } from "@/lib/auth";
export const dynamic="force-dynamic";
export default async function ValidationsPage(){await requireStaff("admin");const rows=(await listContent()).filter(({item})=>item.status==="in_review");return <><div className="page-intro compact"><div><span className="eyebrow">Validation</span><h1>{rows.length} contenus attendent une décision</h1><p>Relisez le contenu, puis publiez-le avec votre compte administrateur. La version active ne change jamais si l’indexation échoue.</p></div></div><div className="review-queue">{rows.map(({item})=>{const agent=getAgent(item.agentKey);return <Link className="review-card card" href={`/studio/contenus/${item.id}`} key={item.id}><span className="agent-badge" style={{borderColor:agent.color}}>{agent.name}</span><div><strong>{item.title}</strong><p>{item.summary}</p></div><span>Relire →</span></Link>})}{rows.length===0&&<div className="empty card">Tout est validé. Les prochains brouillons soumis apparaîtront ici.</div>}</div></>}
