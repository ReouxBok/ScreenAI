import { Fragment } from "react";
import { SkeletonBlock, SkeletonLine, SkeletonRegion } from "@/components/skeleton";
import { savIntakeViewLabels } from "@/lib/sav/intake/contract";
import styles from "./intake.module.css";

// Route-shaped placeholders reusing the console layout classes, so the real
// page replaces them in place. Only static wording is printed: counts, statuses,
// subjects and HubSpot names stay blank until the server has returned them.

const Back = () => <SkeletonLine width={150} height={14}/>;

function Heading({ eyebrow, title, subtitle, lines = 1 }: { eyebrow: string; title?: string; subtitle?: string; lines?: number }) {
  // flex: 1 so percentage widths resolve against the row, not a shrink-to-fit box.
  return <header className={styles.heading}><div style={{ flex: 1, minWidth: 0 }}>
    <span className="eyebrow">{eyebrow}</span>
    {title ? <h1>{title}</h1> : <SkeletonLine width="min(560px, 90%)" height={36} style={{ margin: "8px 0" }}/>}
    {subtitle ? <p>{subtitle}</p> : Array.from({ length: lines }, (_, i) => <SkeletonLine key={i} width={i ? "min(260px, 45%)" : "min(520px, 85%)"} height={13} style={{ marginTop: 8 }}/>)}
  </div></header>;
}

export function IntakeListSkeleton() {
  return <SkeletonRegion label="Chargement des nouveaux dossiers" className={styles.console}>
    <Heading eyebrow="SAV · nouveaux dossiers" title="Suivre le traitement" subtitle="Les actions confirmées et le suivi réel déterminent l’avancement."/>
    <nav aria-label="Vues des nouveaux dossiers" className={styles.views}>
      {Object.entries(savIntakeViewLabels).map(([key, label]) => <a key={key} aria-disabled="true">
        <span>{label}</span><SkeletonLine inline width={22} height={14}/></a>)}
    </nav>
    <div className={styles.controls}>
      <SkeletonBlock height={40} style={{ width: 280 }}/>
      <SkeletonBlock height={38} style={{ width: "min(520px, 100%)" }}/>
    </div>
    <section aria-label="Dossiers" className={styles.list}>
      {Array.from({ length: 8 }, (_, i) => <div key={i} className={styles.row}>
        <div><SkeletonLine width={`${88 - (i % 3) * 14}%`} height={16}/><SkeletonLine width="45%" height={11}/></div>
        <div><SkeletonLine width="70%" height={13}/></div>
        <div><SkeletonLine width={80} height={11}/><SkeletonLine width={110} height={11}/></div>
      </div>)}
    </section>
    <footer className={styles.pagination}><SkeletonLine width={170} height={12}/></footer>
  </SkeletonRegion>;
}

export function IntakeDetailSkeleton() {
  return <SkeletonRegion label="Chargement du dossier" className={styles.console}>
    <Back/>
    <Heading eyebrow="Dossier"/>
    <section className={styles.crmContext} aria-label="Fiche et ticket HubSpot">
      {[0, 1].map(i => <div key={i}><SkeletonLine width="55%" height={18}/><SkeletonLine width="80%" height={14}/><SkeletonLine width="40%" height={12}/></div>)}
    </section>
    <div className={styles.detailGrid}>
      <div>
        <SkeletonBlock height={320}/>
        <section className={styles.decision}><SkeletonLine width="40%" height={18}/>
          <dl>{[0, 1, 2, 3].map(i => <div key={i}><SkeletonLine width="45%" height={10} style={{ marginBottom: 6 }}/><SkeletonLine width="75%" height={13}/></div>)}</dl>
        </section>
        <section className={styles.decision}><SkeletonLine width="45%" height={18}/>
          {[0, 1, 2].map(i => <SkeletonLine key={i} width="65%" height={12} style={{ marginTop: 14 }}/>)}
        </section>
      </div>
      <aside className={styles.side}>
        <SkeletonBlock height={280}/>
        <SkeletonBlock height={140}/>
      </aside>
    </div>
  </SkeletonRegion>;
}

const budgetRows = ["Plafond effectif", "Plafond de la configuration", "Compté aujourd’hui", "Marge restante", "Appels aujourd’hui", "Sur 30 jours glissants"];

export function IntakeBudgetSkeleton() {
  return <SkeletonRegion label="Chargement du budget" className={styles.console}>
    <Back/>
    <Heading eyebrow="Administration SAV" title="Budget quotidien de l’analyse IA" lines={2}/>
    <section className={styles.choice}><h2>Aujourd’hui (jour UTC)</h2>
      <dl>{budgetRows.map(label => <Fragment key={label}><dt>{label}</dt><dd><SkeletonLine width={140} height={14}/></dd></Fragment>)}</dl>
    </section>
    <SkeletonBlock height={220}/>
    <section className={styles.choice}><h2>Derniers changements</h2>
      {[0, 1, 2].map(i => <SkeletonLine key={i} width="80%" height={12} style={{ marginTop: 10 }}/>)}
    </section>
  </SkeletonRegion>;
}

export function IntakeAdminSkeleton({ eyebrow, title, subtitle, blocks }: { eyebrow: string; title: string; subtitle: string; blocks: number[] }) {
  return <SkeletonRegion label="Chargement de l’administration" className={styles.console}>
    <Back/>
    <Heading eyebrow={eyebrow} title={title} subtitle={subtitle}/>
    {blocks.map((height, i) => <SkeletonBlock key={i} height={height}/>)}
  </SkeletonRegion>;
}
