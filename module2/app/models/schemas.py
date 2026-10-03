from datetime import datetime, timezone
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field

IncidentType = Literal["accident","road_closure","fire","flooding","protest","crime","traffic","other"]
SignalType = Literal["MANUAL_SOS", "KEYWORD_DETECTED", "EMOTION_DETECTED", "FALL_DETECTED", "COUNTDOWN_EXPIRED", "SAFE", "MOVEMENT_RESUMED"]
RiskLevel = Literal["LOW", "SUSPICIOUS", "HIGH", "CRITICAL"]
TriggerType = Literal["MANUAL", "AUTO"]

class LatLon(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)

class Incident(BaseModel):
    id: str
    type: IncidentType = "other"
    title: str
    description: str = ""
    latitude: float
    longitude: float
    published_at: datetime
    severity: float = Field(0.5, ge=0, le=1)
    source: str = "demo"
    confidence: float = Field(0.8, ge=0, le=1)

class IncidentReport(BaseModel):
    type: IncidentType = "other"
    title: str
    description: str = ""
    latitude: float
    longitude: float
    severity: float = 0.5

class SearchRequest(BaseModel):
    start: LatLon
    destination: LatLon

class StartRequest(BaseModel):
    route_id: str

class RecalcRequest(BaseModel):
    journey_id: str

class SwitchRequest(BaseModel):
    alternative_route_id: str

class InjectRequest(BaseModel):
    journey_id: Optional[str] = None
    type: IncidentType = "accident"
    severity: float = 0.9
    ahead_meters: float = 600
    title: str = "Traffic accident ahead"

class SosJourneyStartRequest(BaseModel):
    user_name: Optional[str] = "User"
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class SignalEventRequest(BaseModel):
    journey_id: str
    signal_type: SignalType = "KEYWORD_DETECTED"
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy: Optional[float] = None
    emotion: Optional[str] = None
    transcript: Optional[str] = None

class EmergencyCreateRequest(BaseModel):
    journey_id: Optional[str] = None
    trigger_type: TriggerType = "MANUAL"
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy: Optional[float] = None
    user_name: Optional[str] = "User"
    public_origin: Optional[str] = None
    nav_journey_id: Optional[str] = None


class ShareTripRequest(BaseModel):
    nav_journey_id: str
    user_name: Optional[str] = "User"
    public_origin: Optional[str] = None
    sos_journey_id: Optional[str] = None

class EmergencyResolveRequest(BaseModel):
    reason: str = "SAFE"


class AssistantAskRequest(BaseModel):
    question: str
    journey_id: Optional[str] = None
    nav_journey_id: Optional[str] = None
    route_id: Optional[str] = None
    context: dict[str, Any] = Field(default_factory=dict)


class EmergencyResponse(BaseModel):
    id: str
    journey_id: str
    trigger_type: str
    user_name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy: Optional[float] = None
    created_at: str
    status: str
    risk_score: int
    risk_level: str
    trigger_reasons: list[str] = Field(default_factory=list)
    events: list[dict] = Field(default_factory=list)
    safety: Optional[float] = None
    factors: dict[str, Any] = Field(default_factory=dict)
    progress_m: Optional[float] = None
    distance_m: Optional[float] = None
    eta_min: Optional[float] = None
    geometry: list[Any] = Field(default_factory=list)
    position: Optional[dict[str, Any]] = None
    last_known: Optional[dict[str, Any]] = None
    location_live: Optional[bool] = None
    incidents_ahead: list[dict] = Field(default_factory=list)
    route_id: Optional[str] = None
    nav_status: Optional[str] = None
    nav_journey_id: Optional[str] = None
    sos_journey_id: Optional[str] = None
    sos_active: bool = False
    sos_status: Optional[str] = None
    monitor_kind: str = "emergency"

class EmergencyContactEntry(BaseModel):
    label: str = "Emergency"
    number: str = ""

class EmergencyProfile(BaseModel):
    name: str = ""
    address: str = ""
    blood_type: str = ""
    allergies: str = ""
    medical_conditions: str = ""

class GuardianSettingsRequest(BaseModel):
    guardian_emails: list[str] = Field(default_factory=lambda: ["", ""])
    location_update_interval_minutes: int = Field(default=5, ge=1, le=60)
    emergency_contacts: list[EmergencyContactEntry] = Field(default_factory=lambda: [
        EmergencyContactEntry(label="Police", number="112"),
        EmergencyContactEntry(label="Emergency", number="108"),
    ])
    emergency_profile: EmergencyProfile = Field(default_factory=EmergencyProfile)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)

def aware(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
