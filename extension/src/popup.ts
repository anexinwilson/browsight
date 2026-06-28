import { TIMER_OPTIONS, type Tier } from "./permissions/policy.ts";
/**
 * The toolbar popup: grant the current site a tier (read-only / full-control) with an optional
 * timer, and manage existing grants. Runs `chrome.permissions.request` from the button click (a
 * user gesture), so Chrome's native host-permission prompt is shown.
 */
import { grantSite, listGrants, revokeSite } from "./permissions/storage.ts";

let selectedTier: Tier = "full";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing #${id}`);
  }
  return node as T;
}

async function currentOrigin(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) {
    return null;
  }
  try {
    return new URL(tab.url).origin;
  } catch {
    return null;
  }
}

async function renderList(): Promise<void> {
  const list = el<HTMLUListElement>("list");
  const grants = await listGrants();
  list.replaceChildren();
  if (grants.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "none yet";
    list.append(li);
    return;
  }
  for (const g of grants) {
    const li = document.createElement("li");
    const site = document.createElement("span");
    site.className = "site";
    const remaining =
      g.expiresAt === null
        ? "never"
        : `${Math.max(0, Math.round((g.expiresAt - Date.now()) / 60000))}m left`;
    site.textContent = `${g.origin} · ${g.tier === "full" ? "full" : "read"} · ${remaining}`;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.addEventListener("click", () => {
      void revokeSite(g.origin).then(renderList);
    });
    li.append(site, x);
    list.append(li);
  }
}

async function init(): Promise<void> {
  const origin = await currentOrigin();
  el<HTMLDivElement>("origin").textContent = origin ?? "(no site)";

  const timer = el<HTMLSelectElement>("timer");
  for (const opt of TIMER_OPTIONS) {
    const o = document.createElement("option");
    o.value = String(opt.ms);
    o.textContent = opt.label;
    timer.append(o);
  }

  const tierRow = el<HTMLDivElement>("tier");
  const buttons = Array.from(tierRow.querySelectorAll("button"));
  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      selectedTier = (btn.dataset.tier as Tier | undefined) ?? "full";
      for (const b of buttons) {
        b.classList.toggle("sel", b === btn);
      }
    });
  }

  el<HTMLButtonElement>("grant").addEventListener("click", () => {
    if (!origin) {
      return;
    }
    const raw = el<HTMLSelectElement>("timer").value;
    const ms = raw === "null" ? null : Number(raw);
    const expiresAt = ms === null ? null : Date.now() + ms;
    void grantSite({ origin, tier: selectedTier, expiresAt }).then((ok) => {
      if (ok) {
        void renderList();
      }
    });
  });

  await renderList();
}

void init();
