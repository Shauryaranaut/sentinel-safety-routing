import { formatDistance } from '../lib/navigation.js'

const GLYPH = {
  depart: '▲',
  straight: '↑',
  'slight-left': '↖',
  left: '←',
  'sharp-left': '⟲',
  'slight-right': '↗',
  right: '→',
  'sharp-right': '⟳',
  uturn: '↩',
  roundabout: '↻',
  arrive: '●',
}

export default function NavigationHud({ cue, destName, etaMin, onStop, completed }) {
  if (!cue) return null
  const arrived = completed || cue.maneuver === 'arrive'
  return (
    <div className={'nav-hud' + (cue.offRoute ? ' off-route' : '') + (arrived ? ' arrived' : '')}>
      <div className="nav-banner" role="status">
        <span className="nav-glyph" aria-hidden="true">{GLYPH[cue.maneuver] || '↑'}</span>
        <div className="nav-copy">
          <strong>{arrived ? 'Arrived' : formatDistance(cue.distanceM)}</strong>
          <p>{arrived ? (destName ? `You are at ${destName}` : 'You have arrived') : cue.instruction}</p>
          {!arrived && cue.name ? <small>{cue.name}</small> : null}
          {!arrived && cue.then ? <small>Then {cue.then.instruction}</small> : null}
        </div>
      </div>
      <div className="nav-dock">
        <div><b>{etaMin != null ? `${Math.max(0, Math.round(etaMin))} min` : '—'}</b><small>ETA</small></div>
        <div><b>{formatDistance(cue.remainingM)}</b><small>left</small></div>
        <div className="nav-dest"><b>{destName || 'Destination'}</b><small>toward</small></div>
        <button type="button" className="nav-stop" onClick={onStop}>{arrived ? 'End' : 'Stop'}</button>
      </div>
    </div>
  )
}
