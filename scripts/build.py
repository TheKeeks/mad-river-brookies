#!/usr/bin/env python3
"""Validate the CSVs and build data/spots.js, data/overlays.js and exports/*.

Python 3 standard library only.  Exports are produced by the same JavaScript
serializer the browser uses (exporters.js) so the two are byte-identical; if
Node is not installed the exports step is skipped with a warning.

    python3 scripts/build.py            # build everything
    python3 scripts/build.py --check    # build, then diff exports/ against git HEAD
"""
import csv
import datetime as dt
import json
import math
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OVR = os.path.join(DATA, "overlays")
EXPORTS = os.path.join(ROOT, "exports")

BBOX = {"minlat": 43.95, "maxlat": 44.60, "minlng": -73.10, "maxlng": -72.20}
INN = {"lat": 44.1677427, "lng": -72.8112296, "name": "The Inn at the Round Barn Farm"}
PDF_URL = "https://dec.vermont.gov/sites/dec/files/wsm/mapp/docs/mp_UpperWinooskiWatershedFisheriesSummary_2017-12-15.pdf"
PDF_LOCAL = "docs/VFWD_2017_Upper_Winooski_Fisheries_Assessment.pdf"

SPECIES = {
    "BKT": {"color": "#2e7d32", "label": "brook trout only"},
    "BKT+RBT": {"color": "#00897b", "label": "brook + rainbow"},
    "BKT+BNT": {"color": "#827717", "label": "brook + brown"},
    "BKT+BNT+RBT": {"color": "#1565c0", "label": "brook + brown + rainbow"},
    "no data": {"color": "#9e9e9e", "label": "no survey data"},
}
SPECIES_NAMES = {"BKT": "brook", "BNT": "brown", "RBT": "rainbow"}
ACCESS_TYPES = {"trailhead": "#6d4c41", "parking": "#546e7a", "river_access": "#039be5", "landmark": "#ef6c00"}
POI_CATS = {"base": "#263238", "fly_shop": "#c62828", "lake": "#1e88e5", "landmark": "#ef6c00"}


class BuildError(Exception):
    pass


def read_csv(name):
    path = os.path.join(DATA, name)
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for i, r in enumerate(rows, 2):
        if None in r or any(v is None for v in r.values()):
            raise BuildError(f"{name} line {i}: wrong number of columns (unquoted comma?)")
    return rows


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def fnum(v):
    return float(v) if v not in ("", None) else None


def page_of(source_ref):
    m = re.search(r"p\.\s*(\d+)", source_ref or "")
    return int(m.group(1)) if m else None


def species_key(raw):
    raw = raw.strip()
    if raw.lower() == "no data":
        return "no data", []
    codes = [c.strip().upper() for c in raw.split(",") if c.strip()]
    order = ["BKT", "BNT", "RBT"]
    if not codes or any(c not in order for c in codes) or len(set(codes)) != len(codes):
        return None, codes
    codes = [c for c in order if c in codes]
    return "+".join(codes), codes


