import { z } from "zod";

export const SAV_INTAKE_INVALID_SOURCE = "SAV_INTAKE_MESSAGE_METADATA_INVALID";

/** Only transport address validation is isolated. Storage, authentication and
 * other validation failures must still surface; never log the rejected value. */
export function invalidIntakeAddressMetadata(error: unknown) {
  return error instanceof z.ZodError && error.issues.length > 0
    && error.issues.every(issue => issue.path[0] === "fromEmail" || issue.path[0] === "toEmails");
}
