export type OperationalIdEnvironment = {
  AUTOTASK_SUPPORT_QUEUE_IDS?: string;
  AUTOTASK_INSTALL_QUEUE_IDS?: string;
  AUTOTASK_SURVEY_QUEUE_IDS?: string;
  AUTOTASK_REQUESTED_STATUS_IDS?: string;
  AUTOTASK_ACCESS_STATUS_IDS?: string;
  AUTOTASK_THIRD_PARTY_REQUEST_STATUS_IDS?: string;
  AUTOTASK_READY_TO_BOOK_QUEUE_ID?: string;
  AUTOTASK_READY_TO_BOOK_STATUS_ID?: string;
};

function configuredIds(
  environment: OperationalIdEnvironment,
  name: keyof OperationalIdEnvironment,
  multiple: boolean,
) {
  const value = environment[name]?.trim() ?? "";
  const parts = multiple ? value.split(",") : [value];
  const ids = parts.map((part) => Number(part.trim()));
  if (
    parts.some((part) => !/^\d+$/.test(part.trim())) ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new Error(
      `${name} must contain ${multiple ? "comma-separated positive safe integers" : "one positive safe integer"}.`,
    );
  }
  return ids;
}

/** The web process needs only this scope, never the worker's demand settings. */
export function readyToBookConfiguration(
  environment: OperationalIdEnvironment = process.env as OperationalIdEnvironment,
) {
  return {
    queueId: configuredIds(environment, "AUTOTASK_READY_TO_BOOK_QUEUE_ID", false)[0],
    statusId: configuredIds(environment, "AUTOTASK_READY_TO_BOOK_STATUS_ID", false)[0],
  };
}

export function operationalIdsConfiguration(
  environment: OperationalIdEnvironment = process.env as OperationalIdEnvironment,
) {
  const supportQueueIds = new Set(
    configuredIds(environment, "AUTOTASK_SUPPORT_QUEUE_IDS", true),
  );
  const installQueueIds = new Set(
    configuredIds(environment, "AUTOTASK_INSTALL_QUEUE_IDS", true),
  );
  const surveyQueueIds = new Set(
    configuredIds(environment, "AUTOTASK_SURVEY_QUEUE_IDS", true),
  );
  const requestedStatusIds = new Set(
    configuredIds(environment, "AUTOTASK_REQUESTED_STATUS_IDS", true),
  );
  const accessStatusIds = new Set(
    configuredIds(environment, "AUTOTASK_ACCESS_STATUS_IDS", true),
  );
  const thirdPartyRequestStatusIds = new Set(
    configuredIds(environment, "AUTOTASK_THIRD_PARTY_REQUEST_STATUS_IDS", true),
  );
  return {
    supportQueueIds,
    installQueueIds,
    surveyQueueIds,
    requestedStatusIds,
    accessStatusIds,
    thirdPartyRequestStatusIds,
    planningDemandStatusIds: [
      ...requestedStatusIds,
      ...accessStatusIds,
      ...thirdPartyRequestStatusIds,
    ],
    readyToBook: readyToBookConfiguration(environment),
  };
}

export type OperationalIds = ReturnType<typeof operationalIdsConfiguration>;

export function assertConfiguredIdsExist(
  scope: string,
  configuredIds: Iterable<number>,
  liveValues: Map<number, string>,
) {
  const missing = [...configuredIds].filter((id) => !liveValues.has(id));
  if (missing.length) {
    throw new Error(
      `${scope} metadata is missing configured numeric IDs: ${missing.join(", ")}.`,
    );
  }
}
