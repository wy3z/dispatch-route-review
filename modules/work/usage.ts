export type AutotaskUsagePayload = {
  generatedAt: string;
  periodHours: number;
  summary: {
    requestCount: number;
    lastHourRequestCount: number;
    averageRequestsPerHour: number;
    successCount: number;
    failureCount: number;
    averageDurationMs: number;
    latestRequestAt: string | null;
  };
  breakdown: Array<{
    entity: string;
    operation: string;
    requestCount: number;
    successCount: number;
    failureCount: number;
    averageDurationMs: number;
  }>;
  daily: Array<{
    day: string;
    requestCount: number;
    successCount: number;
    failureCount: number;
  }>;
};
