import time, uuid
from app.config import settings
from app.services import rerouting_service, store
from app.services.geo import point_at
from app.services.routing_service import RoutingService

routing = RoutingService()

def start(route_id):
    r = store.routes[route_id]
    jid = uuid.uuid4().hex[:8]
    store.journeys[jid] = {"id": jid, "route_id": route_id, "progress": 0.0, "t": time.time(),
                           "dest": tuple(r["geometry"][-1]), "dismissed": set()}
    return jid

def _advance(j, r):
    # FREEZE_SIM_WALK: do not interpolate along geometry on a timer (SIM_SPEED / MOCK_MODE demo walk).
    j["t"] = time.time()

def status(jid):
    j = store.journeys[jid]; r = store.routes[j["route_id"]]
    _advance(j, r)
    pos = point_at(r["geometry"], j["progress"])
    ev = rerouting_service.evaluate(routing, r, j["progress"], pos, j["dest"], store.incidents)
    done = j["progress"] >= r["distance_m"] - 1
    key = frozenset(e["incident"].id for e in ev["effects"])
    rec = ev["recommended"] and key not in j["dismissed"] and not done
    if rec:
        store.routes[ev["alternative"]["id"]] = ev["alternative"]
    ahead = [{"id": e["incident"].id, "title": e["incident"].title, "type": e["incident"].type,
              "latitude": e["incident"].latitude, "longitude": e["incident"].longitude,
              "distance_ahead_m": round(e["distance_ahead_m"]), "eta_min": round(e["eta_min"], 1),
              "age_min": round(e["age_min"], 1)} for e in ev["effects"]]
    idx = int(len(r["geometry"])*j["progress"]/max(r["distance_m"], 1))
    nxt = r["geometry"][min(idx+5, len(r["geometry"])-1)]
    alt = ev["alternative"]
    analysis = {"recommended": rec, "why_not": ev["why_not"]}
    if alt:
        analysis.update({
            "improvement": ev["improvement"],
            "extra_minutes": ev["extra_minutes"],
            "alternative": {k: alt[k] for k in ("id", "geometry", "safety", "eta_min", "distance_m")},
        })
    return {"journey_id": jid, "route_id": r["id"], "position": {"latitude": pos[0], "longitude": pos[1]},
            "distance_m": round(r["distance_m"]), "progress_m": round(j["progress"]),
            "eta_min": round(ev["remaining_min"], 1),
            "safety": ev["current_safety"], "factors": ev["factors"], "geometry": r["geometry"],
            "safe_points": r.get("safe_points") or [],
            "steps": r.get("steps") or [],
            "status": "completed" if done else ("reroute_recommended" if rec else ("incident_ahead" if ahead else "on_track")),
            "incidents_ahead": ahead, "next_checkpoint": {"latitude": nxt[0], "longitude": nxt[1]},
            "reroute_analysis": analysis,
            "reroute": ({"alternative": {k: alt[k] for k in ("id", "geometry", "safety", "eta_min", "distance_m")},
                         "reasons": ev["reasons"], "improvement": ev["improvement"], "extra_minutes": ev["extra_minutes"],
                         "current_safety": ev["current_safety"], "current_eta_min": round(ev["remaining_min"], 1)} if rec else None),
            "poll_interval_seconds": settings.poll}

def dismiss(jid):
    s = status(jid)
    store.journeys[jid]["dismissed"].add(frozenset(i["id"] for i in s["incidents_ahead"]))

def switch(jid, alt_id):
    store.journeys[jid].update(route_id=alt_id, progress=0.0, t=time.time())
    return status(jid)
