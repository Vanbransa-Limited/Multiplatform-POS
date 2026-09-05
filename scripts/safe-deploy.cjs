#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { resolveFirebaseCli } = require("./lib/toolchain.cjs");

const PRODUCTION_PROJECT = "vanbransa-pos";
const repositoryRoot = path.resolve(__dirname, "..");
const supplied = process.argv.slice(2);

function options(name) {
  const values = [];
  const consumed = new Set();
  for (let index = 0; index < supplied.length; index += 1) {
    const value = supplied[index];
    if (value.startsWith(`${name}=`)) {
      values.push(value.slice(name.length + 1));
      consumed.add(index);
    } else if (value === name) {
      values.push(supplied[index + 1] ?? "");
      consumed.add(index);
      consumed.add(index + 1);
      index += 1;
    }
  }
  return { values, consumed };
}

if (supplied.some((value) => value.startsWith("-P"))) {
  console.error("Use exactly one --project <project-id>; the -P alias is not accepted.");
  process.exit(1);
}

const projectOptions = options("--project");
if (projectOptions.values.length !== 1) {
  console.error("Deployment requires exactly one explicit --project <project-id>.");
  process.exit(1);
}
const project = projectOptions.values[0];
if (!project || !/^[a-z][a-z0-9-]{4,29}$/.test(project)) {
  console.error(
    "Deployment requires an explicit Firebase project: npm run deploy -- --project <staging-project-id>",
  );
  process.exit(1);
}

const rcPath = path.join(repositoryRoot, ".firebaserc");
if (fs.existsSync(rcPath)) {
  try {
    const aliases = JSON.parse(fs.readFileSync(rcPath, "utf8")).projects ?? {};
    if (typeof aliases[project] === "string" && aliases[project] !== project) {
      console.error("Pass the concrete Firebase project ID, not a .firebaserc alias.");
      process.exit(1);
    }
  } catch (error) {
    console.error(`Cannot validate .firebaserc: ${error.message}`);
    process.exit(1);
  }
}

if (project.startsWith("demo-")) {
  console.error("demo-* project ids are emulator-only and cannot be deployed.");
  process.exit(1);
}

const confirmationOptions = options("--confirm-production");
if (confirmationOptions.values.length > 1) {
  console.error("Pass --confirm-production at most once.");
  process.exit(1);
}
const confirmation = confirmationOptions.values[0] ?? null;
if (project === PRODUCTION_PROJECT && confirmation !== PRODUCTION_PROJECT) {
  console.error(
    `Production deployment is locked. Re-run with --confirm-production=${PRODUCTION_PROJECT} only after approval.`,
  );
  process.exit(1);
}

const consumed = new Set([
  ...projectOptions.consumed,
  ...confirmationOptions.consumed,
]);
const forwarded = supplied.filter((_, index) => !consumed.has(index));
const cli = resolveFirebaseCli(repositoryRoot);
const result = spawnSync(
  cli.command,
  [
    ...cli.argumentsPrefix,
    "deploy",
    ...forwarded,
    "--project",
    project,
    "--non-interactive",
  ],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: cli.shell ?? false,
    windowsHide: true,
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
