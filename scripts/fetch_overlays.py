#!/usr/bin/env python3
"""Fetch the map overlays, geocode blank rows and cache drive times.

Everything here talks to the network; everything it writes is committed so
the map works without ever running it again.  Re-runnable; raw responses are
cached under data/overlays/raw/ (git-ignored) and re-used unless --refresh.

Steps (run all, or pick with flags):
  --overlays     stream lines, watersheds, public land, state fishing access,
                 OSM trailheads/parking/trails
  --geocode      fill blank lat/lng in data/streams.csv and data/access.csv
  --drive-times  OSRM drive time from the inn to every stream/access point

Sources are recorded in each output file's top-level "properties.source".
"""
import argparse
import csv
import datetime as dt
import json
import math
import os
import re
import sys
import time
import urllib.parse

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("pip install requests")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OVR = os.path.join(DATA, "overlays")
RAW = os.path.join(OVR, "raw")
UA = "mad-river-brookies-map/1.0 (github.com/TheKeeks/mad-river-brookies)"
BBOX = (-73.10, 43.95, -72.20, 44.60)  # minlng, minlat, maxlng, maxlat
INN = (44.1677427, -72.8112296)
TODAY = dt.date.today().isoformat()

SRC = {
    "hydro": "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/"
             "FS_VCGI_OPENDATA_Water_VHDCARTO_line_SP_v1/FeatureServer/0",
    "hydro_label": "Vermont Open Geodata Portal - VT Hydrography Dataset, cartographic extract lines (VCGI)",
    "wbd": "https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/5",
    "wbd_label": "USGS Watershed Boundary Dataset, 10-digit HU (as published on the Vermont Open Geodata Portal)",
    "pld": "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/"
           "FS_VCGI_OPENDATA_Cadastral_PROTECTEDLND_poly_SP_v2/FeatureServer/0",
    "pld_label": "Vermont Open Geodata Portal - Vermont Protected Lands Database (VCGI)",
    "faa": "https://anrmaps.vermont.gov/arcgis/rest/services/Open_Data/"
           "OPENDATA_ANR_TOURISM_SP_NOCACHE_v2/MapServer/163",
    "faa_label": "Vermont Open Geodata Portal - Fishing Access Areas (VT ANR / Fish & Wildlife)",
    "overpass": ["https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter",
                 "https://lz4.overpass-api.de/api/interpreter"],
    "nominatim": "https://nominatim.openstreetmap.org/search",
    "osrm": "https://router.project-osrm.org/route/v1/driving/",
}

SESSION = requests.Session()
SESSION.headers["User-Agent"] = UA
_last_call = {}


def polite(host, min_gap):
    """Never hit the same host faster than min_gap seconds."""
    t = time.time()
    wait = _last_call.get(host, 0) + min_gap - t
    if wait > 0:
        time.sleep(wait)
    _last_call[host] = time.time()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get_json(url, params=None, cache_key=None, refresh=False, min_gap=1.0, method="GET", data=None, timeout=120):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, cache_key) if cache_key else None
    if path and os.path.exists(path) and not refresh:
        with open(path) as f:
            return json.load(f)
    host = urllib.parse.urlparse(url).netloc
    polite(host, min_gap)
    for attempt in range(3):
        try:
            if method == "POST":
                r = SESSION.post(url, data=data, timeout=timeout)
            else:
                r = SESSION.get(url, params=params, timeout=timeout)
            if r.status_code == 429:
                log(f"  {host} rate-limited us (429); stopping this source rather than hammering it")
                raise RuntimeError("rate limited")
            r.raise_for_status()
            j = r.json()
            if path:
                with open(path, "w") as f:
                    json.dump(j, f)
            return j
        except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError) as e:
            log(f"  {host}: {e.__class__.__name__}, retry {attempt + 1}/3")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"gave up on {url}")


# ----------------------------------------------------------------- geometry
def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def simplify(coords, tol):
    """Douglas-Peucker in degrees (coords are [lng, lat])."""
    if len(coords) < 3:
        return coords

    def dist(p, a, b):
        (x, y), (x1, y1), (x2, y2) = p, a, b
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0:
            return math.hypot(x - x1, y - y1)
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))

    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        best, bi = 0.0, -1
        for k in range(i + 1, j):
            d = dist(coords[k], coords[i], coords[j])
            if d > best:
                best, bi = d, k
        if best > tol:
            keep[bi] = True
            stack.append((i, bi))
            stack.append((bi, j))
    return [c for c, k in zip(coords, keep) if k]


