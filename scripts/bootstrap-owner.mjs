/**
 * Creates, or takes over, a tenant's owner account.
 *
 * There is no signed-in administrator to authorise the very first account, so
 * this is gated on the deployment's bootstrap secret. Without --adopt it
 * refuses once the tenant has an active owner: it opens the door once, it is
 * not a quiet way into a business already in use.
 *
 * With --adopt it re-points the tenant's existing owner at an address and
 * password someone actually holds. That is the recovery path when the owner
 * password is lost - passwords are stored as hashes and cannot be read back,
 * by Firebase's design and by ours.
 *
 * bootstrapOwner must be exported from backend/functions/src/index.ts and
 * deployed for this to reach anything.
 *
 * Usage, from the repository root:
 *   node scripts/bootstrap-owner.mjs --tenant tenant-01 \
 *     --email owner@savahope.pos --name "Owner" --adopt
 *
 * Neither secret nor password is accepted on the command line: both are
 * prompted for and masked, so neither reaches your shell history or your
 * terminal scrollback. POS_BOOTSTRAP_SECRET in the environment is honoured for
 * unattended runs.
 */

import { createInterface } from "node:readline";
import { stdin, stdout, env } from "node:process";

const REGION = env.FIREBASE_REGION || "europe-west1";
const PROJECT = env.FIREBASE_PROJECT || "vanbransa-pos";

/** Keys read in raw mode, by code, so no control literals live in this file. */
const ENTER = 13;
const NEWLINE = 10;
const END_OF_TRANSMISSION = 4;
const INTERRUPT = 3;
const BACKSPACE = 8;
const DELETE = 127;
const FIRST_PRINTABLE = 32;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const tenantId = arg("tenant");
const email = arg("email");
const name = arg("name") ?? "Owner";
// Takes over the tenant's existing owner instead of refusing.
const adoptExisting = process.argv.includes("--adopt");

if (!tenantId || !email) {
  console.error(
    "Usage: node scripts/bootstrap-owner.mjs --tenant <id> --email <address> [--name <name>] [--adopt]\n"
      + "  --adopt   take over the tenant's existing owner (use this to recover a lost password)",
  );
  process.exit(1);
}

/**
 * Reads a line, masked when there is a terminal to mask.
 *
 * Keypresses are read in raw mode rather than through readline. Overriding
 * readline's echo hook is the usual trick for a masked prompt and it does not
 * survive a Windows terminal: the prompt either never appeared or came back
 * empty. Raw mode is more code, but it is the same code everywhere.
 *
 * Piped stdin has nothing to echo and no terminal mode to set, so that path
 * reads plain lines - which is also what makes this scriptable.
 */
let piped = null;
function secret(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    if (!piped) piped = createInterface({ input: stdin })[Symbol.asyncIterator]();
    stdout.write(prompt);
    return piped.next().then(({ value }) => {
      stdout.write("\n");
      return String(value ?? "").trim();
    });
  }

  return new Promise((resolve) => {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      resolve(value);
    };

    function onData(chunk) {
      // A paste arrives as a single chunk, so every character is handled here,
      // not just the first one.
      for (const char of String(chunk)) {
        const code = char.charCodeAt(0);

        if (code === ENTER || code === NEWLINE || code === END_OF_TRANSMISSION) {
          finish();
          return;
        }
        if (code === INTERRUPT) {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (code === BACKSPACE || code === DELETE) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        // Arrow keys and the like arrive as escape sequences; none of them
        // belong in a password.
        if (code < FIRST_PRINTABLE) continue;

        value += char;
        stdout.write("*");
      }
    }

    stdin.on("data", onData);
  });
}

const bootstrapSecret = env.POS_BOOTSTRAP_SECRET || await secret("Bootstrap secret: ");
if (!bootstrapSecret) {
  console.error("No bootstrap secret given.");
  process.exit(1);
}

const password = await secret(`New password for ${email} (min 8 chars): `);
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}
const again = await secret("Type it again: ");
if (again !== password) {
  // Nobody can read this password back afterwards, so a typo here locks the
  // account rather than merely annoying whoever set it.
  console.error("Those did not match. Nothing was changed.");
  process.exit(1);
}

const url = `https://${REGION}-${PROJECT}.cloudfunctions.net/bootstrapOwner`;
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data: { bootstrapSecret, tenantId, email, password, name, adoptExisting } }),
});

const text = await response.text();
if (!response.ok) {
  console.error(`${response.status} from bootstrapOwner\n${text}`);
  if (text.includes("already has an owner")) {
    console.error("\nPass --adopt to take that account over.");
  }
  if (text.includes("Provision the tenant")) {
    console.error(`\nNo tenant "${tenantId}" exists. Check the id against the tenants collection.`);
  }
  process.exit(1);
}

console.log(text);
console.log(`\nDone. Sign in at https://${PROJECT}.web.app with ${email}.`);
console.log("Every other device signed in as this owner is now signed out.");
