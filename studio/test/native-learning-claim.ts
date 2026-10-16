// Invoked explicitly by the isolated native qualification runner, never by production.
import { createSavNativeTestDb } from "./sav-native-db";
import { claimSavLearningComparisonTx } from "../src/lib/sav/learning-admission";
const value = process.env.SAV_TEST_POSTGRES_URL;
const run = process.argv[2];
if (!value || !/^native-[a-z0-9]+$/.test(run)) throw new Error("SAV_NATIVE_TEST_ARGUMENTS_REQUIRED");
const fixture = await createSavNativeTestDb(value, process.env.SAV_TEST_POSTGRES_TOKEN);
try {
  const result = await fixture.db.transaction(tx => claimSavLearningComparisonTx(tx, {
    sourceRef: `hubspot:${run}`, sourceHash: run, origin: "hubspot", inputHash: run,
  }));
  console.log(JSON.stringify({ claimed: result.claimed }));
} finally {
  await fixture.client.close();
}
