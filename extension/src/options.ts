import { TIMER_OPTIONS, type Tier } from "./permissions/policy.ts";
/**
 * The options page: manage every grant in a table, and add a site by URL. The pure decisions live
 * in `policy.ts`; this page is the management UI over `chrome.storage` + host permissions.
 */
import { grantSite, listGrants, revokeSite } from "./permissions/storage.ts";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing #${id}`);
  }
  return node as T;
}

function setStatus(text: string): void {
  el<HTMLDivElement>("status").textContent = text;
}

async function render(): Promise<void> {
  const tbody = el<HTMLTableSectionElement>("rows");
  const grants = await listGrants();
  tbody.replaceChildren();
  for (const g of grants) {
    const tr = document.createElement("tr");
    const expires = g.expiresAt === null ? "never" : new Date(g.expiresAt).toLocaleString();
    for (const text of [g.origin, g.tier === "full" ? "full control" : "read only", expires]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    const action = document.createElement("td");
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      void revokeSite(g.origin).then(render);
    });
    action.append(remove);
    tr.append(action);
    tbody.append(tr);
  }
}

async function init(): Promise<void> {
  const timer = el<HTMLSelectElement>("timer");
  for (const opt of TIMER_OPTIONS) {
    const o = document.createElement("option");
    o.value = String(opt.ms);
    o.textContent = opt.label;
    timer.append(o);
  }
  el<HTMLButtonElement>("add").addEventListener("click", () => {
    setStatus("");
    const raw = el<HTMLInputElement>("origin").value.trim();
    if (!raw) {
      return;
    }
    let origin: string;
    try {
      origin = new URL(raw).origin;
    } catch {
      setStatus("Enter a full URL, e.g. https://example.com");
      return;
    }
    const tier = el<HTMLSelectElement>("tier").value as Tier;
    const msRaw = el<HTMLSelectElement>("timer").value;
    const ms = msRaw === "null" ? null : Number(msRaw);
    const expiresAt = ms === null ? null : Date.now() + ms;
    void grantSite({ origin, tier, expiresAt }).then((ok) => {
      if (ok) {
        el<HTMLInputElement>("origin").value = "";
        void render();
      } else {
        setStatus("Chrome declined the permission for that site.");
      }
    });
  });
  await render();
}
void init();
