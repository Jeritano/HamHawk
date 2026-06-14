import { seedChokepoints } from "./chokepoints";
import { db } from "./client";

export async function seed() {
  await seedChokepoints();
}

seed()
  .then(async () => {
    await db.$client.end();
  })
  .catch(async (e) => {
    console.error(e);
    await db.$client.end();
    process.exit(1);
  });
