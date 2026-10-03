import { useEffect, useRef, useState } from 'react'
import { Phone } from 'lucide-react'
import IncomingCallScreen from '../components/IncomingCallScreen.jsx'
import MapView from '../components/MapView.jsx'
import NavigationHud from '../components/NavigationHud.jsx'
import SafetyAssistantPanel from '../components/SafetyAssistantPanel.jsx'
import { TimeProfileTable, DepartCompare, highRiskExposure, speedScore, routeScore, RouteCard, SelectedRouteSummary, RerouteCard, WhyNotCard, IncidentSummary, SafetyProfile, SafePointPanel, IndependencePanel, AnalysisPanel, JourneyStatus, LoadingState, ErrorState } from '../components/Parts.jsx'
import { api, PLACES, POLL_MS } from '../services/api.js'
import KEYWORDS from '../data/distress-keywords.json'
import { navigationCue, snapToRoute } from '../lib/navigation.js'

const DEFAULT_START = { name: 'Jaipur center (demo)', latitude: 26.9196, longitude: 75.7878 }
const parseCoords = (q = '') => { const m = String(q).trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/); if (!m) return null; const latitude = Number(m[1]), longitude = Number(m[2]); if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null; return { name: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, latitude, longitude } }

const bestRouteId = (list, preferenceValue) => {
  const usable = (list || []).filter((route) => route?.eta_min > 0)
  if (!usable.length) return list?.[0]?.id
  const fastest = Math.min(...usable.map((route) => route.eta_min))
  return [...usable].sort((a, b) => {
    const score = (route) => routeScore(route.safety, speedScore(route, fastest), preferenceValue)
    const diff = score(b) - score(a)
    if (diff) return diff
    return a.eta_min - b.eta_min
  })[0].id
}

