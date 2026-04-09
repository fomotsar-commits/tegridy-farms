// CSV export utility with formula injection protection

export function exportCSV(rows, filename = "export") {
  if (!rows.length) return;

  const headers = Object.keys(rows[0]);
  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((h) => {
        let val = String(row[h] ?? "");
        // Prevent formula injection in Excel/Sheets
        if (/^[=+\-@|%]/.test(val)) val = "'" + val;
        // Escape commas, quotes, newlines
        return val.includes(",") || val.includes('"') || val.includes("\n")
          ? `"${val.replace(/"/g, '""')}"`
          : val;
      }).join(",")
    ),
  ].join("\n");

  // UTF-8 BOM so Excel on Windows opens the file with correct encoding
  const bom = "\uFEFF";
  const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Defer revocation to ensure download completes on slow systems
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
