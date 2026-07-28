export interface IdleController {
  touch(): void;
  stop(): void;
}

export function parseIdleTimeoutMinutes(args: readonly string[], fallback = 30): number {
  const equalsArg = args.find((arg) => arg.startsWith("--idle-timeout="));
  const flagIndex = args.indexOf("--idle-timeout");
  const raw =
    equalsArg?.slice("--idle-timeout=".length) ??
    (flagIndex >= 0 ? args[flagIndex + 1] : undefined);
  if (raw === undefined) {
    return fallback;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new TypeError("--idle-timeout must be a non-negative number of minutes");
  }
  return minutes;
}

export function createIdleController(
  minutes: number,
  onIdle: () => void | Promise<void>,
): IdleController {
  let timer: NodeJS.Timeout | undefined;
  const timeoutMs = minutes * 60_000;

  const stop = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const touch = (): void => {
    stop();
    if (timeoutMs === 0) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void Promise.resolve(onIdle()).catch((err: unknown) => {
        process.stderr.write(`browsight idle shutdown failed: ${String(err)}\n`);
      });
    }, timeoutMs);
    timer.unref();
  };

  touch();
  return { touch, stop };
}
