from dataclasses import replace
from datetime import timedelta
from fastapi.testclient import TestClient
from app.main import app
from app.models.schemas import Incident, utcnow
from app.services import route_matcher, rerouting_service as rs
from app.services import store
from app.services.geo import point_at
from app.services.routing_service import RoutingService

S, D = (26.9196, 75.7878), (26.9855, 75.8513)
c = TestClient(app)

def route(): return RoutingService().routes(S, D)[0]
def inc(lat, lon, age=5, sev=.9):
    return Incident(id="x", title="t", latitude=lat, longitude=lon, severity=sev, confidence=.9, published_at=utcnow()-timedelta(minutes=age))

def test_near_detected_far_ignored():
    r = route(); p = point_at(r["geometry"], 600)
    assert route_matcher.match(r["geometry"], [inc(*p)], 0, 8)
    assert not route_matcher.match(r["geometry"], [inc(p[0]+0.1, p[1])], 0, 8)

def test_recent_more_relevant_and_eta():
    r = route(); p = point_at(r["geometry"], 600)
    new = route_matcher.match(r["geometry"], [inc(*p, age=2)], 0, 10)[0]
    old = route_matcher.match(r["geometry"], [inc(*p, age=300)], 0, 10)[0]
    assert new["impact"] > old["impact"]
    assert abs(new["eta_min"] - 1.0) < .1

def test_no_reroute_without_incident():
    assert not rs.evaluate(RoutingService(), route(), 0, S, D, [])["recommended"]

def test_reroute_and_eta_limit(monkeypatch):
    r = route(); p = point_at(r["geometry"], 600)
    assert rs.evaluate(RoutingService(), r, 0, S, D, [inc(*p)])["recommended"]
    monkeypatch.setattr(rs, "settings", replace(rs.settings, max_extra=-100))
    assert not rs.evaluate(RoutingService(), r, 0, S, D, [inc(*p)])["recommended"]

def test_small_improvement_no_reroute(monkeypatch):
    r = route(); p = point_at(r["geometry"], 600)
    monkeypatch.setattr(rs, "settings", replace(rs.settings, min_improve=999))
    assert not rs.evaluate(RoutingService(), r, 0, S, D, [inc(*p)])["recommended"]

def test_navigation_status_does_not_walk_the_pin():
    body = {"start": {"latitude": S[0], "longitude": S[1]}, "destination": {"latitude": D[0], "longitude": D[1]}}
    recs = c.post("/api/routes/search", json=body).json()["routes"]
    jid = c.post("/api/navigation/start", json={"route_id": recs[0]["id"]}).json()["journey_id"]
    first = c.get(f"/api/navigation/{jid}/status").json()
    import time as _time
    _time.sleep(0.2)
    second = c.get(f"/api/navigation/{jid}/status").json()
    assert first["progress_m"] == second["progress_m"] == 0
    assert first["position"] == second["position"]


def test_full_demo_flow():
    body = {"start": {"latitude": S[0], "longitude": S[1]}, "destination": {"latitude": D[0], "longitude": D[1]}}
    res = c.post("/api/routes/search", json=body).json()
    assert 2 <= len(res["routes"]) <= 3
    recs = [r for r in res["routes"] if r.get("recommended")]
    assert len(recs) == 1
    assert "rank_score" in recs[0]
    jid = c.post("/api/navigation/start", json={"route_id": recs[0]["id"]}).json()["journey_id"]
    assert c.get(f"/api/navigation/{jid}/status").json()["reroute"] is None
    assert c.post("/api/demo/inject-incident", json={"journey_id": jid}).status_code == 200
    st = c.get(f"/api/navigation/{jid}/status").json()
    assert st["reroute"]
    st = c.post(f"/api/navigation/{jid}/switch", json={"alternative_route_id": st["reroute"]["alternative"]["id"]}).json()
    assert st["status"] in ("on_track", "incident_ahead")
    assert c.get("/api/incidents/recent").status_code == 200
    assert c.post("/api/incidents/report", json={"title": "x", "latitude": 26.9, "longitude": 75.8}).status_code == 200
    assert c.get(f"/api/navigation/{jid}/route-context").status_code == 200
    assert c.post("/api/routes/recalculate", json={"journey_id": jid}).status_code == 200

