const { spawn } = require('child_process');

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * @param {string} root - Working directory for child processes
 * @returns {{ run: Function, runKubectl: Function }}
 */
function createRun(root) {
  function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd: opts.cwd || root,
        shell: false,
        env: { ...process.env, PATH: process.env.PATH || DEFAULT_PATH },
        ...opts,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      proc.on('error', reject);
    });
  }

  function runKubectl(args, opts = {}) {
    return run('kubectl', args, opts);
  }

  return { run, runKubectl };
}

module.exports = { createRun };
