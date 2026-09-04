const SHUTDOWN_TIMEOUT_MS = 5_000;

const withDeadline = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Runtime shutdown deadline exceeded")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export async function closeRuntimeResources(
  closeHttp: () => Promise<void>,
  closeDatabase: () => Promise<void>,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let primaryError: unknown;
  try {
    await withDeadline(closeHttp(), timeoutMs);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await withDeadline(closeDatabase(), timeoutMs);
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) throw primaryError;
}
