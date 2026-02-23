export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

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

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });

  await Promise.race([
    Promise.all([
      readStream(proc.stdout, stdoutChunks, stream),
      readStream(proc.stderr, stderrChunks, false),
      proc.exited,
    ]),
    timeout,
  ]);

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
