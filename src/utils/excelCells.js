function cellText(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value.result !== undefined) return String(value.result).trim();
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("").trim();
    if (value.text !== undefined) return String(value.text).trim();
    if (value instanceof Date) return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

function normalizeImportHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

module.exports = { cellText, normalizeImportHeader };
