const KNOWN_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "CAA", "SRV"]);
const PROXYABLE = new Set(["A", "AAAA", "CNAME"]);

const TYPE_COPY = {
  A: ["IPv4 address", "Points this name at an IPv4 address, such as 192.0.2.1."],
  AAAA: ["IPv6 address", "Points this name at an IPv6 address, such as 2001:db8::1."],
  CNAME: ["Hostname", "Points this name at another hostname. It cannot point at itself."],
  TXT: ["Text", "Publishes a piece of text. Often used to verify a domain or set email policy."],
  MX: ["Mail server", "Routes email for this name to a mail server. Lower priority is preferred."],
  NS: ["Name server", "Delegates this name to another name server."],
  CAA: ["CAA value", 'Says which certificate authorities may issue certificates. Example: 0 issue "letsencrypt.org".'],
  SRV: ["Service", "Points a service name at a host and port."],
};

const state = {
  zones: [],
  truncatedZones: false,
  selectedId: sessionStorage.getItem("zoneboard-zone") || "",
  records: [],
  truncatedRecords: false,
  zoneQuery: "",
  recordQuery: "",
  recordType: "ALL",
  editingId: "",
  pendingDelete: null,
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showConnect(data.error || "Connect your Cloudflare account to continue.");
    throw new Error(data.error || "Connect your Cloudflare account to continue.");
  }
  if (!response.ok) {
    throw new Error(data.error || "Zoneboard could not complete that request.");
  }
  return data;
}

function showConnect(message) {
  $("#app-view").hidden = true;
  $("#connect-view").hidden = false;
  const error = $("#connect-error");
  if (message) {
    error.hidden = false;
    error.textContent = message;
  }
}

function showApp() {
  $("#connect-view").hidden = true;
  $("#app-view").hidden = false;
  $("#connect-error").hidden = true;
}

function toast(message, kind = "ok") {
  const node = $("#toast");
  node.hidden = false;
  node.dataset.kind = kind;
  node.textContent = message;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 4200);
}

function displayName(fqdn, zoneName) {
  const name = fqdn.replace(/\.$/, "");
  const zone = zoneName.replace(/\.$/, "");
  if (name.toLowerCase() === zone.toLowerCase()) return "@";
  const suffix = `.${zone.toLowerCase()}`;
  if (name.toLowerCase().endsWith(suffix)) return name.slice(0, -suffix.length);
  return name;
}

function formatTtl(ttl) {
  if (ttl === 1) return "Auto";
  if (ttl % 86400 === 0) return ttl === 86400 ? "1 day" : `${ttl / 86400} days`;
  if (ttl % 3600 === 0) return ttl === 3600 ? "1 hour" : `${ttl / 3600} hours`;
  if (ttl % 60 === 0) return `${ttl / 60} min`;
  return `${ttl} sec`;
}

function selectedZone() {
  return state.zones.find((zone) => zone.id === state.selectedId) || null;
}

async function boot() {
  const session = await api("/api/session");
  if (!session.connected) {
    showConnect();
    return;
  }
  showApp();
  await loadZones();
}

async function loadZones() {
  $("#zone-meta").textContent = "Loading domains…";
  const data = await api("/api/zones");
  state.zones = data.zones || [];
  state.truncatedZones = Boolean(data.truncated);
  if (!state.zones.some((zone) => zone.id === state.selectedId)) {
    state.selectedId = state.zones[0]?.id || "";
  }
  renderZones();
  if (state.selectedId) await selectZone(state.selectedId);
  else renderDetail();
}