def test_manual_sos_emails_guardians_and_safe_resets(monkeypatch):
    from app.api import sos

    previous_settings = store.guardian_settings
    store.guardian_settings = {
        "guardian_emails": ["one@example.com", "two@example.com"],
        "location_update_interval_minutes": 5,
        "emergency_contacts": [],
        "emergency_profile": {},
    }
    sent = []
    monkeypatch.setattr(sos, "_send_alert_email",
                        lambda emergency, email: sent.append((emergency["id"], email)) or
                        {"success": True, "recipient": email})
    try:
        started = c.post("/journeys/start", json={
            "user_name": "Test User", "latitude": S[0], "longitude": S[1]
        }).json()
        jid = started["journey_id"]
        emergency = c.post("/emergencies", json={
            "journey_id": jid, "trigger_type": "MANUAL",
            "latitude": S[0], "longitude": S[1],
        })
        assert emergency.status_code == 200
        assert emergency.json()["email_status"] == "sent"
        assert [email for _, email in sent] == ["one@example.com", "two@example.com"]
        safe = c.post("/signals", json={"journey_id": jid, "signal_type": "SAFE"})
        assert safe.json()["status"] == "IDLE"
        assert jid not in store.sos_journeys
        assert store.emergencies[emergency.json()["emergency_id"]]["status"] == "RESOLVED"
    finally:
        store.guardian_settings = previous_settings


def test_frontend_base_url_prefers_https_page_origin(monkeypatch):
    from app.api import sos

    monkeypatch.setattr(sos.settings, "frontend_base_url", "http://localhost:5173")
    monkeypatch.setattr(sos, "_lan_ipv4", lambda: "192.168.1.20")
    assert sos._frontend_base_url("https://demo.example.com/home") == "https://demo.example.com"
    assert sos._frontend_base_url("https://localhost:5173") == "https://192.168.1.20:5173"


def test_emergency_email_uses_https_public_origin(monkeypatch):
    from app.api import sos

    previous_settings = store.guardian_settings
    store.guardian_settings = {
        "guardian_emails": ["one@example.com", "two@example.com"],
        "location_update_interval_minutes": 5,
        "emergency_contacts": [],
        "emergency_profile": {},
    }
    captured = []

    def fake_send(emergency, email):
        captured.append(emergency.get("public_origin"))
        return {"success": True, "recipient": email}

    monkeypatch.setattr(sos, "_send_alert_email", fake_send)
    try:
        started = c.post("/journeys/start", json={
            "user_name": "Test User", "latitude": S[0], "longitude": S[1]
        }).json()
        emergency = c.post("/emergencies", json={
            "journey_id": started["journey_id"],
            "trigger_type": "MANUAL",
            "latitude": S[0],
            "longitude": S[1],
            "public_origin": "https://sentinel.example.com",
        })
        assert emergency.status_code == 200
        assert emergency.json()["dashboard_url"].startswith("https://sentinel.example.com/dashboard/")
        assert captured == ["https://sentinel.example.com", "https://sentinel.example.com"]
        assert store.emergencies[emergency.json()["emergency_id"]]["public_origin"] == "https://sentinel.example.com"
    finally:
        store.guardian_settings = previous_settings


def test_nav_progress_does_not_walk_while_still():
    from app.services import navigation_service as nav

    body = {"start": {"latitude": S[0], "longitude": S[1]}, "destination": {"latitude": D[0], "longitude": D[1]}}
    routes = c.post("/api/routes/search", json=body).json()["routes"]
    jid = c.post("/api/navigation/start", json={"route_id": routes[0]["id"]}).json()["journey_id"]
    first = c.get(f"/api/navigation/{jid}/status").json()
    store.journeys[jid]["t"] = 0
    later = c.get(f"/api/navigation/{jid}/status").json()
    assert later["progress_m"] == first["progress_m"] == 0
    assert later["position"] == first["position"]
    nav._advance(store.journeys[jid], store.routes[store.journeys[jid]["route_id"]])
    assert store.journeys[jid]["progress"] == 0