def rnd(c, nd=5):
    return [round(c[0], nd), round(c[1], nd)]


def simplify_geom(geom, tol, nd=5):
    t = geom["type"]
    if t == "LineString":
        return {"type": t, "coordinates": [rnd(c, nd) for c in simplify(geom["coordinates"], tol)]}
    if t == "MultiLineString":
        return {"type": t, "coordinates": [[rnd(c, nd) for c in simplify(l, tol)] for l in geom["coordinates"]]}
    if t == "Polygon":
        rings = [[rnd(c, nd) for c in simplify(r, tol)] for r in geom["coordinates"]]
        return {"type": t, "coordinates": [r for r in rings if len(r) >= 4]}
    if t == "MultiPolygon":
        polys = []
        for p in geom["coordinates"]:
            rings = [[rnd(c, nd) for c in simplify(r, tol)] for r in p]
            rings = [r for r in rings if len(r) >= 4]
            if rings:
                polys.append(rings)
        return {"type": t, "coordinates": polys}
    if t == "Point":
        return {"type": t, "coordinates": rnd(geom["coordinates"], 6)}
    return geom


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside


def point_in_geom(pt, geom):
    if geom["type"] == "Polygon":
        rings = geom["coordinates"]
        return point_in_ring(pt, rings[0]) and not any(point_in_ring(pt, r) for r in rings[1:])
    if geom["type"] == "MultiPolygon":
        return any(point_in_geom(pt, {"type": "Polygon", "coordinates": p}) for p in geom["coordinates"])
    return False


def esri_to_geojson(feat, gtype):
    g = feat.get("geometry") or {}
    if gtype == "esriGeometryPoint":
        geom = {"type": "Point", "coordinates": [g["x"], g["y"]]}
    elif gtype == "esriGeometryPolyline":
        paths = g.get("paths", [])
        geom = {"type": "LineString", "coordinates": paths[0]} if len(paths) == 1 else {"type": "MultiLineString", "coordinates": paths}
    elif gtype == "esriGeometryPolygon":
        geom = {"type": "Polygon", "coordinates": g.get("rings", [])}
    else:
        geom = None
    return {"type": "Feature", "properties": feat.get("attributes", {}), "geometry": geom}


def arcgis_query(layer_url, cache_prefix, where="1=1", out_fields="*", refresh=False, bbox=BBOX):
    """Page through an ArcGIS layer query inside the bbox, returning GeoJSON features (WGS84)."""
    meta = get_json(layer_url, params={"f": "json"}, cache_key=f"{cache_prefix}_meta.json", refresh=refresh)
    page = min(int(meta.get("maxRecordCount") or 1000), 2000)
    gtype = meta.get("geometryType")
    feats, offset = [], 0
    while True:
        params = {
            "where": where, "outFields": out_fields, "f": "geojson", "outSR": 4326,
            "geometry": ",".join(str(v) for v in bbox), "geometryType": "esriGeometryEnvelope",
            "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
            "resultOffset": offset, "resultRecordCount": page, "geometryPrecision": 6,
        }
        j = get_json(layer_url + "/query", params=params, cache_key=f"{cache_prefix}_{offset}.json",
                     refresh=refresh, min_gap=0.5)
        if "error" in j:
            raise RuntimeError(f"{layer_url}: {j['error']}")
        if j.get("type") == "FeatureCollection":
            got = j["features"]
        else:  # esri json fallback
            got = [esri_to_geojson(f, gtype) for f in j.get("features", [])]
        feats.extend(got)
        log(f"  {cache_prefix}: {len(feats)} features")
        more = j.get("properties", {}).get("exceededTransferLimit") or j.get("exceededTransferLimit")
        if not got or (len(got) < page and not more):
            break
        offset += len(got)
    return feats, meta


