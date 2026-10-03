import base64
import html as html_lib
import io
import logging
import smtplib
import socket
import uuid
from datetime import datetime
from email.message import EmailMessage
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request

from app.config import (
    EMOTION_ANGRY_SCORE,
    EMOTION_SAD_SCORE,
    KEYWORD_FIRST_MATCH_SCORE,
    KEYWORD_REPEAT_SCORE,
    KEYWORD_WINDOW_CAP,
    settings,
)
from app.models.schemas import AssistantAskRequest, EmergencyCreateRequest, EmergencyResolveRequest, EmergencyResponse, GuardianSettingsRequest, ShareTripRequest, SignalEventRequest, SosJourneyStartRequest
from app.services import navigation_service as nav
from app.services import store
from app.services.assistant import ask as ask_safety_assistant, compose_context, provider_status
from app.services.risk_engine import compute_risk, level_for_score, update_risk

logger = logging.getLogger(__name__)
router = APIRouter(tags=["sos"])

MODEL_ID = "Saumya3007/spee_project_fairhindiser-clues"
_fairhindiser_model = None
_fairhindiser_processor = None


def _load_fairhindiser():
    global _fairhindiser_model, _fairhindiser_processor
    if _fairhindiser_model is not None or _fairhindiser_processor is not None:
        return True
    try:
        from transformers import AutoFeatureExtractor, AutoModelForAudioClassification
        _fairhindiser_processor = AutoFeatureExtractor.from_pretrained(MODEL_ID)
        _fairhindiser_model = AutoModelForAudioClassification.from_pretrained(MODEL_ID)
        return True
    except Exception as exc:  # pragma: no cover - optional dependency path
        logger.warning("FairHindiSER unavailable: %s", exc)
        return False


def _normalize_emotion(label):
    value = (label or 'neutral').lower().strip()
    if value in {'angry', 'anger'}:
        return 'angry'
    if value in {'sad', 'cry', 'sorry', 'disappointed'}:
        return 'sad'
    if value in {'happy', 'joy'}:
        return 'happy'
    return 'neutral'


def _transcript_fallback(transcript):
    text = (transcript or '').lower()
    if any(token in text for token in ['angry', 'gussa', 'mad', 'rage', 'furious', 'hate']):
        return 'angry'
    if any(token in text for token in ['sad', 'cry', 'crying', 'upset', 'afraid', 'fear', 'depressed']):
        return 'sad'
    return 'neutral'


def _infer_emotion_from_audio(audio_bytes, sample_rate=16000, transcript=''):
    if not audio_bytes:
        return _transcript_fallback(transcript)

    ok = _load_fairhindiser()
    if not ok:
        return _transcript_fallback(transcript)

    try:
        import numpy as np
        import torch
        from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

        if _fairhindiser_processor is None or _fairhindiser_model is None:
            _fairhindiser_processor = AutoFeatureExtractor.from_pretrained(MODEL_ID)
            _fairhindiser_model = AutoModelForAudioClassification.from_pretrained(MODEL_ID)

        wav = io.BytesIO(audio_bytes)
        try:
            import soundfile as sf
            data, sr = sf.read(wav, dtype='float32', always_2d=False)
        except Exception:
            data = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            sr = sample_rate

        if data.ndim == 2:
            data = data.mean(axis=1)
        if sr != 16000:
            # approximate resample without extra dependency to keep runtime lightweight
            import math
            target = 16000
            new_len = int(len(data) * target / sr)
            if new_len > 0:
                resampled = np.interp(np.linspace(0, len(data), new_len), np.arange(len(data)), data)
                data = resampled.astype(np.float32)
                sr = target
        inputs = _fairhindiser_processor(data, sampling_rate=sr, return_tensors='pt')
        with torch.no_grad():
            logits = _fairhindiser_model(**inputs).logits
        idx = int(torch.argmax(logits, dim=-1).item())
        label = _fairhindiser_model.config.id2label.get(idx, 'neutral')
        return _normalize_emotion(label)
    except Exception as exc:  # pragma: no cover - model/runtime fallback
        logger.warning("FairHindiSER runtime inference failed: %s", exc)
        return _transcript_fallback(transcript)


def _journey(jid):
    if jid not in store.sos_journeys:
        raise HTTPException(404, "Unknown journey")
    return store.sos_journeys[jid]


def _emergency(eid):
    if eid not in store.emergencies:
        raise HTTPException(404, "Unknown emergency")
    return store.emergencies[eid]


def _reset_journey_risk_window(journey):
    journey["risk_score"] = 0
    journey["risk_level"] = "LOW"
    journey["keyword_window_score"] = 0
    journey["countdown_required"] = False
    journey["countdown_seconds"] = 0


def _guardian_emails():
    return [email.strip() for email in store.guardian_settings.get("guardian_emails", []) if email and email.strip()]


