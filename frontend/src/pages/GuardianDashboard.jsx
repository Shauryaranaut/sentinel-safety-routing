import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import MapView from '../components/MapView.jsx'
import { Num, SafetyFactorList, SafetyScore } from '../components/Parts.jsx'
import { Badge } from '../components/ui/badge.jsx'

export const DASHBOARD_POLL_MS = 5000

function pickPosition(emergency) {
  const live = emergency.position
  if (live && live.latitude != null && live.longitude != null) return { point: live, source: emergency.location_live === false ? 'last_known' : (live.source || 'live') }
  if (emergency.latitude != null && emergency.longitude != null) {
    return { point: { latitude: emergency.latitude, longitude: emergency.longitude }, source: 'last_known' }
  }
  const last = emergency.last_known
  if (last && last.latitude != null && last.longitude != null) return { point: last, source: 'last_known' }
  const geometry = emergency.geometry || []
  if (geometry.length) {
    const pt = geometry[0]
    if (Array.isArray(pt) && pt.length >= 2) return { point: { latitude: pt[0], longitude: pt[1] }, source: 'route' }
  }
  return { point: null, source: null }
}

async function readJson(url) {
  const response = await fetch(url)
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Unable to load emergency')
  return response.json()
}

function mergeLiveSos(monitor, emergency, journey) {
  const base = { ...(monitor || {}), ...(emergency || {}) }
  const trip = journey || {}
  const riskScore = trip.risk_score ?? emergency?.risk_score ?? monitor?.risk_score
  const sosActive = Boolean(
    trip.status === 'EMERGENCY_ACTIVE'
    || emergency?.sos_active
    || monitor?.sos_active
    || (emergency?.status === 'ACTIVE' && (emergency?.trigger_type === 'MANUAL' || emergency?.trigger_type === 'AUTO'))
  )
  return {
    ...base,
    risk_score: riskScore == null ? 0 : Number(riskScore),
    risk_level: trip.risk_level || emergency?.risk_level || monitor?.risk_level,
    trigger_reasons: (trip.trigger_reasons && trip.trigger_reasons.length)
      ? trip.trigger_reasons
      : (emergency?.trigger_reasons || monitor?.trigger_reasons || []),
    sos_active: sosActive,
    sos_status: trip.status || emergency?.sos_status || monitor?.sos_status,
    journey_id: trip.journey_id || emergency?.journey_id || monitor?.journey_id,
    sos_journey_id: monitor?.sos_journey_id || emergency?.sos_journey_id || trip.journey_id,
  }
}

