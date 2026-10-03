"""Turn instructions for a route.

OpenRouteService steps are preferred. Geometry-only maneuvers cover mock
routes and ORS responses that omit segments.
"""
import math

from app.services.geo import haversine

# ORS instruction types: https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/instruction-types/
_ORS_MANEUVER = {
    0: "left",
    1: "right",
    2: "sharp-left",
    3: "sharp-right",
    4: "slight-left",
    5: "slight-right",
    6: "straight",
    7: "roundabout",
    8: "roundabout",
    9: "uturn",
    10: "arrive",
    11: "depart",
    12: "slight-left",
    13: "slight-right",
}


def _bearing(a, b) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlon = lon2 - lon1
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _turn(delta: float) -> str:
    mag = abs(delta)
    if mag < 25:
        return "straight"
    if mag >= 150:
        return "uturn"
    side = "right" if delta > 0 else "left"
    if mag < 50:
        return f"slight-{side}"
    if mag > 110:
        return f"sharp-{side}"
    return side


def _phrase(maneuver: str, road: str) -> str:
    onto = f" onto {road}" if road else ""
    labels = {
        "depart": f"Head{onto or ' out'}",
        "straight": f"Continue{onto}",
        "slight-left": f"Slight left{onto}",
        "left": f"Turn left{onto}",
        "sharp-left": f"Sharp left{onto}",
        "slight-right": f"Slight right{onto}",
        "right": f"Turn right{onto}",
        "sharp-right": f"Sharp right{onto}",
        "uturn": "Make a U-turn",
        "roundabout": f"At the roundabout{onto}",
        "arrive": "You have arrived",
    }
    return labels.get(maneuver, f"Continue{onto}")


def maneuvers_from_geometry(geom) -> list[dict]:
    """Depart, significant bearing changes, and arrival along a polyline."""
    if not geom or len(geom) < 2:
        return []
    steps = [{
        "instruction": "Head out",
        "maneuver": "depart",
        "type": 11,
        "name": "",
        "distance_m": 0.0,
        "latitude": geom[0][0],
        "longitude": geom[0][1],
        "index": 0,
    }]
    prev_bearing = _bearing(geom[0], geom[1])
    for i in range(1, len(geom) - 1):
        nxt = _bearing(geom[i], geom[i + 1])
        delta = (nxt - prev_bearing + 540.0) % 360.0 - 180.0
        maneuver = _turn(delta)
        prev_bearing = nxt
        if maneuver == "straight":
            continue
        steps.append({
            "instruction": _phrase(maneuver, ""),
            "maneuver": maneuver,
            "type": None,
            "name": "",
            "distance_m": 0.0,
            "latitude": geom[i][0],
            "longitude": geom[i][1],
            "index": i,
        })
    steps.append({
        "instruction": "You have arrived",
        "maneuver": "arrive",
        "type": 10,
        "name": "",
        "distance_m": 0.0,
        "latitude": geom[-1][0],
        "longitude": geom[-1][1],
        "index": len(geom) - 1,
    })
    for i, step in enumerate(steps[:-1]):
        a = geom[step["index"]]
        b = geom[steps[i + 1]["index"]]
        step["distance_m"] = round(haversine(a, b), 1)
    return steps


def steps_from_ors(properties: dict, geom) -> list[dict]:
    """Parse ORS segment steps. Empty when the payload has none."""
    if not geom:
        return []
    out = []
    for segment in properties.get("segments") or []:
        if not isinstance(segment, dict):
            continue
        for step in segment.get("steps") or []:
            if not isinstance(step, dict):
                continue
            way = step.get("way_points") or [0]
            try:
                idx = int(way[0])
            except (TypeError, ValueError, IndexError):
                idx = 0
            idx = max(0, min(idx, len(geom) - 1))
            try:
                kind = int(step.get("type"))
            except (TypeError, ValueError):
                kind = 6
            maneuver = _ORS_MANEUVER.get(kind, "straight")
            name = step.get("name") if isinstance(step.get("name"), str) else ""
            instruction = step.get("instruction")
            if not isinstance(instruction, str) or not instruction.strip():
                instruction = _phrase(maneuver, name)
            out.append({
                "instruction": instruction.strip(),
                "maneuver": maneuver,
                "type": kind,
                "name": name,
                "distance_m": float(step.get("distance") or 0),
                "latitude": geom[idx][0],
                "longitude": geom[idx][1],
                "index": idx,
            })
    return out