function renderZones() {
  const query = state.zoneQuery.trim().toLowerCase();
  const zones = state.zones.filter((zone) => zone.name.toLowerCase().includes(query));
  const list = $("#zone-list");
  list.replaceChildren();
  const total = state.zones.length;
  const suffix = state.truncatedZones ? " Showing the first batch." : "";
  $("#zone-meta").textContent = query
    ? `${zones.length} of ${total} domains${suffix}`
    : `${total} domain${total === 1 ? "" : "s"}${suffix}`;

  if (zones.length === 0) {
    const item = document.createElement("li");
    item.className = "meta";
    item.textContent = total === 0
      ? "This token cannot see any domains yet."
      : "No domains match that search.";
    list.append(item);
    return;
  }

  for (const zone of zones) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zone-button";
    button.setAttribute("aria-current", zone.id === state.selectedId ? "true" : "false");
    const name = document.createElement("strong");
    name.textContent = zone.name;
    const status = document.createElement("small");
    status.textContent = zone.paused ? "Paused" : capitalize(zone.status);
    button.append(name, status);
    button.addEventListener("click", () => {
      selectZone(zone.id).catch((error) => toast(error.message, "error"));
    });
    const item = document.createElement("li");
    item.append(button);
    list.append(item);
  }
}

async function selectZone(id) {
  state.selectedId = id;
  sessionStorage.setItem("zoneboard-zone", id);
  renderZones();
  renderDetail();
  await loadRecords();
}

function renderDetail() {
  const zone = selectedZone();
  $("#zone-empty").hidden = Boolean(zone);
  $("#zone-detail").hidden = !zone;
  if (!zone) return;
  $("#zone-account").textContent = zone.accountName || "Cloudflare zone";
  $("#zone-name").textContent = zone.name;
  const status = zone.paused ? "Paused" : capitalize(zone.status);
  $("#zone-status").textContent = `${status} · ${zone.type} setup`;
  $("#nameservers").textContent = zone.nameServers.length
    ? `Nameservers: ${zone.nameServers.join(", ")}`
    : "Cloudflare has not listed nameservers for this domain.";
}

async function loadRecords() {
  const zone = selectedZone();
  if (!zone) return;
  $("#records-error").hidden = true;
  $("#record-meta").textContent = "Loading records…";
  try {
    const data = await api(`/api/zones/${zone.id}/records`);
    state.records = data.records || [];
    state.truncatedRecords = Boolean(data.truncated);
    renderRecords();
  } catch (error) {
    if ($("#connect-view").hidden) {
      $("#records-error").hidden = false;
      $("#records-error").textContent = error.message;
      $("#record-meta").textContent = "";
    }
    throw error;
  }
}

