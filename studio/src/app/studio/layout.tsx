import type { ReactNode } from "react";
import { requireStaff } from "@/lib/auth";
import { StudioShell } from "@/components/studio-shell";
export default async function StudioLayout({ children }: { children: ReactNode }) { const staff = await requireStaff(); return <StudioShell staff={staff}>{children}</StudioShell>; }