export default function GuardianDashboard() {
  const { emergencyId } = useParams()
  const [emergency, setEmergency] = useState(null)
  const [state, setState] = useState('loading')

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        let monitor = await readJson(`/monitor/${emergencyId}`)
        if (!monitor) monitor = await readJson(`/emergencies/${emergencyId}`)
        if (!monitor) {
          if (active) setState('invalid')
          return
        }
        let linkedEmergency = monitor
        if (monitor.id && monitor.id !== emergencyId) {
          linkedEmergency = await readJson(`/emergencies/${monitor.id}`) || monitor
        }
        if (monitor.sos_active || monitor.trigger_type === 'MANUAL' || monitor.trigger_type === 'AUTO') {
          linkedEmergency = await readJson(`/emergencies/${emergencyId}`) || linkedEmergency
        }
        const sosJourneyId = monitor.sos_journey_id || (monitor.monitor_kind === 'emergency' ? monitor.journey_id : null)
        let journey = null
        if (sosJourneyId) {
          try {
            journey = await readJson(`/journeys/${sosJourneyId}/status`)
          } catch {
            journey = null
          }
        }
        const payload = mergeLiveSos(monitor, linkedEmergency, journey)
        if (active) {
          setEmergency(payload)
          setState('ready')
        }
      } catch {
        if (active) setState('error')
      }
    }
    load()
    const timer = setInterval(load, DASHBOARD_POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [emergencyId])

  if (state === 'loading') return <main className="guardian-message">Loading live trip data...</main>
  if (state === 'invalid') return <main className="guardian-message">This emergency link is invalid or has expired.</main>
  if (state === 'error') return <main className="guardian-message">Live emergency data is temporarily unavailable.</main>

  const { point: position, source: locationSource } = pickPosition(emergency)
  const geometry = emergency.geometry || []
  const hasRoute = geometry.length >= 2
  const distance = emergency.distance_m || 0
  const progress = emergency.progress_m || 0
  const progressPct = distance ? Math.max(0, Math.min(100, Math.round((100 * progress) / distance))) : null
  const events = [...(emergency.events || [])].reverse()
  const isShare = (emergency.monitor_kind === 'share') && !emergency.sos_active
  const sosOn = Boolean(emergency.sos_active || emergency.sos_status === 'EMERGENCY_ACTIVE')
  const routes = hasRoute
    ? [{ id: emergency.route_id || 'live', geometry, safety: emergency.safety }]
    : []
  const mapTitle = locationSource === 'live' || emergency.location_live
    ? 'Live location and route'
    : locationSource
      ? 'Last known location and route'
      : 'Route map'

  return (
    <main className="guardian-dashboard">
      {sosOn && (
        <div className="guardian-sos-banner" role="alert">
          <strong>SOS triggered</strong>
          <span>Live SOS risk is updating on this Guardian dashboard (the same page emailed when live location was shared).</span>
        </div>
      )}
      {emergency.status === 'RESOLVED' && <div className="resolved-banner">This emergency has been resolved</div>}
      {emergency.nav_status === 'completed' && <div className="resolved-banner">This trip has completed</div>}
      <header>
        <div>
          <span className="eyebrow">{sosOn ? 'Sentinel live SOS' : (isShare ? 'Sentinel live trip' : 'Sentinel live emergency')}</span>
          <h1>{emergency.user_name || 'User'}</h1>
        </div>
        <Badge variant={(emergency.status === 'RESOLVED' || (emergency.status === 'SHARED' && !sosOn)) ? 'secondary' : 'destructive'}>{sosOn ? 'SOS triggered' : emergency.status}</Badge>
      </header>
      <section className="guardian-summary panel">
        <div><small>Trigger</small><strong>{emergency.trigger_type}</strong></div>
        <div><small>Started</small><strong>{new Date(emergency.created_at).toLocaleString()}</strong></div>
        <div className="guardian-risk">
          <small>Route safety</small>
          {emergency.safety != null
            ? <span className="guardian-safety"><SafetyScore value={emergency.safety} /> / 100</span>
            : <strong>Not yet scored</strong>}
        </div>
        <div className="guardian-risk">
          <small>Live SOS risk</small>
          <Badge variant="outline" className="risk-level-badge"><Num value={emergency.risk_score} risk className="score" /> {emergency.risk_level}</Badge>
        </div>
        <div>
          <small>Progress</small>
          <strong>{progressPct != null ? `${progressPct}% · ${Math.round(progress)} m of ${Math.round(distance)} m` : 'Waiting for route'}</strong>
        </div>
        <div>
          <small>ETA</small>
          <strong>{emergency.eta_min != null ? `${emergency.eta_min} min` : 'Unavailable'}</strong>
        </div>
      </section>
      <section className="guardian-map panel">
        <h2>{mapTitle}</h2>
        {hasRoute || position
          ? <MapView
              routes={routes}
              selectedId={emergency.route_id || 'live'}
              incidents={emergency.incidents_ahead || []}
              position={position}
              start={hasRoute ? { latitude: geometry[0][0], longitude: geometry[0][1] } : position}
              dest={hasRoute ? { latitude: geometry[geometry.length - 1][0], longitude: geometry[geometry.length - 1][1] } : undefined}
            />
          : <div className="location-unavailable">Location unavailable</div>}
      </section>
      <div className="guardian-details">
        <section className="panel">
          <h2>Safety factors</h2>
          {emergency.factors && Object.keys(emergency.factors).length
            ? <SafetyFactorList factors={emergency.factors} />
            : <p className="muted">Safety factors will appear once a route is active. Historical crime is one factor, not the whole score.</p>}
        </section>
        <section className="panel">
          <h2>{sosOn ? 'SOS reasons' : (isShare ? 'Trip notes' : 'Trigger reasons')}</h2>
          {emergency.trigger_reasons?.length ? <ul>{emergency.trigger_reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p className="muted">No trigger reasons recorded</p>}
        </section>
        <section className="panel">
          <h2>Incidents ahead</h2>
          {emergency.incidents_ahead?.length
            ? <ul>{emergency.incidents_ahead.map((item) => <li key={item.id || item.title}>{item.title} ({item.distance_ahead_m} m)</li>)}</ul>
            : <p className="muted">No incidents ahead</p>}
        </section>
        <section className="panel">
          <h2>Activity</h2>
          {events.length ? <ol className="event-timeline">{events.map((event, index) => <li key={index}><strong>{event.event_type || event.type || 'Update'}</strong><span>{event.created_at ? new Date(event.created_at).toLocaleString() : 'Time not recorded'}</span></li>)}</ol> : <p className="muted">No activity logged yet</p>}
        </section>
      </div>
    </main>
  )
}