function visibleRecords() {
  const query = state.recordQuery.trim().toLowerCase();
  const zone = selectedZone();
  return state.records
    .filter((record) => {
      if (state.recordType === "OTHER") return !KNOWN_TYPES.has(record.type);
      if (state.recordType !== "ALL" && record.type !== state.recordType) return false;
      if (!query) return true;
      const relative = zone ? displayName(record.name, zone.name) : record.name;
      return [record.type, record.name, relative, record.content, record.comment]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
}

function renderRecords() {
  const zone = selectedZone();
  const rows = $("#record-rows");
  rows.replaceChildren();
  const records = visibleRecords();
  const suffix = state.truncatedRecords ? " Showing the first batch." : "";
  $("#record-meta").textContent = `${records.length} shown of ${state.records.length}${suffix}`;
  const empty = $("#records-empty");
  empty.hidden = records.length !== 0;
  empty.textContent = state.records.length === 0
    ? "This domain has no DNS records yet. Add the first one."
    : "No records match this view.";
  if (!zone) return;

  for (const record of records) {
    const row = document.createElement("tr");
    row.append(
      cell(chip(record.type), "td"),
      nameCell(record, zone.name),
      valueCell(record),
      proxyCell(record),
      textCell(formatTtl(record.ttl)),
      actionsCell(record),
    );
    rows.append(row);
  }
}

function cell(node, tag) {
  const element = document.createElement(tag);
  element.append(node);
  return element;
}

function textCell(value) {
  const element = document.createElement("td");
  element.textContent = value;
  return element;
}

function chip(type) {
  const element = document.createElement("span");
  element.className = "chip";
  element.textContent = type || "—";
  return element;
}

function nameCell(record, zoneName) {
  const wrapper = document.createElement("div");
  wrapper.className = "name-cell";
  const strong = document.createElement("strong");
  strong.textContent = displayName(record.name, zoneName);
  const full = document.createElement("span");
  full.textContent = record.name;
  wrapper.append(strong, full);
  if (record.comment) {
    const note = document.createElement("span");
    note.className = "comment";
    note.textContent = record.comment;
    wrapper.append(note);
  }
  return cell(wrapper, "td");
}

function valueCell(record) {
  const element = document.createElement("td");
  element.textContent = record.priority !== null && record.type === "MX"
    ? `${record.priority} ${record.content}`
    : record.content || "—";
  return element;
}

function proxyCell(record) {
  const element = document.createElement("td");
  if (!record.proxiable && !PROXYABLE.has(record.type)) {
    element.textContent = "—";
    return element;
  }
  const badge = document.createElement("span");
  badge.className = record.proxied ? "proxy" : "proxy dns";
  badge.textContent = record.proxied ? "Proxied" : "DNS only";
  element.append(badge);
  return element;
}

function actionsCell(record) {
  const wrapper = document.createElement("div");
  wrapper.className = "row-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "text-button";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openRecordDialog(record));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "text-button danger";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => openDeleteDialog(record));
  wrapper.append(edit, remove);
  return cell(wrapper, "td");
}

function openRecordDialog(record) {
  const form = $("#record-form");
  form.reset();
  state.editingId = record?.id || "";
  $("#record-dialog-title").textContent = record ? "Edit record" : "Add a record";
  $("#record-save").textContent = record ? "Save changes" : "Add record";
  $("#record-error").hidden = true;
  const zone = selectedZone();
  if (record && zone) {
    $("#field-type").value = KNOWN_TYPES.has(record.type) ? record.type : "A";
    $("#field-name").value = displayName(record.name, zone.name);
    $("#field-content").value = record.type === "TXT" ? "" : record.content;
    $("#field-txt").value = record.type === "TXT" ? record.content : "";
    $("#field-priority").value = record.priority ?? 10;
    $("#field-srv-priority").value = record.priority ?? 0;
    $("#field-weight").value = record.weight ?? 0;
    $("#field-port").value = record.port ?? 443;
    $("#field-target").value = record.target || "";
    $("#field-proxied").checked = Boolean(record.proxied);
    $("#field-comment").value = record.comment || "";
    setTtl(record.ttl);
  } else {
    setTtl(1);
  }
  syncRecordFields();
  $("#record-dialog").showModal();
  $("#field-name").focus();
}

function setTtl(ttl) {
  const select = $("#field-ttl");
  const known = ["1", "120", "300", "3600", "86400"];
  if (known.includes(String(ttl))) {
    select.value = String(ttl);
    $("#field-ttl-custom").value = "";
  } else {
    select.value = "custom";
    $("#field-ttl-custom").value = String(ttl);
  }
  $("#custom-ttl-label").hidden = select.value !== "custom";
}

function syncRecordFields() {
  const type = $("#field-type").value;
  const [label, hint] = TYPE_COPY[type];
  $("#record-hint").textContent = hint;
  const isTxt = type === "TXT";
  const isSrv = type === "SRV";
  $("#content-label").hidden = isTxt || isSrv;
  $("#txt-label").hidden = !isTxt;
  $("#mx-fields").hidden = type !== "MX";
  $("#srv-fields").hidden = !isSrv;
  $("#proxy-label").hidden = !PROXYABLE.has(type);
  $("#content-label-text").textContent = label;
  $("#field-content").required = !isTxt && !isSrv;
  $("#field-txt").required = isTxt;
  $("#field-target").required = isSrv;
  const proxied = $("#field-proxied").checked && PROXYABLE.has(type);
  $("#field-ttl").disabled = proxied;
  $("#field-ttl-custom").disabled = proxied;
  if (proxied) $("#field-ttl").value = "1";
  $("#custom-ttl-label").hidden = $("#field-ttl").value !== "custom" || proxied;
}

function recordPayload() {
  const type = $("#field-type").value;
  const ttlChoice = $("#field-ttl").value;
  const ttl = ttlChoice === "custom" ? Number($("#field-ttl-custom").value) : Number(ttlChoice);
  return {
    type,
    name: $("#field-name").value,
    content: type === "TXT" ? $("#field-txt").value : $("#field-content").value,
    ttl,
    proxied: PROXYABLE.has(type) && $("#field-proxied").checked,
    priority: type === "SRV" ? Number($("#field-srv-priority").value) : Number($("#field-priority").value),
    weight: Number($("#field-weight").value),
    port: Number($("#field-port").value),
    target: $("#field-target").value,
    comment: $("#field-comment").value,
  };
}

function openDeleteDialog(record) {
  const zone = selectedZone();
  state.pendingDelete = record;
  const name = zone ? displayName(record.name, zone.name) : record.name;
  $("#confirm-title").textContent = `Remove the ${record.type} record for ${name}?`;
  $("#confirm-copy").textContent = `${record.name} currently publishes ${record.content || "this value"}. Removing it stops that answer from being served.`;
  $("#confirm-dialog").showModal();
}

function capitalize(value) {
  if (!value) return "Unknown";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

$("#toggle-token").addEventListener("click", () => {
  const input = $("#token");
  const show = !input.classList.contains("is-visible");
  input.classList.toggle("is-visible", show);
  $("#toggle-token").textContent = show ? "Hide" : "Show";
  input.focus();
});

$("#connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  $("#connect-error").hidden = true;
  try {
    await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ token: $("#token").value.trim() }),
    });
    $("#token").value = "";
    showApp();
    await loadZones();
    toast("Connected to Cloudflare.");
  } catch (error) {
    if (!$("#connect-view").hidden) {
      $("#connect-error").hidden = false;
      $("#connect-error").textContent = error.message;
    }
  } finally {
    button.disabled = false;
  }
});

