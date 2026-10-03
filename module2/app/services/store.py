"""In-memory prototype store + incident sources. Swap for SQLite/PostGIS repository later."""
import json, pathlib
from app.models.schemas import Incident

class DemoIncidentSource:
    """Implemented. RSS/GDELT/UserReport sources plug in with the same .fetch()."""
    def fetch(self):
        p = pathlib.Path(__file__).resolve().parents[2]/"data"/"demo_incidents.json"
        return [Incident(**d) for d in json.loads(p.read_text())]

routes: dict = {}
journeys: dict = {}
incidents: list = DemoIncidentSource().fetch()

# SOS prototype state
sos_journeys: dict = {}
emergencies: dict = {}
# Trip-share / SOS live-monitor tokens that open the Guardian dashboard.
monitors: dict = {}
# Built email bodies when SMTP is missing or MOCK_MODE is on.
captured_emails: list = []
guardian_settings: dict = {
    "guardian_emails": [],
    "location_update_interval_minutes": 5,
    "emergency_contacts": [
        {"label": "Police", "number": "112"},
        {"label": "Emergency", "number": "108"},
    ],
    "emergency_profile": {
        "name": "",
        "address": "",
        "blood_type": "",
        "allergies": "",
        "medical_conditions": "",
    },
}
