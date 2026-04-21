/**
 * Shell-completion script emitter tests.
 *
 * Guards against three classes of breakage:
 *   1. Subcommand list drift — if a new command gets added to `index.ts`
 *      but not to `completion.ts`, users lose TAB completion for it.
 *   2. Session-id subcommand list drift — same, for the session-id path.
 *   3. Generated-script shape — the scripts have to be sourceable by their
 *      respective shells. Unit tests can't run bash/zsh/pwsh parsers, but
 *      they CAN pin marker strings so obvious corruption trips a test.
 */

import { describe, test, expect } from 'bun:test';
import {
  SUBCOMMANDS,
  SESSION_ID_SUBCOMMANDS,
  generateBashCompletion,
  generateZshCompletion,
  generatePowerShellCompletion,
  generateCompletionScript,
} from '../src/completion.ts';

describe('completion — subcommand lists', () => {
  test('SESSION_ID_SUBCOMMANDS is a subset of SUBCOMMANDS', () => {
    for (const cmd of SESSION_ID_SUBCOMMANDS) {
      expect(SUBCOMMANDS).toContain(cmd);
    }
  });

  test('SUBCOMMANDS includes the core commands users actually type', () => {
    // Canary: if one of these ever gets renamed or removed, we want the test
    // to scream, because users' muscle memory will crash into a missing completion.
    for (const core of ['analyze', 'list', 'waste', 'fix', 'optimize', 'timeline']) {
      expect(SUBCOMMANDS).toContain(core);
    }
  });

  test('SESSION_ID_SUBCOMMANDS does not accidentally include commands with no session-id arg', () => {
    // `list`, `trend`, `calibrate`, `doctor`, `hooks`, `statusline`, `bench`,
    // `compare` (takes two session ids), `completion` itself — none of these
    // take a single positional session-id, so they must NOT be in the set.
    for (const notSessionScoped of ['list', 'trend', 'calibrate', 'doctor', 'hooks', 'statusline', 'bench', 'compare', 'completion']) {
      expect(SESSION_ID_SUBCOMMANDS).not.toContain(notSessionScoped);
    }
  });
});

describe('completion — bash script', () => {
  const script = generateBashCompletion();

  test('contains the complete -F registration', () => {
    expect(script).toContain('complete -F _claude_crusts_completion claude-crusts');
  });

  test('contains all top-level subcommands in the commands list', () => {
    for (const cmd of SUBCOMMANDS) {
      // Whole-word check: cmd should appear surrounded by word boundaries
      // in the `commands="..."` declaration.
      expect(script).toMatch(new RegExp(`\\b${cmd}\\b`));
    }
  });

  test('calls back into the binary for session ids', () => {
    expect(script).toContain('claude-crusts completion ids');
  });

  test('never inlines JSON parsing (spec: scripts stay portable without jq/node)', () => {
    expect(script).not.toContain('jq ');
    expect(script).not.toContain('JSON.parse');
  });
});

describe('completion — zsh script', () => {
  const script = generateZshCompletion();

  test('declares compdef for claude-crusts', () => {
    expect(script).toContain('#compdef claude-crusts');
  });

  test('uses _describe for both subcommand and session-id layers', () => {
    const describeCount = (script.match(/_describe /g) ?? []).length;
    expect(describeCount).toBe(2);
  });

  test('contains all top-level subcommands', () => {
    for (const cmd of SUBCOMMANDS) {
      expect(script).toContain(`'${cmd}'`);
    }
  });
});

describe('completion — pwsh script', () => {
  const script = generatePowerShellCompletion();

  test('uses Register-ArgumentCompleter -Native', () => {
    expect(script).toContain('Register-ArgumentCompleter -Native -CommandName claude-crusts');
  });

  test('emits CompletionResult objects', () => {
    expect(script).toContain('[System.Management.Automation.CompletionResult]::new');
  });

  test('contains all top-level subcommands', () => {
    for (const cmd of SUBCOMMANDS) {
      expect(script).toContain(`'${cmd}'`);
    }
  });

  test('calls back into the binary for session ids', () => {
    expect(script).toContain('claude-crusts completion ids');
  });
});

describe('generateCompletionScript — dispatch', () => {
  test('dispatches to bash generator', () => {
    expect(generateCompletionScript('bash')).toBe(generateBashCompletion());
  });

  test('dispatches to zsh generator', () => {
    expect(generateCompletionScript('zsh')).toBe(generateZshCompletion());
  });

  test('dispatches to pwsh generator', () => {
    expect(generateCompletionScript('pwsh')).toBe(generatePowerShellCompletion());
  });
});

describe('completion — generator determinism', () => {
  // Completion scripts are sourced into the user's shell rc; we don't want
  // them churning (and re-ordering subcommands) between invocations.
  test('bash output is byte-identical across two invocations', () => {
    expect(generateBashCompletion()).toBe(generateBashCompletion());
  });
  test('zsh output is byte-identical across two invocations', () => {
    expect(generateZshCompletion()).toBe(generateZshCompletion());
  });
  test('pwsh output is byte-identical across two invocations', () => {
    expect(generatePowerShellCompletion()).toBe(generatePowerShellCompletion());
  });
});
