import csv, sys, os

PATH = sys.argv[1] if len(sys.argv) > 1 else "products.csv"

REQ = [
  "sku","name","aliases","category","skin_types","key_ingredients","claims",
  "fragrance_free","oil_based","condom_compatible","size_ml","price",
  "usage","contraindications","notes"
]

bad = 0
if not os.path.exists(PATH):
    print(f"File not found: {PATH}")
    sys.exit(1)

with open(PATH, newline="", encoding="utf-8") as f:
    r = csv.DictReader(f)
    missing_cols = [c for c in REQ if c not in r.fieldnames]
    if missing_cols:
        print("Missing columns:", ", ".join(missing_cols))
        sys.exit(1)

    for i, row in enumerate(r, start=2):  # header is line 1
        errs = []
        for b in ["fragrance_free","oil_based","condom_compatible"]:
            v = str(row.get(b,"")).strip().lower()
            if v not in {"true","false"}:
                errs.append(f"{b}='{row.get(b)}' not true/false")
        if str(row.get("oil_based","")).strip().lower() == "true" and str(row.get("condom_compatible","")).strip().lower() != "false":
            errs.append("oil_based=true must imply condom_compatible=false")
        if not str(row.get("sku","")).strip():
            errs.append("sku empty")
        if not str(row.get("name","")).strip():
            errs.append("name empty")
        if errs:
            bad += 1
            print(f"Row {i} ({row.get('sku','?')}): " + "; ".join(errs))

print("OK" if bad == 0 else f"{bad} row(s) need fixes")