# --------------------------------------------------------------- validation
def validate(streams, pois, temps, access):
    errs = []

    def in_bbox(lat, lng):
        return BBOX["minlat"] <= lat <= BBOX["maxlat"] and BBOX["minlng"] <= lng <= BBOX["maxlng"]

    def check_coords(rows, fname):
        for i, r in enumerate(rows, 2):
            lat, lng = fnum(r.get("lat")), fnum(r.get("lng"))
            if (lat is None) != (lng is None):
                errs.append(f"{fname} line {i} ({r.get('name') or r.get('river')}): lat/lng half empty")
            elif lat is not None and not in_bbox(lat, lng):
                errs.append(f"{fname} line {i} ({r.get('name') or r.get('river')}): {lat},{lng} outside the bbox")

    def check_dupes(rows, fname, key="name"):
        seen = {}
        for i, r in enumerate(rows, 2):
            k = r[key].strip().lower()
            if k in seen:
                errs.append(f"{fname} line {i}: duplicate {key} '{r[key]}' (also line {seen[k]})")
            seen[k] = i

    check_coords(streams, "streams.csv")
    check_coords(pois, "pois.csv")
    check_coords(temps, "temperature_sites.csv")
    check_coords(access, "access.csv")
    check_dupes(streams, "streams.csv")
    check_dupes(pois, "pois.csv")
    check_dupes(access, "access.csv")
    stream_names = {r["name"] for r in streams}
    for i, r in enumerate(streams, 2):
        who = f"streams.csv line {i} ({r['name']})"
        if r["layer"] not in ("b1_water", "narrative_only"):
            errs.append(f"{who}: layer must be b1_water|narrative_only")
        k, _ = species_key(r["species"])
        if k is None:
            errs.append(f"{who}: species '{r['species']}' is not a combination of BKT/BNT/RBT or 'no data'")
        for col in ("b1", "spawning_trib", "private_flag"):
            if r[col] not in ("yes", "no"):
                errs.append(f"{who}: {col} must be yes|no")
        if r["confidence"] not in ("high", "medium", "low"):
            errs.append(f"{who}: confidence must be high|medium|low")
        lng = fnum(r["lng"])
        if lng is not None:
            if r["watershed"] == "Mad River" and not lng < -72.75:
                errs.append(f"{who}: Mad River watershed point must have lng < -72.75 (got {lng})")
            if r["watershed"] == "Dog River" and not lng > -72.76:
                errs.append(f"{who}: Dog River watershed point must have lng > -72.76 (got {lng})")
        if (r["layer"] == "b1_water") != (r["b1"] == "yes"):
            errs.append(f"{who}: layer and b1 flag disagree")
    for i, r in enumerate(access, 2):
        who = f"access.csv line {i} ({r['name']})"
        if r["type"] not in ACCESS_TYPES:
            errs.append(f"{who}: type must be one of {sorted(ACCESS_TYPES)}")
        for s in [x.strip() for x in r["serves"].split(";") if x.strip()]:
            if s not in stream_names and s != "Mad River":
                errs.append(f"{who}: serves '{s}' is not a streams.csv name or 'Mad River'")
        if r["confidence"] not in ("high", "medium", "low"):
            errs.append(f"{who}: confidence must be high|medium|low")
    for i, r in enumerate(pois, 2):
        if r["category"] not in POI_CATS:
            errs.append(f"pois.csv line {i} ({r['name']}): category must be one of {sorted(POI_CATS)}")
        if r["layer"] != "poi":
            errs.append(f"pois.csv line {i} ({r['name']}): layer must be poi")
    for i, r in enumerate(temps, 2):
        try:
            float(r["max_temp_F"]); float(r["max_7day_avg_F"]); int(r["elev_ft"])
        except ValueError:
            errs.append(f"temperature_sites.csv line {i}: non-numeric temperature/elevation")
    if errs:
        raise BuildError("validation failed:\n  " + "\n  ".join(errs))


# ----------------------------------------------------------------- helpers
def load_overlay(name):
    path = os.path.join(OVR, name)
    if not os.path.exists(path):
        print(f"  warning: {name} missing (run scripts/fetch_overlays.py)", file=sys.stderr)
        return {"type": "FeatureCollection", "properties": {"source": "missing"}, "features": []}
    with open(path) as f:
        return json.load(f)


def line_vertices(geom):
    if geom["type"] == "LineString":
        return geom["coordinates"]
    return [c for part in geom["coordinates"] for c in part]


def drive_lookup(cache, lat, lng):
    key = f"{lat:.5f},{lng:.5f}"
    hit = cache.get(key)
    if hit:
        return hit["min"], hit["km"], "OSRM"
    # fallback: road distance ~ 1.35 x straight line at 30 mph
    km = haversine_m(INN["lat"], INN["lng"], lat, lng) / 1000 * 1.35
    return round(km / 48.28 * 60, 1), round(km, 1), "est."


