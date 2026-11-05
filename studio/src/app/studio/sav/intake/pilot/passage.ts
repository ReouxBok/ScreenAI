import { readFileSync } from "node:fs";
import path from "node:path";
import { decodePassageArtifact, type PassageRead } from "./passage-reader";
/** Fixed local artifact only; missing, unreadable or changed evidence stays unavailable. */
export function readPassage(): PassageRead {
  try {
    const directory = path.join(process.cwd(), "src/app/studio/sav/intake/pilot/fixtures");
    return decodePassageArtifact(readFileSync(path.join(directory, "syn-pilot-passage.v1.json"), "utf8"), JSON.parse(readFileSync(path.join(directory, "provenance.json"), "utf8")));
  } catch { return { ok: false, reason: "L’export SYN du pôle C ou sa preuve de version est absent ou illisible." }; }
}
