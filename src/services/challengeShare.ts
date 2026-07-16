export async function writeTextWithTimeout(
  writeText: (text: string) => Promise<void>,
  text: string,
  timeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Clipboard write timed out."));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      Promise.resolve().then(() => writeText(text)),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
