export const MARK_NOT_FOUND = "NOT_FOUND";
export const MARK_INVALID = "INVALID_QUERY";
export const MARK_UNKNOWN = "Не визначено";

function cleanAppList(list, exclude) {
  if (!Array.isArray(list)) return [];
  const skip = new Set([exclude, MARK_NOT_FOUND, MARK_INVALID, MARK_UNKNOWN].filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name || skip.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function normalizeAnswer(result) {
  const safe = result && typeof result === "object" ? result : {};
  const response = (typeof safe.response === "string" ? safe.response : "").replace(/\[\s*SOURCE_ID:\s*\d+\s*\]/gi, "");
  const recommended = typeof safe.recommendedApp === "string" ? safe.recommendedApp.trim() : "";
  const contextApps = cleanAppList(safe.contextApps, null);
  const elapsedMs = Number.isFinite(safe.executionTimeMs) ? safe.executionTimeMs : 0;
  
  const contextDocuments = Array.isArray(safe.contextDocuments) ? safe.contextDocuments : [];

  const base = {
    appName: "",
    reason: "",
    message: response.trim(),
    mainDocuments: [],
    alternatives: [],
    alternativeDocs: [],
    contextApps,
    elapsedMs,
  };

  if (!recommended || recommended === MARK_NOT_FOUND) {
    return { ...base, kind: "empty" };
  }
  if (recommended === MARK_INVALID) {
    return { ...base, kind: "invalid" };
  }

  let body = response.trim();
  const bold = body.match(/^\*\*(.+)\*\*\s*$/m);
  if (bold && bold[1].trim() === recommended) {
    body = body.replace(bold[0], "").trim();
  }

  if (recommended === MARK_UNKNOWN) {
    return { ...base, kind: "uncertain", message: body };
  }
  
  const mainDocuments = contextDocuments.filter(d => d.appName === recommended);
  const alternativeDocs = contextDocuments.filter(d => d.appName !== recommended);

  return {
    ...base,
    kind: "match",
    appName: recommended,
    reason: body,
    message: "",
    mainDocuments,
    alternatives: cleanAppList(safe.alternativeApps, recommended),
    alternativeDocs,
  };
}
