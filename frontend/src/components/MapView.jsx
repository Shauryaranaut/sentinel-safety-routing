import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const ll = (p) => [p.latitude, p.longitude]
const heatColor = (severity) => severity >= .75 ? '#ff4d4f' : severity >= .45 ? '#f5a524' : '#4aa3ff'
const toRad = (d) => d * Math.PI / 180
const meters = (a, b) => { const x = toRad(b[1] - a[1]) * Math.cos(toRad((a[0] + b[0]) / 2)), y = toRad(b[0] - a[0]); return Math.sqrt(x * x + y * y) * 6371000 }
const safetyColor = (v) => v >= 75 ? '#3ddc97' : v >= 60 ? '#f5a524' : '#ff4d4f'
export const segmentSafety = (base, a, b, incidents) => {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const penalty = incidents.reduce((sum, i) => { const d = meters(mid, [i.latitude, i.longitude]); return d < 900 ? sum + (Number(i.severity) || .5) * 40 * (1 - d / 900) : sum }, 0)
  return Math.max(0, Math.min(100, base - penalty))
}
export default function MapView({ routes = [], selectedId, alt, incidents = [], heatmapIncidents = [], position, start, dest, mode = 'safety', safePoints = [], onMapClick, follow = false, heading = null }) {
  const el = useRef(), map = useRef(), layer = useRef(), clickRef = useRef()
  clickRef.current = onMapClick
  useEffect(() => {
    if (!el.current) return undefined
    map.current = L.map(el.current, { zoomControl: true }).setView([26.92, 75.81], 12)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map.current)
    layer.current = L.layerGroup().addTo(map.current)
    map.current.on('click', (e) => clickRef.current?.({ latitude: e.latlng.lat, longitude: e.latlng.lng }))
    const frame = requestAnimationFrame(() => map.current?.invalidateSize())
    const resize = new ResizeObserver(() => map.current?.invalidateSize())
    resize.observe(el.current)
    return () => { cancelAnimationFrame(frame); resize.disconnect(); map.current?.remove(); map.current = undefined; layer.current = undefined }
  }, [])
  useEffect(() => {
    if (!map.current || !layer.current) return
    const g = layer.current; g.clearLayers()
    const all = []
    routes.forEach((r) => { const sel = r.id === selectedId
      const geometry = (r.geometry || []).filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))).map(([lat, lon]) => [Number(lat), Number(lon)])
      if (geometry.length < 2) return
      if (sel && mode === 'heatmap') {
        const step = Math.max(1, Math.floor(geometry.length / 60))
        for (let n = 0; n < geometry.length - 1; n += step) {
          const seg = geometry.slice(n, Math.min(n + step, geometry.length - 1) + 1), v = segmentSafety(Number(r.safety) || 80, seg[0], seg[seg.length - 1], heatmapIncidents)
          all.push(L.polyline(seg, { color: safetyColor(v), weight: 7, opacity: .95 }).bindTooltip(`Segment safety ${Math.round(v)}/100`).addTo(g))
        }
        return
      }
      const pl = L.polyline(geometry, { color: sel ? '#f5a524' : '#6b7a90', weight: sel ? 6 : 3, opacity: sel ? 1 : .6 }).bindTooltip(sel ? 'Selected route' : 'Alternative route').addTo(g); all.push(pl) })
    if (alt?.geometry?.length >= 2) L.polyline(alt.geometry, { color: '#3ddc97', weight: 6, dashArray: '8 8' }).bindTooltip('Safer alternative').addTo(g)
    if (mode === 'safepoints') safePoints.forEach((p) => L.circleMarker(ll(p), { radius: 8, color: '#fff', weight: 2, fillColor: '#3ddc97', fillOpacity: 1 }).bindTooltip(`${p.name} (${p.kind})`).addTo(g))
    if (mode !== 'safepoints') heatmapIncidents.forEach((i) => {
      const severity = Number(i.severity) || 0
      const confidence = Number(i.confidence) || 0
      L.circle(ll(i), { radius: 180 + severity * 420, color: heatColor(severity), weight: 1, opacity: .35, fillColor: heatColor(severity), fillOpacity: .08 + confidence * .16 })
        .bindTooltip(`${i.title} · severity ${Math.round(severity * 100)}% · confidence ${Math.round(confidence * 100)}%`).addTo(g)
    })
    incidents.forEach((i) => {
      L.circle(ll(i), { radius: 500, color: '#ff4d4f', weight: 1, fillOpacity: .12 }).addTo(g)
      L.circleMarker(ll(i), { radius: 9, color: '#fff', fillColor: '#ff4d4f', fillOpacity: 1 }).bindTooltip(i.title).addTo(g) })
    if (start) L.circleMarker(ll(start), { radius: 7, color: '#fff', fillColor: '#4aa3ff', fillOpacity: 1 }).bindTooltip('Start').addTo(g)
    if (dest) L.circleMarker(ll(dest), { radius: 7, color: '#fff', fillColor: '#f5a524', fillOpacity: 1 }).bindTooltip('Destination').addTo(g)
    if (position && follow && Number.isFinite(heading)) {
      const icon = L.divIcon({
        className: 'nav-arrow-marker',
        html: `<span style="transform:rotate(${heading}deg)">▲</span>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      })
      L.marker(ll(position), { icon, interactive: false, zIndexOffset: 800 }).addTo(g)
    } else if (position) L.circleMarker(ll(position), { radius: 9, color: '#fff', weight: 3, fillColor: '#4aa3ff', fillOpacity: 1 }).bindTooltip('You').addTo(g)
    if (follow && position) map.current.setView(ll(position), Math.max(map.current.getZoom(), 16), { animate: true })
    else if (all.length && !position) map.current.fitBounds(L.featureGroup(all).getBounds(), { padding: [30, 30], maxZoom: 15 })
    map.current.invalidateSize()
  }, [routes, selectedId, alt, incidents, heatmapIncidents, position, start, dest, mode, safePoints, follow, heading])
  return <div className="map-shell"><div ref={el} className="map" style={{ height: '100%', minHeight: 300 }} />{!follow && <div className="map-key"><b>Map signals</b><span><i className="key-dot incident" />Reported incident intensity</span><span><i className="key-line route" />Selected route</span><span><i className="key-line safer" />Safer alternative</span>{mode === 'heatmap' && <span>Route colored by segment safety: green safe, amber caution, red risky</span>}{mode === 'safepoints' && <span><i className="key-dot" style={{ background: '#3ddc97' }} />Safe point</span>}<span>Click the map to set destination</span></div>}</div>
}
