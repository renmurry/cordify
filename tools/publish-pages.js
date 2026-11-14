#!/usr/bin/env node
/*
 * Builds the live site with three channels and (with --push) publishes it to the gh-pages branch.
 *
 *   /           Latest    the newest release tag (v1.2.3)
 *   /previous/  Previous  the release before it, as a fallback
 *   /preview/   Preview   a branch not released yet (an open pull request), to try first
 *   /channels.json        which version each channel holds; the app's version menu reads it
 *
 * Previous and Preview work online only: their service worker is replaced by one that caches
 * nothing, so they never disturb the offline copy of Latest. A bar at the top of their pages
 * says which version you are on and links back to Latest. All three share this browser's
 * saved data (history, sheets, saved boundary), because they are on the same site.
 *
 * Usage (from the repository folder):
 *   node tools/publish-pages.js --out <folder>            build only, to look at or serve locally
 *   node tools/publish-pages.js --push                    build and publish to gh-pages
 *   options:  --preview <branch|ref>   what Preview shows (default: main, if it has unreleased commits)
 *             --no-preview             leave Preview out
 *             --latest <ref>           test a build as if <ref> were the newest release (with --out only)
 */
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const PUSH = !!opt("--push"), OUT = opt("--out");
if (!PUSH && !OUT) {
  console.error("Say where to build (--out <folder>) or publish it (--push).");
  process.exit(1);
}
if (PUSH && opt("--latest")) {
  console.error("--latest is for local testing only; it cannot be published.");
  process.exit(1);
}

const run = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: "utf8", stdio: [ "ignore", "pipe", "pipe" ], ...o }).trim();
const git = (...a) => run("git", a);

// Files that belong to development, not to the site.
const LEAVE_OUT = [ "tests", "tools", "package.json", "package-lock.json", ".gitignore", ".gitattributes", "README.md", "CLAUDE.md", "AGENTS.md" ];

