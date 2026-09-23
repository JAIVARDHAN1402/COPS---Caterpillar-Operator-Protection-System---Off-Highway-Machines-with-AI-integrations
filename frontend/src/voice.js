// Voice in/out + alarm sounds. Operators have their hands on the joysticks,
// so every critical interaction must work hands-free.

let lastSpoken = { text: '', at: 0 }

export function speak(text, { lang = 'en-IN', force = false } = {}) {
  if (!('speechSynthesis' in window)) return
  const now = Date.now()
  if (!force && text === lastSpoken.text && now - lastSpoken.at < 6000) return
  lastSpoken = { text, at: now }
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = lang
  u.rate = 1.02
  window.speechSynthesis.speak(u)
}

export const speechSupported = () =>
  !!(window.SpeechRecognition || window.webkitSpeechRecognition)

export function listenOnce({ lang = 'en-IN', onResult, onEnd, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) {
    onError?.('Speech recognition not supported in this browser (use Chrome or Edge)')
    return null
  }
  const rec = new SR()
  rec.lang = lang
  rec.interimResults = true
  rec.maxAlternatives = 1
  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1]
    onResult?.(r[0].transcript, r.isFinal)
  }
  rec.onerror = (e) => onError?.(e.error)
  rec.onend = () => onEnd?.()
  rec.start()
  return rec
}

let ctx
function audio() {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
  return ctx
}

export function beep({ freq = 880, duration = 0.18, type = 'square', volume = 0.15, repeat = 1 } = {}) {
  try {
    const a = audio()
    for (let i = 0; i < repeat; i++) {
      const o = a.createOscillator()
      const g = a.createGain()
      o.type = type
      o.frequency.value = freq
      g.gain.value = volume
      o.connect(g).connect(a.destination)
      const t = a.currentTime + i * duration * 1.6
      o.start(t)
      o.stop(t + duration)
    }
  } catch {
    /* audio blocked until user gesture - ignore */
  }
}

export const alarm = () => beep({ freq: 1200, duration: 0.15, repeat: 4, volume: 0.2 })

/** Two-tone siren for interlock violations (belt off with engine running, blocked start). */
export function siren() {
  beep({ freq: 960, duration: 0.28, type: 'square', volume: 0.22 })
  setTimeout(() => beep({ freq: 640, duration: 0.28, type: 'square', volume: 0.22 }), 330)
  setTimeout(() => beep({ freq: 960, duration: 0.28, type: 'square', volume: 0.22 }), 660)
  setTimeout(() => beep({ freq: 640, duration: 0.28, type: 'square', volume: 0.22 }), 990)
}

/** Diesel "crank and catch" rumble when the engine starts. */
export function engineStartSound() {
  try {
    const a = audio()
    const t = a.currentTime
    const o = a.createOscillator()
    const g = a.createGain()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(40, t)
    o.frequency.linearRampToValueAtTime(115, t + 0.7)
    o.frequency.linearRampToValueAtTime(70, t + 1.5)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(0.16, t + 0.2)
    g.gain.linearRampToValueAtTime(0.0001, t + 1.6)
    o.connect(g).connect(a.destination)
    o.start(t)
    o.stop(t + 1.7)
  } catch {
    /* audio blocked until user gesture */
  }
}
export const chime = () => beep({ freq: 660, duration: 0.12, type: 'sine', repeat: 2, volume: 0.12 })