def point_in_ring(x, y, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def huc_of(watersheds, lng, lat):
    """Name of the HUC10 polygon containing the point, else None."""
    for f in watersheds["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for rings in polys:
            if point_in_ring(lng, lat, rings[0]) and not any(point_in_ring(lng, lat, r) for r in rings[1:]):
                return f["properties"]["name"]
    return None


def temp_band(f):
    if f <= 68:
        return "#1e88e5", "brook-trout comfortable"
    if f <= 72:
        return "#26a69a", "tolerable briefly"
    if f <= 75:
        return "#fdd835", "warm"
    if f <= 80:
        return "#fb8c00", "too warm for brookies"
    return "#e53935", "hot"


# ------------------------------------------------------------------- build
def build(check=False):
    streams = read_csv("streams.csv")
    pois = read_csv("pois.csv")
    temps = read_csv("temperature_sites.csv")
    access = read_csv("access.csv")
    validate(streams, pois, temps, access)

    named = load_overlay("streams_named.geojson")
    watersheds = load_overlay("watersheds.geojson")
    fishing = load_overlay("fishing_access.geojson")
    drive_path = os.path.join(DATA, "drive_times.json")
    drive = json.load(open(drive_path)) if os.path.exists(drive_path) else {"times": {}, "source": "none"}
    dcache = drive["times"]

    lines_by_stream = {f["properties"]["stream"]: f for f in named["features"] if f["properties"]["role"] == "matched"}
    features = []

    # --- access: curated + state fishing access areas (dedupe within 150 m)
    access_feats = []
    for r in access:
        lat, lng = fnum(r["lat"]), fnum(r["lng"])
        if lat is None:
            continue
        mins, km, dsrc = drive_lookup(dcache, lat, lng)
        access_feats.append({
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {
                "id": "a-" + slug(r["name"]), "layer": "access", "name": r["name"], "type": r["type"],
                "color": ACCESS_TYPES[r["type"]], "coord_source": r["coord_source"], "confidence": r["confidence"],
                "serves": [s.strip() for s in r["serves"].split(";") if s.strip()],
                "parking_notes": r["parking_notes"], "source_ref": r["source_ref"], "notes": r["notes"],
                "state_access": False, "drive_min": mins, "drive_km": km, "drive_src": dsrc,
            }})
    skipped_state = []
    for f in fishing["features"]:
        lng, lat = f["geometry"]["coordinates"]
        p = f["properties"]
        near = [a for a in access_feats if haversine_m(lat, lng, a["geometry"]["coordinates"][1], a["geometry"]["coordinates"][0]) < 150]
        if near:
            skipped_state.append((p["name"], near[0]["properties"]["name"]))
            continue
        mins, km, dsrc = drive_lookup(dcache, lat, lng)
        trout = ", ".join({"BrookTrout": "brook", "BrownTrout": "brown", "RainbowTrout": "rainbow"}[t] for t in p.get("trout", []))
        notes = f"{p.get('access_type') or 'Access'} on {p.get('waterbody')}, {p.get('town')}. Owner: {p.get('owner')}."
        if p.get("ramp") and p["ramp"] not in ("None", "No", "none"):
            notes += f" Ramp: {p['ramp']}."
        if trout:
            notes += f" State lists {trout} trout."
        if p.get("location"):
            notes += f" {p['location']}"
        access_feats.append({
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]},
            "properties": {
                "id": "fa-" + slug(f"{p['name']}-{p.get('town','')}"), "layer": "access",
                "name": f"{p['name']} (state fishing access)", "type": "river_access",
                "color": ACCESS_TYPES["river_access"], "coord_source": "VT F&W Fishing Access Areas dataset",
                "confidence": "high", "serves": [], "parking_notes": "State fishing access area; parking on site.",
                "source_ref": fishing["properties"].get("source", ""), "notes": notes,
                "state_access": True, "drive_min": mins, "drive_km": km, "drive_src": dsrc,
            }})

    # --- streams
    unmatched = list(named.get("properties", {}).get("unmatched_streams", []))
    for r in streams:
        lat, lng = fnum(r["lat"]), fnum(r["lng"])
        key, codes = species_key(r["species"])
        line = lines_by_stream.get(r["name"])
        verts = line_vertices(line["geometry"]) if line else []
        # nearest access: distance from each access point to the stream (point or nearest line vertex)
        ranked = []
        for a in access_feats:
            alng, alat = a["geometry"]["coordinates"]
            d = haversine_m(lat, lng, alat, alng)
            for x, y in verts[::2]:
                dd = haversine_m(y, x, alat, alng)
                if dd < d:
                    d = dd
            serves = r["name"] in a["properties"]["serves"] or (r["name"].startswith("Mad River") and "Mad River" in a["properties"]["serves"])
            if serves or d <= 3000:
                ranked.append((0 if serves else 1, d, a))
        ranked.sort(key=lambda t: (t[0], t[1]))
        nearest = [{"id": a["properties"]["id"], "name": a["properties"]["name"], "type": a["properties"]["type"],
                    "walk_m": int(round(d)), "drive_min": a["properties"]["drive_min"], "drive_src": a["properties"]["drive_src"],
                    "serves": s == 0, "lat": a["geometry"]["coordinates"][1], "lng": a["geometry"]["coordinates"][0]}
                   for s, d, a in ranked[:3]]
        mins, km, dsrc = drive_lookup(dcache, lat, lng)
        page = page_of(r["source_ref"])
        features.append({
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {
                "id": "s-" + slug(r["name"]), "layer": r["layer"], "name": r["name"], "watershed": r["watershed"],
                "species": codes, "species_key": key, "species_label": SPECIES[key]["label"], "color": SPECIES[key]["color"],
                "b1": r["b1"] == "yes", "spawning_trib": r["spawning_trib"] == "yes", "private_flag": r["private_flag"] == "yes",
                "coord_source": r["coord_source"], "confidence": r["confidence"], "source_ref": r["source_ref"],
                "source_label": f"VFWD 2017, {r['source_ref'].split(';')[0].strip()}",
                "source_url": f"{PDF_URL}#page={page}" if page else PDF_URL,
                "notes": r["notes"], "drive_min": mins, "drive_km": km, "drive_src": dsrc,
                "has_line": line is not None, "nearest_access": nearest,
            }})
        if line is None and not any(u["stream"] == r["name"] for u in unmatched):
            unmatched.append({"stream": r["name"], "reason": "no matched line in streams_named.geojson"})

    features.extend(access_feats)

    # --- POIs
    for r in pois:
        lat, lng = fnum(r["lat"]), fnum(r["lng"])
        mins, km, dsrc = drive_lookup(dcache, lat, lng)
        features.append({
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {"id": "p-" + slug(r["name"]), "layer": "poi", "name": r["name"], "category": r["category"],
                           "color": POI_CATS[r["category"]], "coord_source": r["coord_source"], "confidence": r["confidence"],
                           "source_ref": r["source_ref"], "notes": r["notes"], "drive_min": mins, "drive_km": km, "drive_src": dsrc}})

    # --- temperature sites
    for i, r in enumerate(temps):
        lat, lng = fnum(r["lat"]), fnum(r["lng"])
        avg = float(r["max_7day_avg_F"])
        color, band = temp_band(avg)
        page = page_of(r["source_ref"])
        features.append({
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {"id": f"t-{slug(r['river'])}-{r['elev_ft']}", "layer": "temperature",
                           "name": f"{r['river']} at {r['elev_ft']} ft", "river": r["river"], "elev_ft": int(r["elev_ft"]),
                           "years": r["years"].replace(";", ", "), "max_temp_F": float(r["max_temp_F"]), "max_7day_avg_F": avg,
                           "color": color, "band": band, "source_ref": r["source_ref"],
                           "source_label": f"VFWD 2017, {r['source_ref']}",
                           "source_url": f"{PDF_URL}#page={page}" if page else PDF_URL}})

    for f in features:
        lng, lat = f["geometry"]["coordinates"]
        f["properties"]["huc10"] = huc_of(watersheds, lng, lat)

    counts = {
        "b1_water": sum(1 for r in streams if r["layer"] == "b1_water"),
        "narrative_only": sum(1 for r in streams if r["layer"] == "narrative_only"),
        "pois": len(pois), "temperature_sites": len(temps),
        "access_curated": len(access), "access_state": sum(1 for a in access_feats if a["properties"]["state_access"]),
        "streams_with_line": sum(1 for r in streams if r["name"] in lines_by_stream),
        "geocoded": sum(1 for r in streams + access if r["coord_source"].startswith("geocoded")),
    }
    meta = {
        "generated": dt.date.today().isoformat(),
        "inn": INN, "bbox": BBOX, "pdf_url": PDF_URL, "pdf_local": PDF_LOCAL,
        "report": "Ladago, B. (2017). 2017 Upper Winooski Fisheries Assessment. Vermont Fish & Wildlife Department, 2017-12-15.",
        "species": SPECIES, "access_types": ACCESS_TYPES, "poi_categories": POI_CATS,
        "drive_source": drive.get("source", "none"), "drive_fetched": drive.get("fetched"),
        "counts": counts, "unmatched_streams": unmatched,
        "overlay_sources": {n: load_overlay(n + ".geojson")["properties"].get("source")
                            for n in ("streams_all", "streams_named", "watersheds", "public_land", "fishing_access", "osm_access", "osm_trails")},
        "state_access_deduped": skipped_state,
    }
    spots = {"type": "FeatureCollection", "properties": meta, "features": features}
    with open(os.path.join(DATA, "spots.js"), "w", encoding="utf-8") as f:
        f.write("// Generated by scripts/build.py - do not edit; edit data/*.csv and rebuild.\n")
        f.write("window.SPOTS = ")
        json.dump(spots, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")

    overlays = {n: load_overlay(n + ".geojson") for n in ("streams_all", "streams_named", "watersheds", "public_land", "osm_access", "osm_trails")}
    for n in ("streams_all", "streams_named", "osm_trails", "osm_access"):
        for f in overlays[n]["features"]:
            g = f["geometry"]
            if g["type"] == "Point":
                lng, lat = g["coordinates"]
            else:
                part = g["coordinates"][0] if g["type"] == "MultiLineString" else g["coordinates"]
                lng, lat = part[len(part) // 2]
            f["properties"]["huc10"] = huc_of(watersheds, lng, lat)
    with open(os.path.join(DATA, "overlays.js"), "w", encoding="utf-8") as f:
        f.write("// Generated by scripts/build.py from data/overlays/*.geojson - do not edit.\n")
        f.write("window.OVERLAYS = ")
        json.dump(overlays, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")

    print(f"spots.js: {len(features)} features  (" + ", ".join(f"{k}={v}" for k, v in counts.items()) + ")")
    print("overlays.js: " + ", ".join(f"{k}={len(v['features'])}" for k, v in overlays.items()))
    if unmatched:
        print("unmatched streams: " + "; ".join(f"{u['stream']} ({u['reason']})" for u in unmatched))
    if skipped_state:
        print("state access points merged into curated rows: " + "; ".join(f"{a} ~ {b}" for a, b in skipped_state))

    # --- exports via the shared JS serializer
    node = shutil.which("node")
    if not node:
        print("warning: node not found; exports/ not regenerated (the browser Export buttons still work)", file=sys.stderr)
        return
    os.makedirs(EXPORTS, exist_ok=True)
    subprocess.run([node, os.path.join(ROOT, "scripts", "export_node.js"), EXPORTS], check=True, cwd=ROOT)
    verify_exports(spots, overlays)
    if check:
        r = subprocess.run(["git", "diff", "--stat", "--exit-code", "--", "exports"], cwd=ROOT)
        if r.returncode:
            raise BuildError("exports/ differ from the committed files")
        print("exports/ match git HEAD")


def verify_exports(spots, overlays):
    n_pts = sum(1 for f in spots["features"] if f["properties"]["layer"] != "temperature")
    n_lines = sum(1 for f in overlays["streams_named"]["features"] if f["properties"]["role"] == "matched")
    gpx = ET.parse(os.path.join(EXPORTS, "spots.gpx")).getroot()
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    wpt, trk = len(gpx.findall("g:wpt", ns)), len(gpx.findall("g:trk", ns))
    assert wpt == n_pts, f"gpx waypoints {wpt} != {n_pts}"
    assert trk == n_lines, f"gpx tracks {trk} != {n_lines}"
    kml = ET.parse(os.path.join(EXPORTS, "spots.kml")).getroot()
    kns = {"k": "http://www.opengis.net/kml/2.2"}
    pm_pts = len(kml.findall(".//k:Placemark/k:Point", kns))
    pm_lines = len(kml.findall(".//k:Placemark/k:MultiGeometry", kns)) + len(kml.findall(".//k:Placemark/k:LineString", kns))
    assert pm_pts == n_pts, f"kml point placemarks {pm_pts} != {n_pts}"
    assert pm_lines == n_lines, f"kml line placemarks {pm_lines} != {n_lines}"
    with open(os.path.join(EXPORTS, "spots.csv"), newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == n_pts, f"csv rows {len(rows)} != {n_pts}"
    with open(os.path.join(EXPORTS, "spots.geojson"), encoding="utf-8") as f:
        gj = json.load(f)
    assert len(gj["features"]) == n_pts, f"geojson features {len(gj['features'])} != {n_pts}"
    print(f"exports OK: {wpt} waypoints, {trk} tracks, {pm_pts} placemarks + {pm_lines} lines, {len(rows)} csv rows")


if __name__ == "__main__":
    try:
        build(check="--check" in sys.argv)
    except BuildError as e:
        print(f"build failed: {e}", file=sys.stderr)
        sys.exit(1)