$("#disconnect").addEventListener("click", async () => {
  await api("/api/session", { method: "DELETE" });
  state.zones = [];
  state.records = [];
  state.selectedId = "";
  sessionStorage.removeItem("zoneboard-zone");
  showConnect();
  toast("Disconnected.");
});

$("#zone-search").addEventListener("input", (event) => {
  state.zoneQuery = event.target.value;
  renderZones();
});

$("#record-search").addEventListener("input", (event) => {
  state.recordQuery = event.target.value;
  renderRecords();
});

$("#record-type").addEventListener("change", (event) => {
  state.recordType = event.target.value;
  renderRecords();
});

$("#refresh-records").addEventListener("click", () => {
  loadRecords().catch((error) => toast(error.message, "error"));
});

$("#add-record").addEventListener("click", () => openRecordDialog(null));
$("#field-type").addEventListener("change", syncRecordFields);
$("#field-proxied").addEventListener("change", syncRecordFields);
$("#field-ttl").addEventListener("change", syncRecordFields);

$("#record-cancel").addEventListener("click", () => $("#record-dialog").close());
$("#confirm-cancel").addEventListener("click", () => $("#confirm-dialog").close());

$("#record-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const zone = selectedZone();
  if (!zone) return;
  const button = $("#record-save");
  button.disabled = true;
  $("#record-error").hidden = true;
  const path = state.editingId
    ? `/api/zones/${zone.id}/records/${state.editingId}`
    : `/api/zones/${zone.id}/records`;
  try {
    await api(path, {
      method: state.editingId ? "PATCH" : "POST",
      body: JSON.stringify(recordPayload()),
    });
    const wasEdit = Boolean(state.editingId);
    $("#record-dialog").close();
    await loadRecords();
    toast(wasEdit ? "Record updated." : "Record added.");
  } catch (error) {
    if ($("#record-dialog").open) {
      $("#record-error").hidden = false;
      $("#record-error").textContent = error.message;
    } else {
      toast(error.message, "error");
    }
  } finally {
    button.disabled = false;
  }
});

$("#confirm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const zone = selectedZone();
  const record = state.pendingDelete;
  if (!zone || !record) return;
  const button = $("#confirm-delete");
  button.disabled = true;
  try {
    await api(`/api/zones/${zone.id}/records/${record.id}`, { method: "DELETE" });
    $("#confirm-dialog").close();
    state.pendingDelete = null;
    await loadRecords();
    toast("Record removed.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

boot().catch((error) => {
  showConnect(error.message);
});
