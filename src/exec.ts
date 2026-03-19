export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ErrorCode =
  | 'ERR_TIMEOUT'
  | 'ERR_GIT_LOCK'
  | 'ERR_GIT_NETWORK'
  | 'ERR_GIT_AUTH'
  | 'ERR_BUILD_FAILED'
  | 'ERR_NO_CHANGES'
  | 'ERR_UNKNOWN';

export class OneshotError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'OneshotError';
  }
}

const classifyError = (stderr: string, stdout: string): ErrorCode => {
  const combined = `${stderr} ${stdout}`.toLowerCase();
  if (combined.includes('.lock')) return 'ERR_GIT_LOCK';
  if (combined.includes('could not resolve host') || combined.includes('connection refused') || combined.includes('connection timed out') || combined.includes('unable to access')) return 'ERR_GIT_NETWORK';
  if (combined.includes('authentication failed') || combined.includes('permission denied') || combined.includes('invalid credentials')) return 'ERR_GIT_AUTH';
  if (combined.includes('tsc') || combined.includes('type error') || combined.includes('build failed') || combined.includes('eslint') || combined.includes('compilation failed')) return 'ERR_BUILD_FAILED';
  return 'ERR_UNKNOWN';
};

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
      reject(new OneshotError(`command timed out after ${timeoutMs / 1000}s`, 'ERR_TIMEOUT'));
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
    const code = classifyError(result.stderr, result.stdout);
    throw new OneshotError(
      `command failed (exit ${result.exitCode})`,
      code,
      (result.stderr || result.stdout).slice(0, 2000),
    );
  }
  return result.stdout;
};

/** Retry a git command on lock contention or network errors with exponential backoff */
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
      const detail = err instanceof OneshotError ? err.detail ?? "" : "";
      const combined = `${msg} ${detail}`.toLowerCase();
      const isRetryable = combined.includes('.lock') || combined.includes('could not resolve host') || combined.includes('connection refused') || combined.includes('connection timed out') || combined.includes('unable to access');
      if (attempt === maxAttempts || !isRetryable) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`git contention/network error, retrying in ${delay}ms (${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new OneshotError("unreachable", 'ERR_UNKNOWN');
};
