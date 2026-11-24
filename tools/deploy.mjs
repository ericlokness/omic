#!/usr/bin/env node
/* Deploy the site to Cloudflare Pages with its shop functions.
 *   node tools/deploy.mjs <pages-project-name> [branch]
 *   branch "preview" (default) -> https://preview.<project>.pages.dev, uses the Preview secrets (Stripe TEST key)
 *   your production branch (usually "main") -> the live site, uses the Production secrets
 * Run it from the site's root folder. It copies the site to a temporary folder without the
 * server code, tools, spreadsheets, docs and git files, then runs `wrangler pages deploy`
 * (which bundles ./functions). Dashboard drag-and-drop uploads can't deploy functions.
 */
import { cpSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const [project, branch = "preview"] = process.argv.slice(2);
if (!project) { console.error("Usage: node tools/deploy.mjs <pages-project-name> [branch]"); process.exit(1); }
if (!existsSync("functions")) { console.error("Run this from the site's root folder (the one with functions/)."); process.exit(1); }

const SKIP = /^(\.git|\.github|\.wrangler|node_modules|functions|tools|dist|\.dev\.vars.*|\.env.*|.+\.xlsx|.+\.md|\.gitignore|brand\.json|package(-lock)?\.json)$/i;
const out = mkdtempSync(join(tmpdir(), `${project}-deploy-`));
cpSync(".", out, { recursive: true, filter: (src) => !src.split(sep).some((part) => SKIP.test(part)) });

console.log(`Deploying ${project} (${branch}) from ${out}`);
const result = process.env.DEPLOY_DRY_RUN ? { status: 0 } : spawnSync(
  "npx", ["wrangler", "pages", "deploy", out, "--project-name", project, "--branch", branch, "--commit-dirty=true"],
  { stdio: "inherit", shell: process.platform === "win32" },
);
if (!process.env.DEPLOY_DRY_RUN) rmSync(out, { recursive: true, force: true });
process.exit(result.status ?? 1);
