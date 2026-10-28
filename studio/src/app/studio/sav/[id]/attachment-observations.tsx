import type { SavAttachmentInventory, SavAttachmentMetadata, SavAttachmentObservation, SavAttachmentRead } from "@/lib/sav/attachment-contract";
import styles from "./attachment-observations.module.css";

const status: Record<SavAttachmentObservation["status"], string> = { analyzed: "Analysée", partial: "Lecture partielle", unreadable: "Illisible", unsupported: "Format non pris en charge", not_read: "Non lue" };
const reason: Record<SavAttachmentObservation["reason"], string> = {
  observed: "Observations visuelles acquises.", partial_content: "Une partie seulement est lisible.", unreadable_content: "Aucun texte fiable n’a pu être retenu.",
  unsupported_type: "La lecture accepte les captures PNG, JPEG et WebP.", legacy_reference_missing: "Ce message ancien ne possède pas de référence de fichier récupérable.",
  image_limit: "La limite de trois fichiers lus (images ou PDF) par analyse est atteinte.", byte_limit: "La taille annoncée, reçue ou totale dépasse les limites admises, ou ne correspond pas au fichier.",
  pixel_limit: "Les dimensions dépassent la limite de 16 mégapixels ou le fichier contient plusieurs images.", invalid_image: "Le fichier est vide, corrompu ou ne peut pas être décodé.",
  type_mismatch: "Le type réel du fichier ne correspond pas au type déclaré.",
  invalid_pdf: "Le PDF est vide, corrompu ou sa structure ne permet pas de compter ses pages.", pdf_encrypted: "Le PDF est chiffré ou protégé ; il n’est pas envoyé au modèle.",
  page_limit: "Le PDF dépasse la limite de cinq pages par document.", association_mismatch: "Le fichier ne correspond pas à la boîte, au message ou à la partie attendus.",
  permission_denied: "Gmail refuse l’accès à cette pièce.", not_found: "Le fichier n’est plus accessible dans Gmail.", rate_limited: "Gmail limite temporairement les lectures.",
  timeout: "La lecture a dépassé le temps disponible.", download_failed: "Le téléchargement n’a pas abouti.", provider_failed: "L’analyse visuelle n’a pas produit d’observation exploitable.",
  validation_failed: "La réponse structurée a été rejetée ; aucune panne de vision n’est déduite de ce seul rejet.",
  budget_exhausted: "La lecture n’a pas pu être réalisée dans les limites de cette analyse. Les informations du mail restent disponibles.", model_unsupported: "Le modèle configuré n’est pas qualifié pour ce lecteur.",
  in_progress: "Une lecture a été engagée, sans résultat acquis. Si elle a été interrompue, son issue reste à vérifier.", outcome_uncertain: "Une lecture précédente a été interrompue ; aucun nouvel appel automatique n’est lancé.",
  context_incomplete: "La sélection ou le contexte est incomplet ; cette pièce n’a pas été envoyée au modèle.",
  context_changed: "Le dossier ou son contenu a changé pendant la lecture ; ces observations ne sont pas utilisées.", reader_disabled: "La lecture visuelle n’est pas disponible pour cette analyse.",
};

/** Display only: no request, download, model call or mail action on render/mount. */
export function AttachmentObservations({ attachments = [], inventory, read }: { attachments?: SavAttachmentMetadata[]; inventory?: SavAttachmentInventory | null; read?: Pick<SavAttachmentRead, "readerRevision" | "observations"> | null }) {
  const incomplete = inventory?.complete === false;
  if (!attachments.length && !incomplete) return null;
  return <details className={styles.observations}>
    <summary>{attachments.length ? `${incomplete ? "Au moins " : ""}${attachments.length} pièce(s) jointe(s) — lecture et limites` : "Inventaire des pièces jointes incomplet"}</summary>
    {incomplete && <p role="status">Inventaire incomplet : une limite de collecte a été atteinte. D’autres pièces peuvent ne pas être recensées ni lues. Leur nombre et leur contenu ne sont pas connus.</p>}
    {!inventory && <p>La complétude de l’inventaire de ce message ancien ou sans métadonnée de collecte n’est pas certifiée.</p>}
    <p>Une image analysée fournit des observations à vérifier. Elle ne prouve ni l’identité du client, ni la cause du problème, ni une action réalisée.</p>
    {attachments.length > 0 && <ul aria-label="État des pièces jointes">{attachments.map((attachment, index) => {
      const observation = read?.observations[index];
      return <li key={`${index}:${attachment.filename}`}>
        <strong>{observation?.filename ?? attachment.filename}</strong> — {observation ? status[observation.status] : "Non lue"}
        <p>{observation ? reason[observation.reason] : "Aucune observation visuelle acquise pour ce message."}</p>
        {observation?.text && <pre>{observation.text}</pre>}
        {Boolean(observation?.regions.length) && <ul aria-label="Zones observées">{observation!.regions.map((region, n) => <li key={n}>{region.text}{region.box ? ` — zone ${region.box.join(", ")}/1000` : ""}</li>)}</ul>}
        {Boolean(observation?.uncertainties.length) && <p>Incertitudes : {observation!.uncertainties.join(" · ")}</p>}
        {observation?.fileHash && <details><summary>Provenance de l’observation</summary><small>Source : {observation.sourceId} · empreinte {observation.fileHash.slice(0, 12)} · lecteur {read?.readerRevision}</small></details>}
      </li>;
    })}</ul>}
  </details>;
}