def _lan_ipv4():
    """Address of this machine on the network used for outbound traffic."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        sock.close()
    if not ip or ip.startswith("127."):
        return ""
    return ip


def _is_loopback_host(host: str | None) -> bool:
    value = (host or "").lower().strip("[]")
    return value in {"localhost", "127.0.0.1", "::1"}


def _origin_from_url(url: str | None) -> str:
    if not url or not str(url).strip():
        return ""
    parsed = urlparse(str(url).strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def _frontend_base_url(preferred: str | None = None) -> str:
    """Prefer the live page origin so guardian links match http/https."""
    preferred_origin = _origin_from_url(preferred)
    if preferred_origin and not _is_loopback_host(urlparse(preferred_origin).hostname):
        return preferred_origin

    configured = _origin_from_url(settings.frontend_base_url) or "http://localhost:5173"
    configured_parts = urlparse(configured)
    if not _is_loopback_host(configured_parts.hostname):
        return configured

    lan = _lan_ipv4()
    if not lan:
        return preferred_origin or configured
    scheme = urlparse(preferred_origin).scheme if preferred_origin else (configured_parts.scheme or "http")
    port = urlparse(preferred_origin).port if preferred_origin else configured_parts.port
    port = port or configured_parts.port or 5173
    return f"{scheme}://{lan}:{port}"


def _coords_from_geometry(geometry):
    if not geometry:
        return None
    pt = geometry[0]
    if isinstance(pt, (list, tuple)) and len(pt) >= 2:
        return {"latitude": float(pt[0]), "longitude": float(pt[1]), "source": "route_start"}
    return None


def _live_trip_fields(nav_journey_id):
    # LIVE_PATH_LASTKNOWN: Guardian map uses journey position when browser GPS is missing.
    if not nav_journey_id or nav_journey_id not in store.journeys:
        return {}
    snapshot = nav.status(nav_journey_id)
    position = snapshot.get("position") or {}
    geometry = snapshot.get("geometry") or []
    live = bool(position.get("latitude") is not None and position.get("longitude") is not None)
    if not live:
        position = _coords_from_geometry(geometry) or {}
    else:
        position = {**position, "source": position.get("source") or "journey"}
    journey = store.journeys[nav_journey_id]
    if position.get("latitude") is not None:
        journey["last_known"] = {
            "latitude": position["latitude"],
            "longitude": position["longitude"],
            "source": position.get("source") or "journey",
        }
    last_known = journey.get("last_known") or position
    return {
        "nav_journey_id": nav_journey_id,
        "safety": snapshot.get("safety"),
        "factors": snapshot.get("factors") or {},
        "progress_m": snapshot.get("progress_m"),
        "distance_m": snapshot.get("distance_m"),
        "eta_min": snapshot.get("eta_min"),
        "geometry": geometry,
        "position": position or last_known,
        "last_known": last_known,
        "location_live": live,
        "incidents_ahead": snapshot.get("incidents_ahead") or [],
        "route_id": snapshot.get("route_id"),
        "nav_status": snapshot.get("status"),
        "latitude": (position or last_known or {}).get("latitude"),
        "longitude": (position or last_known or {}).get("longitude"),
    }


def _progress_pct(fields):
    distance = fields.get("distance_m") or 0
    progress = fields.get("progress_m") or 0
    if not distance:
        return None
    return max(0, min(100, round(100.0 * progress / distance, 1)))


def _dashboard_email_bodies(payload, dashboard_link, kind):
    """Plain text plus HTML that mirrors the Guardian dashboard layout."""
    lat = payload.get("latitude")
    lon = payload.get("longitude")
    map_url = "unavailable" if lat is None or lon is None else f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"
    profile = store.guardian_settings.get("emergency_profile", {})
    address = (profile.get("address") or "Address not provided").strip() or "Address not provided"
    blood_type = (profile.get("blood_type") or "Not provided").strip() or "Not provided"
    emergency_contacts = store.guardian_settings.get("emergency_contacts") or []
    contacts_text = "\n".join(
        f"- {item.get('label', 'Contact')}: {item.get('number', 'N/A')}"
        for item in emergency_contacts if item.get("number")
    ) or "- No emergency contacts configured"
    safety = payload.get("safety")
    factors = payload.get("factors") or {}
    factor_lines = "\n".join(f"- {name}: {value}" for name, value in factors.items()) or "- Not yet scored"
    pct = _progress_pct(payload)
    headline = "URGENT SOS ALERT" if kind == "sos" else "TRIP SHARE"
    lead = (
        "This is an emergency notification. Open the same Guardian dashboard used in the app for live tracking and safety."
        if kind == "sos"
        else "A traveler shared this trip with you. Open the Guardian dashboard to watch the live route, progress, and safety score."
    )
    text = (
        f"{headline}\n\n"
        f"{lead}\n\n"
        f"User: {payload.get('user_name', 'User')}\n"
        f"Status: {payload.get('status', '')}\n"
        f"Trigger: {payload.get('trigger_type', 'SHARE')}\n"
        f"SOS risk score: {payload.get('risk_score', 0)} ({payload.get('risk_level', 'LOW')})\n"
        f"Route safety score: {safety if safety is not None else 'unavailable'} (higher is safer; crime is one factor)\n"
        f"Progress: {pct if pct is not None else 'unavailable'}%\n"
        f"ETA: {payload.get('eta_min', 'unavailable')} min\n"
        f"Time: {payload.get('created_at')}\n\n"
        "Safety factors:\n"
        f"{factor_lines}\n\n"
        "Current location:\n"
        f"Latitude: {lat if lat is not None else 'unavailable'}\n"
        f"Longitude: {lon if lon is not None else 'unavailable'}\n"
        f"Map link: {map_url}\n"
        f"Live Guardian dashboard: {dashboard_link}\n\n"
        f"Address: {address}\n"
        f"Blood type: {blood_type}\n\n"
        "Emergency contact numbers:\n"
        f"{contacts_text}\n"
    )
    esc = html_lib.escape
    factor_rows = "".join(
        f"<tr><td>{esc(str(name))}</td><td>{esc(str(value))}</td></tr>"
        for name, value in factors.items()
    ) or "<tr><td colspan='2'>Not yet scored</td></tr>"
    html = f"""<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#1d2440;background:#f5f7fc;padding:16px">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e8f2;border-radius:12px;padding:20px">
    <p style="letter-spacing:.08em;text-transform:uppercase;color:#8991aa;font-size:11px;margin:0">Sentinel live tracking</p>
    <h1 style="margin:6px 0 12px">{esc(str(payload.get('user_name') or 'User'))}</h1>
    <p style="background:#ffeaec;color:#b7283c;padding:10px;border-radius:8px;font-weight:700">{esc(headline)}</p>
    <p>{esc(lead)}</p>
    <table style="width:100%;border-collapse:collapse">
      <tr><td>Status</td><td><strong>{esc(str(payload.get('status') or ''))}</strong></td></tr>
      <tr><td>Trigger</td><td>{esc(str(payload.get('trigger_type') or 'SHARE'))}</td></tr>
      <tr><td>SOS risk</td><td>{esc(str(payload.get('risk_score', 0)))} {esc(str(payload.get('risk_level') or ''))}</td></tr>
      <tr><td>Route safety</td><td>{esc(str(safety if safety is not None else 'unavailable'))} / 100 (higher is safer)</td></tr>
      <tr><td>Progress</td><td>{esc(str(pct if pct is not None else 'unavailable'))}%</td></tr>
      <tr><td>ETA</td><td>{esc(str(payload.get('eta_min', 'unavailable')))} min</td></tr>
    </table>
    <h2 style="font-size:16px">Safety factors</h2>
    <table style="width:100%;border-collapse:collapse">{factor_rows}</table>
    <p>Location: {esc(str(lat if lat is not None else 'unavailable'))}, {esc(str(lon if lon is not None else 'unavailable'))}</p>
    <p><a href="{esc(dashboard_link)}" style="display:inline-block;background:#c41220;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Open live Guardian dashboard</a></p>
    <p style="color:#77809a;font-size:12px">This email is a snapshot. The dashboard at the link above is the same Guardian page in the app and updates live.</p>
  </div>
