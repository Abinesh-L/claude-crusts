/**
 * Cross-platform clipboard utility.
 *
 * Copies text to the system clipboard using platform-native commands:
 * - Windows: `clip`
 * - macOS: `pbcopy`
 * - Linux: `xclip` or `xsel`
 */

import { spawn } from 'child_process';
import { platform } from 'os';

/**
 * Copy text to the system clipboard.
 *
 * @param text - Text to copy
 * @returns True if the copy succeeded, false otherwise
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const os = platform();
  let cmd: string;
  let args: string[];

  if (os === 'win32') {
    cmd = 'clip';
    args = [];
  } else if (os === 'darwin') {
    cmd = 'pbcopy';
    args = [];
  } else {
    // Linux — try xclip first, fall back to xsel
    cmd = 'xclip';
    args = ['-selection', 'clipboard'];
  }

  return new Promise<boolean>((resolve) => {
    try {
      const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      proc.stdin.write(text);
      proc.stdin.end();
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => {
        if (os === 'linux' && cmd === 'xclip') {
          // Fallback to xsel on Linux
          const fallback = spawn('xsel', ['--clipboard', '--input'], {
            stdio: ['pipe', 'ignore', 'ignore'],
          });
          fallback.stdin.write(text);
          fallback.stdin.end();
          fallback.on('close', (c) => resolve(c === 0));
          fallback.on('error', () => resolve(false));
        } else {
          resolve(false);
        }
      });
    } catch {
      resolve(false);
    }
  });
}
