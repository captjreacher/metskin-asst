import csv, sys, os
in_path  = sys.argv[1] if len(sys.argv) > 1 else "products.csv"
out_path = sys.argv[2] if len(sys.argv) > 2 else "products_enriched.csv"

need = ["aliases","skin_types","oil_based","condom_compatible","notes"]
defaults = {k:"" for k in need}

if not os.path.exists(in_path):
    raise SystemExit(f"File not found: {in_path}")

rows = []
with open(in_path, newline="", encoding="utf-8") as f:
    r = csv.DictReader(f)
    fieldnames = list(r.fieldnames or [])
    for k in need:
        if k not in fieldnames: fieldnames.append(k)
    for row in r:
        for k in need:
            row.setdefault(k, defaults[k])
        rows.append(row)

with open(out_path, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(rows)

print(f"Wrote {out_path} with columns: {', '.join(fieldnames)}")
