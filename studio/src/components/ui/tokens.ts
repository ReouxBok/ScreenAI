/** Values read from the Paper mockup "New Studio Design" (SAV-50). The CSS
 * custom properties in ui.module.css are the source used by components; this
 * object documents them and lets tests pin the art direction. One deliberate
 * change: the mockup's tertiary grey #7c7c7d (4.17:1) is darkened to reach AA. */
export const uiTokens = {
  font: { sans: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif", display: "\"Inter\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif" },
  color: {
    canvas: "#ffffff", sidebar: "#fafafa", surfaceMuted: "#f6f6f6", lineSubtle: "#f0f0f0", line: "#e8e8e8",
    ink: "#1d1d1e", inkSecondary: "#5e5e5f", inkTertiary: "#6f6f70", inkMuted: "#afafb0", navActive: "rgb(29 29 30 / 5%)",
    accentBg: "#e0e0ff", accentInk: "#4949a3",
    dangerBg: "#fee6e5", dangerInk: "#bc2439", dangerDot: "#ec5962",
    warningInk: "#9e420e", warningDot: "#e89a3c",
    successInk: "#436e1d", successDot: "#7fbf4d",
  },
  radius: { badge: "6px", control: "8px", field: "10px", pill: "999px" },
  space: { sidebarWidth: "264px", pageBlock: "24px", pageInline: "32px", section: "24px" },
  type: { title: "700 24px/32px", body: "500 14px/20px", meta: "400 13px/18px", badge: "600 12px/18px" },
} as const;

export type UiTone = "neutral" | "accent" | "danger" | "warning" | "success";
