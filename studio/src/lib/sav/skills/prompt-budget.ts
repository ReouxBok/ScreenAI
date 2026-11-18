export type PromptBudgetStage = "entry" | "confirm" | "decision";

export type PromptBudgetMeasurement = Readonly<{
  stage: PromptBudgetStage;
  bodyBytes: number;
  ceilingBytes: number;
  status: "pass" | "fail";
}>;

/** Measure the exact serialized wire body. A pass requires strictly less than 85% of the stage ceiling. */
export function measurePromptBudget(stage: PromptBudgetStage, body: string, ceilingBytes: number): PromptBudgetMeasurement {
  if (!Number.isSafeInteger(ceilingBytes) || ceilingBytes <= 0) {
    throw new RangeError("The prompt ceiling must be a positive safe integer in bytes");
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const fits = BigInt(bodyBytes) * BigInt(100) < BigInt(ceilingBytes) * BigInt(85);
  return { stage, bodyBytes, ceilingBytes, status: fits ? "pass" : "fail" };
}
