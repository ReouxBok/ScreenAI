import { synPreviewEnabled } from "@/lib/sav/local-syn";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Suspense, type ReactNode } from "react";
import type { StaffIdentity } from "@/lib/auth";
import { staffRoleLabel } from "@/lib/access";
import { NavigationTrail } from "./ui/back-link";
import uiStyles from "./ui/ui.module.css";
import { StudioMenu } from "./studio-nav";
import { studioNavigation } from "./studio-navigation";
import styles from "./studio-shell.module.css";

export function StudioShell({ staff, children }: { staff: StaffIdentity; children: ReactNode }) {
  const isDevelopmentAuthBypass =
    synPreviewEnabled() || (process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_BYPASS === "true");

  return <div className={`${uiStyles.theme} ${styles.shell}`}>
    <Suspense fallback={null}><NavigationTrail/></Suspense>
    <aside className={styles.sidebar}>
      <Link href="/studio" className={styles.brand}><span className={styles.brandMark} aria-hidden="true">C</span><span><strong>Studio Charly</strong><small>Apprentissage interne</small></span></Link>
      <StudioMenu groups={studioNavigation(staff)}>
        <div className={styles.account}>
          {isDevelopmentAuthBypass ? <span className={styles.avatar} aria-label="Compte de test">{staff.name.charAt(0)}</span> : <UserButton showName={false} appearance={{ elements: { userButtonTrigger: { width: "32px", height: "32px" } } }}/>}
          <div><strong>{staff.name}</strong><span>{staffRoleLabel(staff.role)}</span><span>{staff.email}</span></div>
        </div>
      </StudioMenu>
    </aside>
    <main className={styles.main}><div className={styles.topline}><span>{synPreviewEnabled() ? "Simulation locale SYN · aucun service réel" : "Charly apprend en continu"}</span><span className={styles.live}>{synPreviewEnabled() ? "Lecture seule · aucun envoi" : "Base synchronisée"}</span></div>{children}</main>
  </div>;
}
