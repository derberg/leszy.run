import { spawn } from 'node:child_process';

/**
 * Run a command as a child process. Streams stdout/stderr to a log writer
 * (so the pipeline log gets full output) while keeping the last N lines of
 * stderr in memory for inclusion in failure emails.
 */
export function runCommand({ argv, env, cwd, logWrite, stderrTailLines = 50, timeoutMs = 30 * 60 * 1000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrTail = [];
    const pushStderr = (line) => {
      stderrTail.push(line);
      if (stderrTail.length > stderrTailLines) stderrTail.shift();
    };

    let stdoutBuf = '';
    let stderrBuf = '';

    const drainLines = (chunk, onLine) => {
      const idx = chunk.lastIndexOf('\n');
      if (idx === -1) return chunk;
      const head = chunk.slice(0, idx);
      const tail = chunk.slice(idx + 1);
      for (const line of head.split('\n')) onLine(line);
      return tail;
    };

    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString('utf8');
      stdoutBuf = drainLines(stdoutBuf, (line) => logWrite(`${line}\n`));
    });
    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
      stderrBuf = drainLines(stderrBuf, (line) => {
        logWrite(`${line}\n`);
        pushStderr(line);
      });
    });

    const timeout = setTimeout(() => {
      logWrite(`[timeout] killing process after ${timeoutMs}ms\n`);
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    timeout.unref();

    proc.on('error', (err) => {
      clearTimeout(timeout);
      pushStderr(`spawn error: ${err.message}`);
      resolve({ exitCode: -1, durationMs: Date.now() - started, stderrTail: stderrTail.join('\n'), error: err });
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      // Flush any trailing buffer that didn't end with \n
      if (stdoutBuf) logWrite(`${stdoutBuf}\n`);
      if (stderrBuf) {
        logWrite(`${stderrBuf}\n`);
        pushStderr(stderrBuf);
      }
      resolve({
        exitCode: code ?? (signal ? 143 : -1),
        signal,
        durationMs: Date.now() - started,
        stderrTail: stderrTail.join('\n'),
      });
    });
  });
}