const normalizeText = (value = '') => value.toLowerCase().replace(/\s+/g, ' ').trim()
const keywordMatch = (value = '') => KEYWORDS.some((keyword) => normalizeText(value).includes(normalizeText(keyword)))
const classifyVoiceEmotion = (value = '') => {
  const text = normalizeText(value)
  if (/(angry|gussa|mad|furious|hate|rage)/.test(text)) return 'angry'
  if (/(sad|cry|crying|upset|depressed|afraid|fear)/.test(text)) return 'sad'
  return 'neutral'
}
const encodeWav = (samples, sampleRate = 16000) => {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const write = (offset, value) => view.setUint32(offset, value, true)
  const write16 = (offset, value) => view.setUint16(offset, value, true)

  write(0, 0x46464952)
  write(4, 36 + samples.length * 2)
  write(8, 0x45564157)
  write(12, 0x20746d66)
  write(16, 16)
  write16(20, 1)
  write16(22, 1)
  write(24, sampleRate)
  write(28, sampleRate * 2)
  write16(32, 2)
  write16(34, 16)
  write(36, 0x61746164)
  write(40, samples.length * 2)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

export default function Home() {
  const [start, setStart] = useState(DEFAULT_START), [dest, setDest] = useState(PLACES[0])
  const [routes, setRoutes] = useState([]), [sel, setSel] = useState(), [busy, setBusy] = useState(false)
  const [err, setErr] = useState(), [jid, setJid] = useState(), [st, setSt] = useState(), [note, setNote] = useState()
  const [incidents, setIncidents] = useState([])
  const [preference, setPreference] = useState(50)
  const [destinationMode, setDestinationMode] = useState(false), [destinationQuery, setDestinationQuery] = useState('')
  const [gps, setGps] = useState(), watch = useRef()
  const [nearbySafePoints, setNearbySafePoints] = useState([])
  const [sosJourney, setSosJourney] = useState(null), [sosStatus, setSosStatus] = useState(null), [sosNotice, setSosNotice] = useState('')
  const [isListening, setIsListening] = useState(false), [manualTranscript, setManualTranscript] = useState('help me')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [activeNav, setActiveNav] = useState('Home')
  const [departMode, setDepartMode] = useState('Now'), [departTime, setDepartTime] = useState('21:30'), [navCollapsed, setNavCollapsed] = useState(false)
  const [mapMode, setMapMode] = useState('safety'), [geoResults, setGeoResults] = useState([]), [geoBusy, setGeoBusy] = useState(false)
  const [originMode, setOriginMode] = useState(false), [originQuery, setOriginQuery] = useState(''), [originResults, setOriginResults] = useState([]), [originBusy, setOriginBusy] = useState(false)
  const [livePoint, setLivePoint] = useState()
  const liveCrimeKey = useRef()
  const [currentPage, setCurrentPage] = useState('home')
  const [fakeCallActive, setFakeCallActive] = useState(false)
  const [guardianEmails, setGuardianEmails] = useState([])
  const [emergencyContacts, setEmergencyContacts] = useState([
    { label: 'Police', number: '112' },
    { label: 'Ambulance', number: '108' }
  ])
  const [emergencyProfile, setEmergencyProfile] = useState({
    name: '',
    address: '',
    blood_type: '',
    allergies: '',
    medical_conditions: '',
  })
  const [locationUpdateMinutes, setLocationUpdateMinutes] = useState(5)
  const [settingsSavedMessage, setSettingsSavedMessage] = useState('')
  const [countdownOpen, setCountdownOpen] = useState(false)
  const [countdownSeconds, setCountdownSeconds] = useState(10)
  const recognitionRef = useRef(null)
  const audioStreamRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const lastVoiceEventRef = useRef(0)
  const countdownTriggeredRef = useRef(false)
  const triggerRef = useRef(null)
  const fallListenerRef = useRef(null)
  const run = async (fn) => { setErr(); try { return await fn() } catch (e) { setErr(e.message) } }

  useEffect(() => { api.recent().then(setIncidents).catch(() => {}) }, [])
  useEffect(() => {
    const loadSettings = async () => {
      const settings = await run(() => api.getGuardianSettings())
      if (!settings) return
      const emails = Array.isArray(settings.guardian_emails) ? settings.guardian_emails : []
      const contacts = Array.isArray(settings.emergency_contacts) && settings.emergency_contacts.length
        ? settings.emergency_contacts
        : [{ label: 'Police', number: '112' }, { label: 'Ambulance', number: '108' }]
      setGuardianEmails(emails.slice(0, 2))
      setEmergencyContacts(contacts.slice(0, 2).map((item) => ({ label: item.label || 'Emergency', number: item.number || '' })))
      setEmergencyProfile({
        name: settings.emergency_profile?.name || '',
        address: settings.emergency_profile?.address || '',
        blood_type: settings.emergency_profile?.blood_type || '',
        allergies: settings.emergency_profile?.allergies || '',
        medical_conditions: settings.emergency_profile?.medical_conditions || '',
      })
      setLocationUpdateMinutes(Number(settings.location_update_interval_minutes) || 5)
    }
    loadSettings()
  }, [])

  const validGuardianEmails = guardianEmails.map((email) => (email || '').trim()).filter(Boolean)
  const validEmergencyContacts = emergencyContacts.filter((c) => (c.number || '').trim())

  const saveSettings = async () => {
    const cleanEmails = guardianEmails.map((email) => (email || '').trim()).filter(Boolean)
    if (cleanEmails.length < 2) {
      setSosNotice('Add guardian emails in Settings before enabling the safety monitor.')
      setSettingsSavedMessage('Need two guardian emails.')
      setCurrentPage('settings')
      setActiveNav('Settings')
      return
    }

    const payload = {
      guardian_emails: cleanEmails.slice(0, 2),
      location_update_interval_minutes: Number(locationUpdateMinutes) || 5,
      emergency_contacts: emergencyContacts
        .map((item) => ({ label: item.label || 'Emergency', number: String(item.number || '').trim() }))
        .filter((item) => item.number),
      emergency_profile: {
        ...emergencyProfile,
        name: (emergencyProfile.name || '').trim(),
        address: (emergencyProfile.address || '').trim(),
        blood_type: (emergencyProfile.blood_type || '').trim(),
        allergies: (emergencyProfile.allergies || '').trim(),
        medical_conditions: (emergencyProfile.medical_conditions || '').trim(),
      }
    }

    const saved = await run(() => api.saveGuardianSettings(payload))
    if (!saved) return
    setGuardianEmails(saved.guardian_emails || cleanEmails.slice(0, 2))
    setEmergencyContacts((saved.emergency_contacts || []).map((item) => ({ label: item.label || 'Emergency', number: item.number || '' })))
    setEmergencyProfile({
      name: saved.emergency_profile?.name || '',
      address: saved.emergency_profile?.address || '',
      blood_type: saved.emergency_profile?.blood_type || '',
      allergies: saved.emergency_profile?.allergies || '',
      medical_conditions: saved.emergency_profile?.medical_conditions || '',
    })
    setLocationUpdateMinutes(Number(saved.location_update_interval_minutes) || 5)
    setSettingsSavedMessage('Settings saved.')
    setSosNotice(`Guardian alerts configured for ${cleanEmails.join(', ')}.`)
    setCurrentPage('home')
    setActiveNav('Home')
  }

  const stopVoiceMonitoring = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop())
      audioStreamRef.current = null
    }
    setIsListening(false)
  }

  const ensureGuardiansConfigured = () => {
    if (validGuardianEmails.length < 2) {
      setCurrentPage('settings')
      setActiveNav('Settings')
      setSosNotice('Add guardian emails in Settings before enabling the safety monitor.')
      return false
    }
    return true
  }

  // UI-only: shows a notice but does not call the backend or re-send any location to guardians.
  const shareGuardianLocation = () => {
    if (!sosJourney || validGuardianEmails.length === 0) return
    const recipients = validGuardianEmails.join(', ')
    setSosNotice(`SOS location shared to ${recipients}. Help contacted and is on the way.`)
  }

  const processTranscript = async (transcript) => {
    const text = (transcript || '').trim()
    if (!text) return

    const now = Date.now()
    if (now - lastVoiceEventRef.current < 2500) return
    lastVoiceEventRef.current = now

    setSosNotice(`Heard: "${text}"`)

    if (/safe|i am safe|i'm safe/.test(normalizeText(text))) {
      await triggerSafetyEvent('SAFE')
      return
    }

    if (keywordMatch(text)) {
      await triggerSafetyEvent('KEYWORD_DETECTED')
      const emotion = await classifyWithFairHindiSER(text)
      if (emotion !== 'neutral') {
        await triggerSafetyEvent('EMOTION_DETECTED', emotion)
      }
    }
  }

  const classifyWithFairHindiSER = async (transcript) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return classifyVoiceEmotion(transcript)
    }

    try {
      if (!audioStreamRef.current) {
        audioStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      }

      const stream = audioStreamRef.current
      const recorder = new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      const audioChunks = []
      recorder.ondataavailable = (event) => event.data && audioChunks.push(event.data)

      const recorded = await new Promise((resolve, reject) => {
        recorder.onstop = () => resolve(new Blob(audioChunks, { type: recorder.mimeType || 'audio/webm' }))
        recorder.onerror = () => reject(new Error('Audio capture failed'))
        recorder.start()
        setTimeout(() => recorder.stop(), 2500)
      })

      const arrayBuffer = await recorded.arrayBuffer()
      const audioContext = new (window.AudioContext || window.webkitAudioContext)()
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0))
      const channelData = decoded.getChannelData(0)
      const mono = new Float32Array(channelData.length)
      for (let i = 0; i < channelData.length; i++) mono[i] = channelData[i]
      const wavBytes = encodeWav(mono, decoded.sampleRate || 16000)
      const audioBase64 = btoa(String.fromCharCode(...wavBytes))
      const response = await fetch('/internal/emotion-infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, audio_base64: audioBase64, sample_rate: decoded.sampleRate || 16000 })
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.label) return data.label.toLowerCase()
      return classifyVoiceEmotion(transcript)
    } catch (error) {
      console.warn('FairHindiSER inference failed, using transcript fallback', error)
      return classifyVoiceEmotion(transcript)
    }
  }

  const startVoiceMonitoring = async () => {
    setLiveTranscript('')

    if (!navigator.mediaDevices?.getUserMedia) {
      setSosNotice('Microphone access is unavailable in this browser. Use the manual transcript box or demo buttons instead.')
      setIsListening(false)
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioStreamRef.current = stream
    } catch (error) {
      setSosNotice(`Microphone permission is blocked: ${error.message || 'allow mic access to enable live voice detection.'}`)
      setIsListening(false)
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setSosNotice('Browser speech recognition is unavailable here. The app is in transcript fallback mode, so you can still trigger SOS manually.')
      setIsListening(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'en-IN'
    recognition.interimResults = true
    recognition.continuous = true

    recognition.onresult = async (event) => {
      const results = Array.from(event.results)
      const interim = results.map((result) => result[0]?.transcript || '').join(' ').trim()
      const finalText = results.filter((result) => result.isFinal).map((result) => result[0]?.transcript || '').join(' ').trim()

      setLiveTranscript(interim || finalText)

      if (finalText) {
        await processTranscript(finalText)
      }
    }

    recognition.onerror = (event) => {
      const fallbackMessages = ['network', 'service-not-allowed', 'not-allowed', 'audio-capture', 'no-speech']
      const msg = fallbackMessages.includes(event.error)
        ? 'Browser speech recognition is unavailable here. The manual transcript box and demo buttons are still active.'
        : `Microphone listening failed: ${event.error}`

      setSosNotice(msg)
      setIsListening(false)
      setLiveTranscript('')
    }

    recognition.onend = () => {
      setIsListening(false)
    }

    recognitionRef.current = recognition
    setIsListening(true)
    try { recognition.start() } catch { setIsListening(false) }
  }

  const startLabel = start.name || `${start.latitude.toFixed(4)}, ${start.longitude.toFixed(4)}`
  const pickOrigin = (place) => { setStart(place); setOriginMode(false); setOriginQuery(''); setOriginResults([]); setRoutes([]); setSel() }
  const locate = () => {
    if (!navigator.geolocation) { setNote('Geolocation is unavailable. Pick a start place or type coordinates.'); return }
    navigator.geolocation.getCurrentPosition(
      (p) => pickOrigin({ name: 'My location', latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => setNote('Live location denied or unavailable. Choose a start place; routing does not need GPS.'),
    )
  }
  const chooseOrigin = (value) => { if (value === '__search__') { setOriginMode(true); setOriginQuery(''); return } if (value === '__gps__') { locate(); return } const next = PLACES.find((p) => p.name === value); if (next) pickOrigin(next) }
  const typeOrigin = (value) => { setOriginQuery(value); const coords = parseCoords(value); if (coords) { pickOrigin(coords); return } const next = PLACES.find((p) => p.name.toLowerCase() === value.trim().toLowerCase()); if (next) pickOrigin(next) }
  const geocodeOrigin = async () => { const q = originQuery.trim(); if (!q) return; const coords = parseCoords(q); if (coords) { pickOrigin(coords); return } setOriginBusy(true); setErr()
    const local = PLACES.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())), found = await api.geocode(q).catch(() => [])
    setOriginBusy(false); const all = [...local, ...found]; setOriginResults(all); if (!all.length) setErr('No start places found. Try another name, lat,lng, or use my location.') }
  const swapLocations = () => { const nextStart = dest; setDest({ ...start, name: startLabel }); setStart({ ...nextStart }); setOriginMode(false); setOriginQuery(''); setOriginResults([]); setDestinationMode(false); setDestinationQuery('') }
  const chooseDestination = (value) => { if (value === '__search__') { setDestinationMode(true); setDestinationQuery(''); return } const next = PLACES.find((p) => p.name === value); if (next) { setDest(next); setDestinationMode(false); setDestinationQuery('') } }
  const typeDestination = (value) => { setDestinationQuery(value); const next = PLACES.find((p) => p.name.toLowerCase() === value.trim().toLowerCase()); if (next) { setDest(next); setDestinationMode(false); setDestinationQuery('') } }
  const pickDestination = (place) => { setDest(place); setDestinationMode(false); setDestinationQuery(''); setGeoResults([]); setRoutes([]); setSel() }
  const geocode = async () => { const q = destinationQuery.trim(); if (!q) return; const coords = parseCoords(q); if (coords) { pickDestination(coords); return } setGeoBusy(true); setErr()
    const local = PLACES.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())), found = await api.geocode(q).catch(() => [])
    setGeoBusy(false); const all = [...local, ...found]; setGeoResults(all); if (!all.length) setErr('No places found. Try another name or click the map to set the destination.') }
  const mapClick = (p) => { if (jid) return; const place = { name: `Pinned ${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`, ...p }; if (originMode) pickOrigin(place); else pickDestination(place) }
  const pinPoint = dest?.latitude != null ? dest : (gps || start)
  const pinSource = dest?.latitude != null ? 'pin' : (gps ? 'gps' : 'origin')
  useEffect(() => {
    if (pinPoint?.latitude == null || pinPoint?.longitude == null) return undefined
    let cancelled = false
    api.pointSafety(pinPoint.latitude, pinPoint.longitude).then((body) => {
      if (cancelled) return
      const key = body.crime?.place_key
      const tagged = { ...body, source: pinSource }
      if (liveCrimeKey.current && liveCrimeKey.current === key && tagged.factors) {
        setLivePoint((prev) => prev ? { ...tagged, factors: { ...tagged.factors, historical_crime: prev.factors?.historical_crime ?? tagged.factors.historical_crime } } : tagged)
      } else {
        liveCrimeKey.current = key
        setLivePoint(tagged)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [pinPoint?.latitude, pinPoint?.longitude, pinSource])
  const stopRoute = async () => { if (jid) await api.stop(jid).catch(() => {}); if (watch.current !== undefined) { navigator.geolocation?.clearWatch(watch.current); watch.current = undefined } setJid(); setSt(); setGps(); setNote('Route stopped. Pick another route or destination.') }
  const minEta = routes.length ? Math.min(...routes.map((r) => r.eta_min)) : undefined
  const changePreference = (value) => {
    const next = Number(value)
    setPreference(next)
    if (routes.length) setSel(bestRouteId(routes, next))
  }
  const search = async () => { if (originMode) { await geocodeOrigin(); return } if (destinationMode) { await geocode(); return } setBusy(true); setNote(); const r = await run(() => api.search(start, dest)); setBusy(false)
    if (r) { setRoutes(r.routes); setSel(bestRouteId(r.routes, preference)); if (!r.routes.length) setErr('No routes found.') } }
  const begin = async () => { const r = await run(() => api.start(sel)); if (r) { setJid(r.journey_id); refresh(r.journey_id)
    // FREEZE_SIM_WALK: pin stays at last real GPS or start; do not follow simulated st.position.
    if (navigator.geolocation) watch.current = navigator.geolocation.watchPosition((p) => setGps({ latitude: p.coords.latitude, longitude: p.coords.longitude }), () => setNote('Live location is unavailable. Pin stays at the last started position until GPS updates.'))
    else setNote('Live location is unavailable. Pin stays at the last started position until GPS updates.') } }
  const refresh = async (id = jid) => { const s = await run(() => api.status(id)); if (s) setSt(s) }
  useEffect(() => { if (!jid || st?.status === 'completed') return; const t = setInterval(refresh, POLL_MS); return () => clearInterval(t) }, [jid, st?.status])
  useEffect(() => { if (st?.status === 'completed' && watch.current !== undefined) { navigator.geolocation?.clearWatch(watch.current); watch.current = undefined } }, [st?.status])
  useEffect(() => () => { if (watch.current !== undefined) navigator.geolocation?.clearWatch(watch.current) }, [])

  const inject = async () => { const i = await run(() => api.inject(jid)); if (i) setIncidents((current) => [i, ...current]); refresh() }
  const doSwitch = async () => { const s = await run(() => api.switchTo(jid, st.reroute.alternative.id)); if (s) { setSt(s); setNote('Switched to the safer route.') } }
  const keep = async () => { await run(() => api.dismiss(jid)); setNote('Keeping current route.'); refresh() }

  const startSafetyJourney = async () => {
    if (!ensureGuardiansConfigured()) return

    const payload = await run(() => api.startSafetyMonitor({ user_name: emergencyProfile.name || 'Traveler', latitude: start.latitude, longitude: start.longitude }))
    if (!payload) return

    setSosJourney(payload)
    setSosNotice('Safety monitor active. Please allow microphone access.')
    setSosStatus({ risk_level: 'LOW', risk_score: 0, status: 'JOURNEY_ACTIVE', countdown_required: false, countdown_seconds: 0 })
    countdownTriggeredRef.current = false
    await watchForFalls()
    await startVoiceMonitoring()
    if (!window.isSecureContext) {
      setSosNotice('Fall sensing is off on this http network address. Open the https network URL, or tap Fall.')
    }
  }

  const refreshSafetyJourney = async () => {
    if (!sosJourney) return
    const payload = await run(() => api.safetyStatus(sosJourney.journey_id))
    if (payload) setSosStatus(payload)
  }

  const triggerSafetyEvent = async (signal_type, emotion) => {
    if (!sosJourney) return
    if (sosStatus?.status === 'EMERGENCY_ACTIVE' && signal_type !== 'SAFE') return
    const payload = await run(() => api.signal({ journey_id: sosJourney.journey_id, signal_type, latitude: start.latitude, longitude: start.longitude, emotion }))
    if (payload) {
      if (signal_type === 'SAFE') {
        stopVoiceMonitoring()
        stopFallWatch()
        setSosJourney(null)
        setSosStatus(null)
        setCountdownOpen(false)
        setCountdownSeconds(0)
        countdownTriggeredRef.current = true
        setLiveTranscript('')
        setMapMode('safety')
        setSosNotice('')
        return
      }
      if (payload?.status === 'EMERGENCY_ACTIVE') {
        setSosStatus({
          ...payload,
          status: 'EMERGENCY_ACTIVE',
          countdown_required: false,
          countdown_seconds: 0,
          sos_trigger: payload.sos_trigger || 'AUTO',
          email_status: payload.email_status,
          help_alerted: payload.help_alerted,
          guardian_count: payload.guardian_count,
        })
        setCountdownOpen(false)
        setCountdownSeconds(0)
        countdownTriggeredRef.current = true
        setMapMode('safepoints')
        setSosNotice('SOS ACTIVATED. Help contacted and is on the way.')
        return
      }
      setSosStatus(payload)
      setSosNotice(`${signal_type} recorded.`)
      if (payload?.risk_score >= 60 && !countdownOpen) {
        setCountdownOpen(true)
        setCountdownSeconds(Number(payload?.countdown_seconds) || 10)
      }
      if (payload?.risk_score >= 60 && !countdownTriggeredRef.current && payload?.countdown_required) {
        countdownTriggeredRef.current = false
      }
      if (payload?.risk_score >= 60 && payload?.countdown_required === false) {
        setCountdownOpen(false)
        setCountdownSeconds(0)
      }
    }
  }

  triggerRef.current = triggerSafetyEvent

  const createEmergency = async (triggerType, journey = sosJourney) => {
    if (!journey || sosStatus?.status === 'EMERGENCY_ACTIVE') return
    stopVoiceMonitoring()
    const recipients = validGuardianEmails.length ? validGuardianEmails.join(', ') : 'guardian contacts'
    const payload = await run(() => api.createEmergency({
      journey_id: journey.journey_id,
      trigger_type: triggerType,
      latitude: start.latitude,
      longitude: start.longitude,
      public_origin: window.location.origin,
      nav_journey_id: jid,
    }))
    if (payload) {
      setSosStatus({
        ...payload,
        status: 'EMERGENCY_ACTIVE',
        countdown_required: false,
        countdown_seconds: 0,
        sos_trigger: payload.sos_trigger || triggerType,
        email_status: payload.email_status,
        help_alerted: payload.help_alerted,
        guardian_count: payload.guardian_count,
      })
      setSosNotice(`SOS triggered. Help contacted and is on the way. Alerts sent to ${recipients}.`)
      setCountdownOpen(false)
      setCountdownSeconds(0)
      countdownTriggeredRef.current = true
      setMapMode('safepoints')
      shareGuardianLocation()
    }
  }

  const triggerManualSos = () => createEmergency('MANUAL')
  const shareLiveDashboard = async () => {
    // SHARE_LIVE_DASHBOARD_AFTER_START: shown only while a nav journey is active, never beside Find.
    if (!ensureGuardiansConfigured()) return
    if (!jid) {
      setNote('Start the route first, then share live location with guardians.')
      return
    }
    const payload = await run(() => api.shareTrip({
      nav_journey_id: jid,
      user_name: emergencyProfile.name || 'Traveler',
      public_origin: window.location.origin,
      sos_journey_id: sosJourney?.journey_id,
    }))
    if (payload) {
      const captured = payload.captured ? ' Email body captured locally because SMTP is not configured.' : ''
      setNote(payload.dashboard_url
        ? `Live location shared. Guardians can open the same Guardian dashboard: ${payload.dashboard_url}.${captured}`
        : `Trip share prepared for guardians.${captured}`)
    }
  }
  const triggerTopBarSos = async () => {
    if (!ensureGuardiansConfigured() || isEmergencyActive) return
    if (sosJourney) {
      await createEmergency('MANUAL')
      return
    }
    const journey = await run(() => api.startSafetyMonitor({ user_name: 'Demo User', latitude: start.latitude, longitude: start.longitude }))
    if (!journey) return
    setSosJourney(journey)
    await createEmergency('MANUAL', journey)
  }

  const escalateToEmergency = () => createEmergency('AUTO')

  const isEmergencyActive = Boolean(sosJourney && sosStatus?.status === 'EMERGENCY_ACTIVE')
  useEffect(() => {
    if (!isEmergencyActive) { setNearbySafePoints([]); return }
    const here = gps || start
    let cancelled = false
    api.safePoints(here.latitude, here.longitude).then((body) => {
      if (!cancelled) setNearbySafePoints(body.points || [])
    }).catch(() => { if (!cancelled) setNearbySafePoints([]) })
    return () => { cancelled = true }
  }, [isEmergencyActive, gps, start])
  const hideActionButtons = isEmergencyActive
  const riskDisplayValue = Number(sosStatus?.risk_score ?? 0)

  const handleSafeResponse = async () => {
    setCountdownOpen(false)
    setCountdownSeconds(0)
    countdownTriggeredRef.current = true
    await triggerSafetyEvent('SAFE')
  }

  useEffect(() => {
    if (!sosJourney) return
    const id = setInterval(refreshSafetyJourney, 4000)
    return () => clearInterval(id)
  }, [sosJourney])

  useEffect(() => {
    if (!sosJourney) {
      setCountdownOpen(false)
      setCountdownSeconds(10)
      return
    }
    const required = Boolean(sosStatus?.countdown_required)
    setCountdownOpen(required)
    if (required) {
      setCountdownSeconds(Number(sosStatus?.countdown_seconds) || 10)
      countdownTriggeredRef.current = false
    }
  }, [sosJourney, sosStatus?.countdown_required, sosStatus?.countdown_seconds])

  useEffect(() => {
    if (!countdownOpen || !sosJourney) return
    const id = setInterval(() => {
      setCountdownSeconds((current) => {
        if (current <= 1) {
          clearInterval(id)
          if (!countdownTriggeredRef.current) {
            countdownTriggeredRef.current = true
            ;(async () => {
              await triggerSafetyEvent('COUNTDOWN_EXPIRED')
              await escalateToEmergency()
            })()
          }
          return 0
        }
        return current - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [countdownOpen, sosJourney])

  useEffect(() => {
    if (!sosJourney || validGuardianEmails.length === 0) return
    const intervalMs = Math.max(300000, Number(locationUpdateMinutes || 5) * 60 * 1000)
    const id = setInterval(() => shareGuardianLocation(), intervalMs)
    return () => clearInterval(id)
  }, [sosJourney, validGuardianEmails.length, locationUpdateMinutes])

  const stopFallWatch = () => {
    if (fallListenerRef.current) {
      window.removeEventListener('devicemotion', fallListenerRef.current)
      fallListenerRef.current = null
    }
  }

  const watchForFalls = async () => {
    stopFallWatch()
    const Motion = window.DeviceMotionEvent
    if (!Motion || !window.isSecureContext) return
    if (typeof Motion.requestPermission === 'function') {
      try {
        const result = await Motion.requestPermission()
        if (result !== 'granted') {
          setSosNotice('Motion permission denied. Tap Fall to record a fall manually.')
          return
        }
      } catch {
        setSosNotice('Motion permission failed. Tap Fall to record a fall manually.')
        return
      }
    }
    let lastSent = 0
    let freefallAt = 0
    const onMotion = (event) => {
      const reading = event.accelerationIncludingGravity
      if (!reading || reading.x == null || reading.y == null || reading.z == null) return
      const magnitude = Math.hypot(reading.x, reading.y, reading.z)
      const now = Date.now()
      // Browsers report either g (resting near 1) or m/s^2 (resting near 9.8).
      const inG = magnitude < 8
      const freefall = inG ? magnitude < 0.35 : magnitude < 3.5
      const impact = inG ? magnitude >= 7 : magnitude >= 70
      if (freefall) freefallAt = now
      if (!impact || !freefallAt || now - freefallAt > 700) return
      if (now - lastSent < 8000) return
      lastSent = now
      freefallAt = 0
      triggerRef.current?.('FALL_DETECTED')
    }
    fallListenerRef.current = onMotion
    window.addEventListener('devicemotion', onMotion)
  }

  useEffect(() => () => { stopVoiceMonitoring(); stopFallWatch() }, [])

  const selectedRoute = routes.find((r) => r.id === sel)
  const activeRoute = st ? { id: st.route_id, geometry: st.geometry, safety: st.safety, factors: st.factors, distance_m: st.distance_m, progress_m: st.progress_m, eta_min: st.eta_min, incident_count: st.incidents_ahead.length } : selectedRoute
  const pinScoredRoute = livePoint ? { ...(activeRoute || {}), safety: livePoint.safety, factors: livePoint.factors, eta_min: activeRoute?.eta_min ?? 1 } : activeRoute
  const navItems = [{ icon: '⌂', label: 'Home' }, { icon: '⚙', label: 'Settings' }]
  const chosenId = bestRouteId(routes, preference)
  const scoredRoutes = routes.map((r) => ({ ...r, high_risk_min: highRiskExposure(r, incidents).minutes, route_score: routeScore(r.safety, speedScore(r, minEta), preference), recommended: r.id === chosenId })).sort((a, b) => b.route_score - a.route_score || a.eta_min - b.eta_min)
  const safePoints = (activeRoute?.safe_points?.length ? activeRoute.safe_points : nearbySafePoints)
  const navGeometry = st?.geometry || activeRoute?.geometry
  const navFix = (() => {
    if (!jid || !navGeometry) return null
    if (gps) {
      const snap = snapToRoute(navGeometry, gps)
      if (snap && snap.offRouteM <= 80) return gps
    }
    return st?.position || gps || start
  })()
  const cue = jid ? navigationCue({ geometry: navGeometry, steps: st?.steps, position: navFix, progressM: st?.progress_m || 0, arrived: st?.status === 'completed' }) : null
  const departAt = departMode === 'Custom' ? departTime : undefined
  const shown = st ? [{ id: st.route_id, geometry: st.geometry }] : routes

  if (currentPage === 'settings') {
    return (<>{fakeCallActive && <IncomingCallScreen onDismiss={() => setFakeCallActive(false)} />}<div className={'dashboard settings-page-shell' + (navCollapsed ? ' nav-collapsed' : '')}>
      <aside className={'sidebar' + (navCollapsed ? ' collapsed' : '')}>
        <div className="brand"><span className="brand-mark">✦</span><div className="nav-text"><strong>SENTINEL</strong><small>Safe navigation</small></div><button type="button" className="collapse-toggle" onClick={() => setNavCollapsed((v) => !v)} title="Toggle sidebar">{navCollapsed ? '»' : '«'}</button></div>
        <nav className="sidebar-nav">{navItems.map(({ icon, label }) => (
          <button
            key={label}
            type="button"
            className={'nav-item' + (label === activeNav ? ' active' : '')}
            onClick={() => {
              setActiveNav(label)
              setCurrentPage(label === 'Settings' ? 'settings' : 'home')
            }}
          >
            <span>{icon}</span><span className="nav-text">{label}</span>
          </button>
        ))}</nav>
        <div className="sidebar-foot"><div className="avatar">A</div><div><b>Aarav</b><small>Stay safe.</small></div><span className="more">•••</span></div>
      </aside>
      <main className="workspace settings-page">
        <header className="topbar settings-topbar"><div><span className="eyebrow">Safety preferences</span><h1>Guardian settings</h1></div><button className="sos-button sos-button-muted" onClick={() => { setCurrentPage('home'); setActiveNav('Home') }}>← Back to home</button></header>
        <section className="panel settings-panel">
          <div className="settings-page-form">
            <label>Guardian email 1<input value={guardianEmails[0] || ''} onChange={(e) => setGuardianEmails((current) => [e.target.value, current[1] || ''])} placeholder="guardian1@example.com" /></label>
            <label>Guardian email 2<input value={guardianEmails[1] || ''} onChange={(e) => setGuardianEmails((current) => [current[0] || '', e.target.value])} placeholder="guardian2@example.com" /></label>
            <label>Emergency contact 1<input value={emergencyContacts[0]?.number || ''} onChange={(e) => setEmergencyContacts((current) => [{ ...current[0], number: e.target.value }, current[1] || { label: 'Ambulance', number: '108' }])} placeholder="112" /></label>
            <label>Emergency contact 2<input value={emergencyContacts[1]?.number || ''} onChange={(e) => setEmergencyContacts((current) => [current[0] || { label: 'Police', number: '112' }, { ...current[1], number: e.target.value }])} placeholder="108" /></label>
            <label>User name<input value={emergencyProfile.name} onChange={(e) => setEmergencyProfile((current) => ({ ...current, name: e.target.value }))} placeholder="Name" /></label>
            <label>Address<textarea value={emergencyProfile.address} onChange={(e) => setEmergencyProfile((current) => ({ ...current, address: e.target.value }))} placeholder="Address" rows={3} /></label>
            <label>Blood type<input value={emergencyProfile.blood_type} onChange={(e) => setEmergencyProfile((current) => ({ ...current, blood_type: e.target.value }))} placeholder="A+" /></label>
            <label>Allergies<input value={emergencyProfile.allergies} onChange={(e) => setEmergencyProfile((current) => ({ ...current, allergies: e.target.value }))} placeholder="Penicillin, peanuts" /></label>
            <label>Medical conditions<input value={emergencyProfile.medical_conditions} onChange={(e) => setEmergencyProfile((current) => ({ ...current, medical_conditions: e.target.value }))} placeholder="Asthma, epilepsy" /></label>
            <label>Location update interval
              <select value={locationUpdateMinutes} onChange={(e) => setLocationUpdateMinutes(Number(e.target.value))}>
                <option value={5}>5 minutes</option>
                <option value={10}>10 minutes</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
              </select>
            </label>
            {settingsSavedMessage && <div className="sos-notice">{settingsSavedMessage}</div>}
            <button className="sos-button sos-button-primary" onClick={saveSettings}>Save settings</button>
          </div>
        </section>
      </main>
    </div></>)
  }

  return (<>{fakeCallActive && <IncomingCallScreen onDismiss={() => setFakeCallActive(false)} />}<div className={'dashboard' + (navCollapsed ? ' nav-collapsed' : '') + (jid ? ' navigating' : '')}>
    <aside className={'sidebar' + (navCollapsed ? ' collapsed' : '')}>
      <div className="brand"><span className="brand-mark">✦</span><div className="nav-text"><strong>SENTINEL</strong><small>Safe navigation</small></div><button type="button" className="collapse-toggle" onClick={() => setNavCollapsed((v) => !v)} title="Toggle sidebar">{navCollapsed ? '»' : '«'}</button></div>
      <nav className="sidebar-nav">{navItems.map(({ icon, label }) => (
        <button
          key={label}
          type="button"
          className={'nav-item' + (label === activeNav ? ' active' : '')}
          onClick={() => {
            setActiveNav(label)
            setCurrentPage(label === 'Settings' ? 'settings' : 'home')
          }}
        >
          <span>{icon}</span><span className="nav-text">{label}</span>
        </button>
      ))}</nav>
      <div className="sidebar-foot"><div className="avatar">A</div><div><b>Aarav</b><small>Stay safe.</small></div><span className="more">•••</span></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div><span className="eyebrow">Safety-first navigation</span><h1>{jid ? 'Live journey' : 'Safe route planner'}</h1></div><div className="top-actions"><span className="status-chip"><span className="live-dot" />{jid ? 'Journey active' : 'Ready to plan'}</span><button type="button" className="sos-top-button" onClick={triggerTopBarSos} disabled={isEmergencyActive} title="Send manual SOS">SOS</button><button type="button" className="icon-button" onClick={() => setFakeCallActive(true)} title="Quick dial" aria-label="Quick dial"><Phone size={16} /></button><button className="icon-button">?</button></div></header>
      <section className="panel sos-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">04 · Intelligent SOS</span><h2>Safety monitor</h2></div>
        </div>
        {isEmergencyActive && <div className="traveler-sos-banner" role="status">SOS triggered, check email for guardian/SOS dashboard.</div>}
        {!sosJourney && <button className="sos-button sos-button-primary" onClick={startSafetyJourney}>Activate safety monitor</button>}
        {sosJourney && <div className="sos-panel-body">
          <div className="sos-header">
            <p className="muted">Journey: {sosJourney.journey_id} · {sosStatus?.status || 'JOURNEY_ACTIVE'}</p>
            <div className="sos-tag-row">
              <span className="tag">Risk: {sosStatus?.risk_level || 'LOW'}</span>
              <span className="tag">{sosStatus?.risk_score || 0}</span>
            </div>
          </div>

          {sosStatus?.countdown_required && <div className="alert"><strong>POSSIBLE EMERGENCY DETECTED</strong><p className="muted">Are you safe? Automatic SOS in {sosStatus.countdown_seconds}s</p></div>}

          <div className="risk-display-wrap">
            <div className="risk-label">Risk score</div>
            <div className={`risk-score risk-score-${riskDisplayValue >= 60 ? 'high' : riskDisplayValue >= 30 ? 'mid' : 'low'}`}>{riskDisplayValue}</div>
          </div>

          <div className="sos-button-grid">
            {!hideActionButtons && <button className="sos-button sos-button-secondary" onClick={() => triggerSafetyEvent('KEYWORD_DETECTED')}>Keyword</button>}
            {!hideActionButtons && <button className="sos-button sos-button-secondary" onClick={() => triggerSafetyEvent('FALL_DETECTED')}>Fall</button>}
            {!hideActionButtons && <button className="sos-button sos-button-secondary" onClick={() => triggerSafetyEvent('EMOTION_DETECTED', 'angry')}>Angry voice</button>}
            <button className="sos-button sos-button-secondary" onClick={handleSafeResponse}>I am safe</button>
          </div>

          {!hideActionButtons && <button className="sos-button sos-button-danger" onClick={triggerManualSos}>Manual SOS</button>}
          {!hideActionButtons && <button className="sos-button sos-button-muted" onClick={isListening ? stopVoiceMonitoring : startVoiceMonitoring}>{isListening ? 'Stop mic' : 'Start mic'}</button>}

          <div className="transcript-box">
            <label>Current detected words</label>
            <div className="transcript-buffer">{liveTranscript || 'Listening for speech…'}</div>
          </div>

          <div className="manual-transcript-row">
            <input value={manualTranscript} onChange={(e) => setManualTranscript(e.target.value)} placeholder="Type a phrase like 'help me'" />
            <button className="sos-button sos-button-primary" onClick={() => processTranscript(manualTranscript)}>Use transcript</button>
          </div>
        </div>}
        {sosNotice && <p className="sos-notice">{sosNotice}</p>}
      </section>

      {countdownOpen && <div className="countdown-backdrop">
        <div className="countdown-modal">
          <p className="eyebrow">Safety check</p>
          <h3>Are you safe?</h3>
          <div className="countdown-total">{countdownSeconds}s</div>
          <p className="muted">If you do not respond, the app will trigger SOS automatically and notify your guardians.</p>
          <div className="countdown-actions">
            <button className="sos-button sos-button-primary" onClick={handleSafeResponse}>I am safe</button>
            <button className="sos-button sos-button-danger" onClick={triggerManualSos}>Trigger SOS now</button>
          </div>
        </div>
      </div>}

      <section className="search-panel">
        <div className="search-fields"><label><span>From</span>{originMode ? <div className="field destination-search"><span className="field-icon blue">⌖</span><input autoFocus value={originQuery} onChange={(e) => typeOrigin(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && geocodeOrigin()} placeholder="Search start or lat,lng..." /><button className="locate-button" onClick={geocodeOrigin} title="Search">{originBusy ? '…' : '⌕'}</button><button className="locate-button" onClick={locate} title="Use my location">◎</button></div> : <div className="field"><span className="field-icon blue">⌖</span><select value={startLabel} onChange={(e) => chooseOrigin(e.target.value)}><option value="__search__">Search any place...</option><option value="__gps__">Use my location</option>{!PLACES.some((p) => p.name === startLabel) && startLabel && <option>{startLabel}</option>}{PLACES.map((p) => <option key={p.name}>{p.name}</option>)}</select><button className="locate-button" onClick={locate} title="Use my location">◎</button></div>}{originMode && originResults.length > 0 && <div className="geo-results">{originResults.map((p) => <button key={'o' + p.name + p.latitude} type="button" onClick={() => pickOrigin(p)}>{p.name}</button>)}</div>}{originMode && <small className="muted destination-note">Press Enter to search a start, type lat,lng, or use my location. GPS is optional.</small>}</label><button className="swap-button" onClick={swapLocations} title="Swap locations">⇄</button><label><span>To</span>{destinationMode ? <div className="field destination-search"><span className="field-icon red">●</span><input autoFocus value={destinationQuery} onChange={(e) => typeDestination(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && geocode()} placeholder="Search any place..." /><button className="locate-button" onClick={geocode} title="Search">{geoBusy ? '…' : '⌕'}</button></div> : <div className="field"><span className="field-icon red">●</span><select value={dest.name} onChange={(e) => chooseDestination(e.target.value)}><option value="__search__">Search any place...</option>{!PLACES.some((p) => p.name === dest.name) && <option>{dest.name}</option>}{PLACES.map((p) => <option key={p.name}>{p.name}</option>)}</select></div>}{destinationMode && geoResults.length > 0 && <div className="geo-results">{geoResults.map((p) => <button key={p.name + p.latitude} type="button" onClick={() => pickDestination(p)}>{p.name}</button>)}</div>}{destinationMode && <small className="muted destination-note">Press Enter to search, or click the map to drop a destination pin.</small>}</label><label className="departure"><span>Depart at</span><div className="field"><span className="field-icon">◷</span><select value={departMode} onChange={(e) => setDepartMode(e.target.value)}><option>Now</option><option value="Custom">Custom time</option></select>{departMode === 'Custom' && <input type="time" className="depart-time" value={departTime} onChange={(e) => setDepartTime(e.target.value)} />}</div></label><button className="find-button" onClick={search} disabled={busy || Boolean(jid)}>{busy ? 'Finding…' : jid ? 'Route active' : (originMode || destinationMode) ? 'Search place' : 'Find Safe Routes'} <span>→</span></button></div>
        {departAt && <DepartCompare route={activeRoute} time={departAt} preference={preference} minEta={minEta} />}<div className="preference"><span className="preference-icon">✦</span><div><b>Safety-Time Preference</b><small>Adjust how much you want to prioritise safety vs faster travel.</small></div><div className="preference-control"><span>Faster Travel</span><input type="range" min="0" max="100" value={preference} onChange={(e) => changePreference(e.target.value)} /><span>Safer Travel</span><div className="preference-labels"><small>Shorter time, higher risk</small><strong>{preference < 40 ? 'Faster Travel' : preference > 60 ? 'Safer Travel' : 'Balanced (Recommended)'}</strong><small>May take longer, higher safety</small></div></div></div>
      </section>
      {err && <ErrorState message={err} />}{busy && <LoadingState text="Finding real road routes…" />}
      <section className="dashboard-grid">
        <div className="route-column"><div className="section-heading"><div><span className="eyebrow">Route planning</span><h2>Route Options <em>{routes.length || (jid ? 1 : 0)}</em></h2></div><select className="sort-select" defaultValue="recommended"><option value="recommended">Recommended</option></select></div>{!jid && scoredRoutes.map((r) => <RouteCard key={r.id} r={r} selected={r.id === sel} onSelect={setSel} />)}{!jid && !routes.length && <div className="empty-card"><span className="empty-icon">⌁</span><b>Find a safe route</b><p>Choose your destination and compare real road routes.</p></div>}{jid && st && <JourneyStatus s={st} />}{!jid && sel && <><SelectedRouteSummary r={selectedRoute} /><button className="start-button" onClick={begin}>START ROUTE <span>→</span></button></>}{jid && st && <><div className="journey-actions">{st.reroute && <RerouteCard rr={st.reroute} onSwitch={doSwitch} onKeep={keep} />}{!st.reroute && st.status !== 'completed' && <WhyNotCard analysis={st.reroute_analysis} />}{note && <p className="muted">{note}</p>}{!st.incidents_ahead.length && st.status !== 'completed' && <p className="muted">No incidents ahead.</p>}<button type="button" className="share-live-dashboard-button" data-share-after-start="1" onClick={shareLiveDashboard} title="Email guardians a live Guardian dashboard link">Share live location</button><button className="demo-button" onClick={inject}>Demo: inject accident 600 m ahead</button><button className="start-button stop-button" onClick={stopRoute}>{st.status === 'completed' ? 'END ROUTE' : 'STOP ROUTE'} <span>■</span></button></div></>}</div>
        <div className="map-column">{!jid && <div className="map-toolbar"><div className="map-tabs">{[['safety', '◉ Safety View'], ['safepoints', '⌖ Safe Points'], ['heatmap', '◌ Risk Heatmap'], ['time', '◷ Time Profile']].map(([k, label]) => <button type="button" key={k} className={mapMode === k ? 'active' : ''} onClick={() => setMapMode(k)}>{label}</button>)}</div><span className="map-expand">⛶</span></div>}<MapView routes={shown} selectedId={jid ? st?.route_id : sel} alt={st?.reroute?.alternative} incidents={st?.incidents_ahead || []} heatmapIncidents={incidents} position={jid ? navFix : (gps || undefined)} start={start} dest={dest} mode={mapMode} safePoints={safePoints} onMapClick={mapClick} follow={Boolean(jid && navFix && st?.status !== 'completed')} heading={cue?.heading} />{jid && <NavigationHud cue={cue} destName={dest?.name} etaMin={st?.eta_min} onStop={stopRoute} completed={st?.status === 'completed'} />}{!jid && mapMode === 'time' && <div className="time-overlay panel"><TimeProfileTable route={pinScoredRoute} preference={preference} minEta={minEta} /></div>}</div>
        <div className="intel-column"><SafetyProfile route={pinScoredRoute} preference={preference} minEta={minEta} livePoint={livePoint} /><SafePointPanel route={activeRoute} points={safePoints} /><IndependencePanel routes={routes} incidents={incidents} /><IncidentSummary incidents={incidents} /></div>
      </section>
      <AnalysisPanel route={activeRoute} incidents={incidents} analysis={st?.reroute_analysis} />
      <SafetyAssistantPanel
        sosJourney={sosJourney}
        sosStatus={sosStatus}
        navJourneyId={jid}
        selectedRoute={pinScoredRoute}
        journeyStatus={st}
        dest={dest}
        start={start}
        livePoint={livePoint}
        safePoints={safePoints}
        userName={emergencyProfile.name || sosJourney?.user_name}
      />
    </main>
  </div></>)
}
