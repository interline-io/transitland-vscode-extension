import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CliExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Paths to check when auto-detecting the transitland binary, in priority order. */
const CANDIDATE_PATHS = [
  // go install default
  path.join(os.homedir(), 'go', 'bin', 'transitland'),
  // Homebrew Apple Silicon
  '/opt/homebrew/bin/transitland',
  // Homebrew Intel / Linux
  '/usr/local/bin/transitland',
  // Linux package manager
  '/usr/bin/transitland',
];

/**
 * Resolves the path to the transitland binary.
 * Resolution order:
 *   1. Explicit path argument (from config / env)
 *   2. Candidate paths (go install, Homebrew, etc.)
 *   3. null if not found
 */
export function resolveBinaryPath(explicitPath?: string): string | null {
  if (explicitPath && explicitPath.trim()) {
    return explicitPath.trim();
  }
  for (const candidate of CANDIDATE_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface TransitlandCLIOptions {
  /** Resolved path to the transitland binary */
  binaryPath: string;
  /** Callback to write log output (stdout+stderr from CLI runs) */
  log?: (line: string) => void;
}

/** Thin wrapper around the transitland CLI binary. */
export class TransitlandCLI {
  private readonly binaryPath: string;
  private readonly log: (line: string) => void;

  constructor(opts: TransitlandCLIOptions) {
    this.binaryPath = opts.binaryPath;
    this.log = opts.log ?? (() => undefined);
  }

  /** Execute a transitland subcommand. Resolves with stdout on success (exit 0), rejects with CliError otherwise. */
  exec(args: string[], signal?: AbortSignal): Promise<CliExecResult> {
    return new Promise((resolve, reject) => {
      this.log(`$ transitland ${args.join(' ')}`);

      const child = cp.spawn(this.binaryPath, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        this.log(chunk.toString().trimEnd());
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          child.kill();
          reject(new CliError('Cancelled', -1, ''));
        });
      }

      child.on('error', (err) => {
        reject(new CliError(`Failed to spawn transitland: ${err.message}`, -1, ''));
      });

      child.on('close', (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        const exitCode = code ?? -1;
        if (exitCode === 0) {
          resolve({ stdout, stderr, exitCode });
        } else {
          reject(new CliError(`transitland exited with code ${exitCode}`, exitCode, stderr));
        }
      });
    });
  }

  /** Returns the version string from `transitland version`. */
  async version(): Promise<string> {
    const result = await this.exec(['version']);
    return result.stdout.trim();
  }
}
