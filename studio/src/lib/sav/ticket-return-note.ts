/** New commands use a versioned generic note. Existing persisted commands retain
 * their original body; reconciliation always compares their dispatch snapshot. */
export const SAV_TICKET_RETURN_NOTE_VERSION = 2;
export function savTicketReturnNote(status: "open" | "closed") {
  return status === "closed"
    ? "Le client a renvoyé un email sur ce sujet. Le ticket est rouvert et repasse en Nouveau."
    : "Le client a renvoyé un email sur ce sujet. Le ticket repasse en Nouveau.";
}
