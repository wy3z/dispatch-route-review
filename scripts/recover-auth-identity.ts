import { database } from "../platform/database";
import {
  isExactExternalSubject,
  isUuid,
  recoverFinalAdministratorIdentity,
} from "../modules/access/server";

type Options = {
  userId: string;
  confirmUserId: string;
  expectedCurrentSubject: string;
  replacementSubject: string;
  confirmReplacementSubject: string;
  operator: string;
  reason: string;
  execute: boolean;
};

function usage(): never {
  throw new Error(
    "Usage: pnpm run auth:recover-identity --user-id <uuid> --confirm-user-id <same uuid> --expected-current-subject <subject> --replacement-subject <subject> --confirm-replacement-subject <same subject> --operator <change/incident id> --reason <reason> [--execute]",
  );
}

function parseArguments(argv: string[]): Options {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      if (execute) usage();
      execute = true;
      continue;
    }
    if (
      !argument.startsWith("--") ||
      !argv[index + 1]?.length ||
      argv[index + 1].startsWith("--")
    ) usage();
    if (values.has(argument)) usage();
    values.set(argument, argv[index + 1]);
    index += 1;
  }

  const allowed = new Set([
    "--user-id",
    "--confirm-user-id",
    "--expected-current-subject",
    "--replacement-subject",
    "--confirm-replacement-subject",
    "--operator",
    "--reason",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) usage();

  const options: Options = {
    userId: values.get("--user-id") ?? "",
    confirmUserId: values.get("--confirm-user-id") ?? "",
    expectedCurrentSubject: values.get("--expected-current-subject") ?? "",
    replacementSubject: values.get("--replacement-subject") ?? "",
    confirmReplacementSubject: values.get("--confirm-replacement-subject") ?? "",
    operator: values.get("--operator") ?? "",
    reason: values.get("--reason") ?? "",
    execute,
  };
  if (
    !isUuid(options.userId) ||
    options.confirmUserId !== options.userId ||
    !isExactExternalSubject(options.expectedCurrentSubject) ||
    !isExactExternalSubject(options.replacementSubject) ||
    options.confirmReplacementSubject !== options.replacementSubject ||
    options.expectedCurrentSubject === options.replacementSubject ||
    options.operator.length < 1 ||
    options.operator.length > 200 ||
    options.operator !== options.operator.trim() ||
    options.reason.length < 1 ||
    options.reason.length > 1_000 ||
    options.reason !== options.reason.trim()
  ) usage();
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await recoverFinalAdministratorIdentity(options);
  process.stdout.write(
    result.executed
      ? `Recovered authentication identity for administrator ${options.userId}; the previous subject remains active for controlled rollback.\n`
      : `Dry run passed for administrator ${options.userId}; no database changes were committed. Re-run with --execute to apply it.\n`,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Identity recovery failed."}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await database().end();
  });