def test_share_trip_and_sos_use_same_dashboard(monkeypatch):
    from app.api import sos

    previous_settings = store.guardian_settings
    store.captured_emails.clear()
    store.guardian_settings = {
        "guardian_emails": ["one@example.com", "two@example.com"],
        "location_update_interval_minutes": 5,
        "emergency_contacts": [],
        "emergency_profile": {},
    }
    monkeypatch.setattr(sos.settings, "mock_mode", True)
    monkeypatch.setattr(sos.settings, "smtp_host", "")
    try:
        body = {"start": {"latitude": S[0], "longitude": S[1]}, "destination": {"latitude": D[0], "longitude": D[1]}}
        routes = c.post("/api/routes/search", json=body).json()["routes"]
        jid = c.post("/api/navigation/start", json={"route_id": routes[0]["id"]}).json()["journey_id"]
        shared = c.post("/monitor/share", json={
            "nav_journey_id": jid,
            "user_name": "Test User",
            "public_origin": "https://sentinel.example.com",
        })
        assert shared.status_code == 200
        share_body = shared.json()
        assert share_body["email_status"] == "sent"
        assert "/dashboard/" in share_body["dashboard_url"]
        monitor_id = share_body["monitor_id"]
        live = c.get(f"/monitor/{monitor_id}").json()
        assert live["id"] == monitor_id
        assert live["safety"] is not None
        assert "historical_crime" in (live.get("factors") or {})
        assert live["geometry"]
        assert live["position"]["latitude"] is not None
        assert live.get("last_known") or live["position"]
        assert store.captured_emails
        assert "Open live Guardian dashboard" in store.captured_emails[-1]["html"]
        started = c.post("/journeys/start", json={"user_name": "Test User", "latitude": S[0], "longitude": S[1]}).json()
        emergency = c.post("/emergencies", json={
            "journey_id": started["journey_id"],
            "trigger_type": "MANUAL",
            "latitude": S[0],
            "longitude": S[1],
            "public_origin": "https://sentinel.example.com",
            "nav_journey_id": jid,
        })
        assert emergency.status_code == 200
        eid = emergency.json()["emergency_id"]
        assert emergency.json()["risk_score"] == 100
        trip = c.get(f"/journeys/{started['journey_id']}/status").json()
        assert trip["status"] == "EMERGENCY_ACTIVE"
        assert trip["risk_score"] == 100
        dash = c.get(f"/emergencies/{eid}").json()
        same = c.get(f"/monitor/{eid}").json()
        assert dash["id"] == same["id"] == eid
        assert dash["geometry"] == same["geometry"]
        assert dash["position"]
        assert dash["sos_active"] is True
        assert dash["risk_score"] == 100
        shared_live = c.get(f"/monitor/{monitor_id}").json()
        assert shared_live["sos_active"] is True
        assert shared_live["risk_score"] == 100
        assert shared_live["trigger_type"] == "MANUAL"
        keyword = c.post("/signals", json={"journey_id": started["journey_id"], "signal_type": "KEYWORD_DETECTED"})
        assert keyword.json()["status"] == "EMERGENCY_ACTIVE"
        assert keyword.json()["risk_score"] == 100
        assert c.get(f"/monitor/{monitor_id}").json()["risk_score"] == 100
        assert "Live Guardian dashboard" in store.captured_emails[-1]["text"]
    finally:
        store.guardian_settings = previous_settings


def test_share_dashboard_keeps_live_sos_risk_after_signals(monkeypatch):
    from app.api import sos

    previous_settings = store.guardian_settings
    store.guardian_settings = {
        "guardian_emails": ["one@example.com", "two@example.com"],
        "location_update_interval_minutes": 5,
        "emergency_contacts": [],
        "emergency_profile": {},
    }
    monkeypatch.setattr(sos.settings, "mock_mode", True)
    monkeypatch.setattr(sos.settings, "smtp_host", "")
    try:
        body = {"start": {"latitude": S[0], "longitude": S[1]}, "destination": {"latitude": D[0], "longitude": D[1]}}
        routes = c.post("/api/routes/search", json=body).json()["routes"]
        nav_id = c.post("/api/navigation/start", json={"route_id": routes[0]["id"]}).json()["journey_id"]
        monitor_id = c.post("/monitor/share", json={"nav_journey_id": nav_id, "user_name": "Test User"}).json()["monitor_id"]
        started = c.post("/journeys/start", json={"user_name": "Test User", "latitude": S[0], "longitude": S[1]}).json()
        jid = started["journey_id"]
        before = c.post("/signals", json={"journey_id": jid, "signal_type": "KEYWORD_DETECTED"}).json()["risk_score"]
        emergency = c.post("/emergencies", json={
            "journey_id": jid,
            "trigger_type": "AUTO",
            "latitude": S[0],
            "longitude": S[1],
            "nav_journey_id": nav_id,
        }).json()
        assert emergency["risk_score"] == before
        after = c.post("/signals", json={"journey_id": jid, "signal_type": "FALL_DETECTED"}).json()
        assert after["risk_score"] > before
        live = c.get(f"/monitor/{monitor_id}").json()
        assert live["sos_active"] is True
        assert live["risk_score"] == after["risk_score"]
        assert c.get(f"/journeys/{jid}/status").json()["risk_score"] == after["risk_score"]
    finally:
        store.guardian_settings = previous_settings

