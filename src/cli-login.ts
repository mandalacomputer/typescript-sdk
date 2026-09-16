import { spawn } from 'node:child_process';
import os from 'node:os';
import { CliError } from './cli-options.js';
import type { Output } from './cli-output.js';
import type { CliIO } from './cli-runtime.js';
import {
  CredentialSaveError,
  canonicalBase,
  DEFAULT_CREDENTIAL_BASE,
  readCredentials,
  saveCredentials,
  selectedProfile,
  trimCredentialWhitespace,
} from './credentials.js';
import { deviceLogin, sleepForLogin } from './device-login.js';

/** Open only a validated URL, as one argument without a shell. Failure keeps manual login usable. */
export function openLoginBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    let finished = false;
    const done = (ok: boolean) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(ok);
      }
    };
    const child = spawn(command, [url], { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, 2000);
    child.once('error', () => done(false));
    child.once('exit', (code) => done(code === 0));
  });
}

export async function loginCommand(
  profile: string | undefined,
  workspace: string | undefined,
  base: string | undefined,
  io: CliIO,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  const destination = selectedProfile({ profile }, io.env);
  // Validate before requesting a key, but reread/merge again under the final writer lock.
  readCredentials();
  const baseUrl = canonicalBase(
    base !== undefined
      ? base
      : trimCredentialWhitespace(io.env.MANDALA_BASE_URL ?? '') || DEFAULT_CREDENTIAL_BASE,
  );
  const label =
    trimCredentialWhitespace(
      Array.from(os.hostname())
        .filter((c) => c.charCodeAt(0) > 31 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159))
        .join('')
        .slice(0, 60),
    ) || 'Mandala CLI';
  const entry = await deviceLogin(
    { baseUrl, deviceName: label, workspace, signal },
    {
      fetch: io.login?.fetch ?? globalThis.fetch.bind(globalThis),
      now: io.login?.now ?? (() => performance.now()),
      sleep: io.login?.sleep ?? sleepForLogin,
      registerSecret: (secret) => {
        if (secret) {
          io.secrets?.add(secret);
          io.secrets?.add(trimCredentialWhitespace(secret));
        }
      },
      diagnostic: (message) => output.diagnostic(message),
      prompt: async ({ verificationUri, verificationUriComplete, userCode }) => {
        output.diagnostic(
          `Open ${verificationUri} and enter ${userCode}. Compare this code before approving.`,
        );
        let opened = false;
        try {
          opened = await (io.login?.openBrowser ?? openLoginBrowser)(verificationUriComplete);
        } catch {
          /* Keep the already displayed manual URL and code. */
        }
        if (!opened)
          output.diagnostic('Browser could not be opened. Continue with the URL and code above.');
      },
    },
  );
  let saved: Awaited<ReturnType<typeof saveCredentials>>;
  try {
    saved = await saveCredentials(entry, destination, { signal });
  } catch (error) {
    if (error instanceof CredentialSaveError) throw error;
    if (signal.aborted) {
      output.diagnostic(
        'Cancelled after authorization; credentials were not saved. Revoke the device-named key in Settings before a fresh explicit login.',
      );
      throw signal.reason;
    }
    throw new CliError(
      'credential_save_failed',
      'Credentials could not be saved after authorization. Revoke the device-named key in Settings before a fresh explicit login.',
    );
  }
  if (!output.json)
    output.diagnostic(
      `Saved profile ${saved.profile} to ${saved.path}. Revoke this device-named key in Settings when it is no longer needed.`,
    );
  return output.result({
    profile: saved.profile,
    base_url: baseUrl,
    account: entry.account,
    scope: entry.scope,
    saved: true,
  });
}