def write_geojson(name, features, source, extra=None):
    os.makedirs(OVR, exist_ok=True)
    fc = {"type": "FeatureCollection",
          "properties": {"source": source, "fetched": TODAY, "bbox": list(BBOX), **(extra or {})},
          "features": features}
    path = os.path.join(OVR, name)
    with open(path, "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    log(f"wrote {name}: {len(features)} features, {os.path.getsize(path) / 1e6:.2f} MB")
    return fc


# ------------------------------------------------------------------- CSVs
def read_csv(name):
    with open(os.path.join(DATA, name), newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        return list(r), r.fieldnames


def write_csv(name, rows, fields):
    path = os.path.join(DATA, name)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)  # atomic: a crash never leaves a half-written CSV


NAME_ALIASES = {  # report spelling -> VHD (GNIS) spelling
    "kidders": "kidder",
    "crossett": "crosset",
    "mollys": "mollys",
}


def norm_name(n):
    """'Chase Brook (Fayston)' -> 'chase'; 'Little River - West Branch' -> 'west branch little'."""
    n = re.sub(r"\(.*?\)", "", n).lower()
    n = n.replace("'", "")
    n = re.sub(r"\b(brook|river|creek|mainstem)\b", " ", n)
    parts = [p.strip() for p in n.split(" - ")]
    if len(parts) == 2:
        n = parts[1] + " " + parts[0]
    n = " ".join(n.split())
    return NAME_ALIASES.get(n, n)


def stream_point(row):
    return (float(row["lat"]), float(row["lng"])) if row.get("lat") and row.get("lng") else None


# ------------------------------------------------------------ 1. streams
def line_coords(geom):
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    return geom["coordinates"]


def min_dist_to_line_m(pt, geom):
    lat, lng = pt
    best = 1e12
    for part in line_coords(geom):
        for x, y in part:
            d = haversine_m(lat, lng, y, x)
            if d < best:
                best = d
    return best


def cluster_lines(feats, join_m=40):
    """Group line features that touch end-to-end into connected clusters."""
    n = len(feats)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    ends = []
    for f in feats:
        parts = line_coords(f["geometry"])
        ends.append([parts[0][0], parts[-1][-1]])
    for i in range(n):
        for j in range(i + 1, n):
            for a in ends[i]:
                for b in ends[j]:
                    if haversine_m(a[1], a[0], b[1], b[0]) < join_m:
                        parent[find(i)] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def upstream_of(feats, idx_set, seed_idx, join_m=40):
    """Indices of segments upstream of (and including) seed, following NHD from->to direction."""
    starts = {}
    for i in idx_set:
        parts = line_coords(feats[i]["geometry"])
        e = parts[-1][-1]
        starts.setdefault((round(e[0], 4), round(e[1], 4)), []).append(i)
    result, stack = set(), [seed_idx]
    while stack:
        i = stack.pop()
        if i in result:
            continue
        result.add(i)
        s = line_coords(feats[i]["geometry"])[0][0]
        for j in idx_set:
            if j in result:
                continue
            e = line_coords(feats[j]["geometry"])[-1][-1]
            if haversine_m(s[1], s[0], e[1], e[0]) < join_m:
                stack.append(j)
    return result


def fetch_streams(refresh, streams_rows, watersheds_fc):
    log("== stream lines")
    feats, meta = arcgis_query(SRC["hydro"], "hydro", out_fields="GNIS_NAME,FTYPE,FCODE,STREAM_ORDER,REACHCODE", refresh=refresh)
    src_label = SRC["hydro_label"]
    for f in feats:
        p = f["properties"]
        p["name"] = (p.get("GNIS_NAME") or "").strip() or None
        p["order"] = p.get("STREAM_ORDER") or 0
        p["fcode"] = int(p.get("FCODE") or 0)
        for k in ("GNIS_NAME", "STREAM_ORDER", "FCODE", "OBJECTID", "FTYPE"):
            p.pop(k, None)

    # --- context lines: perennial (or unspecified) and mainstem centerlines, order >= 2
    ctx = [f for f in feats if f["geometry"] and f["properties"]["order"] >= 2
           and f["properties"]["fcode"] in (46006, 46000, 55800)]
    groups = {}
    for f in ctx:
        g = simplify_geom(f["geometry"], 0.00012, 4)
        groups.setdefault((f["properties"]["name"] or "", f["properties"]["order"]), []).extend(line_coords(g))
    ctx_out = [{"type": "Feature", "properties": {"name": k[0] or None, "order": k[1]},
                "geometry": {"type": "MultiLineString", "coordinates": parts}}
               for k, parts in sorted(groups.items(), key=lambda kv: (kv[0][1], kv[0][0]))]

    # --- named matches for the §4a streams
    by_norm = {}
    for i, f in enumerate(feats):
        nm = f["properties"]["name"]
        if nm and f["geometry"]:
            by_norm.setdefault(norm_name(nm), []).append(i)

    named_out, unmatched, mainstems = [], [], {}
    stream_ids = {}
    for row in streams_rows:
        sid = re.sub(r"[^a-z0-9]+", "-", row["name"].lower()).strip("-")
        stream_ids[row["name"]] = sid
        key = norm_name(row["name"])
        cands = by_norm.get(key, [])
        pt = stream_point(row)
        if not cands:
            unmatched.append({"stream": row["name"], "reason": f"no VHD line named like '{row['name']}' in the bbox"})
            continue
        clusters = cluster_lines([feats[i] for i in cands])
        clusters = [[cands[k] for k in c] for c in clusters]
        chosen = None
        if pt is None:
            # geocode step may not have run yet: prefer the cluster inside the row's watershed polygon
            ws = watershed_for_row(row, watersheds_fc)
            if ws is not None:
                for c in clusters:
                    mid = line_coords(feats[c[0]]["geometry"])[0][0]
                    if point_in_geom(mid, ws["geometry"]):
                        chosen = c
                        break
            if chosen is None and len(clusters) == 1:
                chosen = clusters[0]
            if chosen is None:
                unmatched.append({"stream": row["name"], "reason": f"{len(clusters)} '{row['name']}' lines and no coordinate to pick one"})
                continue
        else:
            best = None
            for c in clusters:
                d = min(min_dist_to_line_m(pt, feats[i]["geometry"]) for i in c)
                if best is None or d < best[0]:
                    best = (d, c)
            if best[0] > 4000:
                unmatched.append({"stream": row["name"], "reason": f"nearest '{row['name']}' line is {best[0] / 1000:.1f} km from the report point"})
                continue
            chosen = best[1]
        idx_set = set(chosen)
        # "(above X)" records describe only the reach upstream of the point: keep the upstream part
        # for the species colour and (for the two big rivers) draw the rest as plain mainstem.
        if "(above" in row["name"].lower() and pt is not None:
            seed = min(idx_set, key=lambda i: min_dist_to_line_m(pt, feats[i]["geometry"]))
            up = upstream_of(feats, idx_set, seed)
            base = re.sub(r"\s*\(.*", "", row["name"])
            if base in ("Mad River", "Winooski River"):
                mainstems[base] = [i for i in idx_set if i not in up]
            idx_set = up
        for i in sorted(idx_set):
            f = feats[i]
            named_out.append({"type": "Feature",
                              "properties": {"stream_id": sid, "stream": row["name"], "name": f["properties"]["name"],
                                             "order": f["properties"]["order"], "role": "matched"},
                              "geometry": simplify_geom(f["geometry"], 0.00003, 5)})
    # mainstems drawn separately (Mad below Warren; Dog is entirely matched so nothing extra)
    for nm, idxs in mainstems.items():
        for i in sorted(idxs):
            f = feats[i]
            named_out.append({"type": "Feature",
                              "properties": {"stream_id": None, "stream": nm, "name": nm,
                                             "order": f["properties"]["order"], "role": "mainstem"},
                              "geometry": simplify_geom(f["geometry"], 0.00003, 5)})

    # one feature per (stream record, role): MultiLineString of all its segments
    merged = {}
    for f in named_out:
        k = (f["properties"]["stream"], f["properties"]["role"])
        m = merged.setdefault(k, {"type": "Feature", "properties": dict(f["properties"], order=0), "geometry": {"type": "MultiLineString", "coordinates": []}})
        m["properties"]["order"] = max(m["properties"]["order"], f["properties"]["order"] or 0)
        m["geometry"]["coordinates"].extend(line_coords(f["geometry"]))
    named_out = list(merged.values())

    write_geojson("streams_all.geojson", ctx_out, src_label,
                  {"filter": "FCODE in (46006 perennial, 46000 unspecified, 55800 artificial path) and STREAM_ORDER >= 2"})
    write_geojson("streams_named.geojson", named_out, src_label,
                  {"unmatched_streams": unmatched, "matched": sorted({f["properties"]["stream"] for f in named_out if f["properties"]["role"] == "matched"})})
    matched = {f["properties"]["stream"] for f in named_out if f["properties"]["role"] == "matched"}
    log(f"  matched {len(matched)}/{len(streams_rows)} streams; unmatched: {[u['stream'] for u in unmatched]}")
    return feats, by_norm


# --------------------------------------------------------- 2. watersheds
WS_ALIASES = {
    "Mad River": ["mad river"],
    "Dog River": ["dog river"],
    "Stevens Branch": ["stevens branch"],
    "North Branch": ["north branch"],
    "Kingsbury Branch": ["kingsbury branch"],
    "Little River": ["little river"],
}


def watershed_for_row(row, fc):
    if not fc:
        return None
    pt = stream_point(row)
    if pt:
        for f in fc["features"]:
            if point_in_geom((pt[1], pt[0]), f["geometry"]):
                return f
    for alias in WS_ALIASES.get(row.get("watershed", ""), []):
        for f in fc["features"]:
            if alias in (f["properties"].get("name") or "").lower():
                return f
    return None


def fetch_watersheds(refresh, streams_rows):
    log("== watersheds (HUC10)")
    feats, _ = arcgis_query(SRC["wbd"], "wbd", out_fields="huc10,name,areasqkm,states", refresh=refresh)
    pts = [stream_point(r) for r in streams_rows]
    keep = []
    for f in feats:
        p = f["properties"]
        name = p.get("name") or ""
        contains = [r["name"] for r, pt in zip(streams_rows, pts) if pt and point_in_geom((pt[1], pt[0]), f["geometry"])]
        core = any(k in name.lower() for k in ("mad river", "dog river"))
        if core or contains:
            keep.append({"type": "Feature",
                         "properties": {"huc10": p.get("huc10"), "name": name, "areasqkm": p.get("areasqkm"),
                                        "core": core, "contains": contains},
                         "geometry": simplify_geom(f["geometry"], 0.0002, 5)})
    return write_geojson("watersheds.geojson", keep, SRC["wbd_label"])


# -------------------------------------------------------- 3. public land
ACCESS_CODES = {"1": "open", "2": "limited (easement)", "3": "none", "4": "public, limited", "5": "unknown"}

def fetch_public_land(refresh):
    log("== public land")
    feats, _ = arcgis_query(SRC["pld"], "pld", out_fields="NAME,PAGENCY1,PTYPE1,PUBACCESS,GISACRES,OWNERKIND,DESIGNAT", refresh=refresh)
    out = []
    for f in feats:
        p = f["properties"]
        acc = str(p.get("PUBACCESS") or "5")
        if (p.get("GISACRES") or 0) < 3:
            continue  # skip slivers to keep the file small
        if acc == "3" or (acc == "5" and p.get("OWNERKIND") != "PUB"):
            continue  # private land with no public access (mostly farm easements)
        g = simplify_geom(f["geometry"], 0.00025, 4)
        if not g["coordinates"]:
            continue
        out.append({"type": "Feature",
                    "properties": {"name": p.get("NAME"), "agency": p.get("PAGENCY1"), "type": p.get("PTYPE1"),
                                   "access": ACCESS_CODES.get(acc, "unknown"), "acres": round(p.get("GISACRES") or 0),
                                   "owner": p.get("OWNERKIND")},
                    "geometry": g})
    return write_geojson("public_land.geojson", out, SRC["pld_label"],
                         {"filter": "parcels >= 3 acres inside the bbox, publicly owned or with public access (PUBACCESS 1/2/4); simplified"})


# ------------------------------------------------ 4. state fishing access
def fetch_fishing_access(refresh):
    log("== state fishing access areas")
    feats, _ = arcgis_query(SRC["faa"], "faa", refresh=refresh)
    out = []
    for f in feats:
        p = f["properties"]
        sp = [k for k in ("BrookTrout", "BrownTrout", "RainbowTrout") if str(p.get(k, "")).lower() in ("yes", "y", "true", "1")]
        out.append({"type": "Feature",
                    "properties": {"name": p.get("AccessName") or p.get("WaterBody"), "waterbody": p.get("WaterBody"),
                                   "town": p.get("Town"), "owner": p.get("Owner"), "access_type": p.get("AccessType"),
                                   "ramp": p.get("RampType"), "trout": sp, "location": p.get("LOCATION")},
                    "geometry": simplify_geom(f["geometry"], 0, 6)})
    return write_geojson("fishing_access.geojson", out, SRC["faa_label"])


# ------------------------------------------------------------- 5. OSM
def overpass(query, cache_key, refresh):
    for url in SRC["overpass"]:
        try:
            j = get_json(url, cache_key=cache_key, refresh=refresh, method="POST", data={"data": query}, min_gap=2.0, timeout=180)
            return j
        except Exception as e:
            log(f"  overpass {url}: {e}")
    return None


def fetch_osm(refresh, stream_feats, stream_norms, streams_rows):
    log("== OSM trailheads / parking / trails (best effort)")
    s, w, n, e = BBOX[1], BBOX[0], BBOX[3], BBOX[2]
    q_pts = f"""[out:json][timeout:120];
(node["highway"="trailhead"]({s},{w},{n},{e});
 way["highway"="trailhead"]({s},{w},{n},{e});
 node["amenity"="parking"]({s},{w},{n},{e});
 way["amenity"="parking"]({s},{w},{n},{e}););
out center tags;"""
    q_trails = f"""[out:json][timeout:180];
way["highway"~"^(path|footway|track)$"]["name"]({s},{w},{n},{e});
out geom tags;"""
    pts = overpass(q_pts, "osm_points.json", refresh)
    trails = overpass(q_trails, "osm_trails.json", refresh)
    if pts is None or trails is None:
        note = "OpenStreetMap via Overpass API - UNAVAILABLE when last fetched; re-run scripts/fetch_overlays.py --overlays"
        write_geojson("osm_access.geojson", [], note, {"status": "unavailable"})
        write_geojson("osm_trails.geojson", [], note, {"status": "unavailable"})
        return False
    # keep parking only within 300 m of a §4a stream line or point
    named_idx = set()
    for r in streams_rows:
        named_idx.update(stream_norms.get(norm_name(r["name"]), []))
    verts = []
    for i in named_idx:
        for part in line_coords(stream_feats[i]["geometry"]):
            verts.extend(part[::3])
    for r in streams_rows:
        p = stream_point(r)
        if p:
            verts.append([p[1], p[0]])

    def near_stream(lat, lng):
        for x, y in verts:
            if abs(y - lat) < 0.004 and abs(x - lng) < 0.005 and haversine_m(lat, lng, y, x) <= 300:
                return True
        return False

    out = []
    for el in pts.get("elements", []):
        tags = el.get("tags", {})
        lat, lng = (el.get("lat"), el.get("lon")) if el["type"] == "node" else (el.get("center", {}).get("lat"), el.get("center", {}).get("lon"))
        if lat is None:
            continue
        kind = "trailhead" if tags.get("highway") == "trailhead" else "parking"
        if kind == "parking" and not near_stream(lat, lng):
            continue
        out.append({"type": "Feature",
                    "properties": {"osm_id": f"{el['type']}/{el['id']}", "name": tags.get("name"), "type": kind,
                                   "fee": tags.get("fee"), "access": tags.get("access"), "operator": tags.get("operator"),
                                   "source": "OSM, unverified"},
                    "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]}})
    tr = []
    for el in trails.get("elements", []):
        if el["type"] != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        coords = [[g["lon"], g["lat"]] for g in el["geometry"]]
        tr.append({"type": "Feature",
                   "properties": {"osm_id": f"way/{el['id']}", "name": tags.get("name"), "highway": tags.get("highway"),
                                  "sac_scale": tags.get("sac_scale"), "source": "OSM, unverified"},
                   "geometry": simplify_geom({"type": "LineString", "coordinates": coords}, 0.00015, 4)})
    write_geojson("osm_access.geojson", out, "OpenStreetMap via Overpass API (ODbL)")
    write_geojson("osm_trails.geojson", tr, "OpenStreetMap via Overpass API (ODbL)")
    return True


# ---------------------------------------------------------- 6. geocoding
def nominatim(q, refresh=False, extra=None):
    key = "nominatim_" + re.sub(r"[^a-z0-9]+", "_", q.lower()) + ".json"
    params = {"q": q, "format": "jsonv2", "limit": 5, "countrycodes": "us",
              "viewbox": f"{BBOX[0]},{BBOX[3]},{BBOX[2]},{BBOX[1]}", "bounded": 1}
    if extra:
        params.update(extra)
    return get_json(SRC["nominatim"], params=params, cache_key=key, refresh=refresh, min_gap=1.1)


def line_mouth(feats, idxs):
    """Downstream end of a cluster: the end vertex that is not the start of any other segment."""
    starts = [line_coords(feats[i]["geometry"])[0][0] for i in idxs]
    for i in idxs:
        e = line_coords(feats[i]["geometry"])[-1][-1]
        if not any(haversine_m(e[1], e[0], s[1], s[0]) < 40 for s in starts):
            return e
    return line_coords(feats[idxs[0]]["geometry"])[-1][-1]


def geocode(refresh, feats, by_norm, watersheds_fc):
    log("== geocoding blank rows")
    report = []
    streams, sf = read_csv("streams.csv")
    for row in streams:
        if row["lat"] and row["lng"]:
            continue
        name = re.sub(r"\(.*?\)", "", row["name"]).strip()
        town = {"Mad River": "Waitsfield", "Dog River": "Northfield"}.get(row["watershed"], "Vermont")
        hits = nominatim(f"{name}, {town}, Vermont", refresh)
        hits = [h for h in hits if h.get("category") == "waterway" and name.lower() in h.get("display_name", "").lower()]
        cands = by_norm.get(norm_name(row["name"]), [])
        chosen = None
        if cands:
            clusters = [[cands[k] for k in c] for c in cluster_lines([feats[i] for i in cands])]
            ws = watershed_for_row(row, watersheds_fc)
            pick = None
            if hits:
                hp = (float(hits[0]["lat"]), float(hits[0]["lon"]))
                best = min(clusters, key=lambda c: min(min_dist_to_line_m(hp, feats[i]["geometry"]) for i in c))
                if min(min_dist_to_line_m(hp, feats[i]["geometry"]) for i in best) < 3000:
                    pick = best
            if pick is None and ws is not None:
                for c in clusters:
                    if point_in_geom(line_coords(feats[c[0]]["geometry"])[0][0], ws["geometry"]):
                        pick = c
                        break
            if pick is None and len(clusters) == 1:
                pick = clusters[0]
            if pick:
                m = line_mouth(feats, pick)
                chosen = (m[1], m[0], "VHD line, downstream end" + (" (Nominatim OSM waterway agrees)" if hits else " (no Nominatim hit)"))
        if chosen is None and hits:
            chosen = (float(hits[0]["lat"]), float(hits[0]["lon"]), f"Nominatim OSM {hits[0]['osm_type']}/{hits[0]['osm_id']}")
        if chosen:
            row["lat"], row["lng"] = f"{chosen[0]:.6f}", f"{chosen[1]:.6f}"
            row["coord_source"] = f"geocoded {TODAY}: {chosen[2]}"
            row["confidence"] = "low"
            report.append((row["name"], row["lat"], row["lng"], chosen[2]))
            log(f"  {row['name']}: {row['lat']},{row['lng']}  [{chosen[2]}]")
        else:
            report.append((row["name"], "", "", "NOT FOUND"))
            log(f"  {row['name']}: not found")
    write_csv("streams.csv", streams, sf)

    access, af = read_csv("access.csv")
    mad_idx = by_norm.get("mad", [])
    mad_line = [feats[i]["geometry"] for i in mad_idx]

    def nearest_to_mad(coords):
        best = None
        for x, y in coords:
            d = min(min_dist_to_line_m((y, x), g) for g in mad_line) if mad_line else 0
            if best is None or d < best[0]:
                best = (d, y, x)
        return best

    special = {
        "Fayston Elementary School lot (German Flats Rd)": ("Fayston Elementary School, Fayston, Vermont", None),
        "Austin Brook Trail / Forest Road 25 gate": ("Austin Brook Trail, Warren, Vermont", "austin"),
        "Warren village - covered bridge / Main St": ("Warren Covered Bridge, Warren, Vermont", None),
        "Mad River Greenway - Tremblay Rd parking (Waitsfield)": ("Tremblay Road, Waitsfield, Vermont", "road_end"),
        "Roxbury Gap Rd / Warren Mountain Rd (the gap)": ("Roxbury Gap, Vermont", None),
        "Moss Glen Falls pull-off (Granville Gulf, Rte 100)": ("Moss Glen Falls, Granville, Vermont", None),
    }
    for row in access:
        if row["lat"] and row["lng"]:
            continue
        q, mode = special.get(row["name"], (row["name"] + ", Vermont", None))
        chosen = None
        if mode == "road_end":
            hits = nominatim(q, refresh, {"polygon_geojson": 1})
            roads = [h for h in hits if h.get("category") == "highway" and h.get("geojson", {}).get("type") == "LineString"]
            if roads:
                b = nearest_to_mad(roads[0]["geojson"]["coordinates"])
                chosen = (b[1], b[2], f"Nominatim OSM {roads[0]['osm_type']}/{roads[0]['osm_id']} (Tremblay Rd), vertex nearest the Mad River VHD line")
        elif mode == "austin":
            hits = nominatim(q, refresh)
            hits = [h for h in hits if "austin" in h.get("display_name", "").lower()]
            if hits:
                chosen = (float(hits[0]["lat"]), float(hits[0]["lon"]), f"Nominatim OSM {hits[0]['osm_type']}/{hits[0]['osm_id']}")
            else:
                idxs = by_norm.get("austin", [])
                if idxs:
                    m = line_mouth(feats, idxs)
                    chosen = (m[1], m[0], "Austin Brook VHD line, downstream end (mouth at Rte 100) - FR 25 gate not in OSM, verify on site")
        else:
            hits = nominatim(q, refresh)
            if hits:
                h = hits[0]
                chosen = (float(h["lat"]), float(h["lon"]), f"Nominatim OSM {h['osm_type']}/{h['osm_id']}: {h.get('display_name', '')[:80]}")
        if chosen:
            row["lat"], row["lng"] = f"{chosen[0]:.6f}", f"{chosen[1]:.6f}"
            row["coord_source"] = f"geocoded {TODAY}: {chosen[2]}"
            row["confidence"] = "low"
            report.append((row["name"], row["lat"], row["lng"], chosen[2]))
            log(f"  {row['name']}: {row['lat']},{row['lng']}  [{chosen[2]}]")
        else:
            report.append((row["name"], "", "", "NOT FOUND"))
            log(f"  {row['name']}: not found")
    write_csv("access.csv", access, af)
    with open(os.path.join(DATA, "geocode_report.json"), "w") as f:
        json.dump([{"name": n, "lat": la, "lng": lo, "how": how} for n, la, lo, how in report], f, indent=1)
    return report


# --------------------------------------------------------- 7. drive times
def drive_times(refresh):
    log("== drive times from the inn (OSRM demo server)")
    path = os.path.join(DATA, "drive_times.json")
    cache = {}
    if os.path.exists(path) and not refresh:
        with open(path) as f:
            cache = json.load(f).get("times", {})
    targets = []
    streams, _ = read_csv("streams.csv")
    access, _ = read_csv("access.csv")
    for r in streams + access:
        if r["lat"] and r["lng"]:
            targets.append((r["name"], float(r["lat"]), float(r["lng"])))
    fa = os.path.join(OVR, "fishing_access.geojson")
    if os.path.exists(fa):
        with open(fa) as f:
            for ft in json.load(f)["features"]:
                x, y = ft["geometry"]["coordinates"]
                targets.append((ft["properties"]["name"], y, x))
    pois, _ = read_csv("pois.csv")
    for r in pois:
        if r["lat"] and r["lng"]:
            targets.append((r["name"], float(r["lat"]), float(r["lng"])))
    failed = 0
    for name, lat, lng in targets:
        key = f"{lat:.5f},{lng:.5f}"
        if key in cache:
            continue
        url = f"{SRC['osrm']}{INN[1]},{INN[0]};{lng},{lat}"
        try:
            j = get_json(url, params={"overview": "false"}, min_gap=1.0, timeout=30)
            if j.get("code") == "Ok":
                rt = j["routes"][0]
                cache[key] = {"min": round(rt["duration"] / 60, 1), "km": round(rt["distance"] / 1000, 1), "src": "OSRM"}
                log(f"  {name}: {cache[key]['min']} min, {cache[key]['km']} km")
                continue
            log(f"  {name}: OSRM said {j.get('code')} {j.get('message', '')}")
        except Exception as e:
            log(f"  {name}: OSRM failed ({e})")
            failed += 1
            if failed >= 3:
                log("  OSRM unreachable; remaining points will be estimated by build.py")
                break
    with open(path, "w") as f:
        json.dump({"origin": {"lat": INN[0], "lng": INN[1], "name": "The Inn at the Round Barn Farm"},
                   "source": "OSRM demo router (router.project-osrm.org), driving profile", "fetched": TODAY,
                   "times": dict(sorted(cache.items()))}, f, indent=1)
    log(f"  cached {len(cache)} drive times")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--overlays", action="store_true")
    ap.add_argument("--geocode", action="store_true")
    ap.add_argument("--drive-times", action="store_true")
    ap.add_argument("--refresh", action="store_true", help="ignore the raw cache")
    a = ap.parse_args()
    if not (a.overlays or a.geocode or a.drive_times):
        a.overlays = a.geocode = a.drive_times = True
    streams, _ = read_csv("streams.csv")
    ws_fc = None
    feats = by_norm = None
    if a.overlays or a.geocode:
        ws_fc = fetch_watersheds(a.refresh, streams)
        feats, by_norm = fetch_streams(a.refresh, streams, ws_fc)
    if a.geocode:
        geocode(a.refresh, feats, by_norm, ws_fc)
        streams, _ = read_csv("streams.csv")
        # re-run matching now that every stream has a coordinate
        feats, by_norm = fetch_streams(False, streams, ws_fc)
    if a.overlays:
        fetch_public_land(a.refresh)
        fetch_fishing_access(a.refresh)
        fetch_osm(a.refresh, feats, by_norm, streams)
    if a.drive_times:
        drive_times(a.refresh)
    log("done")


if __name__ == "__main__":
    main()
