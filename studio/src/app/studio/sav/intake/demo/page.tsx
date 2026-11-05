import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDemoStaff } from "./demo-auth";
import { formatParisDateTime } from "@/lib/paris-date";
import styles from "../intake.module.css";
import { DEMO_OWNERS, DEMO_SETS, PILOT_EVIDENCE, demoCaseHref, demoConsoleEnabled, demoCounts, demoListHref, demoOwnerLabels, demoRows, demoSetCounts, demoSetLabels, readDemoFilter } from "./demo-cases";
import { DemoCaseLink, DemoListPosition } from "./demo-navigation";
import pilot from "./demo.module.css";
import { PILOT_HANDS, pilotHandLabels } from "./pilot-access-evidence";

export const dynamic = "force-dynamic";

// The V2 cases (the three John cases and the access pilot) as a fictitious demonstration in the real console layout. 404 in a production build before anything else;
// then the Studio session with the SAV menu's access rule (demo-auth.ts). One fixed source in code (demo-cases.ts), no store, no HubSpot, no Gmail, no form that writes.
export default async function SavDemoListPage({ searchParams }: { searchParams: Promise<{ set?: string; owner?: string; q?: string }> }) {
  if (!demoConsoleEnabled()) notFound();
  await requireDemoStaff();
  const query = await searchParams, filter = readDemoFilter(query);
  const counts = demoCounts(filter?.q ?? "", filter?.set ?? null), setCounts = demoSetCounts(filter?.q ?? ""), rows = filter ? demoRows(filter) : [];
  const origin = demoListHref(filter ?? { set: null, owner: null, q: "" });
  // An owner tab with no case at all in the current journey is not shown (unless it is the selected one); the search never hides a tab.
  const present = demoCounts("", filter?.set ?? null);
  // Who has the hand among the pilot rows shown, from the same rows as the list.
  const pilotRows = rows.filter(c => c.pilot), hands = PILOT_HANDS.map(h => [h, pilotRows.filter(c => c.pilot!.hand === h).length] as const);
  // Changing the journey keeps the search and resets the owner tab; changing the owner keeps the journey and the search.
  const setTab = (set: string | null) => demoListHref({ set: set as never, owner: null, q: filter?.q ?? "" });
  const tab = (owner: string | null) => demoListHref({ set: filter?.set ?? null, owner: owner as never, q: filter?.q ?? "" });
  return <div className={styles.console}>
    <DemoListPosition origin={origin}/>
    <header className={styles.heading}><div><span className="eyebrow">SAV · démonstration V2</span><h1>Cas fictifs : ancien cas John et pilote accès</h1>
      <p>Données synthétiques seulement : aucun client, aucun ticket HubSpot, aucun mail réel. Aucune commande, rien n’est envoyé.</p></div>
      <div className={styles.actions}><Link className="button secondary" href="/studio/sav/intake">Suivi réel des dossiers</Link><Link className="button secondary" href="/studio/sav/v2">Pilote V2</Link></div></header>
    <section className={styles.notice} aria-label="Démonstration"><h2>Démonstration, pas un suivi réel</h2>
      <p>Ces dossiers sont écrits dans le code de cette version, pour montrer le parcours V2 : mail V1, admission, puis SAV Pilote ou l’équipe. Le pilote accès est lu dans un artefact de preuves synthétique et versionné : chaque étape dit si elle vient de la production d’aujourd’hui, d’un test local du pôle A, d’une donnée fictive ou d’un résultat non vérifié ; le propriétaire SAV Pilote est fictif. Le suivi réel reste dans « Suivi réel des dossiers » et « Pilote V2 » : cette page n’y lit et n’y écrit rien. Les branchements réels (relais, admission, préparation de la réponse) ne sont pas encore raccordés à cette démonstration.</p></section>
    {!PILOT_EVIDENCE.ok && <section className={styles.notice} role="alert" aria-label="Preuves du pilote"><h2>Preuves du pilote accès illisibles</h2>
      <p>L’artefact des preuves a été refusé ({PILOT_EVIDENCE.reason}) : aucun cas pilote n’est affiché plutôt qu’un pilote partiel.</p></section>}
    <nav aria-label="Parcours" className={styles.views}>
      {[null, ...DEMO_SETS].map(set => <Link key={set ?? "all"} href={setTab(set)} aria-current={filter && (filter.set ?? null) === set ? "page" : undefined}>
        <span>{set ? demoSetLabels[set] : "Tous les parcours"}</span><b>{setCounts[set ?? "all"]}</b></Link>)}
    </nav>
    <nav aria-label="Responsable actuel" className={styles.views}>
      {[null, ...DEMO_OWNERS].filter(owner => owner === null || owner === filter?.owner || present[owner] > 0).map(owner => <Link key={owner ?? "all"} href={tab(owner)} aria-current={(filter?.owner ?? null) === owner && filter ? "page" : undefined}>
        <span>{owner ? demoOwnerLabels[owner] : "Tous les cas"}</span><b>{counts[owner ?? "all"]}</b></Link>)}
    </nav>
    {pilotRows.length > 0 && <p className={pilot.handSummary} aria-label="Qui a la main, pilote accès">Pilote accès, qui a la main :
      {hands.map(([h, n]) => <span key={h} className={pilot.hand} data-hand={h}>{pilotHandLabels[h]} : {n}</span>)}</p>}
    <div className={styles.controls}><span/>
      <form method="get" className={styles.search} action="/studio/sav/intake/demo">{filter?.set && <input type="hidden" name="set" value={filter.set}/>}{filter?.owner && <input type="hidden" name="owner" value={filter.owner}/>}
        <label className={styles.srOnly} htmlFor="demo-search">Rechercher un objet</label>
        <input id="demo-search" type="search" name="q" maxLength={120} defaultValue={filter?.q ?? ""} placeholder="Objet"/>
        <button type="submit" className="secondary">Rechercher</button></form></div>
    {!filter ? <div className={styles.empty} role="alert"><h2>Filtre non reconnu</h2><p>Ce filtre n’existe pas dans la démonstration.</p><Link href="/studio/sav/intake/demo">Revenir à tous les cas</Link></div>
      : <section aria-label="Cas de démonstration" className={styles.list}>
        {rows.length ? rows.map(c => <DemoCaseLink key={c.ref} id={c.ref} origin={origin} href={demoCaseHref(c.ref, origin)} className={styles.row}>
          <div><strong>{c.title}</strong><span>{c.subject} · {c.from}</span></div>
          <div><span className={styles.status}>{c.state}</span><small>Responsable actuel : {demoOwnerLabels[c.owner]}</small>{c.pilot && <span className={pilot.rowHand}><span className={pilot.hand} data-hand={c.pilot.hand}>{pilotHandLabels[c.pilot.hand]}</span></span>}
            {c.pilot?.cause && <small>Cause de non-prise : {c.pilot.cause}</small>}{c.pilot && <small>Production aujourd’hui : {c.pilot.today}</small>}<small>Prochaine action : {c.next}</small></div>
          <div><span>{demoSetLabels[c.set]}</span><time dateTime={c.receivedAt}>{formatParisDateTime(new Date(c.receivedAt))}</time></div>
        </DemoCaseLink>) : <div className={styles.empty}><h2>Aucun cas pour ce filtre</h2><p>{filter.q ? "Aucun objet ne correspond à la recherche." : "Aucun cas de ce parcours n’a ce responsable."}</p><Link href={demoListHref({ set: filter.set, owner: filter.owner, q: "" })}>Effacer la recherche</Link></div>}
      </section>}
    <footer className={styles.pagination}><span>{rows.length} cas affiché{rows.length > 1 ? "s" : ""} sur {counts.all} · démonstration</span><div/></footer>
  </div>;
}