</body></html>"""
    return text, html, dashboard_link


def _deliver_guardian_email(subject, text, html, recipient_email, extra=None):
    extra = extra or {}
    captured = {
        "recipient": recipient_email,
        "subject": subject,
        "text": text,
        "html": html,
        **extra,
    }
    store.captured_emails.append(captured)
    logger.info("Guardian email captured for %s subject=%s", recipient_email, subject)

    host = settings.smtp_host
    port = settings.smtp_port
    user = settings.smtp_username
    password = settings.smtp_password
    from_addr = settings.smtp_from
    smtp_ready = all([host, port, user, password, from_addr])

    if not recipient_email:
        return {"success": False, "error": "No valid guardian email configured.", "recipient": recipient_email, "captured": True}

    if not smtp_ready:
        ok = bool(settings.mock_mode)
        return {
            "success": ok,
            "captured": True,
            "error": None if ok else "SMTP not configured. Add SMTP_HOST/PORT/USERNAME/PASSWORD and SMTP_FROM (or EMAIL_* equivalents). Body captured for demo.",
            "recipient": recipient_email,
        }

    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = from_addr
        msg["To"] = recipient_email
        msg["Reply-To"] = from_addr
        msg.set_content(text)
        msg.add_alternative(html, subtype="html")
        port_int = int(port)
        if port_int == 465:
            with smtplib.SMTP_SSL(host, port_int) as smtp:
                smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port_int, timeout=30) as smtp:
                if host.lower() not in {"localhost"}:
                    smtp.starttls()
                smtp.login(user, password)
                smtp.send_message(msg)
        return {"success": True, "captured": True, "recipient": recipient_email}
    except Exception as exc:  # pragma: no cover - network config only
        return {"success": bool(settings.mock_mode), "captured": True, "error": str(exc), "recipient": recipient_email}


def _send_alert_email(emergency, recipient_email):
    base_url = emergency.get("public_origin") or _frontend_base_url()
    dashboard_link = f"{base_url}/dashboard/{emergency['id']}"
    live = _live_trip_fields(emergency.get("nav_journey_id"))
    payload = {**emergency, **{k: v for k, v in live.items() if v is not None or k in {"factors", "geometry", "incidents_ahead"}}}
    if live.get("latitude") is not None:
        payload["latitude"] = live["latitude"]
        payload["longitude"] = live["longitude"]
    text, html, dashboard_link = _dashboard_email_bodies(payload, dashboard_link, "sos")
    return _deliver_guardian_email(
        "URGENT: SOS ALERT - Immediate Assistance Needed",
        text,
        html,
        recipient_email,
        extra={"kind": "sos", "dashboard_url": dashboard_link, "monitor_id": emergency["id"]},
    )


def _send_share_email(monitor, recipient_email):
    base_url = monitor.get("public_origin") or _frontend_base_url()
    dashboard_link = f"{base_url}/dashboard/{monitor['id']}"
    live = _live_trip_fields(monitor.get("nav_journey_id"))
    payload = {**monitor, **live}
    text, html, dashboard_link = _dashboard_email_bodies(payload, dashboard_link, "share")
    return _deliver_guardian_email(
        "Sentinel trip share: live Guardian dashboard",
        text,
        html,
        recipient_email,
        extra={"kind": "share", "dashboard_url": dashboard_link, "monitor_id": monitor["id"]},
    )


def _sync_emergency_risk(emergency, journey=None):
    if not emergency:
        return
    jid = emergency.get("journey_id")
    trip = journey or (store.sos_journeys.get(jid) if jid else None)
    if trip is None:
        return
    if trip.get("risk_score") is not None:
        emergency["risk_score"] = int(trip.get("risk_score") or 0)
        emergency["risk_level"] = trip.get("risk_level") or level_for_score(emergency["risk_score"])
    if trip.get("trigger_reasons"):
        emergency["trigger_reasons"] = list(trip["trigger_reasons"])
    eid = emergency.get("id")
    if eid and eid in store.monitors:
        store.monitors[eid]["risk_score"] = emergency["risk_score"]
        store.monitors[eid]["risk_level"] = emergency.get("risk_level")


def _attach_sos_to_share_monitors(emergency):
    eid = emergency.get("id")
    nav_id = emergency.get("nav_journey_id")
    sos_id = emergency.get("journey_id")
    for monitor in store.monitors.values():
        if monitor.get("monitor_kind") != "share":
            continue
        matches_nav = nav_id and monitor.get("nav_journey_id") == nav_id
        matches_sos = sos_id and monitor.get("sos_journey_id") == sos_id
        if not (matches_nav or matches_sos):
            continue
        monitor["emergency_id"] = eid
        monitor["sos_journey_id"] = sos_id
        monitor["status"] = emergency.get("status") or "ACTIVE"
        monitor["trigger_type"] = emergency.get("trigger_type")
        monitor["risk_score"] = emergency.get("risk_score", 0)
        monitor["risk_level"] = emergency.get("risk_level") or "LOW"
        monitor.setdefault("events", []).append({
            "event_type": "SOS_TRIGGERED",
            "created_at": datetime.utcnow().isoformat() + "Z",
        })


def _linked_emergency(record):
    eid = record.get("emergency_id")
    if eid and eid in store.emergencies:
        return store.emergencies[eid]
    if record.get("id") in store.emergencies:
        return store.emergencies[record["id"]]
    sos_id = record.get("sos_journey_id")
    if sos_id and sos_id in store.sos_journeys:
        jeid = store.sos_journeys[sos_id].get("emergency_id")
        if jeid and jeid in store.emergencies:
            return store.emergencies[jeid]
    nav_id = record.get("nav_journey_id")
    if nav_id:
        for item in store.emergencies.values():
            if item.get("nav_journey_id") == nav_id and item.get("status") != "RESOLVED":
                return item
    return None


def _monitor_record(token):
    if token in store.monitors:
        return store.monitors[token]
    if token in store.emergencies:
        emergency = store.emergencies[token]
        return {
            "id": token,
            "monitor_kind": "emergency",
            "emergency_id": token,
            "nav_journey_id": emergency.get("nav_journey_id"),
            "sos_journey_id": emergency.get("journey_id"),
            "user_name": emergency.get("user_name"),
            "public_origin": emergency.get("public_origin"),
            "created_at": emergency.get("created_at"),
            "status": emergency.get("status"),
            "trigger_type": emergency.get("trigger_type"),
            "risk_score": emergency.get("risk_score", 0),
            "risk_level": emergency.get("risk_level", "LOW"),
        }
    return None


def _monitor_live_response(token):
    record = _monitor_record(token)
    if record is None:
        raise HTTPException(404, "Unknown monitor")
    live = _live_trip_fields(record.get("nav_journey_id"))
    if not live:
        live = {
            k: record[k]
            for k in ("safety", "factors", "progress_m", "distance_m", "eta_min", "geometry", "position", "last_known", "incidents_ahead", "route_id", "nav_status", "latitude", "longitude")
            if k in record and record[k] is not None
        }
    if live.get("latitude") is None:
        last = record.get("last_known") or {}
        if last.get("latitude") is not None:
            live["latitude"] = last["latitude"]
            live["longitude"] = last["longitude"]
            live["position"] = last
            live["last_known"] = last
            live["location_live"] = False
    emergency = _linked_emergency(record)
    extra_live = {k: live[k] for k in ("safety", "factors", "progress_m", "distance_m", "eta_min", "geometry", "position", "last_known", "location_live", "incidents_ahead", "route_id", "nav_status") if k in live}
    sos_journey_id = (emergency or {}).get("journey_id") or record.get("sos_journey_id")
    sos_trip = store.sos_journeys.get(sos_journey_id) if sos_journey_id else None
    if emergency:
        _sync_emergency_risk(emergency, sos_trip)
        risk = compute_risk(emergency)
        latitude = live.get("latitude") if live.get("latitude") is not None else emergency.get("latitude")
        longitude = live.get("longitude") if live.get("longitude") is not None else emergency.get("longitude")
        if live.get("latitude") is not None:
            emergency["latitude"] = live["latitude"]
            emergency["longitude"] = live["longitude"]
            emergency["last_known"] = live.get("last_known") or {"latitude": live["latitude"], "longitude": live["longitude"]}
        sos_active = emergency.get("status") == "ACTIVE" or (sos_trip or {}).get("status") == "EMERGENCY_ACTIVE"
        return EmergencyResponse(
            id=token,
            journey_id=emergency.get("journey_id") or record.get("sos_journey_id") or "",
            trigger_type=emergency.get("trigger_type") or "MANUAL",
            user_name=emergency.get("user_name") or record.get("user_name"),
            latitude=latitude,
            longitude=longitude,
            accuracy=emergency.get("accuracy"),
            created_at=emergency["created_at"],
            status=emergency["status"],
            events=list(emergency.get("events") or []) + list(record.get("events") or []),
            nav_journey_id=record.get("nav_journey_id"),
            sos_journey_id=sos_journey_id,
            sos_active=bool(sos_active),
            sos_status=(sos_trip or {}).get("status") or emergency.get("status"),
            monitor_kind=record.get("monitor_kind") or "emergency",
            **risk,
            **extra_live,
        )
    latitude = live.get("latitude")
    longitude = live.get("longitude")
    sos_active = (sos_trip or {}).get("status") == "EMERGENCY_ACTIVE"
    risk_score = int((sos_trip or record).get("risk_score") or 0) if sos_trip else int(record.get("risk_score") or 0)
    return EmergencyResponse(
        id=token,
        journey_id=record.get("sos_journey_id") or "",
        trigger_type=record.get("trigger_type") or "SHARE",
        user_name=record.get("user_name"),
        latitude=latitude,
        longitude=longitude,
        created_at=record.get("created_at") or datetime.utcnow().isoformat() + "Z",
        status=record.get("status") or live.get("nav_status") or "SHARED",
        events=list(record.get("events", [])),
        risk_score=risk_score,
        risk_level=(sos_trip or {}).get("risk_level") or record.get("risk_level") or "LOW",
        trigger_reasons=list((sos_trip or {}).get("trigger_reasons") or record.get("trigger_reasons") or ["Trip shared with guardians"]),
        nav_journey_id=record.get("nav_journey_id"),
        sos_journey_id=sos_journey_id,
        sos_active=bool(sos_active),
        sos_status=(sos_trip or {}).get("status"),
        monitor_kind=record.get("monitor_kind") or "share",
        **extra_live,
    )


@router.get("/settings/guardians")
def get_guardian_settings():
    settings = dict(store.guardian_settings)
    settings["guardian_emails"] = [email for email in settings.get("guardian_emails", []) if email]
    settings.setdefault("emergency_contacts", [])
    settings.setdefault("emergency_profile", {
        "name": "",
        "address": "",
        "blood_type": "",
        "allergies": "",
        "medical_conditions": "",
    })
    return settings


@router.post("/settings/guardians")
def save_guardian_settings(req: GuardianSettingsRequest):
    emails = []
    for email in req.guardian_emails or []:
        cleaned = (email or "").strip()
        if cleaned:
            emails.append(cleaned)
    if len(emails) < 2:
        raise HTTPException(400, "At least two guardian emails are required")
    contacts = []
    for item in req.emergency_contacts or []:
        number = (item.number or "").strip()
        if number:
            contacts.append({"label": (item.label or "Emergency").strip() or "Emergency", "number": number})
    if len(contacts) < 2:
        contacts = [{"label": "Police", "number": "112"}, {"label": "Emergency", "number": "108"}]
    profile = {
        "name": (req.emergency_profile.name or "").strip(),
        "address": (req.emergency_profile.address or "").strip(),
        "blood_type": (req.emergency_profile.blood_type or "").strip(),
        "allergies": (req.emergency_profile.allergies or "").strip(),
        "medical_conditions": (req.emergency_profile.medical_conditions or "").strip(),
    }
    store.guardian_settings = {
        "guardian_emails": emails[:2],
        "location_update_interval_minutes": max(1, int(req.location_update_interval_minutes or 5)),
        "emergency_contacts": contacts[:2],
        "emergency_profile": profile,
    }
    return store.guardian_settings


@router.post("/journeys/start")
def start_journey(req: SosJourneyStartRequest):
    jid = uuid.uuid4().hex[:8]
    store.sos_journeys[jid] = {
        "journey_id": jid,
        "status": "JOURNEY_ACTIVE",
        "risk_score": 0,
        "risk_level": "LOW",
        "trigger_reasons": [],
        "keyword_window_score": 0,
        "user_name": req.user_name,
        "latitude": req.latitude,
        "longitude": req.longitude,
    }
    return {"journey_id": jid, "status": "JOURNEY_ACTIVE"}


@router.post("/assistant/ask")
def assistant_ask(req: AssistantAskRequest):
    return ask_safety_assistant(
        req.question,
        compose_context(
            sos_journey_id=req.journey_id,
            nav_journey_id=req.nav_journey_id,
            route_id=req.route_id,
            client=req.context,
        ),
    )


@router.get("/assistant/status")
def assistant_status():
    return provider_status()


@router.post("/journeys/{jid}/end")
def end_journey(jid: str):
    journey = _journey(jid)
    journey["status"] = "IDLE"
    if journey.get("emergency_id"):
        emergency = _emergency(journey["emergency_id"])
        emergency["status"] = "RESOLVED"
    return {"journey_id": jid, "status": "IDLE"}


@router.get("/journeys/{jid}/status")
def journey_status(jid: str):
    journey = _journey(jid)
    return {
        "journey_id": jid,
        "status": journey["status"],
        "risk_score": journey.get("risk_score", 0),
        "risk_level": journey.get("risk_level", "LOW"),
        "trigger_reasons": journey.get("trigger_reasons", []),
        "countdown_required": journey.get("countdown_required", False),
        "countdown_seconds": journey.get("countdown_seconds", 0),
        "latitude": journey.get("latitude"),
        "longitude": journey.get("longitude"),
        "sos_trigger": journey.get("sos_trigger"),
        "email_status": journey.get("email_status"),
        "help_alerted": journey.get("help_alerted"),
        "guardian_count": journey.get("guardian_count"),
        "emergency_id": journey.get("emergency_id"),
    }


@router.post("/signals")
def record_signal(req: SignalEventRequest):
    journey = _journey(req.journey_id)
    if req.latitude is not None:
        journey["latitude"] = req.latitude
    if req.longitude is not None:
        journey["longitude"] = req.longitude

    if req.signal_type == "KEYWORD_DETECTED":
        current = journey.get("keyword_window_score", 0)
        if current == 0:
            delta = KEYWORD_FIRST_MATCH_SCORE
            reason = "Distress keyword detected"
        else:
            delta = max(0, min(KEYWORD_REPEAT_SCORE, KEYWORD_WINDOW_CAP - current))
            reason = "Repeated distress keyword"
        journey["keyword_window_score"] = current + delta
        risk = update_risk(journey, "KEYWORD_DETECTED", reason=reason, delta=delta)
    elif req.signal_type == "EMOTION_DETECTED":
        emotion = (req.emotion or "neutral").lower()
        if emotion == "angry":
            delta = EMOTION_ANGRY_SCORE
            signal_reason = "Angry voice tone"
        elif emotion == "sad":
            delta = EMOTION_SAD_SCORE
            signal_reason = "Sad voice tone"
        else:
            delta = 0
            signal_reason = "Neutral voice tone"
        risk = update_risk(journey, "EMOTION_DETECTED", reason=signal_reason, delta=delta)
    elif req.signal_type == "FALL_DETECTED":
        risk = update_risk(journey, "FALL_DETECTED", reason="Fall detected + post-fall inactivity", delta=70)
    elif req.signal_type == "COUNTDOWN_EXPIRED":
        risk = update_risk(journey, "COUNTDOWN_EXPIRED", reason="No response to safety countdown", delta=30)
    elif req.signal_type == "MOVEMENT_RESUMED":
        risk = update_risk(journey, "MOVEMENT_RESUMED", reason="Normal movement resumed", delta=-10)
    elif req.signal_type == "SAFE":
        emergency_id = journey.pop("emergency_id", None)
        if emergency_id and emergency_id in store.emergencies:
            store.emergencies[emergency_id]["status"] = "RESOLVED"
            store.emergencies[emergency_id]["risk_score"] = 0
            store.emergencies[emergency_id]["risk_level"] = "LOW"
            store.emergencies[emergency_id]["trigger_reasons"] = ["User confirmed safe"]
        _reset_journey_risk_window(journey)
        journey["status"] = "IDLE"
        journey["trigger_reasons"] = []
        store.sos_journeys.pop(req.journey_id, None)
        return {"journey_id": req.journey_id, "risk_score": 0, "risk_level": "LOW",
                "trigger_reasons": [], "countdown_required": False, "countdown_seconds": 0,
                "status": "IDLE"}
    else:
        risk = compute_risk(journey)

    journey["risk_score"] = risk["risk_score"]
    journey["risk_level"] = risk["risk_level"]
    journey["trigger_reasons"] = risk["trigger_reasons"]
    eid = journey.get("emergency_id")
    if eid and eid in store.emergencies:
        _sync_emergency_risk(store.emergencies[eid], journey)
    if journey.get("status") == "EMERGENCY_ACTIVE":
        journey["countdown_required"] = False
        journey["countdown_seconds"] = 0
        return {
            "journey_id": req.journey_id,
            "risk_score": risk["risk_score"],
            "risk_level": risk["risk_level"],
            "trigger_reasons": risk["trigger_reasons"],
            "countdown_required": False,
            "countdown_seconds": 0,
            "status": "EMERGENCY_ACTIVE",
            "emergency_id": eid,
        }
    if risk["risk_score"] >= 60:
        journey["countdown_required"] = True
        journey["countdown_seconds"] = settings.safety_countdown_seconds
        if journey["status"] == "JOURNEY_ACTIVE":
            journey["status"] = "SUSPECTED_EMERGENCY"
    else:
        journey["countdown_required"] = False
        journey["countdown_seconds"] = 0
    return {"journey_id": req.journey_id, **risk, "countdown_required": journey.get("countdown_required", False), "countdown_seconds": journey.get("countdown_seconds", 0), "status": journey.get("status", "JOURNEY_ACTIVE")}


@router.post("/emergencies")
def create_emergency(req: EmergencyCreateRequest, request: Request):
    # TODO: single-user prototype assumption; without journey_id the first stored journey is used.
    journey = _journey(req.journey_id) if req.journey_id else next(iter(store.sos_journeys.values()), None)
    if journey is None:
        raise HTTPException(404, "No active journey")
    trigger_score = 100 if req.trigger_type == "MANUAL" else int(journey.get("risk_score", 0))
    eid = uuid.uuid4().hex[:8]
    emergency = {
        "id": eid,
        "journey_id": journey["journey_id"],
        "trigger_type": req.trigger_type,
        "user_name": req.user_name or journey.get("user_name", "User"),
        "latitude": req.latitude if req.latitude is not None else journey.get("latitude"),
        "longitude": req.longitude if req.longitude is not None else journey.get("longitude"),
        "accuracy": req.accuracy,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "status": "ACTIVE",
        "risk_score": trigger_score,
        "risk_level": level_for_score(trigger_score),
        "trigger_reasons": ["Manual SOS"] if req.trigger_type == "MANUAL" else list(journey.get("trigger_reasons", [])),
        "events": [],
        "public_origin": _frontend_base_url(
            req.public_origin or request.headers.get("origin") or request.headers.get("referer")
        ),
        "nav_journey_id": req.nav_journey_id,
    }
    store.emergencies[eid] = emergency
    store.monitors[eid] = {
        "id": eid,
        "monitor_kind": "emergency",
        "emergency_id": eid,
        "nav_journey_id": req.nav_journey_id,
        "sos_journey_id": journey["journey_id"],
        "user_name": emergency["user_name"],
        "public_origin": emergency["public_origin"],
        "created_at": emergency["created_at"],
        "status": "ACTIVE",
        "trigger_type": req.trigger_type,
        "risk_score": trigger_score,
        "risk_level": level_for_score(trigger_score),
        "events": [],
    }
    journey["emergency_id"] = eid
    journey["status"] = "EMERGENCY_ACTIVE"
    journey["risk_score"] = trigger_score
    journey["risk_level"] = level_for_score(trigger_score)
    journey["countdown_required"] = False
    journey["countdown_seconds"] = 0
    journey["trigger_reasons"] = ["Manual SOS"] if req.trigger_type == "MANUAL" else list(journey.get("trigger_reasons") or ["SOS ACTIVATED"])
    emergency["trigger_reasons"] = list(journey["trigger_reasons"])
    _attach_sos_to_share_monitors(emergency)
    guardian_emails = _guardian_emails()
    email_results = [_send_alert_email(emergency, email) for email in guardian_emails]
    email_status = (
        "sent"
        if guardian_emails and all(result.get("success") for result in email_results)
        else "skipped"
        if not guardian_emails
        else "partial"
    )
    journey["sos_trigger"] = req.trigger_type
    journey["help_alerted"] = email_status in {"sent", "partial"}
    journey["email_status"] = email_status
    journey["guardian_count"] = len(guardian_emails)
    dashboard_url = f"{emergency['public_origin']}/dashboard/{eid}"
    return {
        "emergency_id": eid,
        "dashboard_url": dashboard_url,
        "status": "EMERGENCY_ACTIVE",
        "risk_score": trigger_score,
        "risk_level": level_for_score(trigger_score),
        "countdown_required": False,
        "countdown_seconds": 0,
        "trigger_reasons": emergency["trigger_reasons"],
        "sos_trigger": req.trigger_type,
        "help_alerted": email_status in {"sent", "partial"},
        "email_status": email_status,
        "guardian_count": len(guardian_emails),
        "guardian_emails_sent": guardian_emails,
        "email_results": email_results,
    }


def _emergency_response(emergency):
    return _monitor_live_response(emergency["id"])


@router.get("/emergencies/{eid}", response_model=EmergencyResponse)
def read_emergency(eid: str):
    return _monitor_live_response(eid)


@router.get("/monitor/{token}", response_model=EmergencyResponse)
def read_monitor(token: str):
    return _monitor_live_response(token)


@router.post("/monitor/share")
def share_trip(req: ShareTripRequest, request: Request):
    if req.nav_journey_id not in store.journeys:
        raise HTTPException(404, "Unknown navigation journey")
    emails = _guardian_emails()
    if len(emails) < 1:
        raise HTTPException(400, "Add guardian emails in Settings before sharing a trip")
    token = uuid.uuid4().hex[:8]
    origin = _frontend_base_url(req.public_origin or request.headers.get("origin") or request.headers.get("referer"))
    live = _live_trip_fields(req.nav_journey_id)
    monitor = {
        "id": token,
        "monitor_kind": "share",
        "emergency_id": None,
        "nav_journey_id": req.nav_journey_id,
        "sos_journey_id": req.sos_journey_id,
        "user_name": req.user_name or "User",
        "public_origin": origin,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "status": live.get("nav_status") or "SHARED",
        "trigger_type": "SHARE",
        "risk_score": 0,
        "risk_level": "LOW",
        "trigger_reasons": ["Trip shared with guardians"],
        "events": [{"event_type": "TRIP_SHARED", "created_at": datetime.utcnow().isoformat() + "Z"}],
        "latitude": live.get("latitude"),
        "longitude": live.get("longitude"),
        "last_known": live.get("last_known") or live.get("position"),
        "safety": live.get("safety"),
        "factors": live.get("factors") or {},
        "geometry": live.get("geometry") or [],
        "progress_m": live.get("progress_m"),
        "distance_m": live.get("distance_m"),
    }
    store.monitors[token] = monitor
    email_results = [_send_share_email(monitor, email) for email in emails]
    email_status = (
        "sent"
        if emails and all(result.get("success") for result in email_results)
        else "skipped"
        if not emails
        else "partial"
    )
    dashboard_url = f"{origin}/dashboard/{token}"
    return {
        "monitor_id": token,
        "dashboard_url": dashboard_url,
        "email_status": email_status,
        "guardian_count": len(emails),
        "email_results": email_results,
        "captured": any(r.get("captured") for r in email_results),
    }


@router.post("/emergencies/{eid}/resolve")
def resolve_emergency(eid: str, req: EmergencyResolveRequest):
    emergency = _emergency(eid)
    journey = _journey(emergency["journey_id"])
    if req.reason == "SAFE":
        emergency["status"] = "RESOLVED"
        journey["status"] = "JOURNEY_ACTIVE"
        _reset_journey_risk_window(journey)
        journey["trigger_reasons"] = []
        emergency["risk_score"] = 0
        emergency["risk_level"] = "LOW"
        emergency["trigger_reasons"] = ["User confirmed safe"]
        return {"emergency_id": eid, "status": "RESOLVED", "message": "Journey resumed"}
    emergency["status"] = "RESOLVED"
    return {"emergency_id": eid, "status": "RESOLVED"}


@router.post("/emergencies/{eid}/resend-email")
def resend_email(eid: str):
    emergency = _emergency(eid)
    results = [_send_alert_email(emergency, email) for email in _guardian_emails()]
    success = bool(results) and all(r.get("success") for r in results)
    errors = [r["error"] for r in results if r.get("error")]
    emergency.setdefault("events", []).append({"event_type": "EMAIL_SENT", "metadata": {"success": success, "errors": errors}})
    return {"emergency_id": eid, "success": success, "email_results": results}


@router.post("/internal/emotion-infer")
def emotion_infer(payload: dict):
    payload = payload or {}
    transcript = payload.get("transcript") or ""
    label = payload.get("emotion")
    if label is None:
        audio_b64 = payload.get("audio_base64") or payload.get("audio")
        if audio_b64:
            try:
                raw = base64.b64decode(audio_b64)
                label = _infer_emotion_from_audio(raw, sample_rate=int(payload.get("sample_rate") or 16000), transcript=transcript)
            except Exception:
                label = _transcript_fallback(transcript)
        else:
            label = _transcript_fallback(transcript)
    return {"label": _normalize_emotion(label), "source": "FairHindiSER" if _fairhindiser_model is not None else "heuristic"}