// Release tags, newest first: v3.10.0 comes after v3.9.0.
const semver = t => (t.match(/^v(\d+)\.(\d+)\.(\d+)$/) || []).slice(1).map(Number);
const tags = git("tag", "--list", "v*").split("\n").filter(t => semver(t).length === 3)
  .sort((a, b) => { const x = semver(a), y = semver(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
if (!tags.length) {
  console.error("No release tags (v1.2.3) found.");
  process.exit(1);
}
const latestRef = typeof opt("--latest") === "string" ? opt("--latest") : tags[0];
const previousRef = tags[latestRef === tags[0] ? 1 : 0] || null;
let previewRef = null;
if (!opt("--no-preview")) {
  if (typeof opt("--preview") === "string") previewRef = opt("--preview");
  else if (+git("rev-list", "--count", `${tags[0]}..main`) > 0) previewRef = "main";
}

// A release can carry a name: the first word of its tag message, when the message starts
// with "Name: …" or "Name — …" (git tag -a v3.10.0 -m "Fable: …").
function nameOf(ref) {
  if (semver(ref).length !== 3) return "";
  const subject = git("tag", "-l", "--format=%(contents:subject)", ref);
  const m = subject.match(/^([A-Z][A-Za-z]{1,19})(?=\s*[:—–-]\s)/);
  return m ? m[1] : "";
}

// What to show for a ref: its tag (or branch name), its name if it has one, short commit and date.
function describe(ref) {
  const sha = git("rev-parse", "--short", `${ref}^{commit}`);
  const date = git("log", "-1", "--format=%cs", `${ref}^{commit}`);
  const version = semver(ref).length === 3 ? ref : /^[0-9a-f]{7,40}$/i.test(ref) ? sha : `${ref} (${sha})`;
  return { ref, version, name: nameOf(ref), commit: sha, date };
}

// Writes the files of a ref into a folder, exactly as stored in git (no tar needed, so it works
// the same with any shell on Windows, macOS or Linux).
function extract(ref, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = run("git", [ "ls-tree", "-r", "-z", "--name-only", `${ref}^{commit}` ]).split("\0").filter(Boolean);
  for (const f of files) {
    if (LEAVE_OUT.some(x => f === x || f.startsWith(`${x}/`))) continue;
    const data = execFileSync("git", [ "show", `${ref}^{commit}:${f}` ], { maxBuffer: 1 << 28 });
    const to = path.join(dir, ...f.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, data);
  }
}

const PASS_THROUGH_SW = `// This channel works online only. Its own offline copy is switched off so that it
// never disturbs the offline copy of the latest version on the same site.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
`;

// A channel other than Latest: online only, with a bar saying which version it is.
function markChannel(dir, label, info, note) {
  fs.writeFileSync(path.join(dir, "service-worker.js"), PASS_THROUGH_SW);
  const file = path.join(dir, "index.html");
  const html = fs.readFileSync(file, "utf8");
  const bar = `<div class="cordify-channel-bar" style="padding:7px 14px;font:600 13px/1.45 system-ui,'Segoe UI',Roboto,sans-serif;background:#7a4a00;color:#fff;text-align:center">` +
    `You are using the <b>${label}</b> version (${info.version}${info.name ? ` “${info.name}”` : ""}, ${info.date}). ${note} ` +
    `<a href="../" style="color:#fff;text-decoration:underline">Go to the latest version</a></div>`;
  fs.writeFileSync(file, html.replace(/<body([^>]*)>/i, m => `${m}\n${bar}`));
}

const build = OUT ? path.resolve(OUT) : fs.mkdtempSync(path.join(os.tmpdir(), "cordify-pages-"));
fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });

const channels = [];
const latest = describe(latestRef);
extract(latestRef, build);
channels.push({ id: "latest", label: "Latest", path: "./", ...latest });
if (previousRef) {
  const info = describe(previousRef);
  extract(previousRef, path.join(build, "previous"));
  markChannel(path.join(build, "previous"), "Previous", info, "Use it if the latest version gives you trouble. It works online only.");
  channels.push({ id: "previous", label: "Previous", path: "previous/", ...info });
}
if (previewRef) {
  const info = describe(previewRef);
  extract(previewRef, path.join(build, "preview"));
  markChannel(path.join(build, "preview"), "Preview", info, "It is not released yet: try new features here first. It works online only, and shares saved data with the latest version.");
  channels.push({ id: "preview", label: "Preview", path: "preview/", ...info });
}
fs.writeFileSync(path.join(build, "channels.json"), JSON.stringify({ built: new Date().toISOString(), channels }, null, 1) + "\n");
fs.writeFileSync(path.join(build, ".nojekyll"), "");   // publish files as they are, without Jekyll
console.log(`Built in ${build}`);
channels.forEach(c => console.log(`  ${c.label.padEnd(8)} /${c.path === "./" ? "" : c.path}  ${c.version}${c.name ? ` “${c.name}”` : ""}  ${c.date}`));

if (PUSH) {
  // Publish: replace the gh-pages branch's files with the build, as one new commit.
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "cordify-gh-pages-"));
  fs.rmSync(wt, { recursive: true, force: true });
  let exists = true;
  try {
    git("fetch", "origin", "gh-pages");
  } catch (e) {
    exists = false;
  }
  if (exists) git("worktree", "add", "-B", "gh-pages", wt, "origin/gh-pages");
  else git("worktree", "add", "--orphan", "-b", "gh-pages", wt);
  try {
    for (const f of fs.readdirSync(wt)) if (f !== ".git") fs.rmSync(path.join(wt, f), { recursive: true, force: true });
    fs.cpSync(build, wt, { recursive: true });
    run("git", [ "-C", wt, "add", "-A" ]);
    const changed = run("git", [ "-C", wt, "status", "--porcelain" ]);
    if (!changed) {
      console.log("Nothing changed; gh-pages is already up to date.");
    } else {
      run("git", [ "-C", wt, "commit", "-q", "-m", `Publish: ${channels.map(c => `${c.label} ${c.version}`).join(", ")}` ]);
      run("git", [ "-C", wt, "push", "origin", "gh-pages" ]);
      console.log("Published to gh-pages.");
    }
  } finally {
    git("worktree", "remove", "--force", wt);
  }
}
