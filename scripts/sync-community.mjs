#!/usr/bin/env node
// Sync the community.obsidian.md listing to the latest GitHub release and wait
// for the automated review to finish — fully scripted, no manual clicking.
//
// Prereq: the web-access CDP proxy is running on localhost:3456 and your
// Chrome is signed in to community.obsidian.md (Obsidian account).
//   node ~/.claude/skills/web-access/scripts/check-deps.mjs
//
// Usage:
//   node scripts/sync-community.mjs <plugin-id> <expected-version>
//   node scripts/sync-community.mjs media-transcript 1.0.6
//
// What it does:
//   1. Opens the plugin entry page in a background tab.
//   2. Opens the "…" (More actions) menu and clicks "Check for new releases"
//      — using a shadow-DOM-piercing search so it never depends on brittle
//      selectors, and an open-then-verify loop so it never toggles the menu
//      shut by double-clicking.
//   3. Confirms the "A scan has been queued" screen shows the expected version.
//   4. Polls the review until it leaves "Pending" and reports Completed/Failed.
//   5. Closes the tab it opened (never touches your other tabs).

const PROXY = process.env.CDP_PROXY || "http://localhost:3456";
const [, , PLUGIN_ID, EXPECT_VERSION] = process.argv;

if (!PLUGIN_ID || !EXPECT_VERSION) {
  console.error("usage: node scripts/sync-community.mjs <plugin-id> <expected-version>");
  process.exit(2);
}

const ENTRY = `https://community.obsidian.md/account/plugins/${PLUGIN_ID}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(target, fn) {
  // fn is a function; we send its source as an IIFE string.
  const body = `(${fn.toString()})()`;
  const res = await fetch(`${PROXY}/eval?target=${target}`, { method: "POST", body });
  if (!res.ok) throw new Error(`eval failed: ${res.status}`);
  const data = await res.json();
  return data.value;
}

async function openTab(url) {
  const res = await fetch(`${PROXY}/new?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  return data.targetId || data.id;
}

async function navigate(target, url) {
  await fetch(`${PROXY}/navigate?target=${target}&url=${encodeURIComponent(url)}`);
}

async function closeTab(target) {
  await fetch(`${PROXY}/close?target=${target}`).catch(() => {});
}

// --- Injected page functions (run in the browser, shadow-DOM aware) ---------

// Is the "Check for new releases" menu item currently visible?
function menuItemVisible() {
  let found = false;
  const walk = (root) => {
    root.querySelectorAll("a,button,[role=menuitem]").forEach((i) => {
      if ((i.innerText || i.textContent || "").trim() === "Check for new releases") {
        const r = i.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) found = true;
      }
    });
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  return found;
}

// Click the "More actions" (…) button.
function clickMoreActions() {
  const all = [];
  const walk = (root) => {
    root.querySelectorAll("button").forEach((b) => all.push(b));
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  const b = all.find((x) => /more actions/i.test(x.innerText || x.getAttribute("aria-label") || ""));
  if (!b) return "NOT_FOUND";
  const r = b.getBoundingClientRect();
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) =>
    b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })));
  return "CLICKED";
}

// Click the "Check for new releases" menu item.
function clickCheckReleases() {
  let target = null;
  const walk = (root) => {
    root.querySelectorAll("a,button,[role=menuitem]").forEach((i) => {
      if ((i.innerText || i.textContent || "").trim() === "Check for new releases" && !target) {
        const r = i.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) target = i;
      }
    });
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  if (!target) return "NOT_FOUND";
  target.scrollIntoView({ block: "center" });
  const r = target.getBoundingClientRect();
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) =>
    target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })));
  return "CLICKED";
}

// Read the queued-scan confirmation banner text (whole page, shadow-aware).
function readQueuedBanner() {
  let txt = "";
  const walk = (root) => {
    root.querySelectorAll("*").forEach((el) => {
      if (!el.children.length) txt += " " + (el.innerText || el.textContent || "");
    });
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  return txt.replace(/\s+/g, " ").trim();
}

// Read the TOP review row: its version and status word.
function readTopReview() {
  const rows = [];
  const walk = (root) => {
    root.querySelectorAll("*").forEach((el) => {
      const t = (el.innerText || el.textContent || "").trim();
      if (!el.children.length && /^(Completed|Pending|Failed|In progress)$/i.test(t)) {
        const r = el.getBoundingClientRect();
        rows.push({ status: t, y: r.top });
      }
    });
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  rows.sort((a, b) => a.y - b.y);
  const top = rows[0] || null;
  // version text somewhere on page
  let all = "";
  const gather = (root) => {
    all += " " + (root.body ? root.body.innerText : "");
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) gather(el.shadowRoot); });
  };
  gather(document);
  const vm = all.match(/Version:\s*([\d.]+)/i);
  const incomplete = /results are incomplete|still running/i.test(all);
  return JSON.stringify({ status: top && top.status, version: vm && vm[1], incomplete });
}

// --- Main flow --------------------------------------------------------------

async function main() {
  console.log(`→ opening ${ENTRY}`);
  const target = await openTab(ENTRY);
  await sleep(6000);

  // Open the menu and click the item, without toggling it shut.
  console.log("→ opening More actions menu and clicking 'Check for new releases'");
  let clicked = false;
  for (let attempt = 0; attempt < 8 && !clicked; attempt++) {
    const visible = await evalJs(target, menuItemVisible);
    if (visible) {
      const res = await evalJs(target, clickCheckReleases);
      if (res === "CLICKED") clicked = true;
    } else {
      await evalJs(target, clickMoreActions);
      await sleep(1500);
    }
  }
  if (!clicked) { await closeTab(target); throw new Error("could not click 'Check for new releases'"); }

  await sleep(4000);
  const banner = await evalJs(target, readQueuedBanner);
  if (banner.includes("scan has been queued")) {
    const okVersion = banner.includes(EXPECT_VERSION);
    console.log(`✓ scan queued${okVersion ? ` for ${EXPECT_VERSION}` : ` (WARNING: expected ${EXPECT_VERSION}, banner: "${banner.slice(0, 120)}")`}`);
  } else {
    console.log(`? no queued-scan banner detected (page said: "${banner.slice(0, 120)}") — continuing to poll anyway`);
  }

  // Poll the review until it leaves Pending.
  console.log("→ polling review status…");
  let final = null;
  for (let i = 0; i < 30; i++) {
    await sleep(15000);
    await navigate(target, ENTRY);
    await sleep(8000);
    let parsed;
    try { parsed = JSON.parse(await evalJs(target, readTopReview)); } catch { parsed = {}; }
    const { status, version, incomplete } = parsed;
    console.log(`   [${i + 1}] version=${version} status=${status} incomplete=${incomplete}`);
    if (version === EXPECT_VERSION && status && status.toLowerCase() !== "pending" && incomplete === false) {
      final = { status, version };
      break;
    }
  }

  await closeTab(target);

  if (!final) { console.log("⚠ timed out waiting for review to complete — check the entry page manually"); process.exit(1); }
  console.log(`\n${final.status === "Completed" ? "✅" : "❌"} Review ${final.status} for version ${final.version}`);
  process.exit(final.status === "Completed" ? 0 : 1);
}

main().catch((e) => { console.error("sync failed:", e.message); process.exit(1); });
