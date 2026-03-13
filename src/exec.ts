export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const killProcessTree = (pid: number): void => {
  try {
    // Kill entire process group (negative PID) to catch child processes
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process group kill failed, fall back to direct kill
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }

  // Follow up with SIGKILL after 5s in case SIGTERM is ignored
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }, 5_000).unref();
};

export const exec = async (
  command: string,
  options: { timeoutMs?: number; stream?: boolean } = {}
): Promise<ExecResult> => {
  const { timeoutMs = 120_000, stream = false } = options;

  const proc = Bun.spawn(["bash", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const readStream = async (
    reader: ReadableStream<Uint8Array>,
    chunks: string[],
    streamToConsole: boolean
  ) => {
    const r = reader.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      const text = decoder.decode(value);
      chunks.push(text);
      if (streamToConsole) process.stdout.write(text);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      killProcessTree(proc.pid);
      reject(new Error(`command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      Promise.all([
        readStream(proc.stdout, stdoutChunks, stream),
        readStream(proc.stderr, stderrChunks, false),
        proc.exited,
      ]),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode: proc.exitCode ?? 1,
  };
};

export const execOrThrow = async (
  command: string,
  options: { timeoutMs?: number; stream?: boolean } = {}
): Promise<string> => {
  const result = await exec(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `command failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
};

/** Retry a git command on .lock contention with linear backoff */
export const gitRetry = async (
  command: string,
  options: { maxAttempts?: number; baseDelayMs?: number; timeoutMs?: number } = {}
): Promise<string> => {
  const { maxAttempts = 5, baseDelayMs = 2_000, timeoutMs } = options;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await execOrThrow(command, { timeoutMs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts || !msg.includes(".lock")) throw err;
      const delay = baseDelayMs * attempt;
      console.warn(`git lock contention, retrying in ${delay}ms (${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
};
