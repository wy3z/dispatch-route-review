import { database } from "../platform/database";
import { provisionAdministrator } from "../modules/access/server";

const args = process.argv.slice(2);
const breakGlass = args[0] === "--break-glass";
const subject = (breakGlass ? args[1] : args[0])?.trim();

if (!subject || args.length !== (breakGlass ? 2 : 1)) {
  console.error(
    "Usage: pnpm admin:bootstrap -- <external-subject>\n" +
      "       pnpm admin:bootstrap -- --break-glass <external-subject>",
  );
  process.exitCode = 2;
} else {
  try {
    const user = await provisionAdministrator(
      subject,
      breakGlass ? "break-glass" : "bootstrap",
    );
    console.log(
      `${breakGlass ? "Break-glass" : "Bootstrap"} administrator provisioned: ` +
        `${user.display_name} <${user.email}> (${user.external_subject})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await database().end();
    globalThis.__dispatchDatabasePool = undefined;
  }
}
